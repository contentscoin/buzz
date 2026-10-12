import { completionEvidence } from "./completion.mjs";
import { publicModel } from "./model-binding.mjs";

/** Check the completed RPC envelope without assuming it includes a terminal attestation. */
export function completedEnvelope(receipt, task, durableFallback = false) {
  const meta = receipt?.result?.meta;
  return Boolean(
    receipt?.runId === task.run_id &&
      receipt.status === "ok" &&
      receipt.summary === "completed" &&
      Array.isArray(receipt.result?.payloads) &&
      meta &&
      !receipt.error &&
      !meta.error &&
      !meta.aborted &&
      !meta.yielded &&
      !meta.continuationPending &&
      // OpenClaw also marks settled tool calls unsafe to replay. This flag
      // prevents re-execution; completion needs an independent bound wait.
      (!meta.replayInvalid || durableFallback) &&
      !meta.timeoutPhase &&
      !(meta.pendingToolCalls?.length > 0) &&
      ![
        "tool_calls",
        "aborted",
        "restart",
        "superseded",
        "rpc",
        "error",
        "timeout",
      ].includes(meta.stopReason) &&
      !["paused", "blocked", "abandoned"].includes(
        meta.livenessState,
      ) &&
      // A final normal stop can retain the SDK's last working observation.
      // Missing/foreign receipts still cannot use this completion path.
      (meta.livenessState !== "working" ||
        (durableFallback && (meta.stopReason == null || meta.stopReason === "stop")) ||
        (meta.stopReason === "stop" && meta.agentMeta?.terminalReceipt?.runId === task.run_id)) &&
      !receipt.result.payloads.some((item) => item?.isError === true),
  );
}

/** Validate run/session/model identity before an independent terminal observation. */
export function boundTerminalModel(terminal, task) {
  const actual = terminal?.effective;
  const model =
    actual &&
    publicModel(`${actual.provider}/${actual.responseModel ?? actual.model}`);
  const valid =
    terminal?.runId === task.run_id &&
    typeof terminal.sessionId === "string" &&
    terminal.sessionId.length > 0 &&
    typeof terminal.turnId === "string" &&
    terminal.turnId.length > 0 &&
    `${terminal.requested?.provider}/${terminal.requested?.model}` ===
      task.proposal.requested_model &&
    model &&
    model !== "not_reported";
  return valid ? model : null;
}

/** Validate the actual SDK final receipt. A normal model stop is not cancellation. */
export function finalResult(receipt, task, clean) {
  const model = boundTerminalModel(receipt?.result?.meta?.agentMeta?.terminalReceipt, task);
  if (!completedEnvelope(receipt, task) || !model) return null;
  const result = {
    status: "succeeded",
    run_id: task.run_id,
    reply: clean(
      receipt.result.payloads
        .map((item) => clean(item?.text, 10000) ?? "")
        .filter(Boolean)
        .join("\n"),
      10000,
    ),
    requested_model: task.proposal.requested_model,
    actual_model: model,
    error_code: null,
  };
  result.completion_evidence = completionEvidence(
    receipt,
    task,
    result,
    "gateway.agent.final",
  );
  return result;
}
