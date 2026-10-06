import { open } from "node:fs/promises";
import { constants } from "node:fs";

const endpoint = "http://fmg-dot-supervisor:8001/operator";
const tokenFile = "/data/.openclaw/secrets/fmg-supervisor-operator.token";

/** Use the private operator endpoint only for the broker's verified audience. */
export async function operatorRequest(
  config,
  binding,
  action,
  arguments_,
  signal,
) {
  const settings = config.plugins?.entries?.["fmg-supervisor"];
  if (
    settings?.enabled !== true ||
    settings.config?.ownerPubkey !== binding.owner ||
    settings.config?.operatorUrl !== endpoint ||
    settings.config?.tokenFile !== tokenFile
  )
    throw new Error("tasks_unavailable");
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
      throw new Error("tasks_unavailable");
    token = (await file.readFile("utf8")).trim();
  } finally {
    await file.close();
  }
  if (!/^[A-Za-z0-9_-]{40,100}$/.test(token))
    throw new Error("tasks_unavailable");
  const args = {
    owner_pubkey: binding.owner,
    relay_origin: binding.origin,
    gateway_agent_pubkey: binding.agent,
    ...arguments_,
  };
  const response = await fetch(endpoint, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      action,
      arguments: args,
    }),
  });
  if (!response.body) throw new Error("task_read_failed");
  const reader = response.body.getReader(),
    chunks = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 100000) throw new Error("response_size_limit");
      chunks.push(Buffer.from(part.value));
    }
  } finally {
    await reader.cancel();
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!response.ok)
    throw new Error(
      action.startsWith("documents.") &&
        /^[a-z_]{1,80}$/.test(value.error ?? "")
        ? value.error
        : "task_read_failed",
    );
  return value;
}

/** Only audience-bound task reads are reachable through this projection. */
export async function taskView(config, binding, request, signal) {
  const value = await operatorRequest(
    config,
    binding,
    request.action === "tasks.get" ? "view_get" : "view_list",
    request.action === "tasks.get" ? { task_id: request.taskId } : {},
    signal,
  );
  if (request.action === "tasks.list") return value;
  const originalReply = value.result?.reply ?? "";
  // Bound UTF-8 bytes without splitting a Unicode code point.
  let reply = "",
    bytes = 0;
  for (const character of originalReply) {
    const next = Buffer.byteLength(character);
    if (bytes + next > 30000) break;
    reply += character;
    bytes += next;
  }
  const result = {
    task_id: value.task_id,
    status: value.status,
    revision: value.revision,
    created_at: value.created_at,
    updated_at: value.updated_at,
    proposal_hash: value.proposal_hash,
    run_id: value.run_id,
    dispatch_stage: value.dispatch_stage,
    proposal: {
      role_id: value.proposal.role_id,
      requested_model: value.proposal.requested_model,
      requested_effort: value.proposal.requested_effort ?? null,
      instructions: value.proposal.instructions,
      ...(value.proposal.schema === 4 &&
      value.proposal.project?.project_id === "buzz"
        ? {
            project: value.proposal.project,
            proposal_account: value.proposal.proposal_account,
          }
        : {}),
    },
    result: value.result
      ? {
          status: value.result.status,
          reply,
          reply_truncated: reply !== originalReply,
          requested_model: value.result.requested_model ?? null,
          actual_model: value.result.actual_model ?? null,
          error_code: value.result.error_code ?? null,
        }
      : null,
    recovery_history: value.recovery_history.map((entry) => ({
      revision: entry.revision,
      previous_status: entry.previous_status,
      recorded_at: entry.recorded_at,
    })),
  };
  if (Buffer.byteLength(JSON.stringify(result)) > 54000 && result.result) {
    const characters = Array.from(reply);
    let low = 0,
      high = characters.length;
    result.result.reply_truncated = true;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      result.result.reply = characters.slice(0, middle).join("");
      if (Buffer.byteLength(JSON.stringify(result)) <= 54000) low = middle;
      else high = middle - 1;
    }
    result.result.reply = characters.slice(0, low).join("");
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 54000)
    throw new Error("response_size_limit");
  return result;
}
