import { createHash } from "node:crypto";
import { publicModel } from "./model-binding.mjs";
import { completionEvidence } from "./completion.mjs";

/** Only terminal evidence for the persisted run can release the dispatch block. */
export function recoveredResult(observation, task, clean) {
  if (
    observation?.runId !== task.run_id ||
    task.run_id !== task.task_id ||
    observation.pendingError === true ||
    observation.yielded === true ||
    !Number.isFinite(observation.endedAt) ||
    observation.endedAt < task.created_at * 1000 - 5000 ||
    observation.endedAt > Date.now() + 5000 ||
    observation.livenessState === "paused" ||
    observation.timeoutPhase != null ||
    (observation.livenessState === "working" &&
      (observation.status !== "ok" || observation.stopReason !== "stop"))
  )
    return null;
  // OpenClaw preserves its last "working" value on normal terminal snapshots.
  // It is admitted only with a real endedAt, normal stop and the bound receipt
  // validated below; it never makes an accepted/pending response terminal.
  const evidence = {
    source: "gateway.agent.wait",
    run_id: task.run_id,
    ended_at: observation.endedAt,
    gateway_status: observation.status,
    stop_reason: clean(observation.stopReason, 80),
  };
  const result = {
    run_id: task.run_id,
    requested_model: task.proposal.requested_model,
    reply: "",
    actual_model: null,
    error_code: null,
  };
  if (
    observation.status === "ok" &&
    !observation.error &&
    ![
      "tool_calls",
      "aborted",
      "restart",
      "superseded",
      "rpc",
      "error",
      "timeout",
    ].includes(observation.stopReason) &&
    !["blocked", "abandoned"].includes(observation.livenessState)
  ) {
    const receipt = observation.terminalReceipt;
    const reply = observation.terminalReply;
    if (
      receipt?.runId !== task.run_id ||
      typeof receipt.sessionId !== "string" ||
      !receipt.sessionId ||
      typeof receipt.turnId !== "string" ||
      !receipt.turnId ||
      typeof receipt.requested?.provider !== "string" ||
      typeof receipt.requested?.model !== "string" ||
      `${receipt.requested.provider}/${receipt.requested.model}` !==
        task.proposal.requested_model.split("@")[0] ||
      typeof receipt.effective?.provider !== "string" ||
      typeof receipt.effective?.model !== "string" ||
      !["visible", "silent", "empty"].includes(reply?.disposition) ||
      (reply.disposition === "visible" && typeof reply.text !== "string")
    )
      return null;
    result.status = "succeeded";
    result.reply = clean(reply.text, 10000) ?? "";
    result.actual_model = publicModel(
      `${receipt.effective.provider}/${receipt.effective.responseModel ?? receipt.effective.model}`,
    );
    if (result.actual_model === "not_reported") return null;
    evidence.receipt_hash = createHash("sha256")
      .update(JSON.stringify(receipt))
      .digest("hex");
    result.completion_evidence = completionEvidence(
      receipt,
      task,
      result,
      "gateway.agent.wait",
      observation.endedAt,
    );
  } else if (
    observation.status === "error" &&
    observation.stopReason !== "tool_calls"
  ) {
    result.status = [
      "aborted",
      "restart",
      "superseded",
      "rpc",
      "stop",
    ].includes(observation.stopReason)
      ? "canceled"
      : "failed";
    result.error_code =
      result.status === "canceled"
        ? "gateway_terminal_cancel_confirmed"
        : "gateway_terminal_failure_confirmed";
    // Error strings can contain credentials, paths or transcript fragments; do not export.
  } else return null; // An RPC wait timeout is never proof that execution stopped.
  return { result, evidence };
}

