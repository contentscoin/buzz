import type { ManagedAgent } from "@/shared/api/types";
import { Badge } from "@/shared/ui/badge";

/** Current-community local process state, separate from relay presence. */
export function LocalAgentStatusBadge({
  agent,
}: {
  agent: Pick<ManagedAgent, "backend" | "status"> | null | undefined;
}) {
  if (agent?.backend.type !== "local") return null;
  const running = agent.status === "running";
  const stopped = agent.status === "stopped";
  return (
    <Badge
      className="whitespace-normal normal-case"
      title="이 기기의 현재 커뮤니티 실행 상태입니다. 아바타의 점은 커뮤니티 접속 상태입니다."
      variant={running ? "default" : stopped ? "secondary" : "warning"}
    >
      로컬 실행: {running ? "실행 중" : stopped ? "중지됨" : "상태 확인 필요"}
    </Badge>
  );
}
