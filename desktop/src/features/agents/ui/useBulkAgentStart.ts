import * as React from "react";
import type { ManagedAgent } from "@/shared/api/types";
import {
  isManagedAgentActive,
  type ManagedAgentCommandScope,
  type StartManagedAgentCommand,
  startManagedAgentWithRules,
} from "../lib/managedAgentControlActions";

type Options = {
  agents: readonly ManagedAgent[];
  scope: ManagedAgentCommandScope | null;
  assertPresence: (agent: ManagedAgent) => void;
  start: StartManagedAgentCommand;
  clearFeedback: () => void;
  notice: (message: string | null) => void;
  error: (message: string | null) => void;
};

/** Start existing managed instances with bounded concurrency and pinned owner/tenant scope. */
export function useBulkAgentStart(options: Options) {
  const [pending, setPending] = React.useState(false);
  const [progress, setProgress] = React.useState({ completed: 0, total: 0 });
  const running = React.useRef(false);
  const currentScope = React.useRef(options.scope);
  currentScope.current = options.scope;
  const candidates = options.agents.filter(
    (agent) => !isManagedAgentActive(agent),
  );

  async function startAll() {
    if (running.current) return;
    const scope = options.scope;
    if (!scope) {
      options.error("커뮤니티 연결과 소유자 확인 후 다시 시도하세요.");
      return;
    }
    const capturedScope: ManagedAgentCommandScope = scope;
    const targets = [
      ...new Map(candidates.map((agent) => [agent.pubkey, agent])).values(),
    ];
    if (targets.length === 0) return;
    running.current = true;
    setPending(true);
    setProgress({ completed: 0, total: targets.length });
    options.clearFeedback();
    let cursor = 0,
      completed = 0,
      started = 0;
    const failures: string[] = [];
    const isCurrent = () =>
      currentScope.current?.expectedRelayUrl === scope.expectedRelayUrl &&
      currentScope.current?.expectedSignerPubkey === scope.expectedSignerPubkey;
    try {
      async function worker() {
        while (cursor < targets.length && isCurrent()) {
          const agent = targets[cursor++];
          try {
            options.assertPresence(agent);
            await startManagedAgentWithRules({
              agent,
              scope: capturedScope,
              startManagedAgent: options.start,
            });
            started += 1;
          } catch (cause) {
            failures.push(
              `${agent.name}: ${cause instanceof Error ? cause.message : "시작 실패"}`,
            );
          } finally {
            completed += 1;
            setProgress({ completed, total: targets.length });
          }
        }
      }
      await Promise.all([worker(), worker()]);
      if (!isCurrent()) return;
      options.notice(
        `${started}개 에이전트의 시작 요청이 완료됐습니다. 로컬 에이전트는 앱을 다시 열 때 자동으로 시작됩니다.`,
      );
      if (failures.length) {
        options.error(
          `${failures.length}개 시작 실패. ${failures.slice(0, 4).join(" · ")}${failures.length > 4 ? " · 나머지는 개별 시작으로 확인하세요." : ""}`,
        );
      }
    } finally {
      running.current = false;
      setPending(false);
    }
  }
  return { startAll, pending, progress, count: candidates.length };
}
