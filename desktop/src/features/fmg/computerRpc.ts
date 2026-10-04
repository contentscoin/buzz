import { z } from "zod";
import { relayClient } from "@/shared/api/relayClient";
import {
  buildObserverControlEvent,
  decryptObserverEvent,
} from "@/shared/api/tauriObserver";
import { getIdentity } from "@/shared/api/tauriIdentity";
import { getRelayHttpUrl } from "@/shared/api/tauri";
import { fetchMediaBytes } from "@/shared/api/tauriMedia";

export const computerStateSchema = z.object({
  generation: z.uuid(),
  profile: z.string().max(64),
  running: z.boolean(),
  ready: z.boolean(),
  tabs: z
    .array(
      z.object({
        handle: z.uuid(),
        title: z.string().max(200),
        url: z.string().max(1000),
      }),
    )
    .max(40),
});
export type ComputerState = z.infer<typeof computerStateSchema>;
export type ComputerScope = { relay: string; owner: string; agent: string };
export type ComputerTarget = {
  generation?: string;
  tabHandle?: string;
  taskId?: string;
  documentId?: string | null;
  version?: number | null;
  cursor?: string | null;
  saveRequestId?: string;
  expectedVersion?: number;
  markdownBase64?: string;
};

/** Preserve a bounded server code for document conflict/recovery flows. */
export class ComputerRequestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ComputerRequestError";
  }
}
const responseSchema = z.object({
  schemaVersion: z.literal(1),
  requestId: z.uuid(),
  action: z.string(),
  relay: z.string(),
  generation: z.uuid(),
  checkedAt: z.iso.datetime(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});
const captureSchema = z.object({
  url: z.url(),
  size: z.number().int().min(19).max(2097168),
  cipherSha256: z.string().regex(/^[0-9a-f]{64}$/),
  key: z.string().max(44),
  iv: z.string().max(16),
  aad: z.string().max(1000),
  mime: z.literal("image/jpeg"),
});

/** Canonical relay origin is included in the signed, encrypted request. */
export function computerRelayOrigin(raw: string): string {
  const url = new URL(raw);
  if (url.protocol === "wss:") url.protocol = "https:";
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("지원되지 않는 서버 주소입니다.");
  return url.origin;
}

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
    throw new Error("커뮤니티 또는 계정이 변경되었습니다.");
}

/** A request owns its subscription and cancellation; no cross-community cache. */
export async function requestComputer(
  scope: ComputerScope,
  action: string,
  target: ComputerTarget,
  signal: AbortSignal,
) {
  await assertScope(scope, signal);
  await relayClient.preconnect();
  await assertScope(scope, signal);
  const requestId = crypto.randomUUID();
  let unsubscribe: (() => Promise<void>) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    let resolveResult:
      | ((value: z.infer<typeof responseSchema>) => void)
      | undefined;
    const result = new Promise<z.infer<typeof responseSchema>>(
      (resolve, reject) => {
        resolveResult = resolve;
        abort = () => reject(new DOMException("요청 취소", "AbortError"));
        signal.addEventListener("abort", abort, { once: true });
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "서버가 응답하지 않습니다. FMG Computer 플러그인과 연결을 확인하세요.",
              ),
            ),
          60000,
        );
      },
    );
    void result.catch(() => undefined);
    unsubscribe = await relayClient.subscribeInteractive(
      {
        kinds: [24200],
        authors: [scope.agent],
        "#p": [scope.owner],
        "#frame": ["telemetry"],
        limit: 100,
        since: Math.floor(Date.now() / 1000),
      },
      (event) => {
        if (event.pubkey !== scope.agent || signal.aborted) return;
        void decryptObserverEvent(event)
          .then((raw) => {
            if (
              signal.aborted ||
              typeof raw !== "object" ||
              raw === null ||
              !("kind" in raw) ||
              raw.kind !== "fmg_computer_result" ||
              !("payload" in raw)
            )
              return;
            const parsed = responseSchema.safeParse(raw.payload);
            if (
              parsed.success &&
              parsed.data.requestId === requestId &&
              parsed.data.action === action &&
              parsed.data.relay === scope.relay
            )
              resolveResult?.(parsed.data);
          })
          .catch(() => undefined);
      },
    );
    // Attach the rejection handler before native signing/publishing can yield.
    const send = (async () => {
      const event = await buildObserverControlEvent({
        agentPubkey: scope.agent,
        payload: {
          type: "fmg.computer.request",
          schemaVersion: 1,
          requestId,
          relay: scope.relay,
          expiresAt: new Date(Date.now() + 55000).toISOString(),
          action,
          ...target,
        },
      });
      await assertScope(scope, signal);
      await relayClient.publishEvent(
        event,
        "서버 조회 요청 전송 시간 초과",
        "서버 조회 요청을 보낼 수 없습니다.",
      );
    })();
    const [response] = await Promise.all([result, send]);
    await assertScope(scope, signal);
    if (target.generation && response.generation !== target.generation)
      throw new Error("브라우저가 변경되었습니다. 상태를 새로 고침하세요.");
    if (!response.ok) {
      const errors: Record<string, string> = {
        stale_generation: "브라우저가 변경되었습니다. 상태를 새로 고침하세요.",
        tab_changed: "조회 중 탭이 변경되었습니다. 다시 선택하세요.",
        tab_unavailable: "탭이 닫혔습니다. 상태를 새로 고침하세요.",
        capture_size_limit: "화면 이미지가 2MiB 제한을 초과했습니다.",
        browser_operation_failed: "서버 브라우저 조회에 실패했습니다.",
        tasks_unavailable: "작업 조회 플러그인이 준비되지 않았습니다.",
        task_read_failed:
          "작업을 조회할 수 없습니다. 연결과 작업 소유자를 확인하세요.",
        response_size_limit: "조회 결과가 크기 제한을 초과했습니다.",
        rate_limited: "잠시 후 다시 조회하세요.",
      };
      throw new ComputerRequestError(
        response.error ?? "request_rejected",
        errors[response.error ?? ""] ?? "서버 요청이 거부되었습니다.",
      );
    }
    return response;
  } finally {
    if (unsubscribe) void unsubscribe().catch(() => undefined);
    clearTimeout(timer);
    if (abort) signal.removeEventListener("abort", abort);
  }
}

const decode = (encoded: string) =>
  Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
async function hash(bytes: Uint8Array<ArrayBuffer>) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Verify the encrypted blob and owner/agent/request binding before decoding. */
export async function decryptComputerCapture(
  scope: ComputerScope,
  response: Awaited<ReturnType<typeof requestComputer>>,
  signal: AbortSignal,
): Promise<Blob> {
  const capture = captureSchema.parse(response.result);
  const url = new URL(capture.url);
  if (
    url.origin !== scope.relay ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("화면 파일의 서버 주소가 일치하지 않습니다.");
  const aad = z
    .object({
      schemaVersion: z.literal(1),
      requestId: z.uuid(),
      owner: z.string(),
      agent: z.string(),
      relay: z.string(),
      generation: z.uuid(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .parse(JSON.parse(capture.aad));
  if (
    aad.requestId !== response.requestId ||
    aad.owner !== scope.owner ||
    aad.agent !== scope.agent ||
    aad.relay !== scope.relay ||
    aad.generation !== response.generation
  )
    throw new Error("화면 파일의 소유자 또는 요청이 일치하지 않습니다.");
  await assertScope(scope, signal);
  const bytes = await fetchMediaBytes(capture.url, signal);
  if (
    bytes.length !== capture.size ||
    (await hash(bytes)) !== capture.cipherSha256
  )
    throw new Error("화면 파일 검증에 실패했습니다.");
  const keyBytes = decode(capture.key),
    iv = decode(capture.iv);
  if (keyBytes.length !== 32 || iv.length !== 12)
    throw new Error("화면 암호화 정보가 올바르지 않습니다.");
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, [
    "decrypt",
  ]);
  keyBytes.fill(0);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: new TextEncoder().encode(capture.aad),
        tagLength: 128,
      },
      key,
      bytes,
    ),
  );
  await assertScope(scope, signal);
  if (
    (await hash(plain)) !== aad.sha256 ||
    plain[0] !== 255 ||
    plain[1] !== 216 ||
    plain[2] !== 255
  )
    throw new Error("화면 원본 검증에 실패했습니다.");
  return new Blob([plain], { type: "image/jpeg" });
}
