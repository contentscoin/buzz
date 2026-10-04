import { lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { completionEvidence } from "./completion.mjs";
import { publicModel } from "./model-binding.mjs";

const source = "gateway.runtime.no_tools";
const flags = [
  "aborted",
  "externalAbort",
  "timedOut",
  "idleTimedOut",
  "timedOutDuringCompaction",
  "timedOutDuringToolExecution",
  "timedOutByRunBudget",
];
const kinds = [
  "session.started",
  "trace.metadata",
  "model.completed",
  "trace.artifacts",
  "session.ended",
];

/** Recover only a dedicated, single-turn, no-tool OpenAI run from persisted runtime end evidence. */
export function runtimeResult(events, task, clean) {
  if (
    task.run_id !== task.task_id ||
    task.dispatch_stage !== "intent_recorded" ||
    task.proposal.session_key !==
      `agent:${task.proposal.role_id}:fmg-task:${task.task_id}` ||
    events.length !== kinds.length ||
    Buffer.byteLength(JSON.stringify(events)) > 262144
  )
    return null;
  const byKind = new Map(events.map((e) => [e.type, e]));
  if (byKind.size !== kinds.length || kinds.some((k) => !byKind.has(k)))
    return null;
  const start = byKind.get("session.started"),
    end = byKind.get("session.ended");
  if (
    typeof start.sessionId !== "string" ||
    !start.sessionId ||
    events.some(
      (e) =>
        e.traceSchema !== "openclaw-trajectory" ||
        e.schemaVersion !== 1 ||
        e.source !== "runtime" ||
        e.runId !== task.run_id ||
        e.sessionKey !== task.proposal.session_key ||
        e.sessionId !== start.sessionId ||
        e.provider !== "openai" ||
        `${e.provider}/${e.modelId}` !== task.proposal.requested_model ||
        !Number.isFinite(Date.parse(e.ts)) ||
        Date.parse(e.ts) < task.created_at * 1000 - 5000 ||
        Date.parse(e.ts) > Date.now() + 5000 ||
        !Number.isInteger(e.seq),
    ) ||
    start.data?.agentId !== task.proposal.role_id ||
    start.seq >= end.seq ||
    events.some((e) => e.seq < start.seq || e.seq > end.seq)
  )
    return null;
  const metadata = byKind.get("trace.metadata"),
    completed = byKind.get("model.completed"),
    artifacts = byKind.get("trace.artifacts");
  if (
    metadata.data?.model?.thinkLevel !== task.proposal.requested_effort ||
    end.data?.status !== "success" ||
    end.data.stopReason !== "stop" ||
    artifacts.data?.finalStatus !== "success" ||
    artifacts.data.stopReason !== "stop" ||
    completed.data?.stopReason !== "stop" ||
    [end, completed, artifacts].some((e) =>
      flags.some((k) => e.data?.[k] !== false),
    ) ||
    completed.data.promptErrorSource !== null ||
    artifacts.data.promptErrorSource !== null ||
    completed.data.finalPromptText !== task.proposal.instructions ||
    artifacts.data.finalPromptText !== task.proposal.instructions ||
    !Array.isArray(artifacts.data.toolMetas) ||
    artifacts.data.toolMetas.length !== 0 ||
    artifacts.data.didSendViaMessagingTool !== false ||
    artifacts.data.successfulCronAdds !== 0 ||
    [
      "messagingToolSentTexts",
      "messagingToolSentMediaUrls",
      "messagingToolSentTargets",
    ].some((k) => !Array.isArray(artifacts.data[k]) || artifacts.data[k].length)
  )
    return null;
  const messages = completed.data.messagesSnapshot;
  if (
    !Array.isArray(messages) ||
    messages.filter((m) => m.role === "user").length !== 1 ||
    messages.filter((m) => m.role === "assistant").length !== 1 ||
    messages.some((m) => !["user", "assistant", "custom"].includes(m.role))
  )
    return null;
  const last = messages.at(-1);
  if (
    last?.role !== "assistant" ||
    last.stopReason !== "stop" ||
    last.provider !== "openai" ||
    `${last.provider}/${last.model}` !== task.proposal.requested_model ||
    last.errorMessage ||
    !Array.isArray(last.content) ||
    last.content.length !== 1 ||
    last.content[0].type !== "text" ||
    typeof last.content[0].text !== "string" ||
    !last.diagnostics?.some(
      (d) =>
        d.type === "openai_responses_terminal" &&
        d.details?.eventType === "response.completed" &&
        d.details.stopReason === "stop",
    )
  )
    return null;
  let signature;
  try {
    signature = JSON.parse(last.content[0].textSignature);
  } catch {
    return null;
  }
  if (
    signature?.phase !== "final_answer" ||
    typeof signature.id !== "string" ||
    !signature.id
  )
    return null;
  if (
    !Array.isArray(artifacts.data.assistantTexts) ||
    artifacts.data.assistantTexts.length !== 1 ||
    artifacts.data.assistantTexts[0] !== last.content[0].text ||
    !Array.isArray(completed.data.assistantTexts) ||
    completed.data.assistantTexts.length !== 1 ||
    completed.data.assistantTexts[0] !== last.content[0].text
  )
    return null;
  const actual = publicModel(
    `${last.provider}/${last.responseModel ?? last.model}`,
  );
  if (actual === "not_reported") return null;
  const receipt = { runId: task.run_id, events };
  const result = {
    status: "succeeded",
    run_id: task.run_id,
    requested_model: task.proposal.requested_model,
    actual_model: actual,
    reply: clean(last.content[0].text, 10000),
    error_code: null,
  };
  const endedAt = Date.parse(end.ts);
  result.completion_evidence = completionEvidence(
    receipt,
    task,
    result,
    source,
    endedAt,
  );
  return {
    result,
    evidence: {
      source,
      run_id: task.run_id,
      ended_at: endedAt,
      gateway_status: "ok",
      stop_reason: "stop",
      receipt_hash: createHash("sha256")
        .update(JSON.stringify(receipt))
        .digest("hex"),
    },
  };
}

/** Read the agent database without migrations or writes; reject missing or oversized evidence. */
export async function recoverRuntime(task, clean) {
  if (
    !/^fmg-(planner|frontend|backend|qa|release|live-gate)$/.test(
      task.proposal.role_id,
    )
  )
    return null;
  const path = `/data/.openclaw/agents/${task.proposal.role_id}/agent/openclaw-agent.sqlite`;
  let db;
  try {
    const stat = await lstat(path);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid() ||
      (stat.mode & 0o022) !== 0
    )
      return null;
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(path, { readOnly: true, timeout: 1000 });
    const node = db
      .prepare(
        "SELECT current_session_id FROM session_nodes WHERE session_key=?",
      )
      .get(task.proposal.session_key);
    if (!node) return null;
    const bound = db
      .prepare(
        "SELECT count(*) AS count, sum(length(CAST(event_json AS BLOB))) AS bytes, max(length(CAST(event_json AS BLOB))) AS largest FROM trajectory_runtime_events WHERE run_id=? AND session_id=? AND json_extract(event_json,'$.type') IN ('session.started','trace.metadata','model.completed','trace.artifacts','session.ended')",
      )
      .get(task.run_id, node.current_session_id);
    if (bound.count !== 5 || bound.bytes > 262144 || bound.largest > 131072)
      return null;
    const rows = db
      .prepare(
        "SELECT event_json FROM trajectory_runtime_events WHERE run_id=? AND session_id=? AND json_extract(event_json,'$.type') IN ('session.started','trace.metadata','model.completed','trace.artifacts','session.ended') ORDER BY seq LIMIT 5",
      )
      .all(task.run_id, node.current_session_id);
    return runtimeResult(
      rows.map((r) => JSON.parse(r.event_json)),
      task,
      clean,
    );
  } catch {
    return null;
  } finally {
    db?.close();
  }
}
