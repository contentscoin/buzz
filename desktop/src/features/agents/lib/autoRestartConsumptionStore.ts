const STORAGE_KEY = "buzz:auto-restart-consumptions:v1";
const MAX_CONSUMPTIONS = 256;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

type StoredConsumption = Readonly<{
  /** SHA-256 of tenant + signer + agent. */
  id: string;
  /** SHA-256 of tenant + signer, used to prune removed agents in that scope. */
  scopeId: string;
  generation: string;
  consumedAt: number;
}>;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export type ConsumeAutoRestartResult =
  | "consumed"
  | "already-consumed"
  | "unavailable";

async function sha256(value: string): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  try {
    const digest = await subtle.digest(
      "SHA-256",
      new TextEncoder().encode(value),
    );
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return null;
  }
}

function normalize(value: string) {
  return value.trim().toLowerCase();
}

/**
 * Durable one-shot journal for automatic restart edges.
 *
 * The journal is written before stop/start begins. A renderer crash therefore
 * cannot turn one drift edge into a second automatic attempt after launch.
 * Records are opaque at rest and bounded; visiting a scope also prunes agents
 * that no longer exist in that tenant + signer scope.
 */
export class AutoRestartConsumptionStore {
  private readonly entries = new Map<string, StoredConsumption>();
  private readonly storageProvider: () => StorageLike | null;
  private readonly digest: (value: string) => Promise<string | null>;
  private hydrated = false;

  constructor(
    storageProvider: () => StorageLike | null = () =>
      typeof window === "undefined" ? null : window.localStorage,
    digest: (value: string) => Promise<string | null> = sha256,
  ) {
    this.storageProvider = storageProvider;
    this.digest = digest;
  }

  private storage() {
    try {
      return this.storageProvider();
    } catch {
      return null;
    }
  }

  private hydrate() {
    if (this.hydrated) return;
    this.hydrated = true;
    const storage = this.storage();
    if (!storage) return;

    try {
      const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? "[]");
      if (!Array.isArray(parsed)) return;
      for (const entry of parsed.slice(-MAX_CONSUMPTIONS)) {
        if (!entry || typeof entry !== "object") continue;
        const candidate = entry as Record<string, unknown>;
        if (
          typeof candidate.id !== "string" ||
          !HASH_PATTERN.test(candidate.id) ||
          typeof candidate.scopeId !== "string" ||
          !HASH_PATTERN.test(candidate.scopeId) ||
          typeof candidate.generation !== "string" ||
          candidate.generation.length === 0 ||
          typeof candidate.consumedAt !== "number"
        ) {
          continue;
        }
        this.entries.set(candidate.id, {
          id: candidate.id,
          scopeId: candidate.scopeId,
          generation: candidate.generation,
          consumedAt: candidate.consumedAt,
        });
      }
      this.pruneToBound();
    } catch {
      // Optional UI state: a later successful write replaces corrupt data.
    }
  }

  private pruneToBound() {
    if (this.entries.size <= MAX_CONSUMPTIONS) return;
    const oldest = [...this.entries.values()].sort(
      (left, right) => left.consumedAt - right.consumedAt,
    );
    for (const entry of oldest.slice(0, this.entries.size - MAX_CONSUMPTIONS)) {
      this.entries.delete(entry.id);
    }
  }

  private persist() {
    const storage = this.storage();
    if (!storage) return false;
    try {
      this.pruneToBound();
      storage.setItem(
        STORAGE_KEY,
        JSON.stringify(
          [...this.entries.values()].sort(
            (left, right) => left.consumedAt - right.consumedAt,
          ),
        ),
      );
      return true;
    } catch {
      return false;
    }
  }

  private async identifiers(scope: string, pubkey: string) {
    const normalizedScope = normalize(scope);
    const normalizedPubkey = normalize(pubkey);
    const [scopeId, id] = await Promise.all([
      this.digest(normalizedScope),
      this.digest(`${normalizedScope}\n${normalizedPubkey}`),
    ]);
    return scopeId && id ? { scopeId, id } : null;
  }

  async generation(scope: string, pubkey: string): Promise<string | null> {
    this.hydrate();
    const identifiers = await this.identifiers(scope, pubkey);
    if (!identifiers) return null;
    return this.entries.get(identifiers.id)?.generation ?? null;
  }

  async consume(
    scope: string,
    pubkey: string,
    generation: string,
  ): Promise<ConsumeAutoRestartResult> {
    this.hydrate();
    const identifiers = await this.identifiers(scope, pubkey);
    if (!identifiers) return "unavailable";
    const previous = this.entries.get(identifiers.id);
    if (previous?.generation === generation) return "already-consumed";

    const snapshot = new Map(this.entries);
    this.entries.set(identifiers.id, {
      ...identifiers,
      generation,
      consumedAt: Date.now(),
    });
    if (this.persist()) return "consumed";

    this.entries.clear();
    for (const [id, entry] of snapshot) this.entries.set(id, entry);
    return "unavailable";
  }

  async clear(scope: string, pubkey: string): Promise<boolean> {
    this.hydrate();
    const identifiers = await this.identifiers(scope, pubkey);
    if (!identifiers) return false;
    const previous = this.entries.get(identifiers.id);
    if (!previous) return true;

    this.entries.delete(identifiers.id);
    if (this.persist()) return true;
    this.entries.set(previous.id, previous);
    return false;
  }

  async pruneScope(scope: string, activePubkeys: readonly string[]) {
    this.hydrate();
    const normalizedScope = normalize(scope);
    const scopeId = await this.digest(normalizedScope);
    if (!scopeId) return;
    const hashedActiveIds = await Promise.all(
      activePubkeys.map((pubkey) =>
        this.digest(`${normalizedScope}\n${normalize(pubkey)}`),
      ),
    );
    // A partial hash result cannot distinguish an actually removed agent from
    // a transient crypto failure. Fail closed rather than deleting its guard.
    if (hashedActiveIds.some((id) => id === null)) return;
    const activeIds = new Set(hashedActiveIds as string[]);
    const removed: StoredConsumption[] = [];
    for (const entry of this.entries.values()) {
      if (entry.scopeId === scopeId && !activeIds.has(entry.id)) {
        removed.push(entry);
        this.entries.delete(entry.id);
      }
    }
    if (removed.length === 0 || this.persist()) return;
    for (const entry of removed) this.entries.set(entry.id, entry);
  }
}

const autoRestartConsumptionStore = new AutoRestartConsumptionStore();

export const getConsumedAutoRestartGeneration = (
  scope: string,
  pubkey: string,
) => autoRestartConsumptionStore.generation(scope, pubkey);

export const consumeAutoRestartGeneration = (
  scope: string,
  pubkey: string,
  generation: string,
) => autoRestartConsumptionStore.consume(scope, pubkey, generation);

export const clearConsumedAutoRestartGeneration = (
  scope: string,
  pubkey: string,
) => autoRestartConsumptionStore.clear(scope, pubkey);

export const pruneAutoRestartConsumptionScope = (
  scope: string,
  activePubkeys: readonly string[],
) => autoRestartConsumptionStore.pruneScope(scope, activePubkeys);
