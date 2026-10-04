import * as React from "react";
import { ClipboardList, RefreshCw } from "lucide-react";
import { useRelayAgentsQuery } from "@/features/agents/hooks";
import { useCommunities } from "@/features/communities/useCommunities";
import { useIdentityQuery } from "@/shared/api/hooks";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import {
  computerRelayOrigin,
  requestComputer,
  type ComputerScope,
} from "../computerRpc";
import {
  taskDetailSchema,
  taskListSchema,
  taskStatusLabel,
  type TaskDetail,
  type TaskSummary,
} from "../taskRpc";
import { FmgDocumentLauncher } from "./FmgDocumentEditor";
import { FmgDocumentLibrary } from "./FmgDocumentLibrary";
import {
  resolveTaskAgentSelection,
  taskAgentGroups,
} from "../taskAgentOptions";

/** Owner-only task observations use Buzz's existing encrypted relay controls. */
export function FmgTasksLauncher() {
  const [open, setOpen] = React.useState(false);
  const [selected, setSelected] = React.useState("");
  const [selectedGroup, setSelectedGroup] = React.useState<string>();
  const { activeCommunity } = useCommunities();
  const identity = useIdentityQuery();
  const agents = useRelayAgentsQuery();
  const owner = identity.data?.pubkey;
  const groups = taskAgentGroups(agents.data ?? [], owner);
  const { group, agent } = resolveTaskAgentSelection(
    groups,
    selectedGroup,
    selected,
  );
  const relayUrl = activeCommunity?.relayUrl;
  const agentPubkey = agent?.pubkey;
  const scope = React.useMemo<ComputerScope | undefined>(() => {
    try {
      if (relayUrl && owner && agentPubkey)
        return {
          relay: computerRelayOrigin(relayUrl),
          owner,
          agent: agentPubkey,
        };
    } catch {
      /* The unavailable connection is displayed below. */
    }
    return undefined;
  }, [relayUrl, owner, agentPubkey]);
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <ClipboardList />
        작업 목록·결과·문서 열기
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>GPT dot · Buzz 작업 목록과 결과</DialogTitle>
            <DialogDescription>
              최근 작업 25건을 조회합니다. GPT dot에서 작업을 제안하고
              텔레그램에서 직접 승인한 뒤, 여기서 상태와 결과를 새로 고침하세요.
            </DialogDescription>
          </DialogHeader>
          <Button
            size="sm"
            variant="outline"
            disabled={agents.isFetching}
            onClick={() => void agents.refetch()}
          >
            <RefreshCw className={agents.isFetching ? "animate-spin" : ""} />
            에이전트 목록 새로 고침
          </Button>
          {agents.isError ? (
            <p role="alert" className="text-sm text-destructive">
              에이전트 목록을 확인하지 못했습니다. 연결을 확인하고 다시
              조회하세요.
            </p>
          ) : null}
          <p className="text-sm text-muted-foreground">
            커뮤니티: {activeCommunity?.name ?? "연결 확인 중"}
          </p>
          <label className="flex items-center gap-3 text-sm">
            소유한 에이전트
            <select
              aria-label="작업 조회 에이전트"
              className="min-w-0 rounded-md border bg-background p-2"
              value={group?.value ?? ""}
              disabled={groups.length === 0}
              onChange={(event) => {
                setSelectedGroup(event.target.value);
                setSelected("");
              }}
            >
              {!group ? (
                <option value="" disabled>
                  에이전트 선택
                </option>
              ) : null}
              {groups.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.name || "이름 없음"}
                </option>
              ))}
            </select>
          </label>
          {group && group.connections.length > 1 ? (
            <div className="space-y-2">
              <label className="flex items-center gap-3 text-sm">
                연결 ({group.connections.length}개)
                <select
                  aria-label="같은 이름의 에이전트 연결"
                  className="min-w-0 rounded-md border bg-background p-2"
                  value={agent?.pubkey ?? ""}
                  onChange={(event) => {
                    setSelectedGroup(group.value);
                    setSelected(event.target.value);
                  }}
                >
                  <option value="" disabled>
                    조회할 연결 선택
                  </option>
                  {group.connections.map((item, index) => (
                    <option key={item.pubkey} value={item.pubkey}>
                      연결 {index + 1} · {item.identifier}
                    </option>
                  ))}
                </select>
              </label>
              <p className="text-sm text-muted-foreground">
                이 이름에 여러 연결이 있습니다. 조회할 연결을 선택하세요.
              </p>
            </div>
          ) : null}
          {agent ? (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">
                선택한 에이전트 식별자
              </summary>
              <p className="break-all pt-2">{agent.pubkey}</p>
            </details>
          ) : null}
          {open && scope ? (
            <TasksViewer
              key={`${activeCommunity?.id}:${scope.relay}:${scope.owner}:${scope.agent}`}
              scope={scope}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              {group && !agent
                ? "작업을 조회하려면 위에서 연결을 선택하세요."
                : "현재 커뮤니티에서 소유한 서버 에이전트를 확인할 수 없습니다."}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function TasksViewer({ scope }: { scope: ComputerScope }) {
  const [tasks, setTasks] = React.useState<TaskSummary[]>();
  const [selected, setSelected] = React.useState("");
  const [detail, setDetail] = React.useState<TaskDetail>();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [checkedAt, setCheckedAt] = React.useState("");
  const lifecycle = React.useRef({
    active: false,
    revision: 0,
    controller: new AbortController(),
  });
  React.useEffect(() => {
    const life = lifecycle.current;
    life.active = true;
    return () => {
      life.active = false;
      life.revision++;
      life.controller.abort();
    };
  }, []);
  async function read(taskId?: string) {
    const life = lifecycle.current;
    if (!life.active) return;
    life.controller.abort();
    life.controller = new AbortController();
    const revision = ++life.revision;
    const current = () =>
      life.active &&
      life.revision === revision &&
      !life.controller.signal.aborted;
    setBusy(true);
    setError("");
    setDetail(undefined);
    setCheckedAt("");
    setSelected(taskId ?? "");
    if (!taskId) setTasks(undefined);
    try {
      const response = await requestComputer(
        scope,
        taskId ? "tasks.get" : "tasks.list",
        taskId ? { taskId } : {},
        life.controller.signal,
      );
      if (!current()) return;
      if (taskId) {
        const value = taskDetailSchema.parse(response.result);
        if (value.task_id !== taskId)
          throw new Error("조회한 작업이 요청과 일치하지 않습니다.");
        setDetail(value);
        setTasks((rows) =>
          rows?.map((row) =>
            row.task_id === value.task_id
              ? {
                  ...row,
                  status: value.status,
                  revision: value.revision,
                  updated_at: value.updated_at,
                }
              : row,
          ),
        );
      } else setTasks(taskListSchema.parse(response.result).tasks);
      setCheckedAt(response.checkedAt);
    } catch (failure) {
      if (current())
        setError(
          failure instanceof Error
            ? failure.message
            : "작업 조회에 실패했습니다.",
        );
    } finally {
      if (current()) setBusy(false);
    }
  }
  return (
    <div className="space-y-4" aria-busy={busy}>
      <div className="flex flex-wrap gap-2">
        <FmgDocumentLibrary scope={scope} />
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void read()}
        >
          <RefreshCw className={busy ? "animate-spin" : ""} />
          목록 새로 고침
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !selected}
          onClick={() => void read(selected)}
        >
          선택한 작업 새로 고침
        </Button>
      </div>
      {busy ? (
        <p role="status" className="text-sm">
          서버 작업을 조회하는 중입니다.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {checkedAt ? (
        <p className="text-xs text-muted-foreground">
          마지막 조회: {new Date(checkedAt).toLocaleString("ko-KR")} · 자동
          갱신되지 않습니다.
        </p>
      ) : null}
      <div className="grid gap-4 md:grid-cols-[18rem_1fr]">
        <nav aria-label="서버 작업 목록" className="space-y-2">
          {tasks?.map((task) => (
            <button
              type="button"
              key={task.task_id}
              disabled={busy}
              aria-pressed={selected === task.task_id}
              onClick={() => void read(task.task_id)}
              className={`w-full rounded-lg border p-3 text-left disabled:opacity-50 ${selected === task.task_id ? "border-primary bg-muted" : "border-border"}`}
            >
              <span className="block text-sm font-medium">
                {task.proposal_hash.slice(0, 8)} · {task.role_id}
              </span>
              <span className="block text-sm">
                {taskStatusLabel[task.status]}
              </span>
              <span className="block break-all text-xs text-muted-foreground">
                {task.requested_model}
              </span>
            </button>
          ))}
          {tasks?.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              등록된 작업이 없습니다. GPT dot의 FMG Buzz Tasks에서 먼저 작업을
              제안하세요.
            </p>
          ) : tasks === undefined && !busy && !error ? (
            <p className="text-sm text-muted-foreground">
              목록 새로 고침으로 서버 작업을 조회하세요.
            </p>
          ) : null}
        </nav>
        <section
          aria-label="선택한 작업의 상세 정보와 결과"
          className="min-w-0 space-y-3 rounded-lg border p-4"
        >
          {detail ? (
            <>
              <TaskResult detail={detail} />
              <FmgDocumentLauncher
                key={detail.task_id}
                scope={scope}
                taskId={detail.task_id}
              />
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              작업을 선택하면 지시문, 모델과 실행 결과를 확인할 수 있습니다.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

function TaskResult({ detail }: { detail: TaskDetail }) {
  const command =
    detail.status === "needs_reconcile"
      ? `/fmg_task reconcile ${detail.task_id} ${detail.proposal_hash}`
      : detail.status === "awaiting_approval"
        ? `/fmg_task approve ${detail.task_id} ${detail.proposal_hash}`
        : "";
  return (
    <>
      <h3 className="text-sm font-semibold">
        {taskStatusLabel[detail.status]}
      </h3>
      <dl className="space-y-1 break-all text-xs">
        <dt>작업 ID</dt>
        <dd>{detail.task_id}</dd>
        <dt>역할 · 요청 모델</dt>
        <dd>
          {detail.proposal.role_id} · {detail.proposal.requested_model}
        </dd>
        <dt>요청 effort</dt>
        <dd>{detail.proposal.requested_effort ?? "이전 작업 · 기록 없음"}</dd>
        <dt>실제 응답 모델</dt>
        <dd>{detail.result?.actual_model ?? "아직 확인되지 않음"}</dd>
        <dt>최종 변경</dt>
        <dd>{new Date(detail.updated_at * 1000).toLocaleString("ko-KR")}</dd>
        {detail.run_id ? (
          <>
            <dt>실행 ID</dt>
            <dd>{detail.run_id}</dd>
          </>
        ) : null}
      </dl>
      <h4 className="text-sm font-medium">작업 지시문</h4>
      <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words text-sm">
        {detail.proposal.instructions}
      </pre>
      {command ? (
        <label className="block space-y-2 text-sm">
          {detail.status === "needs_reconcile"
            ? "결과가 불확실합니다. 다시 실행하기 전에 소유자 텔레그램에서 복구 명령을 보내세요."
            : "지시문·모델·effort를 검토한 뒤 소유자 텔레그램에서 이 명령을 보내 승인하세요."}
          <textarea
            aria-label="소유자 텔레그램 명령"
            readOnly
            value={command}
            rows={3}
            className="w-full rounded-md border bg-muted p-2 font-mono text-xs"
            onFocus={(event) => event.target.select()}
          />
          <span className="block break-all text-xs text-muted-foreground">
            전체 제안 해시: {detail.proposal_hash}
          </span>
        </label>
      ) : null}
      <h4 className="text-sm font-medium">실행 결과</h4>
      {detail.result?.reply ? (
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-sm">
          {detail.result.reply}
        </pre>
      ) : (
        <p className="text-sm text-muted-foreground">
          {detail.status === "succeeded"
            ? "작업은 완료되었지만 텍스트 응답이 없습니다."
            : "완료된 응답이 아직 없습니다. 실행 요청이나 취소 요청은 완료를 의미하지 않습니다."}
        </p>
      )}
      {detail.result?.reply_truncated ? (
        <p className="text-xs text-muted-foreground">
          화면의 응답은 최대 30KB까지 표시됩니다. 전체 결과는 GPT dot의 작업
          조회 도구에서 확인하세요.
        </p>
      ) : null}
      {detail.result?.error_code ? (
        <p className="break-all text-sm">오류: {detail.result.error_code}</p>
      ) : null}
      {detail.recovery_history.length ? (
        <details>
          <summary className="cursor-pointer text-sm">
            최근 복구 기록 {detail.recovery_history.length}건
          </summary>
          <ul className="space-y-1 pt-2 text-xs">
            {detail.recovery_history.map((entry) => (
              <li key={entry.revision}>
                {new Date(entry.recorded_at * 1000).toLocaleString("ko-KR")} ·{" "}
                {taskStatusLabel[entry.previous_status]}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}
