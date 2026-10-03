import { identity, profileOwner } from "../../fmg-computer/src/binding.mjs";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { clean, gateway, reconcileTask } from "./recovery.mjs";
import { approvedExecution, publicModel } from "./model-binding.mjs";
import { completionEvidence } from "./completion.mjs";

const endpoint = "http://fmg-dot-supervisor:8001/operator";
const tokenFile = "/data/.openclaw/secrets/fmg-supervisor-operator.token";
const roles = new Set([
  "fmg-planner",
  "fmg-frontend",
  "fmg-backend",
  "fmg-qa",
  "fmg-release",
  "fmg-live-gate",
]);
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function operator(settings, action, args = {}) {
  if (settings.operatorUrl !== endpoint || settings.tokenFile !== tokenFile)
    throw new Error("operator_config_invalid");
  const file = await open(tokenFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  let token;
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.size > 200 ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid()
    )
      throw new Error("operator_token_permissions");
    token = (await file.readFile("utf8")).trim();
  } finally {
    await file.close();
  }
  if (!/^[A-Za-z0-9_-]{40,100}$/.test(token))
    throw new Error("operator_token_invalid");
  const response = await fetch(endpoint, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10000),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ action, arguments: args }),
  });
  if (!response.ok || !response.body)
    throw new Error("operator_request_rejected");
  const reader = response.body.getReader(),
    chunks = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 1048576) throw new Error("operator_response_limit");
      chunks.push(Buffer.from(part.value));
    }
  } finally {
    await reader.cancel();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function owner(config, settings, expected) {
  const binding = await identity(config);
  try {
    if (
      (await profileOwner(binding, AbortSignal.timeout(12000))) !==
      settings.ownerPubkey
    )
      throw new Error("owner_binding_changed");
    if (
      expected &&
      (expected.owner_pubkey !== settings.ownerPubkey ||
        expected.gateway_agent_pubkey !== binding.agent ||
        expected.relay_origin !== binding.origin)
    )
      throw new Error("audience_changed");
  } finally {
    binding.key.fill(0);
  }
}

function directOwner(context, settings) {
  const normalized = (value) => String(value ?? "").replace(/^telegram:/, "");
  if (
    context.channel !== "telegram" ||
    context.isAuthorizedSender !== true ||
    context.agentId !== "main" ||
    normalized(context.senderId) !== settings.telegramOwnerId ||
    normalized(context.from) !== settings.telegramOwnerId
  )
    throw new Error("direct_owner_command_required");
  context.assertOwnerCurrent?.();
}

export function registerTaskCommand(api) {
  api.registerCommand({
    name: "fmg_task",
    description: "Buzz 작업 조회·승인·취소·완료 기록 복구 (소유자 개인 채팅)",
    channels: ["telegram"],
    acceptsArgs: true,
    requireAuth: true,
    async handler(context) {
      try {
        const settings =
          context.config.plugins?.entries?.["fmg-supervisor"]?.config ??
          api.pluginConfig;
        directOwner(context, settings);
        const parts = (context.args ?? "").trim().split(/\s+/);
        const action = parts[0];
        let args;
        if (action === "list" && parts.length === 1) args = {};
        else if (action === "get" && parts.length === 2 && uuid.test(parts[1]))
          args = { task_id: parts[1] };
        else if (
          ["approve", "cancel", "reconcile"].includes(action) &&
          parts.length === 3 &&
          uuid.test(parts[1]) &&
          /^[0-9a-f]{64}$/.test(parts[2])
        )
          args = { task_id: parts[1], proposal_hash: parts[2] };
        else
          return {
            text: "사용법: /fmg_task list\n/fmg_task get <작업 ID>\n/fmg_task approve <작업 ID> <전체 해시>\n/fmg_task cancel <작업 ID> <전체 해시>\n/fmg_task reconcile <작업 ID> <전체 해시>\n닷에서 제안 내용을 먼저 확인하세요.",
          };
        await owner(context.config, settings);
        directOwner(context, settings);
        const result =
          action === "reconcile"
            ? await reconcileTask(context, settings, args, {
                operator,
                owner,
                directOwner,
              })
            : await operator(settings, action, args);
        if (action === "list")
          return {
            text:
              result.tasks
                .map(
                  (task) =>
                    `${task.task_id} · ${task.role_id} · ${task.status}`,
                )
                .join("\n") || "저장된 작업 제안이 없습니다.",
          };
        const task = result;
        return {
          text: `작업: ${task.task_id}\n상태: ${task.status}\n실행 ID: ${task.run_id ?? "아직 기록 없음"}\n역할: ${task.proposal.role_id}\n모델: ${task.proposal.requested_model}\neffort: ${task.proposal.requested_effort ?? "이전 작업 · 기록 없음"}\n요청:\n${clean(task.proposal.instructions, 5000)}\n해시: ${task.proposal_hash}\n승인: ${task.approve_command}\n${task.result ? `결과(에이전트 출력):\n${clean(task.result.reply, 18000) ?? task.result.error_code ?? task.result.status}` : "실행 완료 결과가 아직 없습니다."}\n${task.recovery_note ?? ""}\n실행 중 취소는 요청 상태이며 종료 확인을 뜻하지 않습니다.`,
        };
      } catch {
        return {
          text: "작업 명령을 처리하지 못했습니다. 소유자 Telegram 개인 채팅, 최신 Buzz 소유권 연결, 작업 ID·전체 해시·현재 상태를 확인하세요. 실행 성공으로 처리하지 않았습니다.",
        };
      }
    },
  });
}

export async function createTaskWorker(context, settings) {
  if (!settings.telegramOwnerId || !settings.operatorUrl || !settings.tokenFile)
    return async () => {};
  let stopped = false,
    timer,
    running,
    activeController,
    activeTask,
    pending;

  async function execute(task, lease) {
    const proposal = task.proposal;
    if (
      !uuid.test(task.task_id) ||
      !roles.has(proposal.role_id) ||
      proposal.session_key !==
        `agent:${proposal.role_id}:fmg-task:${task.task_id}` ||
      proposal.deliver !== false ||
      proposal.timeout_seconds !== 120 ||
      typeof proposal.instructions !== "string" ||
      proposal.instructions.length > 5000 ||
      typeof proposal.requested_model !== "string" ||
      !proposal.requested_model ||
      proposal.requested_model.length > 120
    )
      throw new Error("proposal_invalid");
    await owner(context.config, settings, proposal);
    await approvedExecution(proposal);
    const admitted = await operator(settings, "get", { task_id: task.task_id });
    if (stopped || admitted.status !== "dispatching")
      return {
        status: "canceled",
        requested_model: proposal.requested_model,
        error_code: "canceled_before_gateway_dispatch",
      };
    const checkpoint = await operator(settings, "checkpoint", {
      task_id: task.task_id,
      lease,
    });
    task.run_id = checkpoint.run_id;
    if (
      task.run_id !== task.task_id ||
      checkpoint.dispatch_stage !== "intent_recorded"
    )
      throw new Error("dispatch_intent_invalid");
    if (stopped)
      return {
        status: "canceled",
        run_id: task.run_id,
        requested_model: proposal.requested_model,
        error_code: "canceled_before_gateway_dispatch",
      };
    const controller = new AbortController();
    activeController = controller;
    activeTask = task;
    let receipt,
      poll,
      polling = false,
      finished = false,
      canceled = false;
    try {
      poll = setInterval(async () => {
        if (polling || finished) return;
        polling = true;
        try {
          const current = await operator(settings, "get", {
            task_id: task.task_id,
          });
          await owner(context.config, settings, proposal);
          if (!finished && (current.status === "cancel_requested" || stopped)) {
            canceled = true;
            await gateway(context.config, "chat.abort", {
              sessionKey: proposal.session_key,
              runId: task.run_id,
            });
            if (!finished) controller.abort();
          }
        } catch {
          if (!finished) controller.abort();
        } finally {
          polling = false;
        }
      }, 5000);
      // The immutable run ID is stored before admission. Execution is never retried.
      const selected = await approvedExecution(proposal);
      if (stopped) throw new Error("worker_stopped_before_dispatch");
      receipt = await gateway(
        context.config,
        "agent",
        {
          message: proposal.instructions,
          agentId: proposal.role_id,
          sessionKey: proposal.session_key,
          model: selected.model,
          thinking: selected.effort,
          deliver: false,
          timeout: 120,
          idempotencyKey: task.run_id,
        },
        controller.signal,
      );
    } catch {
      receipt = null;
    } finally {
      finished = true;
      clearInterval(poll);
      activeController = undefined;
      activeTask = undefined;
    }
    const meta = receipt?.result?.meta;
    const terminal =
      receipt?.runId === task.run_id &&
      ["ok", "completed"].includes(receipt.status) &&
      typeof receipt?.result === "object" &&
      Array.isArray(receipt?.result?.payloads) &&
      !(meta?.pendingToolCalls?.length > 0) &&
      meta?.aborted !== true &&
      !meta?.error &&
      !meta?.yielded &&
      !meta?.continuationPending &&
      !meta?.replayInvalid &&
      ![
        "tool_calls",
        "aborted",
        "restart",
        "superseded",
        "rpc",
        "stop",
      ].includes(meta?.stopReason) &&
      !["working", "paused", "blocked", "abandoned"].includes(
        meta?.livenessState,
      ) &&
      !receipt?.error &&
      !receipt?.result?.payloads?.some((item) => item?.isError === true);
    const metadata = meta?.agentMeta;
    const actual =
      metadata?.provider && metadata?.model
        ? `${metadata.provider}/${metadata.model}`
        : metadata?.model;
    const reply = Array.isArray(receipt?.result?.payloads)
      ? clean(
          receipt.result.payloads
            .map((item) => clean(item?.text, 10000) ?? "")
            .filter(Boolean)
            .join("\n"),
          10000,
        )
      : "";
    const result = {
      status: terminal ? "succeeded" : "needs_reconcile",
      run_id: task.run_id,
      reply,
      requested_model: proposal.requested_model,
      actual_model:
        publicModel(actual) === "not_reported" ? null : publicModel(actual),
      error_code: terminal
        ? null
        : canceled
          ? "cancel_requested_no_terminal_receipt"
          : "gateway_terminal_receipt_unconfirmed",
    };
    if (terminal)
      result.completion_evidence = completionEvidence(
        receipt,
        task,
        result,
        "gateway.agent.final",
      );
    return result;
  }

  async function cycle() {
    // Retrying result persistence is safe; retrying agent execution is forbidden.
    if (pending) {
      await operator(settings, "finish", pending);
      pending = undefined;
      return;
    }
    await owner(context.config, settings);
    const claim = await operator(settings, "claim", { worker_protocol: 5 });
    if (!claim.task) return;
    let result;
    try {
      result = await execute(claim.task, claim.lease);
    } catch {
      result = {
        status: "needs_reconcile",
        error_code: "dispatch_preparation_or_run_unconfirmed",
        requested_model: claim.task.proposal.requested_model,
        run_id: claim.task.run_id,
      };
    }
    pending = { task_id: claim.task.task_id, lease: claim.lease, result };
    await operator(settings, "finish", pending);
    pending = undefined;
  }
  function schedule() {
    if (stopped) return;
    running = cycle()
      .catch(() =>
        context.logger.warn(
          "FMG task worker unavailable; no automatic execution retry.",
        ),
      )
      .finally(() => {
        if (!stopped) timer = setTimeout(schedule, 5000);
      });
  }
  schedule();
  context.logger.info(
    "FMG task worker started; direct owner approval required.",
  );
  return async () => {
    stopped = true;
    clearTimeout(timer);
    if (activeTask) {
      try {
        await owner(context.config, settings, activeTask.proposal);
        await gateway(context.config, "chat.abort", {
          sessionKey: activeTask.proposal.session_key,
          runId: activeTask.run_id,
        });
      } catch {
        /* Authority or abort receipt unavailable: preserve uncertain status. */
      }
    }
    activeController?.abort();
    await running;
  };
}
