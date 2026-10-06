import { directOwner, operator, owner } from "./tasks.mjs";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hash = /^[0-9a-f]{64}$/;
const usage =
  "사용법: /fmg_document access <작업 ID>\n/fmg_document allow <작업 ID> <전체 제안 해시> <현재 접근 revision> <요청 UUID>\n/fmg_document revoke <작업 ID> <전체 제안 해시> <현재 접근 revision> <요청 UUID>\nHostinger main 제안 작업에만 적용됩니다. 실행 승인·문서 공유가 아닙니다.";

/** Register a direct human command, never an LLM tool or computer broker action. */
export function registerDocumentCommand(api) {
  api.registerCommand({
    name: "fmg_document",
    description: "Hostinger main 작업의 Desktop 문서 접근 조회·허용·철회",
    channels: ["telegram"],
    acceptsArgs: true,
    requireAuth: true,
    async handler(context) {
      let changing = false;
      try {
        const settings =
          context.config.plugins?.entries?.["fmg-supervisor"]?.config ??
          api.pluginConfig;
        directOwner(context, settings);
        const parts = (context.args ?? "").trim().split(/\s+/);
        const action = parts[0];
        let args;
        if (action === "access" && parts.length === 2 && uuid.test(parts[1])) {
          args = { task_id: parts[1] };
        } else if (
          ["allow", "revoke"].includes(action) &&
          parts.length === 5 &&
          uuid.test(parts[1]) &&
          hash.test(parts[2]) &&
          /^(0|[1-9][0-9]{0,9})$/.test(parts[3]) &&
          Number(parts[3]) <= 2147483646 &&
          uuid.test(parts[4])
        ) {
          changing = true;
          args = {
            task_id: parts[1],
            proposal_hash: parts[2],
            expected_revision: Number(parts[3]),
            request_id: parts[4],
            enabled: action === "allow",
          };
        } else return { text: usage };
        const audience = await owner(context.config, settings);
        directOwner(context, settings);
        const result = await operator(
          settings,
          changing ? "documents.owner_set" : "documents.owner_get",
          { ...audience, ...args },
        );
        await owner(context.config, settings, audience);
        directOwner(context, settings);
        if (
          result.task_id !== args.task_id ||
          result.proposal_account !== "gateway_owner_main" ||
          !Number.isSafeInteger(result.revision) ||
          result.revision < 0 ||
          typeof result.enabled !== "boolean" ||
          typeof result.completion_verified !== "boolean" ||
          !hash.test(result.proposal_hash) ||
          Object.entries(audience).some(
            ([key, value]) => result.audience?.[key] !== value,
          ) ||
          (changing &&
            (result.receipt?.request_id !== args.request_id ||
              result.receipt?.task_id !== args.task_id ||
              result.receipt?.proposal_hash !== args.proposal_hash ||
              result.receipt?.enabled !== args.enabled ||
              result.receipt?.revision !== args.expected_revision + 1))
        )
          throw new Error("document_access_response_invalid");
        const receipt = changing
          ? `\n접근 변경 요청: ${result.receipt.request_id}\n요청 처리: ${result.replayed ? "기존 처리 기록 조회" : "새 접근 설정 기록"}\n당시 허용: ${result.receipt.enabled ? "허용" : "철회"} · 당시 접근 revision: ${result.receipt.revision}`
          : "";
        return {
          text: `작업: ${result.task_id}\n제안 계정: Hostinger main\n현재 Desktop 문서 접근: ${result.enabled ? "허용" : "차단"}\n현재 접근 revision: ${result.revision}\n성공 종료 근거: ${result.completion_verified ? "검증됨" : "미확인 · 저장 불가"}\n전체 제안 해시: ${result.proposal_hash}${receipt}\n문서 허용은 모델 실행 승인이나 외부 공유가 아닙니다. 철회해도 서버의 기존 불변 문서와 이미 내려받은 로컬 초안은 삭제하지 않습니다. Desktop에서 접근·성공 종료 다시 확인을 누르세요.`,
        };
      } catch {
        return {
          text: changing
            ? "문서 접근 변경 결과가 확인되지 않았습니다. 같은 명령의 요청 UUID를 보존하세요. /fmg_document access <작업 ID>로 현재 revision을 조회하고, 응답 유실이면 기존 명령 그대로 다시 보내세요. 충돌이면 최신 revision으로 새 요청 UUID를 사용합니다. 소유자 개인 대화와 Buzz 연결도 확인하세요."
            : "문서 접근을 조회하지 못했습니다. 소유자 Telegram 개인 대화, 최신 Buzz 연결과 Hostinger main 제안 작업 ID를 확인하세요.",
        };
      }
    },
  });
}
