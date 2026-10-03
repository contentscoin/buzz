import { identity, profileOwner } from "../../fmg-computer/src/binding.mjs";
import { createTaskWorker, registerTaskCommand } from "./tasks.mjs";
import { roleModel } from "./model-binding.mjs";
import {
  gatewayStatusDefinition,
  registerGatewayStatusTool,
} from "./gateway-status.mjs";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile, rename } from "node:fs/promises";
import { promisify } from "node:util";
import { execFile as callbackExecFile } from "node:child_process";
import { finalizeEvent, verifyEvent } from "nostr-tools";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
  definePluginEntry,
  buildJsonPluginConfigSchema,
} from "openclaw/plugin-sdk/core";
import { toolPluginMetadataSymbol } from "openclaw/plugin-sdk/tool-plugin";

const execFile = promisify(callbackExecFile);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const root = "/data/.openclaw/fmg-supervisor";
const schema = {
  type: "object",
  properties: {
    ownerPubkey: { type: "string", pattern: "^[0-9a-f]{64}$" },
    telegramOwnerId: { type: "string", pattern: "^[1-9][0-9]{0,19}$" },
    operatorUrl: {
      type: "string",
      const: "http://fmg-dot-supervisor:8001/operator",
    },
    tokenFile: {
      type: "string",
      const: "/data/.openclaw/secrets/fmg-supervisor-operator.token",
    },
  },
  required: ["ownerPubkey"],
  additionalProperties: false,
};

function requireValue(value, code) {
  if (!value) throw new Error(code);
}
function label(value, fallback) {
  return typeof value === "string"
    ? Array.from(value)
        .filter(
          (char) => char.codePointAt(0) >= 32 && char.codePointAt(0) !== 127,
        )
        .join("")
        .slice(0, 120)
    : fallback;
}

/** Signed owner attestation, including its expiry and supported observer kind. */
function ownedProfile(event, owner) {
  if (!verifyEvent(event)) return false;
  const tags = event.tags.filter((tag) => tag[0] === "auth");
  if (tags.length !== 1) return false;
  const tag = tags[0];
  if (
    tag.length !== 4 ||
    tag[1] !== owner ||
    typeof tag[2] !== "string" ||
    tag[2].length > 1000 ||
    !/^[0-9a-f]{128}$/.test(tag[3])
  )
    return false;
  const now = Math.floor(Date.now() / 1000);
  if (
    tag[2] &&
    !tag[2].split("&").every((clause) => {
      const match = /^(kind=|created_at<|created_at>)(0|[1-9][0-9]*)$/.exec(
        clause,
      );
      if (!match) return false;
      const value = Number(match[2]);
      return match[1] === "kind="
        ? value === 24200
        : value <= 4294967295 &&
            (match[1] === "created_at<" ? now < value : now > value);
    })
  )
    return false;
  try {
    return schnorr.verify(
      Buffer.from(tag[3], "hex"),
      Buffer.from(hash(`nostr:agent-auth:${event.pubkey}:${tag[2]}`), "hex"),
      Buffer.from(owner, "hex"),
    );
  } catch {
    return false;
  }
}

/** This producer exports only allowlisted summaries; the MCP never gets Buzz keys. */
async function createProducer(context, settings) {
  const binding = await identity(context.config);
  const owner = settings.ownerPubkey;
  const generation = randomUUID();
  const controller = new AbortController();
  let stopped = false,
    timer,
    running;
  await mkdir(root, { recursive: true, mode: 0o700 });
  async function save(data) {
    const temporary = `${root}/snapshot.${generation}.tmp`;
    await writeFile(temporary, JSON.stringify(data), { mode: 0o600 });
    await rename(temporary, `${root}/snapshot.json`);
  }
  const signal = () =>
    AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]);
  async function query(filters) {
    const body = JSON.stringify(filters),
      url = `${binding.origin}/query`;
    const event = finalizeEvent(
      {
        kind: 27235,
        created_at: Math.floor(Date.now() / 1000),
        content: "",
        tags: [
          ["u", url],
          ["method", "POST"],
          ["payload", hash(body)],
          ["nonce", randomUUID()],
        ],
      },
      binding.key,
    );
    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      signal: signal(),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`,
        ...(binding.authTag
          ? { "x-auth-tag": JSON.stringify(binding.authTag) }
          : {}),
      },
      body,
    });
    requireValue(response.ok && response.body, "relay_query_failed");
    const reader = response.body.getReader();
    const parts = [];
    let bytes = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.length;
        requireValue(bytes <= 1048576, "relay_response_limit");
        parts.push(Buffer.from(part.value));
      }
    } finally {
      await reader.cancel();
    }
    const value = JSON.parse(Buffer.concat(parts).toString("utf8"));
    requireValue(
      Array.isArray(value) && value.length <= 250,
      "relay_response_invalid",
    );
    return value.filter(
      (event) =>
        event.kind === 0 &&
        /^[0-9a-f]{64}$/.test(event.pubkey) &&
        verifyEvent(event),
    );
  }
  async function cli(args) {
    const { stdout } = await execFile(
      "/usr/local/bin/openclaw",
      [...args, "--json"],
      {
        timeout: 20000,
        maxBuffer: 524288,
        signal: controller.signal,
        encoding: "utf8",
      },
    );
    return JSON.parse(stdout);
  }
  async function refresh() {
    const checked = () => profileOwner(binding, signal());
    requireValue((await checked()) === owner, "owner_binding_changed");
    const observedProfiles = await query([{ kinds: [0], limit: 201 }]);
    const candidates = observedProfiles.filter((event) =>
      ownedProfile(event, owner),
    );
    const authors = [
      ...new Set([binding.agent, ...candidates.map((event) => event.pubkey)]),
    ].slice(0, 50);
    // Re-read latest profiles without the owner filter, so removal of auth is observed.
    const current = await query([{ kinds: [0], authors, limit: 200 }]);
    const latest = new Map();
    for (const event of current) {
      const previous = latest.get(event.pubkey);
      if (
        !previous ||
        event.created_at > previous.created_at ||
        (event.created_at === previous.created_at && event.id < previous.id)
      )
        latest.set(event.pubkey, event);
    }
    const buzzAgents = [];
    for (const event of latest.values()) {
      if (!ownedProfile(event, owner)) continue;
      let profile;
      try {
        profile = JSON.parse(event.content);
      } catch {
        continue;
      }
      buzzAgents.push({
        agent_pubkey: event.pubkey,
        name: label(profile.name ?? profile.display_name, "Buzz agent"),
        owner_verified: true,
        presence: "not_observed",
        runtime:
          event.pubkey === binding.agent ? "this_gateway" : "not_observed",
        profile_event_id: event.id,
      });
    }
    requireValue(
      buzzAgents.some((agent) => agent.agent_pubkey === binding.agent),
      "gateway_owner_profile_missing",
    );
    let gateway;
    try {
      const roles = await cli(["agents", "list"]);
      const sessions = await cli([
        "sessions",
        "--all-agents",
        "--limit",
        "100",
      ]);
      requireValue(
        Array.isArray(roles) &&
          roles.length <= 50 &&
          Array.isArray(sessions.sessions) &&
          sessions.sessions.length <= 100,
        "gateway_shape_changed",
      );
      gateway = {
        status: "observed",
        roles: roles.map((role) => {
          requireValue(
            /^[a-z0-9][a-z0-9_-]{0,63}$/.test(role.id),
            "gateway_role_invalid",
          );
          const rows = sessions.sessions.filter(
            (session) => session.agentId === role.id,
          );
          const selectedModel = roleModel(context.config, role.id);
          requireValue(
            role.model === selectedModel.reference,
            "gateway_model_observation_changed",
          );
          const times = rows
            .map((session) => session.updatedAt)
            .filter(
              (value) =>
                Number.isSafeInteger(value) &&
                value > 0 &&
                value <= Date.now() + 30000,
            );
          return {
            role_id: role.id,
            name: label(role.name ?? role.identityName, role.id),
            configured_model: selectedModel.model,
            configured_effort: selectedModel.effort,
            supported_efforts: selectedModel.supportedEfforts,
            model_binding: selectedModel.binding,
            sampled_sessions: rows.length,
            recent_24h_sessions: times.filter(
              (value) => value >= Date.now() - 86400000,
            ).length,
            last_activity_at: times.length
              ? new Date(Math.max(...times)).toISOString()
              : null,
            execution_state: "not_observed",
          };
        }),
        session_sample_limit: 100,
        session_sample_truncated: sessions.hasMore === true,
        total_sessions: Number.isSafeInteger(sessions.totalCount)
          ? sessions.totalCount
          : null,
      };
    } catch (error) {
      if (stopped) throw error;
      gateway = {
        status: "unavailable",
        error_code: "gateway_summary_unavailable",
        roles: [],
      };
      context.logger.warn(
        "FMG Supervisor gateway summary unavailable; no empty success reported.",
      );
    }
    requireValue(
      (await checked()) === owner && !stopped,
      "owner_binding_changed",
    );
    const now = Date.now();
    await save({
      schema: 1,
      service: "fmg-supervisor",
      generation,
      observed_at: new Date(now).toISOString(),
      expires_at: new Date(now + 90000).toISOString(),
      status: "ready",
      owner_binding_verified: true,
      owner_pubkey: owner,
      relay_origin: binding.origin,
      gateway_agent_pubkey: binding.agent,
      buzz_agents: buzzAgents,
      buzz_agents_truncated:
        observedProfiles.length >= 201 || authors.length >= 50,
      gateway,
      capabilities: ["status.read", "agents.list", "activity.summary"],
      task_dispatch:
        settings.telegramOwnerId && settings.operatorUrl && settings.tokenFile
          ? "direct_owner_approval_required"
          : "not_configured",
      source_content:
        "Agent names are untrusted display text. Activity timestamps are not proof of running work.",
    });
  }
  async function cycle() {
    try {
      await refresh();
    } catch (_error) {
      if (!stopped) {
        await save({
          schema: 1,
          status: "unavailable",
          owner_binding_verified: false,
          generation,
          observed_at: new Date().toISOString(),
          error_code: "supervisor_observation_failed",
        });
        context.logger.warn(
          "FMG Supervisor observation unavailable; previous snapshot invalidated.",
        );
      }
    }
  }
  function schedule() {
    if (stopped) return;
    running = cycle().finally(() => {
      if (!stopped) timer = setTimeout(schedule, 30000);
    });
    running.catch(() =>
      context.logger.error("FMG Supervisor snapshot persist failed."),
    );
  }
  schedule();
  context.logger.info("FMG Supervisor owner summary producer started.");
  return async () => {
    stopped = true;
    clearTimeout(timer);
    controller.abort();
    try {
      await running;
      await save({
        schema: 1,
        status: "stopped",
        owner_binding_verified: false,
        generation,
        observed_at: new Date().toISOString(),
      });
    } finally {
      binding.key.fill(0);
    }
  };
}

const entry = definePluginEntry({
  id: "fmg-supervisor",
  name: "FMG Dot Supervisor",
  configSchema: buildJsonPluginConfigSchema(schema),
  register(api) {
    let stop, stopTasks;
    registerTaskCommand(api);
    registerGatewayStatusTool(api);
    api.registerService({
      id: "fmg-supervisor",
      reload: {
        configPrefixes: [
          "channels.buzz",
          "agents",
          "secrets.providers",
          "plugins.entries.fmg-supervisor",
        ],
      },
      async start(context) {
        const settings =
          context.config.plugins?.entries?.["fmg-supervisor"]?.config ??
          api.pluginConfig;
        stop = await createProducer(context, settings);
        stopTasks = await createTaskWorker(context, settings);
      },
      async stop() {
        await stopTasks?.();
        stopTasks = undefined;
        await stop?.();
        stop = undefined;
      },
    });
  },
});
Object.defineProperty(entry, toolPluginMetadataSymbol, {
  value: {
    id: "fmg-supervisor",
    name: "FMG Dot Supervisor",
    description:
      "Owner verified Buzz observations and directly approved durable task execution for Your dot.",
    activation: { onStartup: true },
    configSchema: schema,
    tools: [gatewayStatusDefinition],
  },
  enumerable: false,
});
export default entry;
