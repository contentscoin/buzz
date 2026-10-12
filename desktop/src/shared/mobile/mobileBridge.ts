import { relayClient } from "@/shared/api/relayClient";
import {
  buildObserverControlEvent,
  decryptObserverEvent,
} from "@/shared/api/tauriObserver";
import { getIdentity } from "@/shared/api/tauriIdentity";
import { updateMobileBridgeStatus } from "./mobileBridgeStatus";
import {
  nip44EncryptToSelf,
  nip44DecryptFromSelf,
  signRelayEvent,
  getRelayHttpUrl,
} from "@/shared/api/tauri";

export type MobileScope = {
  owner: string;
  relay: string;
  assertActive: () => Promise<void>;
};
export type MobileHandler = (
  action: string,
  input: Record<string, unknown>,
  scope: MobileScope,
) => Promise<unknown>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const origin = (url: string) =>
  new URL(url.replace(/^wss:/, "https:").replace(/^ws:/, "http:")).origin;
type Receipt = {
  hash: string;
  status: "running" | "done" | "reviewed";
  at: number;
  result?: unknown;
  error?: string;
};
type Journal = {
  version: 1;
  deviceId: string;
  entries: Record<string, Receipt>;
};

/** Owner-key authenticated NIP-78 app data. No native command names or credentials cross this boundary. */
export async function startMobileBridge(
  owner: string,
  relayUrl: string,
  handler: MobileHandler,
  signal?: AbortSignal,
  statusGeneration?: string,
): Promise<() => void> {
  if (origin(relayUrl) !== "https://fmg.communities.buzz.xyz") return () => {};
  if (!navigator.locks) throw new Error("coordination_unavailable");
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let resolveReady!: (cleanup: () => void) => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<() => void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void navigator.locks
    .request(
      `fmg.mobile.bridge:${origin(relayUrl)}:${owner}`,
      // Wait for an earlier mount to finish retiring. A non-blocking lease can
      // silently abandon this mount while the old async initializer still owns it.
      { ...(signal ? { signal } : {}) },
      async (lock) => {
        if (!lock) {
          resolveReady(() => {});
          return;
        }
        try {
          const stop = await startBridgeInternal(
            owner,
            relayUrl,
            handler,
            signal,
            statusGeneration,
          );
          const cleanup = () => {
            stop();
            release();
          };
          signal?.addEventListener("abort", cleanup, { once: true });
          try {
            if (signal?.aborted) cleanup();
            resolveReady(cleanup);
            await held;
          } finally {
            signal?.removeEventListener("abort", cleanup);
          }
        } catch (error) {
          rejectReady(error);
        }
      },
    )
    .catch(rejectReady);
  return ready;
}

async function startBridgeInternal(
  owner: string,
  relayUrl: string,
  handler: MobileHandler,
  signal?: AbortSignal,
  statusGeneration?: string,
) {
  const relay = origin(relayUrl);
  if (relay !== "https://fmg.communities.buzz.xyz") return () => {};
  const storageKey = `fmg.mobile.controls.v1:${relay}:${owner}`;
  let stopped = false;
  const diagnose = (
    patch: Parameters<typeof updateMobileBridgeStatus>[1],
    count?: "received" | "responded",
  ) => {
    if (!stopped && !signal?.aborted && statusGeneration)
      updateMobileBridgeStatus(statusGeneration, patch, count);
  };
  const scope: MobileScope = {
    owner,
    relay,
    assertActive: async () => {
      const [identity, nativeRelay] = await Promise.all([
        getIdentity(),
        getRelayHttpUrl(),
      ]);
      if (
        stopped ||
        signal?.aborted ||
        identity.pubkey !== owner ||
        origin(nativeRelay) !== relay
      )
        throw new Error("scope_changed");
    },
  };
  let journal: Journal;
  const stored = localStorage.getItem(storageKey);
  if (stored) {
    if (stored.length > 4_000_000) throw new Error("journal_invalid");
    let plaintext: string;
    if (stored.startsWith("{")) {
      const envelope = JSON.parse(stored) as {
        version: number;
        chunks: string[];
      };
      if (
        envelope.version !== 2 ||
        !Array.isArray(envelope.chunks) ||
        !envelope.chunks.length ||
        envelope.chunks.length > 260 ||
        envelope.chunks.some(
          (chunk) => typeof chunk !== "string" || chunk.length > 100_000,
        )
      )
        throw new Error("journal_invalid");
      let generation: string | undefined;
      const parts: string[] = [];
      for (const [index, chunk] of envelope.chunks.entries()) {
        const part = JSON.parse(await nip44DecryptFromSelf(chunk)) as {
          generation: string;
          index: number;
          total: number;
          data: string;
        };
        generation ??= part.generation;
        if (
          !uuid.test(part.generation) ||
          part.generation !== generation ||
          part.index !== index ||
          part.total !== envelope.chunks.length ||
          typeof part.data !== "string" ||
          part.data.length > 8000
        )
          throw new Error("journal_invalid");
        parts.push(part.data);
      }
      plaintext = parts.join("");
    } else {
      // Migration from the original single-frame journal.
      plaintext = await nip44DecryptFromSelf(stored);
    }
    if (new TextEncoder().encode(plaintext).length > 2_000_000)
      throw new Error("journal_invalid");
    journal = JSON.parse(plaintext) as Journal;
    if (
      journal.version !== 1 ||
      !uuid.test(journal.deviceId) ||
      !journal.entries
    )
      throw new Error("journal_invalid");
  } else {
    journal = { version: 1, deviceId: crypto.randomUUID(), entries: {} };
  }
  const save = async () => {
    await scope.assertActive();
    for (const [id, receipt] of Object.entries(journal.entries)) {
      if (receipt.status === "done" && Date.now() - receipt.at > 7 * 86400_000)
        delete journal.entries[id];
    }
    const text = JSON.stringify(journal);
    if (new TextEncoder().encode(text).length > 2_000_000)
      throw new Error("journal_full");
    // NIP-44 has a 65,535-byte plaintext ceiling; journal entries must not share
    // one oversized frame. Split without breaking UTF-16 surrogate pairs.
    const parts: string[] = [];
    for (let start = 0; start < text.length; ) {
      let end = Math.min(start + 8000, text.length);
      const last = text.charCodeAt(end - 1);
      if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
      parts.push(text.slice(start, end));
      start = end;
    }
    const generation = crypto.randomUUID();
    const chunks = await Promise.all(
      parts.map((data, index) =>
        nip44EncryptToSelf(
          JSON.stringify({ generation, index, total: parts.length, data }),
        ),
      ),
    );
    await scope.assertActive();
    // One atomic localStorage replacement; each encrypted chunk authenticates
    // its generation, index and total, detecting swaps and incomplete writes.
    localStorage.setItem(storageKey, JSON.stringify({ version: 2, chunks }));
  };
  // Do not expire unresolved writes. Completed outcomes survive response loss/restart for seven days.
  for (const [id, receipt] of Object.entries(journal.entries)) {
    if (receipt.status === "done" && Date.now() - receipt.at > 7 * 86400_000)
      delete journal.entries[id];
  }
  await save();
  let queue = Promise.resolve();
  let queued = 0;
  const reply = async (
    request: Record<string, unknown>,
    result: unknown,
    error?: string,
  ) => {
    await scope.assertActive();
    const payload = {
      kind: "fmg_mobile_desktop_result",
      payload: {
        schemaVersion: 1,
        requestId: request.requestId,
        action: request.action,
        relay,
        generation: journal.deviceId,
        checkedAt: new Date().toISOString(),
        ok: !error,
        // A failed handler may still hold an oversized partial result. Never
        // encrypt it into an error reply and lose the error itself to NIP-44's cap.
        result: error ? {} : (result ?? {}),
        ...(error ? { error } : {}),
      },
    };
    if (new TextEncoder().encode(JSON.stringify(payload)).length > 60_000) {
      payload.payload.ok = false;
      payload.payload.result = {};
      payload.payload.error = "response_too_large";
    }
    const encrypted = await buildObserverControlEvent({
      agentPubkey: owner,
      payload,
    });
    const event = await signRelayEvent({
      kind: 30078,
      content: encrypted.content,
      // nostr EventBuilder otherwise removes p tags equal to the signer. Both
      // paired devices intentionally use the owner key and require this tag.
      allowSelfTagging: true,
      tags: [
        ["d", `fmg.mobile:${String(request.requestId)}:result`],
        ["t", "fmg-mobile-control"],
        ["p", owner],
        ["agent", owner],
        ["frame", "telemetry"],
      ],
    });
    const recipients = event.tags.filter((tag) => tag[0] === "p");
    if (
      event.pubkey !== owner ||
      recipients.length !== 1 ||
      recipients[0][1] !== owner
    )
      throw new Error("response_recipient_invalid");
    await scope.assertActive();
    await relayClient.publishEvent(
      event,
      "Mobile response timed out.",
      "Mobile response rejected.",
    );
    diagnose({ lastError: payload.payload.error }, "responded");
  };
  let subscriptionClosed = false;
  const unsubscribe = await relayClient.subscribeInteractive(
    {
      kinds: [30078],
      authors: [owner],
      "#p": [owner],
      "#t": ["fmg-mobile-control"],
      "#frame": ["control"],
      since: Math.floor(Date.now() / 1000) - 1,
      limit: 30,
    },
    (event) => {
      if (
        stopped ||
        queued >= 8 ||
        event.pubkey !== owner ||
        event.content.length > 100_000
      )
        return;
      const hasTag = (key: string, value: string) => {
        const tags = event.tags.filter((tag) => tag[0] === key);
        return tags.length === 1 && tags[0][1] === value;
      };
      if (
        event.kind !== 30078 ||
        !hasTag("t", "fmg-mobile-control") ||
        !hasTag("p", owner) ||
        !hasTag("agent", owner) ||
        !hasTag("frame", "control")
      )
        return;
      queued++;
      queue = queue
        .then(async () => {
          const raw = await decryptObserverEvent(event); // Native verifies signature AND event ID.
          if (!raw || typeof raw !== "object") return;
          const request = raw as Record<string, unknown>;
          if (
            request.type !== "fmg.mobile.desktop.request" ||
            request.schemaVersion !== 1 ||
            request.relay !== relay ||
            typeof request.requestId !== "string" ||
            !uuid.test(request.requestId) ||
            typeof request.action !== "string" ||
            typeof request.expiresAt !== "string"
          )
            return;
          const remaining = Date.parse(request.expiresAt) - Date.now();
          if (!hasTag("d", `fmg.mobile:${request.requestId}:request`)) return;
          if (
            !Number.isFinite(remaining) ||
            remaining <= 0 ||
            remaining > 60_000
          )
            return;
          if (
            (request.action !== "desktop.discover" ||
              request.deviceId !== undefined) &&
            request.deviceId !== journal.deviceId
          )
            return;
          await scope.assertActive();
          diagnose(
            { lastAction: request.action, lastError: undefined },
            "received",
          );
          if (request.action === "desktop.discover") {
            await reply(request, {
              deviceId: journal.deviceId,
              label: "Buzz Desktop",
              protocol: 1,
            });
            return;
          }
          if (request.action === "operations.get") {
            const receipt = journal.entries[String(request.operationId)];
            await reply(request, {
              status: receipt?.status ?? "not_found",
              result: receipt?.result ?? null,
              error: receipt?.error ?? null,
              ...(receipt?.status === "running"
                ? { requiresReview: true }
                : {}),
            });
            return;
          }
          const input = request.input;
          if (request.action === "operations.review") {
            const operationId = String(request.operationId);
            let receipt = journal.entries[operationId];
            if (
              !uuid.test(operationId) ||
              request.confirmation !== operationId ||
              (receipt && !["running", "reviewed"].includes(receipt.status))
            ) {
              await reply(request, {}, "review_not_allowed");
              return;
            }
            if (!receipt) {
              if (Object.keys(journal.entries).length >= 200) {
                await reply(request, {}, "journal_full");
                return;
              }
              receipt = {
                hash: "0".repeat(64),
                status: "running",
                at: Date.now(),
              };
              journal.entries[operationId] = receipt;
            }
            // A direct owner click acknowledges uncertainty without inventing a successful execution.
            receipt.status = "reviewed";
            receipt.error = "reviewed_uncertain";
            await save();
            await reply(request, { status: "reviewed", completed: false });
            return;
          }
          if (!input || typeof input !== "object" || Array.isArray(input)) {
            await reply(request, {}, "invalid_request");
            return;
          }
          const bytes = new TextEncoder().encode(
            JSON.stringify({
              action: request.action,
              input,
              deviceId: request.deviceId,
            }),
          );
          const hash = [
            ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
          ]
            .map((v) => v.toString(16).padStart(2, "0"))
            .join("");
          const previous = journal.entries[request.requestId];
          if (previous) {
            await reply(
              request,
              previous.result,
              previous.hash !== hash
                ? "request_conflict"
                : previous.status !== "done"
                  ? "needs_reconcile"
                  : previous.error,
            );
            return;
          }
          const mutation = !/\.(list|get|catalog|models|snapshot|file)$/.test(
            request.action,
          );
          if (mutation) {
            const issuedAt =
              typeof request.operationCreatedAt === "string"
                ? Date.parse(request.operationCreatedAt)
                : NaN;
            if (
              !Number.isFinite(issuedAt) ||
              issuedAt > Date.now() + 5000 ||
              Date.now() - issuedAt > 7 * 86400_000
            ) {
              await reply(request, {}, "request_expired");
              return;
            }
            if (Object.keys(journal.entries).length >= 200) {
              await reply(request, {}, "journal_full");
              return;
            }
            journal.entries[request.requestId] = {
              hash,
              status: "running",
              at: Date.now(),
            };
            try {
              await save();
            } catch {
              delete journal.entries[request.requestId];
              await reply(request, {}, "journal_unavailable");
              return;
            }
          }
          let result: unknown, error: string | undefined;
          try {
            result = await handler(
              request.action,
              input as Record<string, unknown>,
              scope,
            );
            if (
              new TextEncoder().encode(JSON.stringify(result)).length > 50_000
            )
              throw new Error("response_too_large");
          } catch (reason) {
            // Only bounded domain codes leave the desktop; native errors may include private paths/credentials.
            const message =
              reason instanceof Error
                ? reason.message
                : typeof reason === "string"
                  ? reason
                  : "";
            error = /^[a-z_]{1,64}$/.test(message)
              ? message
              : "operation_failed";
          }
          if (mutation) {
            const uncertain =
              error === "operation_failed" ||
              error === "response_too_large" ||
              error === "needs_reconcile";
            journal.entries[request.requestId] = {
              hash,
              status: uncertain ? "running" : "done",
              at: Date.now(),
              result,
              error,
            };
            try {
              await save();
            } catch {
              await reply(request, {}, "needs_reconcile");
              return;
            }
            if (uncertain) error = "needs_reconcile";
          }
          await reply(request, result, error);
        })
        .catch(() => {
          diagnose({ lastError: "request_or_response_failed" });
          /* Fail closed; keep durable running receipt on uncertain completion. */
        })
        .finally(() => {
          queued--;
        });
    },
    (readiness) => {
      subscriptionClosed = readiness === "closed";
    },
    signal,
  );
  if (signal?.aborted || subscriptionClosed) {
    stopped = true;
    unsubscribe();
    throw new Error(signal?.aborted ? "scope_changed" : "subscription_closed");
  }
  diagnose({ phase: "ready" });
  return () => {
    stopped = true;
    unsubscribe();
  };
}
