import { boundTerminalModel, completedEnvelope, finalResult } from "./terminal.mjs";
import { recoverRuntime } from "./runtime-recovery.mjs";
import { recoverToolRuntime } from "./tool-recovery.mjs";
import { recoveredResult } from "./wait-result.mjs";

/** Settle a live dispatch using its terminal receipt or matching durable bounded trace. */
export async function executionResult(
  receipt,
  task,
  clean,
  canceled = false,
  readRuntime = recoverRuntime,
  readTools = recoverToolRuntime,
  readWait,
) {
  const completed = finalResult(receipt, task, clean);
  if (completed) return completed;
  const metadata = receipt?.result?.meta?.agentMeta;
  const terminal = metadata?.terminalReceipt;
  if (
    canceled ||
    task.status !== "dispatching" ||
    task.run_id !== task.task_id ||
    task.dispatch_stage !== "intent_recorded" ||
    !completedEnvelope(receipt, task, true) ||
    (terminal != null && !boundTerminalModel(terminal, task)) ||
    ((metadata?.provider !== undefined || metadata?.model !== undefined) &&
      `${metadata?.provider}/${metadata?.model}` !==
        task.proposal.requested_model)
  )
    return null;
  // The same strict, bounded reader used by explicit recovery. No model call,
  // retry, historic ledger mutation or interpretation of reply text as success.
  const observation = readWait ? await readWait(task) : null;
  if (observation && observation.runId !== task.run_id) return null;
  const waited = observation && recoveredResult(observation, task, clean);
  if (waited && waited.result.status !== "succeeded") return null;
  // Never infer completion from a replay-unsafe envelope or database trace.
  // Only the independent ended run may attest its already-produced result.
  if (receipt.result.meta.replayInvalid && (!terminal || !waited)) return null;
  // A present SDK identity must be independently confirmed, never ignored.
  if (terminal != null && (!waited ||
    observation.terminalReceipt.sessionId !== terminal.sessionId ||
    observation.terminalReceipt.turnId !== terminal.turnId ||
    waited.result.actual_model !== boundTerminalModel(terminal, task))) return null;
  const recovered = waited ?? await readRuntime(task, clean) ?? await readTools(task, clean);
  if (!recovered) return null;
  const reply = clean(
    receipt.result.payloads
      .map((item) => clean(item?.text, 10000) ?? "")
      .filter(Boolean)
      .join("\n"),
    10000,
  );
  return recovered.result.reply === reply ? recovered.result : null;
}

/** Log only schema/boolean observations; never export provider errors or reply text. */
export function completionObservation(receipt, task) {
  const meta = receipt?.result?.meta;
  return {
    matching_run: receipt?.runId === task.run_id,
    rpc_ok: receipt?.status === "ok",
    summary_completed: receipt?.summary === "completed",
    payload_array: Array.isArray(receipt?.result?.payloads),
    meta_present: !!meta,
    last_working: meta?.livenessState === "working",
    stop_missing: meta?.stopReason == null,
    normal_stop: meta?.stopReason === "stop",
    eligible_envelope: completedEnvelope(receipt, task, true) && !meta?.replayInvalid,
    rpc_error: !!receipt?.error,
    meta_error: !!meta?.error,
    aborted: !!meta?.aborted,
    yielded: !!meta?.yielded,
    continuation_pending: !!meta?.continuationPending,
    replay_invalid: !!meta?.replayInvalid,
    timeout_phase: !!meta?.timeoutPhase,
    pending_tools: meta?.pendingToolCalls?.length > 0,
    blocked_liveness: ["paused", "blocked", "abandoned"].includes(meta?.livenessState),
    payload_error: !!receipt?.result?.payloads?.some?.((item) => item?.isError === true),
    terminal_present: meta?.agentMeta?.terminalReceipt != null,
    terminal_bound: !!boundTerminalModel(meta?.agentMeta?.terminalReceipt, task),
    model_metadata_present: meta?.agentMeta?.provider !== undefined || meta?.agentMeta?.model !== undefined,
  };
}
