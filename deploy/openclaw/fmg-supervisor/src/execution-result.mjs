import { completedEnvelope, finalResult } from "./terminal.mjs";
import { recoverRuntime } from "./runtime-recovery.mjs";

/** Settle a live dispatch from a terminal receipt or its matching durable no-tool trace. */
export async function executionResult(
  receipt,
  task,
  clean,
  canceled = false,
  readRuntime = recoverRuntime,
) {
  const completed = finalResult(receipt, task, clean);
  if (completed) return completed;
  const metadata = receipt?.result?.meta?.agentMeta;
  if (
    canceled ||
    task.status !== "dispatching" ||
    task.run_id !== task.task_id ||
    task.dispatch_stage !== "intent_recorded" ||
    !completedEnvelope(receipt, task) ||
    metadata?.terminalReceipt != null ||
    ((metadata?.provider !== undefined || metadata?.model !== undefined) &&
      `${metadata?.provider}/${metadata?.model}` !==
        task.proposal.requested_model)
  )
    return null;
  // The same strict, bounded reader used by explicit recovery. No model call,
  // retry, historic ledger mutation or interpretation of reply text as success.
  const recovered = await readRuntime(task, clean);
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
