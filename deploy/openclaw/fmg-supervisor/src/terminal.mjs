import { completionEvidence } from "./completion.mjs";
import { publicModel } from "./model-binding.mjs";

/** Validate the actual SDK final receipt. A normal model stop is not cancellation. */
export function finalResult(receipt, task, clean) {
  const meta = receipt?.result?.meta;
  const terminal = meta?.agentMeta?.terminalReceipt;
  const actual = terminal?.effective;
  const model =
    actual &&
    publicModel(`${actual.provider}/${actual.responseModel ?? actual.model}`);
  const valid =
    receipt?.runId === task.run_id &&
    receipt.status === "ok" &&
    receipt.summary === "completed" &&
    Array.isArray(receipt.result?.payloads) &&
    terminal?.runId === task.run_id &&
    typeof terminal.sessionId === "string" &&
    terminal.sessionId.length > 0 &&
    typeof terminal.turnId === "string" &&
    terminal.turnId.length > 0 &&
    `${terminal.requested?.provider}/${terminal.requested?.model}` ===
      task.proposal.requested_model &&
    model &&
    model !== "not_reported" &&
    !receipt.error &&
    !meta.error &&
    !meta.aborted &&
    !meta.yielded &&
    !meta.continuationPending &&
    !meta.replayInvalid &&
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
    !["working", "paused", "blocked", "abandoned"].includes(
      meta.livenessState,
    ) &&
    !receipt.result.payloads.some((item) => item?.isError === true);
  if (!valid) return null;
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
