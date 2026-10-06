import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { managedAgentsQueryKey } from "../hooks";
import {
  clearActiveTurnsForAgentOnStop,
  managedAgentRuntimesQueryKey,
} from "../managedAgentRuntimeHooks";
import type { ManagedAgentCommandScope } from "../lib/managedAgentControlActions";
import { stopAllLocalManagedAgents } from "@/shared/api/tauriManagedAgents";

export function useBulkAgentStop(options: {
  scope: ManagedAgentCommandScope | null;
  clearFeedback: () => void;
  notice: (message: string | null) => void;
  error: (message: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const [pending, setPending] = React.useState(false);
  const running = React.useRef(false);
  const currentScope = React.useRef(options.scope);
  currentScope.current = options.scope;
  async function stopAll() {
    const scope = options.scope;
    if (running.current || !scope) return;
    if (
      !window.confirm(
        "모든 커뮤니티에 연결된 이 기기의 로컬 에이전트를 중지할까요? 앱을 다시 열면 자동 시작 설정에 따라 시작됩니다.",
      )
    )
      return;
    running.current = true;
    setPending(true);
    options.clearFeedback();
    const isCurrent = () =>
      currentScope.current?.expectedRelayUrl === scope.expectedRelayUrl &&
      currentScope.current?.expectedSignerPubkey === scope.expectedSignerPubkey;
    try {
      const result = await stopAllLocalManagedAgents(scope);
      if (!isCurrent()) return;
      for (const pubkey of result.stoppedPubkeys) {
        clearActiveTurnsForAgentOnStop(
          pubkey,
          null,
          scope.expectedSignerPubkey,
        );
      }
      options.notice(
        `이 기기의 로컬 에이전트 ${result.stoppedAgents}개 중지 처리. 남은 실행 연결 ${result.remainingRuntimes}개. 커뮤니티 접속 표시는 별도로 갱신됩니다.`,
      );
      if (result.failures.length || result.remainingRuntimes > 0) {
        options.error(
          `중지하지 못한 연결이 있습니다. ${result.failures
            .slice(0, 4)
            .map((failure) => `${failure.name}: ${failure.error}`)
            .join(" · ")} 전체 중지를 다시 시도하세요.`,
        );
      }
    } catch (cause) {
      if (isCurrent())
        options.error(
          cause instanceof Error
            ? cause.message
            : typeof cause === "string"
              ? cause
              : "전체 중지에 실패했습니다.",
        );
    } finally {
      running.current = false;
      setPending(false);
      void queryClient.invalidateQueries({ queryKey: managedAgentsQueryKey });
      void queryClient.invalidateQueries({
        queryKey: managedAgentRuntimesQueryKey,
      });
      if (isCurrent())
        void queryClient.invalidateQueries({ queryKey: ["presence"] });
    }
  }
  return { stopAll, pending };
}
