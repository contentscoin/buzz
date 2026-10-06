import { taskStatusLabel, type TaskDetail, type TaskSummary } from "./taskRpc";

export type TaskStatusFilter = "all" | TaskSummary["status"];

/** Filter only the bounded, already-authorized recent task observations. */
export function filterTasks(
  tasks: readonly TaskSummary[],
  search: string,
  status: TaskStatusFilter,
): TaskSummary[] {
  const query = search.trim().toLowerCase();
  return tasks.filter(
    (task) =>
      (status === "all" || task.status === status) &&
      (!query ||
        [
          task.task_id,
          task.proposal_hash,
          task.role_id,
          task.requested_model,
          task.requested_effort ?? "",
          taskStatusLabel[task.status],
        ]
          .join("\n")
          .toLowerCase()
          .includes(query)),
  );
}

/** Commands are copied for the direct owner to review and send in Telegram. */
export function taskOwnerCommands(detail: TaskDetail) {
  const suffix = `${detail.task_id} ${detail.proposal_hash}`;
  const commands: { label: string; text: string }[] = [];
  if (detail.status === "awaiting_approval")
    commands.push({ label: "승인 명령", text: `/fmg_task approve ${suffix}` });
  if (["awaiting_approval", "approved", "dispatching"].includes(detail.status))
    commands.push({ label: "취소 명령", text: `/fmg_task cancel ${suffix}` });
  if (detail.status === "needs_reconcile")
    commands.push({
      label: "복구 명령",
      text: `/fmg_task reconcile ${suffix}`,
    });
  return commands;
}

function excerpt(value: string, limit: number) {
  let output = "",
    count = 0;
  for (const character of value) {
    if (count++ === limit) return { text: output, truncated: true };
    output += character;
  }
  return { text: output, truncated: false };
}

/** A bounded observation preview for manual mobile sharing; never a receipt. */
export function taskMobileSummary(
  detail: TaskDetail,
  relay: string,
  checkedAt: string,
) {
  const project = detail.proposal.project;
  const preview = excerpt(detail.result?.reply ?? "", 500);
  const lines = [
    "Buzz 작업 조회 요약",
    `커뮤니티: ${relay}`,
    `조회 시각: ${checkedAt || "기록 없음"}`,
    `작업: ${detail.task_id} · 변경 번호 ${detail.revision}`,
    `제안 해시: ${detail.proposal_hash}`,
    `상태: ${taskStatusLabel[detail.status]}`,
    `역할: ${detail.proposal.role_id}`,
    `요청 모델: ${detail.proposal.requested_model}`,
    `요청 effort: ${detail.proposal.requested_effort ?? "기록 없음"}`,
    `기록된 응답 모델: ${detail.result?.actual_model ?? "미확인"}`,
  ];
  if (project)
    lines.push(
      `저장소: ${project.repository_url}`,
      `브랜치: ${project.branch}`,
      `기준 commit: ${project.source_commit}`,
    );
  else lines.push("저장소 연결: 이 제안에 기록 없음");
  if (detail.run_id) lines.push(`실행: ${detail.run_id}`);
  if (detail.status === "needs_reconcile")
    lines.push(
      "결과 미확정: 재실행 전에 소유자 Telegram에서 복구가 필요합니다.",
    );
  if (detail.status === "cancel_requested")
    lines.push("취소 요청 상태입니다. 실행 종료는 아직 확인되지 않았습니다.");
  if (detail.result?.error_code)
    lines.push(`오류: ${detail.result.error_code}`);
  if (preview.text) lines.push("", "서버 기록의 응답 미리보기:", preview.text);
  if (preview.truncated || detail.result?.reply_truncated)
    lines.push("[응답 일부만 포함됨 · 전체 결과는 작업 상세에서 확인]");
  lines.push(
    "",
    "이 요약은 조회 시점의 상태입니다. 자동 갱신되거나 게시되지 않습니다.",
  );
  return lines.join("\n");
}
