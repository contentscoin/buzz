import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";
import { recoveredResult } from "./wait-result.mjs";
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
      recovered = recoveredResult(observation, task, clean);
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
