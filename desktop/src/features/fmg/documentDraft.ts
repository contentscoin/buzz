import { z } from "zod";
import { getIdentity } from "@/shared/api/tauriIdentity";
import {
  getRelayHttpUrl,
  nip44EncryptToSelf,
  nip44DecryptFromSelf,
} from "@/shared/api/tauri";
import { computerRelayOrigin, type ComputerScope } from "./computerRpc";
import {
  documentHash,
  markdownBytes,
  type SaveDocumentInput,
} from "./documentRpc";

const draftSchema = z.object({
  markdown: z.string(),
  documentId: z.uuid().nullable(),
  baseVersion: z.number().int().min(0).max(20),
  pending: z
    .object({
      taskId: z.uuid(),
      saveRequestId: z.uuid(),
      documentId: z.uuid().nullable(),
      expectedVersion: z.number().int().min(0).max(20),
      markdown: z.string(),
    })
    .nullable(),
});
export type DocumentDraft = z.infer<typeof draftSchema>;
export const emptyDocumentDraft: DocumentDraft = {
  markdown: "",
  documentId: null,
  baseVersion: 0,
  pending: null,
};
type StoredDraft = {
  key: string;
  scope: string;
  revision: number;
  chunks: string[];
  stamp: string;
  dataHash: string;
};

async function assertScope(scope: ComputerScope, signal: AbortSignal) {
  signal.throwIfAborted();
  const [identity, relay] = await Promise.all([
    getIdentity(),
    getRelayHttpUrl(),
  ]);
  signal.throwIfAborted();
  if (
    identity.pubkey !== scope.owner ||
    computerRelayOrigin(relay) !== scope.relay
  )
    throw new Error(
      "계정 또는 커뮤니티가 변경되어 로컬 초안을 처리하지 않았습니다.",
    );
}

function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () =>
      reject(new Error("암호화 초안 저장소에 접근할 수 없습니다."));
  });
}

function finished(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () =>
      reject(
        new Error("암호화 초안을 보관하지 못했습니다. 저장을 다시 시도하세요."),
      );
  });
}

async function database(): Promise<IDBDatabase> {
  const opening = indexedDB.open("fmg-private-document-drafts", 1);
  opening.onupgradeneeded = () => {
    const store = opening.result.createObjectStore("drafts", {
      keyPath: "key",
    });
    store.createIndex("scope", "scope");
  };
  return request(opening);
}

async function keys(scope: ComputerScope, taskId: string) {
  const scopeHash = await documentHash(
    new TextEncoder().encode(JSON.stringify(scope)),
  );
  const key = await documentHash(
    new TextEncoder().encode(`${scopeHash}:${taskId}`),
  );
  return { scopeHash, key };
}

/** Read only self-encrypted chunks; verify the embedded scope after decryption. */
export async function loadDocumentDraft(
  scope: ComputerScope,
  taskId: string,
  signal: AbortSignal,
): Promise<{ draft: DocumentDraft; revision: number } | null> {
  await assertScope(scope, signal);
  const { key, scopeHash } = await keys(scope, taskId);
  const db = await database();
  let row: StoredDraft | undefined;
  try {
    const tx = db.transaction("drafts", "readonly");
    const done = finished(tx);
    [row] = await Promise.all([
      request<StoredDraft | undefined>(tx.objectStore("drafts").get(key)),
      done,
    ]);
  } finally {
    db.close();
  }
  if (!row) return null;
  if (
    row.scope !== scopeHash ||
    !Number.isInteger(row.revision) ||
    row.revision < 1 ||
    typeof row.stamp !== "string" ||
    !z.uuid().safeParse(row.stamp).success ||
    typeof row.dataHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(row.dataHash) ||
    !Array.isArray(row.chunks) ||
    row.chunks.length > 20 ||
    row.chunks.some((part) => typeof part !== "string" || part.length > 90000)
  )
    throw new Error(
      "로컬 초안 기록이 올바르지 않습니다. 기존 기록을 덮어쓰지 않았습니다.",
    );
  let plaintext = "";
  for (const [index, chunk] of row.chunks.entries()) {
    await assertScope(scope, signal);
    const packet = JSON.parse(await nip44DecryptFromSelf(chunk));
    if (
      packet.schema !== 1 ||
      packet.key !== key ||
      packet.scope !== scopeHash ||
      packet.revision !== row.revision ||
      packet.stamp !== row.stamp ||
      packet.dataHash !== row.dataHash ||
      packet.index !== index ||
      packet.total !== row.chunks.length ||
      typeof packet.part !== "string"
    )
      throw new Error("암호화 초안 조각의 출처 또는 순서가 일치하지 않습니다.");
    plaintext += packet.part;
    if (new TextEncoder().encode(plaintext).length > 512000)
      throw new Error("로컬 초안 크기 제한을 초과했습니다.");
  }
  await assertScope(scope, signal);
  if (
    (await documentHash(new TextEncoder().encode(plaintext))) !== row.dataHash
  )
    throw new Error("로컬 초안 무결성 확인에 실패했습니다.");
  const envelope = JSON.parse(plaintext);
  if (
    envelope.schema !== 1 ||
    envelope.taskId !== taskId ||
    envelope.scope?.relay !== scope.relay ||
    envelope.scope?.owner !== scope.owner ||
    envelope.scope?.agent !== scope.agent
  )
    throw new Error("로컬 초안의 연결 범위가 일치하지 않습니다.");
  const parsed = draftSchema.safeParse(envelope.draft);
  if (
    !parsed.success ||
    new TextEncoder().encode(parsed.data.markdown).length > 32768
  )
    throw new Error("로컬 초안 데이터가 올바르지 않습니다.");
  if (parsed.data.pending) {
    if (parsed.data.pending.taskId !== taskId)
      throw new Error("미확인 저장 요청의 작업이 일치하지 않습니다.");
    markdownBytes(parsed.data.pending.markdown);
  }
  return { draft: parsed.data, revision: row.revision };
}

/** Encrypt before one atomic IndexedDB write; stale dialogs cannot overwrite it. */
export async function persistDocumentDraft(
  scope: ComputerScope,
  taskId: string,
  draft: DocumentDraft,
  revision: number,
  signal: AbortSignal,
): Promise<number> {
  await assertScope(scope, signal);
  if (new TextEncoder().encode(draft.markdown).length > 32768)
    throw new Error("로컬 초안도 32KiB 이하여야 합니다.");
  if (draft.pending) {
    markdownBytes(draft.pending.markdown);
    if (draft.pending.taskId !== taskId)
      throw new Error("저장 요청의 작업이 일치하지 않습니다.");
  }
  const envelope = JSON.stringify({ schema: 1, scope, taskId, draft });
  if (new TextEncoder().encode(envelope).length > 512000)
    throw new Error("로컬 초안 보관 한도를 초과했습니다.");
  const chunks: string[] = [];
  let part = "",
    bytes = 0;
  for (const character of envelope) {
    const size = new TextEncoder().encode(character).length;
    if (bytes + size > 24000) {
      chunks.push(part);
      part = "";
      bytes = 0;
    }
    part += character;
    bytes += size;
  }
  if (part) chunks.push(part);
  if (chunks.length > 20)
    throw new Error("로컬 초안 조각 수 한도를 초과했습니다.");
  const { key, scopeHash } = await keys(scope, taskId);
  const stamp = crypto.randomUUID();
  const dataHash = await documentHash(new TextEncoder().encode(envelope));
  const encrypted: string[] = [];
  for (const [index, chunk] of chunks.entries()) {
    await assertScope(scope, signal);
    const packet = JSON.stringify({
      schema: 1,
      key,
      scope: scopeHash,
      revision: revision + 1,
      stamp,
      dataHash,
      index,
      total: chunks.length,
      part: chunk,
    });
    encrypted.push(await nip44EncryptToSelf(packet));
  }
  await assertScope(scope, signal);
  const db = await database();
  try {
    const tx = db.transaction("drafts", "readwrite", { durability: "strict" });
    const done = finished(tx);
    const store = tx.objectStore("drafts");
    const [old, count, total] = await Promise.all([
      request<StoredDraft | undefined>(store.get(key)),
      request(store.index("scope").count(scopeHash)),
      request(store.count()),
    ]);
    if (
      (old?.revision ?? 0) !== revision ||
      (!old && (count >= 20 || total >= 100))
    ) {
      tx.abort();
      await done.catch(() => undefined);
      throw new Error(
        old
          ? "다른 창에서 초안이 변경됐습니다. 현재 내용을 복사한 뒤 다시 여세요."
          : "로컬 초안 보관 한도에 도달했습니다.",
      );
    }
    store.put({
      key,
      scope: scopeHash,
      revision: revision + 1,
      chunks: encrypted,
      stamp,
      dataHash,
    } satisfies StoredDraft);
    await done;
    return revision + 1;
  } finally {
    db.close();
  }
}

/** Remove only a caller-confirmed local copy; never deletes a server document. */
export async function removeConfirmedDocumentDraft(
  scope: ComputerScope,
  taskId: string,
  revision: number,
  signal: AbortSignal,
): Promise<void> {
  await assertScope(scope, signal);
  const { key, scopeHash } = await keys(scope, taskId);
  const db = await database();
  try {
    const tx = db.transaction("drafts", "readwrite", { durability: "strict" });
    const done = finished(tx);
    const store = tx.objectStore("drafts");
    const old = await request<StoredDraft | undefined>(store.get(key));
    if (!old || old.revision !== revision || old.scope !== scopeHash) {
      tx.abort();
      await done.catch(() => undefined);
      throw new Error(
        "로컬 초안이 변경됐습니다. 보관 기록을 정리하지 않았습니다.",
      );
    }
    store.delete(key);
    await done;
  } finally {
    db.close();
  }
}

/** Freeze a save UUID and payload before any network operation. */
export function pendingDocumentSave(
  taskId: string,
  draft: DocumentDraft,
): SaveDocumentInput {
  markdownBytes(draft.markdown);
  return {
    taskId,
    saveRequestId: crypto.randomUUID(),
    documentId: draft.documentId,
    expectedVersion: draft.baseVersion,
    markdown: draft.markdown,
  };
}
