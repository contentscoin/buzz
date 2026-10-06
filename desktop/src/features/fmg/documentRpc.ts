import { z } from "zod";
import {
  requestComputer,
  ComputerRequestError,
  type ComputerScope,
} from "./computerRpc";

const sha = z.string().regex(/^[0-9a-f]{64}$/);
export const documentMetaSchema = z.object({
  document_id: z.uuid(),
  version: z.number().int().min(1).max(20),
  current_version: z.number().int().min(1).max(20),
  previous_version: z.number().int().min(0).max(19),
  request_id: z.uuid(),
  content_sha256: sha,
  content_bytes: z.number().int().min(1).max(32768),
  saved_at: z.number().finite(),
  source_validation: z.enum(["verified_at_save", "needs_reconcile"]),
  source: z.object({
    task_id: z.uuid(),
    run_id: z.uuid(),
    proposal_hash: sha,
    role_id: z.string().max(100),
    requested_model: z.string().max(200),
    requested_effort: z.string().max(20).nullable(),
    actual_model: z.string().max(200).nullable(),
    response_sha256: sha,
    source_completeness: z.literal("stored_summary"),
    receipt_sha256: sha,
    verified_at: z.number().finite(),
  }),
});
const detailSchema = documentMetaSchema.extend({
  markdown_base64: z.string().max(43692),
});
export type DocumentMeta = z.infer<typeof documentMetaSchema>;
export type DocumentDetail = DocumentMeta & { markdown: string };
export type SaveDocumentInput = {
  taskId: string;
  saveRequestId: string;
  documentId: string | null;
  expectedVersion: number;
  markdown: string;
};

function checked<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new Error("서버 문서 응답 형식이 올바르지 않습니다.");
  return parsed.data;
}

/** Hash exactly the UTF-8 bytes used by the immutable server ledger. */
export async function documentHash(
  bytes: Uint8Array<ArrayBuffer>,
): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (item) => item.toString(16).padStart(2, "0"),
  ).join("");
}

async function decode(
  encoded: string,
  hash: string,
  limit: number,
): Promise<string> {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
    throw new Error("문서 인코딩이 올바르지 않습니다.");
  const bytes = Uint8Array.from(atob(encoded), (item) => item.charCodeAt(0));
  if (
    bytes.length > limit ||
    btoa(String.fromCharCode(...bytes)) !== encoded ||
    (await documentHash(bytes)) !== hash
  )
    throw new Error("문서 무결성 확인에 실패했습니다.");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** Reject unpaired surrogates rather than silently replacing source bytes. */
export function markdownBytes(markdown: string): Uint8Array<ArrayBuffer> {
  const bytes = new TextEncoder().encode(markdown);
  if (
    new TextDecoder().decode(bytes) !== markdown ||
    bytes.length > 32768 ||
    !markdown.trim()
  )
    throw new Error(
      "Markdown은 비어 있지 않은 올바른 UTF-8이어야 하며 32KiB 이하여야 합니다.",
    );
  return bytes;
}

async function detail(value: unknown, taskId: string): Promise<DocumentDetail> {
  const item = checked(detailSchema, value);
  if (
    item.source.task_id !== taskId ||
    item.previous_version !== item.version - 1
  )
    throw new Error("문서가 요청한 작업과 일치하지 않습니다.");
  const markdown = await decode(
    item.markdown_base64,
    item.content_sha256,
    32768,
  );
  if (new TextEncoder().encode(markdown).length !== item.content_bytes)
    throw new Error("문서 크기 검증에 실패했습니다.");
  return { ...item, markdown };
}

export async function saveDocument(
  scope: ComputerScope,
  input: SaveDocumentInput,
  signal: AbortSignal,
) {
  const { markdown, ...target } = input;
  const bytes = markdownBytes(markdown);
  const response = await requestComputer(
    scope,
    "documents.save",
    { ...target, markdownBase64: btoa(String.fromCharCode(...bytes)) },
    signal,
  );
  const saved = await detail(response.result, input.taskId);
  if (saved.request_id !== input.saveRequestId || saved.markdown !== markdown)
    throw new Error(
      "저장 확인 결과가 요청과 일치하지 않습니다. 같은 요청 UUID로 다시 확인하세요.",
    );
  return saved;
}

export async function getDocument(
  scope: ComputerScope,
  taskId: string,
  documentId: string,
  version: number | null,
  signal: AbortSignal,
) {
  const response = await requestComputer(
    scope,
    "documents.get",
    { taskId, documentId, version },
    signal,
  );
  const item = await detail(response.result, taskId);
  if (
    item.document_id !== documentId ||
    (version !== null && item.version !== version)
  )
    throw new Error("조회한 문서 버전이 요청과 일치하지 않습니다.");
  return item;
}

export async function findDocumentRequest(
  scope: ComputerScope,
  taskId: string,
  saveRequestId: string,
  signal: AbortSignal,
) {
  const response = await requestComputer(
    scope,
    "documents.by_request",
    { taskId, saveRequestId },
    signal,
  );
  const item = await detail(response.result, taskId);
  if (item.request_id !== saveRequestId)
    throw new Error("저장 요청 UUID가 일치하지 않습니다.");
  return item;
}

export async function documentVersions(
  scope: ComputerScope,
  taskId: string,
  signal: AbortSignal,
) {
  const response = await requestComputer(
    scope,
    "documents.versions",
    { taskId },
    signal,
  );
  const result = checked(
    z.object({
      versions: z.array(documentMetaSchema).max(20),
      limit: z.literal(20),
    }),
    response.result,
  );
  if (result.versions.some((item) => item.source.task_id !== taskId))
    throw new Error("문서 목록의 작업이 일치하지 않습니다.");
  return result.versions;
}

export async function documentLibrary(
  scope: ComputerScope,
  cursor: string | null,
  signal: AbortSignal,
) {
  const response = await requestComputer(
    scope,
    "documents.list",
    { cursor },
    signal,
  );
  return checked(
    z.object({
      documents: z.array(documentMetaSchema).max(20),
      limit: z.literal(20),
      next_cursor: z.uuid().nullable(),
    }),
    response.result,
  );
}

export async function documentAccess(
  scope: ComputerScope,
  taskId: string,
  signal: AbortSignal,
) {
  const response = await requestComputer(
    scope,
    "documents.access",
    { taskId },
    signal,
  );
  const access = checked(
    z.object({
      task_id: z.uuid(),
      enabled: z.boolean(),
      completion_verified: z.boolean(),
      revision: z.number().int().min(0).max(2147483647).optional(),
      proposal_account: z.literal("gateway_owner_main").optional(),
    }),
    response.result,
  );
  if (access.task_id !== taskId)
    throw new Error("문서 접근 작업이 일치하지 않습니다.");
  return access;
}

export async function documentTaskSource(
  scope: ComputerScope,
  taskId: string,
  signal: AbortSignal,
) {
  const response = await requestComputer(
    scope,
    "documents.task_source",
    { taskId },
    signal,
  );
  const source = checked(
    z.object({
      task_id: z.uuid(),
      run_id: z.uuid(),
      source_base64: z.string().max(56000),
      response_sha256: sha,
      source_completeness: z.literal("stored_summary"),
    }),
    response.result,
  );
  if (source.task_id !== taskId)
    throw new Error("원본 작업이 일치하지 않습니다.");
  return decode(source.source_base64, source.response_sha256, 40000);
}

export async function documentSource(
  scope: ComputerScope,
  item: DocumentMeta,
  signal: AbortSignal,
) {
  const response = await requestComputer(
    scope,
    "documents.source",
    {
      taskId: item.source.task_id,
      documentId: item.document_id,
      version: item.version,
    },
    signal,
  );
  const source = checked(
    documentMetaSchema.extend({ source_base64: z.string().max(56000) }),
    response.result,
  );
  if (
    source.document_id !== item.document_id ||
    source.version !== item.version ||
    source.source.task_id !== item.source.task_id ||
    source.source.response_sha256 !== item.source.response_sha256
  )
    throw new Error("원본 조회 결과가 문서와 일치하지 않습니다.");
  return decode(source.source_base64, source.source.response_sha256, 40000);
}

export function documentError(failure: unknown): string {
  const messages: Record<string, string> = {
    desktop_access_required:
      "이 작업의 원 제안 계정에서 Desktop 문서 접근을 허용해야 합니다. Hostinger main 제안은 소유자 Telegram 문서 접근 명령을 사용하세요.",
    completion_evidence_unavailable:
      "실제 성공 종료 증거를 확인할 수 없어 저장할 수 없습니다.",
    version_conflict:
      "다른 버전이 먼저 저장됐습니다. 최신 버전을 조회해 비교하세요.",
    request_conflict:
      "같은 요청 UUID에 다른 내용이 있습니다. 원래 저장 결과를 확인하세요.",
    content_too_large: "Markdown이 32KiB 한도를 초과했습니다.",
    version_capacity: "문서의 최대 20개 버전에 도달했습니다.",
    storage_capacity: "문서 보관 용량이 가득 찼습니다. 초안은 유지됩니다.",
    request_capacity: "저장 요청 기록 한도에 도달했습니다.",
    document_not_found: "이 요청 UUID의 저장 기록을 아직 찾지 못했습니다.",
    document_unavailable: "현재 연결에서 이 문서에 접근할 수 없습니다.",
    access_denied: "연결 또는 소유권이 변경됐습니다. 다시 연결하세요.",
    integrity_error: "문서 무결성 확인에 실패했습니다. 복구가 필요합니다.",
  };
  return failure instanceof ComputerRequestError
    ? (messages[failure.code] ?? failure.message)
    : failure instanceof Error
      ? failure.message
      : "문서 처리에 실패했습니다.";
}
