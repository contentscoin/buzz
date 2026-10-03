import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { Type } from "typebox";
import { identity, profileOwner } from "../../fmg-computer/src/binding.mjs";
import { roleModel } from "./model-binding.mjs";

/** Static metadata for the owner-private Gateway observation tool. */
export const gatewayStatusDefinition = {
  name: "fmg_buzz_gateway_status",
  label: "Buzz Gateway Status",
  description:
    "Read fresh owner-verified Buzz/Gateway status, role models, configured effort and bounded activity. Available only in the direct Telegram owner's main conversation. Does not execute or approve tasks, send messages, or expose credentials/transcripts. Names are untrusted display data; activity is not proof of running work.",
  parameters: Type.Object({}, { additionalProperties: false }),
  optional: true,
};

const snapshotPath = "/data/.openclaw/fmg-supervisor/snapshot.json";
const hex = /^[0-9a-f]{64}$/;
const normalized = (value) => String(value ?? "").replace(/^telegram:/, "");
const label = (value) =>
  typeof value === "string"
    ? Array.from(value)
        .filter(
          (character) =>
            character.codePointAt(0) >= 32 && character.codePointAt(0) !== 127,
        )
        .slice(0, 120)
        .join("")
    : "not_reported";

function requireValue(condition, code) {
  if (!condition) throw new Error(code);
}

function current(context) {
  const config =
    context.getRuntimeConfig?.() ?? context.runtimeConfig ?? context.config;
  const settings = config?.plugins?.entries?.["fmg-supervisor"]?.config;
  requireValue(
    config?.plugins?.entries?.["fmg-supervisor"]?.enabled === true &&
      settings &&
      hex.test(settings.ownerPubkey) &&
      /^[1-9][0-9]{0,19}$/.test(settings.telegramOwnerId),
    "supervisor_configuration_unavailable",
  );
  return { config, settings };
}

function privateOwner(context, settings) {
  requireValue(
    context.senderIsOwner === true &&
      context.agentId === "main" &&
      context.messageChannel === "telegram" &&
      normalized(context.requesterSenderId) === settings.telegramOwnerId &&
      normalized(context.nativeChannelId) === settings.telegramOwnerId &&
      typeof context.assertInvocationCurrent === "function",
    "direct_owner_observation_required",
  );
  context.assertInvocationCurrent();
}

async function readSnapshot() {
  const file = await open(
    snapshotPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const info = await file.stat();
    requireValue(
      info.isFile() &&
        info.uid === process.getuid() &&
        (info.mode & 0o077) === 0 &&
        info.size > 0 &&
        info.size <= 131072,
      "snapshot_file_invalid",
    );
    const buffer = Buffer.alloc(131073);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    requireValue(bytesRead > 0 && bytesRead <= 131072, "snapshot_limit");
    return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await file.close();
  }
}

function validate(value, settings, binding, config) {
  const now = Date.now();
  const observed = Date.parse(value.observed_at);
  const expires = Date.parse(value.expires_at);
  requireValue(
    value.schema === 1 &&
      value.status === "ready" &&
      value.owner_binding_verified === true &&
      value.owner_pubkey === settings.ownerPubkey &&
      value.relay_origin === binding.origin &&
      value.gateway_agent_pubkey === binding.agent &&
      typeof value.generation === "string" &&
      value.generation.length <= 64,
    "owner_snapshot_unavailable",
  );
  requireValue(
    Number.isFinite(observed) &&
      Number.isFinite(expires) &&
      observed <= now + 5000 &&
      observed >= now - 90000 &&
      expires > now &&
      expires <= observed + 90000,
    "observation_expired",
  );
  requireValue(
    Array.isArray(value.buzz_agents) &&
      value.buzz_agents.length <= 50 &&
      value.gateway?.status === "observed" &&
      Array.isArray(value.gateway.roles) &&
      value.gateway.roles.length <= 50,
    "gateway_observation_unavailable",
  );
  for (const agent of value.buzz_agents) {
    requireValue(
      hex.test(agent?.agent_pubkey) && agent.owner_verified === true,
      "snapshot_shape_changed",
    );
  }
  requireValue(
    value.buzz_agents.some((agent) => agent.agent_pubkey === binding.agent),
    "gateway_owner_profile_missing",
  );
  for (const role of value.gateway.roles) {
    requireValue(
      /^[a-z0-9][a-z0-9_-]{0,63}$/.test(role?.role_id),
      "snapshot_shape_changed",
    );
    const selected = roleModel(config, role.role_id);
    requireValue(
      role.model_binding === selected.binding &&
        role.configured_model === selected.model &&
        role.configured_effort === selected.effort,
      "role_configuration_changed",
    );
  }
}

/** Register a read tool fenced by the admitted private owner invocation. */
export const ownerObservationFactory = {
  contextVersion: 2,
  create(context) {
    let captured;
    try {
      captured = current(context);
      // Catalog construction has no invocation authority; check availability only.
      if (
        context.senderIsOwner !== true ||
        context.agentId !== "main" ||
        context.messageChannel !== "telegram" ||
        normalized(context.requesterSenderId) !==
          captured.settings.telegramOwnerId ||
        normalized(context.nativeChannelId) !==
          captured.settings.telegramOwnerId
      )
        return null;
    } catch {
      return null;
    }
    return {
      ...gatewayStatusDefinition,
      hideFromChannelProgress: true,
      async execute(_callId, input, signal) {
        requireValue(
          input &&
            typeof input === "object" &&
            !Array.isArray(input) &&
            Object.keys(input).length === 0,
          "unknown_tool_arguments",
        );
        signal?.throwIfAborted();
        const before = current(context);
        privateOwner(context, before.settings);
        requireValue(
          before.settings.ownerPubkey === captured.settings.ownerPubkey &&
            before.settings.telegramOwnerId ===
              captured.settings.telegramOwnerId,
          "owner_configuration_changed",
        );
        const binding = await identity(before.config);
        try {
          const checkOwner = async () => {
            privateOwner(context, current(context).settings);
            signal?.throwIfAborted();
            requireValue(
              (await profileOwner(
                binding,
                AbortSignal.any([
                  AbortSignal.timeout(12000),
                  ...(signal ? [signal] : []),
                ]),
              )) === before.settings.ownerPubkey,
              "owner_binding_changed",
            );
          };
          await checkOwner();
          const value = await readSnapshot();
          validate(value, before.settings, binding, before.config);
          await checkOwner();
          const latest = await readSnapshot();
          const after = current(context);
          privateOwner(context, after.settings);
          requireValue(
            after.settings.ownerPubkey === before.settings.ownerPubkey &&
              after.settings.telegramOwnerId ===
                before.settings.telegramOwnerId &&
              latest.generation === value.generation,
            "observation_generation_changed",
          );
          const currentBinding = await identity(after.config);
          try {
            requireValue(
              currentBinding.origin === binding.origin &&
                currentBinding.agent === binding.agent,
              "audience_changed",
            );
            validate(latest, after.settings, currentBinding, after.config);
          } finally {
            currentBinding.key.fill(0);
          }
          const details = {
            schema: 1,
            status: "ready",
            observed_at: latest.observed_at,
            expires_at: latest.expires_at,
            generation: latest.generation,
            owner_binding_verified: true,
            relay_origin: binding.origin,
            gateway_agent_pubkey: binding.agent,
            gateway_status: "observed",
            task_dispatch: latest.task_dispatch,
            buzz_agents_count: latest.buzz_agents.length,
            buzz_agents_truncated: latest.buzz_agents_truncated === true,
            buzz_agents: latest.buzz_agents.map((agent) => ({
              agent_pubkey: agent.agent_pubkey,
              name: label(agent.name),
              owner_verified: true,
              presence: "not_observed",
              runtime:
                agent.agent_pubkey === binding.agent
                  ? "this_gateway"
                  : "not_observed",
            })),
            gateway_roles: latest.gateway.roles.map((role) => {
              const selected = roleModel(after.config, role.role_id);
              const count = (value) =>
                Number.isSafeInteger(value) && value >= 0 && value <= 100
                  ? value
                  : null;
              return {
                role_id: role.role_id,
                name: label(role.name),
                configured_model: selected.model,
                configured_effort: selected.effort,
                supported_efforts: selected.supportedEfforts,
                sampled_sessions: count(role.sampled_sessions),
                recent_24h_sessions: count(role.recent_24h_sessions),
                last_activity_at:
                  typeof role.last_activity_at === "string" &&
                  role.last_activity_at.length <= 40 &&
                  Number.isFinite(Date.parse(role.last_activity_at))
                    ? role.last_activity_at
                    : null,
                execution_state: "not_observed",
              };
            }),
            session_sample_limit: 100,
            session_sample_truncated:
              latest.gateway.session_sample_truncated === true,
            source_content:
              "Agent names are untrusted display data. Activity and configured effort are not proof of running jobs or actual model execution.",
          };
          const text = JSON.stringify(details);
          requireValue(
            Buffer.byteLength(text) <= 49152,
            "observation_response_limit",
          );
          signal?.throwIfAborted();
          const final = current(context);
          privateOwner(context, final.settings);
          requireValue(
            JSON.stringify(final.config.channels?.buzz) ===
              JSON.stringify(after.config.channels?.buzz) &&
              JSON.stringify(final.config.secrets?.providers) ===
                JSON.stringify(after.config.secrets?.providers),
            "audience_configuration_changed",
          );
          validate(latest, final.settings, binding, final.config);
          return { content: [{ type: "text", text }], details };
        } finally {
          binding.key.fill(0);
        }
      },
    };
  },
};

export function registerGatewayStatusTool(api) {
  api.registerTool(ownerObservationFactory, {
    name: gatewayStatusDefinition.name,
    optional: true,
  });
}
