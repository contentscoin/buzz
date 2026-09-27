import * as React from "react";

type AutoRestartFailureKind = "automatic" | "manual";

export type AutoRestartFailureState = Readonly<{
  /** Safe, fixed user-facing copy. Raw backend errors are never retained. */
  message: string;
  /** Wall-clock time of the most recent failed attempt. */
  failedAt: number;
  /** One explicit retry is offered for each automatic failure. */
  manualRetryAvailable: boolean;
  /** True while the explicit retry is running. */
  retrying: boolean;
}>;

type StoredFailure = Readonly<{
  /** SHA-256 of the normalized relay scope and agent pubkey. */
  id: string;
  kind: AutoRestartFailureKind;
  failedAt: number;
  manualRetryAvailable: boolean;
}>;

const failures = new Map<string, AutoRestartFailureState>();
const storedFailures = new Map<string, StoredFailure>();
const listeners = new Set<() => void>();
const scopeLoads = new Map<string, Promise<void>>();
const mutationVersions = new Map<string, number>();
const clearedKeys = new Map<string, number>();
const STORAGE_KEY = "buzz:auto-restart-failures:v2";
const LEGACY_STORAGE_KEY = "buzz:auto-restart-failures:v1";
const MAX_FAILURES = 100;
const FAILURE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
let storageHydrated = false;
let mutationClock = 0;

const FAILURE_COPY: Record<AutoRestartFailureKind, string> = {
  automatic:
    "Automatic restart failed. Retry once, or open the agent profile for runtime details.",
  manual: "Restart retry failed. Open the agent profile for runtime details.",
};

function keyFor(scope: string, pubkey: string) {
  return `${scope.trim().toLowerCase()}\n${pubkey.trim().toLowerCase()}`;
}

function stateFor(
  kind: AutoRestartFailureKind,
  failedAt: number,
  manualRetryAvailable: boolean,
  retrying = false,
): AutoRestartFailureState {
  return {
    message: FAILURE_COPY[kind],
    failedAt,
    manualRetryAvailable,
    retrying,
  };
}

function isFailureKind(value: unknown): value is AutoRestartFailureKind {
  return value === "automatic" || value === "manual";
}

function pruneMemory() {
  const cutoff = Date.now() - FAILURE_TTL_MS;
  for (const [key, failure] of failures) {
    if (failure.failedAt < cutoff) failures.delete(key);
  }
  if (failures.size <= MAX_FAILURES) return;
  const oldest = [...failures.entries()].sort(
    ([, left], [, right]) => left.failedAt - right.failedAt,
  );
  for (const [key] of oldest.slice(0, failures.size - MAX_FAILURES)) {
    failures.delete(key);
  }
}

function pruneStored() {
  const cutoff = Date.now() - FAILURE_TTL_MS;
  for (const [id, failure] of storedFailures) {
    if (failure.failedAt < cutoff) storedFailures.delete(id);
  }
  if (storedFailures.size <= MAX_FAILURES) return;
  const oldest = [...storedFailures.entries()].sort(
    ([, left], [, right]) => left.failedAt - right.failedAt,
  );
  for (const [id] of oldest.slice(0, storedFailures.size - MAX_FAILURES)) {
    storedFailures.delete(id);
  }
}

function hydrateStorage() {
  if (storageHydrated || typeof window === "undefined") return;
  storageHydrated = true;

  try {
    // v1 stored raw relay URLs and backend messages. Remove it rather than
    // migrating sensitive data into the privacy-preserving schema.
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
    const parsed: unknown = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) ?? "[]",
    );
    if (!Array.isArray(parsed)) return;
    for (const entry of parsed.slice(-MAX_FAILURES)) {
      if (!entry || typeof entry !== "object") continue;
      const candidate = entry as Record<string, unknown>;
      if (
        typeof candidate.id !== "string" ||
        !HASH_PATTERN.test(candidate.id) ||
        !isFailureKind(candidate.kind) ||
        typeof candidate.failedAt !== "number" ||
        typeof candidate.manualRetryAvailable !== "boolean"
      ) {
        continue;
      }
      storedFailures.set(candidate.id, {
        id: candidate.id,
        kind: candidate.kind,
        failedAt: candidate.failedAt,
        manualRetryAvailable: candidate.manualRetryAvailable,
      });
    }
    pruneStored();
  } catch {
    // Corrupt optional UI state is ignored; the next write replaces it.
  }
}

function persistStored() {
  if (typeof window === "undefined") return;
  try {
    pruneStored();
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(
        [...storedFailures.values()].sort(
          (left, right) => left.failedAt - right.failedAt,
        ),
      ),
    );
  } catch {
    // The bounded in-memory state remains authoritative for this session.
  }
}

async function opaqueFailureId(
  scope: string,
  pubkey: string,
): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  try {
    const bytes = new TextEncoder().encode(keyFor(scope, pubkey));
    const digest = await subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    // Persistence is optional; never fall back to storing the raw scope.
    return null;
  }
}

function emitChange() {
  for (const listener of listeners) listener();
}

function beginMutation(key: string): number | null {
  if (!mutationVersions.has(key) && mutationVersions.size >= MAX_FAILURES * 2) {
    return null;
  }
  const next = ++mutationClock;
  mutationVersions.set(key, next);
  return next;
}

function finishMutation(key: string, version: number) {
  if (mutationVersions.get(key) === version) mutationVersions.delete(key);
}

function markCleared(key: string) {
  clearedKeys.delete(key);
  clearedKeys.set(key, Date.now());
  while (clearedKeys.size > MAX_FAILURES) {
    const oldest = clearedKeys.keys().next().value;
    if (oldest === undefined) break;
    clearedKeys.delete(oldest);
  }
}

function queuePersist(
  scope: string,
  pubkey: string,
  key: string,
  version: number | null,
  kind: AutoRestartFailureKind,
  failure: AutoRestartFailureState,
) {
  if (version === null) return;
  void (async () => {
    try {
      const id = await opaqueFailureId(scope, pubkey);
      if (!id || mutationVersions.get(key) !== version) return;
      storedFailures.set(id, {
        id,
        kind,
        failedAt: failure.failedAt,
        manualRetryAvailable: failure.manualRetryAvailable,
      });
      persistStored();
    } finally {
      finishMutation(key, version);
    }
  })();
}

function writeFailure(
  scope: string,
  pubkey: string,
  kind: AutoRestartFailureKind,
  failure: AutoRestartFailureState,
) {
  hydrateStorage();
  const key = keyFor(scope, pubkey);
  clearedKeys.delete(key);
  const version = beginMutation(key);
  failures.set(key, failure);
  pruneMemory();
  emitChange();
  queuePersist(scope, pubkey, key, version, kind, failure);
}

function ensureFailureHydrated(scope: string, pubkey: string) {
  hydrateStorage();
  const key = keyFor(scope, pubkey);
  if (failures.has(key) || scopeLoads.has(key) || clearedKeys.has(key)) return;
  if (scopeLoads.size >= MAX_FAILURES) return;
  const version = mutationVersions.get(key) ?? 0;
  const load = (async () => {
    const id = await opaqueFailureId(scope, pubkey);
    if (
      !id ||
      (mutationVersions.get(key) ?? 0) !== version ||
      clearedKeys.has(key)
    ) {
      return;
    }
    const stored = storedFailures.get(id);
    if (!stored || failures.has(key)) return;
    failures.set(
      key,
      stateFor(stored.kind, stored.failedAt, stored.manualRetryAvailable),
    );
    pruneMemory();
    emitChange();
  })().finally(() => {
    scopeLoads.delete(key);
  });
  scopeLoads.set(key, load);
}

export function recordAutomaticRestartFailure(scope: string, pubkey: string) {
  writeFailure(
    scope,
    pubkey,
    "automatic",
    stateFor("automatic", Date.now(), true),
  );
}

/**
 * Atomically consumes the single manual retry for an automatic failure.
 * Returning false means the failure was cleared, already retried, or is
 * currently being retried.
 */
export function beginManualRestartRetry(
  scope: string,
  pubkey: string,
): boolean {
  hydrateStorage();
  const key = keyFor(scope, pubkey);
  const current = failures.get(key);
  if (!current?.manualRetryAvailable || current.retrying) return false;

  writeFailure(
    scope,
    pubkey,
    "manual",
    stateFor("manual", current.failedAt, false, true),
  );
  return true;
}

export function recordManualRestartRetryFailure(scope: string, pubkey: string) {
  writeFailure(scope, pubkey, "manual", stateFor("manual", Date.now(), false));
}

export function clearAutoRestartFailure(scope: string, pubkey: string) {
  hydrateStorage();
  const key = keyFor(scope, pubkey);
  if (!failures.has(key) && clearedKeys.has(key)) return;
  markCleared(key);
  const version = beginMutation(key);
  const removed = failures.delete(key);
  if (removed) emitChange();

  if (version === null) return;
  void (async () => {
    try {
      const id = await opaqueFailureId(scope, pubkey);
      if (!id || mutationVersions.get(key) !== version) return;
      if (storedFailures.delete(id)) persistStored();
    } finally {
      finishMutation(key, version);
    }
  })();
}

export function getAutoRestartFailure(
  scope: string | null | undefined,
  pubkey: string | null | undefined,
): AutoRestartFailureState | null {
  if (!scope || !pubkey) return null;
  hydrateStorage();
  return failures.get(keyFor(scope, pubkey)) ?? null;
}

export function useAutoRestartFailure(
  scope: string | null | undefined,
  pubkey: string | null | undefined,
): AutoRestartFailureState | null {
  React.useEffect(() => {
    if (scope && pubkey) ensureFailureHydrated(scope, pubkey);
  }, [pubkey, scope]);

  const subscribe = React.useCallback((listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, []);
  const getSnapshot = React.useCallback(
    () => getAutoRestartFailure(scope, pubkey),
    [pubkey, scope],
  );

  return React.useSyncExternalStore(subscribe, getSnapshot, () => null);
}
