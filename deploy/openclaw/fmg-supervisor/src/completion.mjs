import { createHash } from "node:crypto";

/** Attest only an already validated final response; never export raw receipts. */
export function completionEvidence(
  receipt,
  task,
  result,
  source,
  endedAt = null,
) {
  if (
    result.status !== "succeeded" ||
    result.run_id !== task.run_id ||
    receipt?.runId !== task.run_id ||
    typeof result.reply !== "string" ||
    ![
      "gateway.agent.final",
      "gateway.agent.wait",
      "gateway.runtime.no_tools",
    ].includes(source)
  )
    throw new Error("completion_binding_invalid");
  const raw = JSON.stringify(receipt);
  if (Buffer.byteLength(raw) > 262144)
    throw new Error("completion_receipt_limit");
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  return {
    schema: 1,
    validation_contract:
      source === "gateway.runtime.no_tools"
        ? "fmg-terminal-v2"
        : "fmg-terminal-v1",
    source,
    run_id: task.run_id,
    proposal_hash: task.proposal_hash,
    requested_model: task.proposal.requested_model,
    actual_model: result.actual_model ?? null,
    requested_effort: task.proposal.requested_effort ?? null,
    model_binding: task.proposal.model_binding ?? null,
    terminal_status: "succeeded",
    source_completeness: "stored_summary",
    reply_hash: hash(result.reply),
    receipt_hash: hash(raw),
    validated_at: Date.now(),
    ended_at: endedAt,
  };
}
