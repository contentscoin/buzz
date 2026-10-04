import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";
import { createHash } from "node:crypto";
import { publicModel } from "./model-binding.mjs";
import { completionEvidence } from "./completion.mjs";
import { recoverRuntime } from "./runtime-recovery.mjs";

export const clean = (value, limit) =>
  typeof value === "string"
    ? Array.from(value)
        .filter((char) => {
          const code = char.codePointAt(0);
          return (
            ((code >= 32 && code !== 127) || [9, 10, 13].includes(code)) &&
            !(code >= 0xd800 && code <= 0xdfff)
          );
        })
        .slice(0, limit)
        .join("")
    : null;

export async function gateway(config, method, params, signal) {
  if (
    config.gateway?.mode === "remote" ||
    !["agent", "agent.wait", "chat.abort"].includes(method)
  )
    throw new Error("local_gateway_required");
  const port = config.gateway?.port ?? 18789;
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("gateway_port_invalid");
  const scheme = config.gateway?.tls?.enabled ? "wss" : "ws";
  return callGatewayFromCli(
    method,
    {
      json: true,
      timeout: method === "agent" ? "150000" : "10000",
      expectFinal: method === "agent",
      expectUrl: `${scheme}://127.0.0.1:${port}`,
    },
    params,
    { progress: false, scopes: ["operator.admin"], signal },
  );
}

/** Only terminal evidence for the persisted run can release the dispatch block. */
export function recoveredResult(observation, task) {
  if (
    observation?.runId !== task.run_id ||
    task.run_id !== task.task_id ||
    observation.pendingError === true ||
    observation.yielded === true ||
    !Number.isFinite(observation.endedAt) ||
    observation.endedAt < task.created_at * 1000 - 5000 ||
    observation.endedAt > Date.now() + 5000 ||
    ["working", "paused"].includes(observation.livenessState)
  )
    return null;
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

export async function reconcileTask(context, settings, args, access) {
  let task = await access.operator(settings, "get", { task_id: args.task_id });
  if (task.proposal_hash !== args.proposal_hash)
    throw new Error("proposal_changed");
  await access.owner(context.config, settings, task.proposal);
  access.directOwner(context, settings);
  if (task.status !== "needs_reconcile") return task;
  let recovered;
  if (task.run_id === null && task.dispatch_stage === null) {
    recovered = {
      result: {
        status: "canceled",
        requested_model: task.proposal.requested_model,
        error_code: "durable_no_dispatch_intent",
      },
      evidence: { source: "durable_no_dispatch_intent", run_id: null },
    };
  } else if (
    task.dispatch_stage === "intent_recorded" &&
    task.run_id === task.task_id
  ) {
    try {
      const observation = await gateway(context.config, "agent.wait", {
        runId: task.run_id,
        timeoutMs: 1000,
      });
      recovered = recoveredResult(observation, task);
    } catch {
      /* A transport failure is not terminal evidence. */
    }
    if (!recovered) recovered = await recoverRuntime(task, clean);
  }
  if (!recovered)
    return {
      ...task,
      recovery_note:
        "완료 기록을 확인하지 못했습니다. 캐시와 저장된 단일 턴·도구 미사용 종료 기록을 확인했습니다. 미확인 상태를 유지하며 작업을 다시 실행하지 않습니다.",
    };
  await access.owner(context.config, settings, task.proposal);
  access.directOwner(context, settings);
  task = await access.operator(settings, "reconcile", {
    task_id: task.task_id,
    proposal_hash: args.proposal_hash,
    revision: task.revision,
    ...recovered,
  });
  return task;
}
