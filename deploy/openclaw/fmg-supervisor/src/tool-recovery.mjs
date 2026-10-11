import { lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import * as zlib from "node:zlib";
import { completionEvidence } from "./completion.mjs";
import { publicModel } from "./model-binding.mjs";

const source = "gateway.runtime.read_exec";
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const limit = 262144;
const flags = ["aborted", "externalAbort", "timedOut", "idleTimedOut",
  "timedOutDuringCompaction", "timedOutDuringToolExecution", "timedOutByRunBudget"];
const core = ["session.started", "trace.metadata", "model.completed", "trace.artifacts", "session.ended"];
const allowed = new Set([...core, "context.compiled", "prompt.submitted",
  "provider.prompt.observed", "tool.call", "tool.result"]);

/** Validate a bounded dedicated turn, its closed tools and its persisted final response. */
export function toolRuntimeResult(events, transcript, entry, task, clean) {
  if (task.run_id !== task.task_id || task.dispatch_stage !== "intent_recorded" ||
      task.proposal.session_key !== `agent:${task.proposal.role_id}:fmg-task:${task.task_id}` ||
      !Array.isArray(events) || events.length > 64 || !Array.isArray(transcript) ||
      transcript.length > 64 || Buffer.byteLength(JSON.stringify(events)) > limit ||
      Buffer.byteLength(JSON.stringify(transcript)) > limit || entry?.status !== "done" ||
      entry.lastRunId !== task.run_id || entry.abortedLastRun !== false ||
      !Number.isFinite(entry.endedAt)) return null;
  const byKind = new Map(core.map((kind) => [kind, events.filter((e) => e.type === kind)]));
  if ([...byKind.values()].some((rows) => rows.length !== 1)) return null;
  const get = (kind) => byKind.get(kind)[0];
  const start = get("session.started"), end = get("session.ended");
  const completed = get("model.completed"), artifacts = get("trace.artifacts");
  if (!start.sessionId || entry.sessionId !== start.sessionId ||
      start.data?.agentId !== task.proposal.role_id || start.seq !== events[0]?.seq ||
      end.seq !== events.at(-1)?.seq || new Set(events.map((e) => e.seq)).size !== events.length ||
      events.some((e, i) => !allowed.has(e.type) || e.traceSchema !== "openclaw-trajectory" ||
        e.schemaVersion !== 1 || e.source !== "runtime" || e.runId !== task.run_id ||
        e.sessionKey !== task.proposal.session_key || e.sessionId !== start.sessionId ||
        `${e.provider}/${e.modelId}` !== task.proposal.requested_model || e.provider !== "openai" ||
        !Number.isInteger(e.seq) || (i > 0 && e.seq <= events[i-1].seq) ||
        !Number.isFinite(Date.parse(e.ts)) || Date.parse(e.ts) < task.created_at * 1000 - 5000 ||
        Date.parse(e.ts) > Date.now() + 5000 ||
        (i > 0 && Date.parse(e.ts) < Date.parse(events[i-1].ts))) ||
      get("trace.metadata").data?.model?.thinkLevel !== task.proposal.requested_effort ||
      end.data?.status !== "success" || artifacts.data?.finalStatus !== "success" ||
      [end, completed, artifacts].some((e) => e.data?.stopReason !== "stop" ||
        flags.some((key) => e.data?.[key] !== false)) ||
      completed.data.promptErrorSource !== null || artifacts.data.promptErrorSource !== null ||
      completed.data.finalPromptText !== task.proposal.instructions ||
      artifacts.data.finalPromptText !== task.proposal.instructions ||
      Math.abs(entry.endedAt - Date.parse(end.ts)) > 5000 ||
      artifacts.data.didSendViaMessagingTool !== false || artifacts.data.successfulCronAdds !== 0 ||
      ["messagingToolSentTexts", "messagingToolSentMediaUrls", "messagingToolSentTargets"].some(
        (key) => !Array.isArray(artifacts.data[key]) || artifacts.data[key].length)) return null;

  const calls = events.filter((e) => e.type === "tool.call");
  const results = events.filter((e) => e.type === "tool.result");
  const metas = artifacts.data.toolMetas;
  const lifecycle = artifacts.data.itemLifecycle;
  if (calls.length < 1 || calls.length > 16 || results.length !== calls.length ||
      !Array.isArray(metas) || metas.length !== calls.length ||
      new Set(calls.map((e) => e.data?.toolCallId)).size !== calls.length ||
      lifecycle?.startedCount !== calls.length || lifecycle.completedCount !== calls.length ||
      lifecycle.activeCount !== 0) return null;
  for (const call of calls) {
    const { toolCallId: id, name } = call.data ?? {};
    const matches = results.filter((e) => e.data?.toolCallId === id);
    const matchingMetas = metas.filter((m) => m.toolCallId === id);
    const result = matches[0], meta = matchingMetas[0];
    if (typeof id !== "string" || !id || !["read", "exec"].includes(name) ||
        matches.length !== 1 || matchingMetas.length !== 1 || result.seq <= call.seq ||
        result.seq >= completed.seq || result.data.name !== name || result.data.success !== true ||
        result.data.result?.isError === true || meta.toolName !== name || meta.isError !== false)
      return null;
    const details = result.data.result?.details;
    if (name === "exec" && (details?.status !== "completed" || details.exitCode !== 0 ||
        details.exitSignal != null || details.exitReason !== "exit" ||
        details.noOutputTimedOut !== false || details.sessionId != null)) return null;
  }

  const messages = transcript.filter((e) => e.type === "message").map((e) => e.message);
  const finalEvent = transcript.filter((e) => e.type === "message").at(-1);
  const final = finalEvent?.message;
  if (messages.some((m) => !m || !["user", "assistant", "toolResult", "custom"].includes(m.role)) ||
      messages.filter((m) => m.role === "user").length !== 1 ||
      final?.role !== "assistant" || final.stopReason !== "stop" || final.errorMessage ||
      final.provider !== "openai" || `${final.provider}/${final.model}` !== task.proposal.requested_model ||
      !Array.isArray(final.content) || final.content.length !== 1 ||
      final.content[0].type !== "text" || typeof final.content[0].text !== "string" ||
      !final.diagnostics?.some((d) => d.type === "openai_responses_terminal" &&
        d.details?.eventType === "response.completed" && d.details.stopReason === "stop") ||
      !Number.isFinite(Date.parse(finalEvent.timestamp)) ||
      Date.parse(finalEvent.timestamp) < Date.parse(start.ts) ||
      Date.parse(finalEvent.timestamp) > Date.parse(end.ts)) return null;
  let signature;
  try { signature = JSON.parse(final.content[0].textSignature); } catch { return null; }
  if (signature?.phase !== "final_answer" || typeof signature.id !== "string" || !signature.id ||
      [completed, artifacts].some((e) => !Array.isArray(e.data.assistantTexts) ||
        e.data.assistantTexts.length !== 1 || e.data.assistantTexts[0] !== final.content[0].text)) return null;
  const transcriptCalls = messages.filter((m) => m.role === "assistant" && m !== final)
    .flatMap((m) => Array.isArray(m.content) && m.stopReason === "toolUse" &&
      `${m.provider}/${m.model}` === task.proposal.requested_model ?
      m.content.filter((item) => item.type === "toolCall") : [{ invalid: true }]);
  const transcriptResults = messages.filter((m) => m.role === "toolResult");
  if (transcriptCalls.length !== calls.length || transcriptResults.length !== calls.length ||
      calls.some((c) => transcriptCalls.filter((item) => item.id === c.data.toolCallId && item.name === c.data.name).length !== 1 ||
        transcriptResults.filter((m) => m.toolCallId === c.data.toolCallId && m.toolName === c.data.name && m.isError === false).length !== 1)) return null;

  const actual = publicModel(`${final.provider}/${final.responseModel ?? final.model}`);
  if (actual === "not_reported") return null;
  const receipt = { runId: task.run_id, events, transcriptHash: hash(transcript), sessionHash: hash(entry) };
  const result = { status: "succeeded", run_id: task.run_id,
    requested_model: task.proposal.requested_model, actual_model: actual,
    reply: clean(final.content[0].text, 10000), error_code: null };
  const endedAt = Date.parse(end.ts);
  result.completion_evidence = completionEvidence(receipt, task, result, source, endedAt);
  return { result, evidence: { source, run_id: task.run_id, ended_at: endedAt,
    gateway_status: "ok", stop_reason: "stop", receipt_hash: hash(receipt) } };
}

/** Read only the same owner-private agent database; no SDK migrations or model execution. */
export async function recoverToolRuntime(task, clean) {
  if (!/^fmg-(planner|frontend|backend|qa|release|live-gate)$/.test(task.proposal.role_id)) return null;
  const path = `/data/.openclaw/agents/${task.proposal.role_id}/agent/openclaw-agent.sqlite`;
  let db;
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0) return null;
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(path, { readOnly: true, timeout: 1000 });
    db.exec("BEGIN");
    const node = db.prepare("SELECT current_session_id,entry_json FROM session_nodes WHERE session_key=? AND length(CAST(entry_json AS BLOB))<=262144").get(task.proposal.session_key);
    if (!node) return null;
    const entry = JSON.parse(node.entry_json);
    const args = [task.run_id, node.current_session_id];
    const bounds = db.prepare("SELECT count(*) AS count,sum(length(CAST(event_json AS BLOB))) AS bytes FROM trajectory_runtime_events WHERE run_id=? AND session_id=?").get(...args);
    const transcriptBounds = db.prepare("SELECT count(*) AS count,sum(event_utf8_bytes) AS bytes,max(event_utf8_bytes) AS largest FROM transcript_events WHERE session_id=?").get(node.current_session_id);
    if (bounds.count > 64 || bounds.bytes > limit || transcriptBounds.count > 64 ||
        !Number.isFinite(transcriptBounds.bytes) || transcriptBounds.bytes > limit || transcriptBounds.largest > limit) return null;
    const events = db.prepare("SELECT event_json FROM trajectory_runtime_events WHERE run_id=? AND session_id=? ORDER BY seq LIMIT 64").all(...args).map((r) => JSON.parse(r.event_json));
    const transcript = db.prepare("SELECT event_json,event_zstd,event_utf8_bytes FROM transcript_events WHERE session_id=? ORDER BY seq LIMIT 64").all(node.current_session_id).map((r) => {
      const raw = r.event_json != null ? r.event_json : zlib.zstdDecompressSync(r.event_zstd, { maxOutputLength: limit }).toString("utf8");
      if (Buffer.byteLength(raw) !== r.event_utf8_bytes) throw new Error("transcript_size_mismatch");
      return JSON.parse(raw);
    });
    return toolRuntimeResult(events, transcript, entry, task, clean);
  } catch { return null; } finally { db?.close(); }
}
