import { communityConfig } from "../../fmg-computer/src/community-binding.mjs";
import { directOwner, operator, owner } from "./tasks.mjs";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const id = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const usage =
  "사용법: /fmg_dot access <닷 연결 ID> <커뮤니티 ID>\n/fmg_dot allow|revoke <닷 연결 ID> <커뮤니티 ID> <현재 접근 revision> <요청 UUID>\n기본 BD 동의는 기존 OAuth 연결에서 관리합니다. 추가 커뮤니티 접근은 작업 실행 승인·문서 접근 허용과 별개입니다.";

/** Direct owner consent for one original dot connection, never an LLM grant tool. */
export function registerDotCommunityCommand(api) {
  api.registerCommand({
    name: "fmg_dot",
    channels: ["telegram"],
    acceptsArgs: true,
    requireAuth: true,
    description: "GPT dot 연결별 추가 커뮤니티 접근 조회·허용·철회",
    async handler(context) {
      let changing = false;
      try {
        const settings =
          context.config.plugins?.entries?.["fmg-supervisor"]?.config ??
          api.pluginConfig;
        directOwner(context, settings);
        const parts = (context.args ?? "").trim().split(/\s+/);
        const [action, connection, community] = parts;
        if (!uuid.test(connection) || !id.test(community))
          return { text: usage };
        let args = { connection_id: connection, community_id: community };
        if (action === "access" && parts.length === 3) {
          /* Read only. */
        } else if (
          ["allow", "revoke"].includes(action) &&
          parts.length === 5 &&
          /^(0|[1-9][0-9]{0,9})$/.test(parts[3]) &&
          Number(parts[3]) <= 2147483646 &&
          uuid.test(parts[4])
        ) {
          changing = true;
          args = {
            ...args,
            enabled: action === "allow",
            expected_revision: Number(parts[3]),
            request_id: parts[4],
          };
        } else return { text: usage };
        const audience = await owner(
          communityConfig(context.config, community),
          settings,
        );
        directOwner(context, settings);
        const result = await operator(
          settings,
          changing ? "communities.set" : "communities.get",
          { ...audience, ...args },
        );
        await owner(context.config, settings, audience);
        directOwner(context, settings);
        if (
          result.connection_id !== connection ||
          result.community_id !== community ||
          typeof result.enabled !== "boolean" ||
          !Number.isSafeInteger(result.revision) ||
          result.revision < 0 ||
          Object.entries(audience).some(
            ([key, value]) => result.audience?.[key] !== value,
          ) ||
          (changing &&
            (result.receipt?.request_id !== args.request_id ||
              result.receipt?.connection_id !== connection ||
              result.receipt?.community_id !== community ||
              result.receipt?.enabled !== args.enabled ||
              result.receipt?.revision !== args.expected_revision + 1))
        )
          throw new Error("dot_community_response_invalid");
        return {
          text: `닷 연결: ${connection}\n커뮤니티: ${community}\n현재 접근: ${result.enabled ? "허용" : "차단"}\n현재 접근 revision: ${result.revision}${changing ? `\n요청 처리: ${result.replayed ? "기존 요청 기록 조회" : "새 접근 설정 기록"}\n당시 허용: ${result.receipt.enabled ? "허용" : "철회"} · 당시 revision: ${result.receipt.revision}` : ""}\n추가 커뮤니티 접근은 모델 실행 승인이나 작업별 Desktop 문서 접근 허용이 아닙니다. 철회는 저장된 작업·문서를 삭제하거나 실행 중 작업을 취소하지 않습니다.`,
        };
      } catch {
        return {
          text: changing
            ? "닷 커뮤니티 접근 변경 결과가 확인되지 않았습니다. 같은 요청 UUID를 보존하세요. access 명령으로 현재 revision을 조회하고 응답 유실이면 기존 명령 그대로 다시 보내세요. 충돌이면 최신 revision과 새 요청 UUID를 사용합니다."
            : "닷 커뮤니티 접근을 조회하지 못했습니다. 연결 ID, 등록된 커뮤니티 ID, 소유자 Telegram 개인 대화와 최신 소유권 snapshot을 확인하세요.",
        };
      }
    },
  });
}
