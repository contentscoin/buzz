import {
  createManagedAgent,
  listManagedAgents,
  updateManagedAgent,
  getAgentModels,
  getAgentConfigSurface,
  listRelayAgents,
  getChannels,
} from "@/shared/api/tauri";
import { discoverAcpRuntimes } from "@/shared/api/tauriAcpDiscovery";
import {
  startManagedAgent,
  stopManagedAgent,
  stopAllLocalManagedAgents,
  setManagedAgentStartOnAppLaunch,
  setManagedAgentAutoRestart,
  listManagedAgentRuntimes,
} from "@/shared/api/tauriManagedAgents";
import { getAgentAccessOwnerOnly } from "@/shared/api/tauriAgentAccess";
import type {
  AcpRuntimeCatalogEntry,
  ManagedAgent,
  UpdateManagedAgentInput,
} from "@/shared/api/types";
import type { MobileScope } from "@/shared/mobile/mobileBridge";
import { deriveAgentConfigFieldModel } from "./lib/agentConfigCore";
import { getPersonaProviderOptions } from "./ui/agentConfigOptions";
import { resolveModelCapabilities } from "./ui/modelCapabilities";
import { attachManagedAgentToChannel } from "./channelAgents";
import { clearScopedActiveTurnsForAgentOnStop } from "./managedAgentRuntimeHooks";

const pubkey = /^[0-9a-f]{64}$/;
const relayOrigin = (url: string) =>
  new URL(url.replace(/^wss:/, "https:").replace(/^ws:/, "http:")).origin;
function required(input: Record<string, unknown>, key: string, max = 200) {
  const value = input[key];
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error("invalid_request");
  return value.trim();
}
function project(agent: ManagedAgent, detailed = true) {
  const promptFits =
    new TextEncoder().encode(agent.systemPrompt ?? "").length <= 20_000;
  return {
    pubkey: agent.pubkey,
    name: agent.name,
    runtime: agent.runtime,
    relayUrl: agent.relayUrl,
    model: agent.model,
    provider: agent.provider,
    ...(detailed
      ? {
          ...(promptFits ? { systemPrompt: agent.systemPrompt } : {}),
          systemPromptUnavailable: !promptFits,
        }
      : {}),
    parallelism: agent.parallelism,
    status: agent.status,
    updatedAt: agent.updatedAt,
    startOnAppLaunch: agent.startOnAppLaunch,
    autoRestartOnConfigChange: agent.autoRestartOnConfigChange,
    respondTo: agent.respondTo,
    respondToAllowlist: agent.respondToAllowlist,
    backendType: agent.backend.type,
    needsRestart: agent.needsRestart,
  };
}
async function inventory(scope: MobileScope) {
  await scope.assertActive();
  const agents = (await listManagedAgents()).filter(
    (agent) => relayOrigin(agent.relayUrl) === scope.relay,
  );
  await scope.assertActive();
  return agents;
}
function selected(agents: ManagedAgent[], input: Record<string, unknown>) {
  const target = required(input, "pubkey");
  if (!pubkey.test(target)) throw new Error("invalid_request");
  const agent = agents.find((a) => a.pubkey === target);
  if (!agent) throw new Error("agent_unavailable");
  return agent;
}
function runtimeFor(agent: ManagedAgent, catalog: AcpRuntimeCatalogEntry[]) {
  return catalog.find(
    (runtime) =>
      runtime.id === agent.runtime || runtime.command === agent.agentCommand,
  );
}
async function options(agent: ManagedAgent) {
  const [catalog, models, surface] = await Promise.all([
    discoverAcpRuntimes(),
    getAgentModels(agent.pubkey).catch(() => null),
    getAgentConfigSurface(agent.pubkey).catch(() => null),
  ]);
  const runtime = runtimeFor(agent, catalog);
  const fields = deriveAgentConfigFieldModel({
    config: {
      preferred_runtime: agent.runtime,
      provider: agent.provider,
      model: agent.model,
      env_vars: agent.envVars,
    },
    runtime,
    scope: "instance",
  });
  const descriptor = fields.fields.find((field) => field.kind === "effort");
  const effortOptions =
    agent.backend.type !== "local"
      ? []
      : surface?.effortConfigId
        ? (surface.effortOptions ?? []).map((option) => ({
            id: option.value,
            label: option.displayName ?? option.value,
          }))
        : descriptor?.kind === "effort" && descriptor.render === "control"
          ? (
              runtime?.effortCanonicalValues ??
              resolveModelCapabilities(agent.provider ?? "", agent.model ?? "")
                .supportedEfforts
            ).map((id) => ({ id, label: id }))
          : [];
  return {
    runtimes: catalog.map((r) => ({
      id: r.id,
      label: r.label,
      available: r.availability === "available",
      maxParallelism: r.maxParallelism ?? null,
    })),
    providers: runtime?.providerEnvVar
      ? getPersonaProviderOptions(agent.provider ?? "", runtime.id).map(
          (p) => ({ id: p.id, label: p.label }),
        )
      : [],
    models: (models?.models ?? []).map((m) => ({
      id: m.id,
      label: m.name ?? m.id,
    })),
    modelsUnavailable: models === null,
    effortOptions,
    effort:
      surface?.normalized.thinkingEffort?.value ??
      (descriptor?.kind === "effort" ? descriptor.value : null),
    effortKind: surface?.effortConfigId
      ? "native"
      : descriptor?.kind === "effort" && descriptor.render === "control"
        ? "env"
        : "unavailable",
    effortKey:
      descriptor?.kind === "effort" &&
      descriptor.currentPersistence.kind === "envVar"
        ? descriptor.currentPersistence.key
        : null,
    omissions: fields.omissions,
    ownerOnly: await getAgentAccessOwnerOnly(),
  };
}

/** Calls the exact native agent APIs used by Desktop, retaining native runtime policy and credentials. */
export async function mobileAgentManagement(
  action: string,
  input: Record<string, unknown>,
  scope: MobileScope,
): Promise<unknown> {
  const commandScope = {
    expectedRelayUrl: scope.relay,
    expectedSignerPubkey: scope.owner,
  };
  const agents = await inventory(scope);
  if (action === "agents.channels.list")
    return {
      channels:
        (await getChannels(null)).channels?.map((channel) => ({
          id: channel.id,
          name: channel.name,
        })) ?? [],
    };
  if (action === "agents.list") {
    const runtimes = await listManagedAgentRuntimes();
    return {
      agents: agents.slice(0, 100).map((agent) => ({
        ...project(agent, false),
        execution:
          runtimes.find(
            (r) =>
              r.pubkey === agent.pubkey &&
              relayOrigin(r.relayUrl) === scope.relay,
          )?.lifecycle ?? "unobserved",
      })),
      truncated: agents.length > 100,
    };
  }
  if (action === "agents.catalog") {
    const catalog = await discoverAcpRuntimes();
    return {
      runtimes: catalog.map((r) => ({
        id: r.id,
        label: r.label,
        available: r.availability === "available",
        maxParallelism: r.maxParallelism ?? null,
      })),
      ownerOnly: await getAgentAccessOwnerOnly(),
    };
  }
  if (action === "agents.stop_all") {
    await scope.assertActive();
    const result = await stopAllLocalManagedAgents(commandScope);
    for (const key of result.stoppedPubkeys)
      clearScopedActiveTurnsForAgentOnStop(key, scope.relay, scope.owner);
    return {
      ...result,
      failures: result.failures.map((failure) => ({
        name: failure.name,
        error: "stop_failed",
      })),
    };
  }
  if (action === "agents.start_all") {
    const results = [];
    const presence = await listRelayAgents();
    for (const agent of agents
      .filter((a) => a.backend.type === "local")
      .slice(0, 100)) {
      await scope.assertActive();
      if (
        agent.status === "running" ||
        presence.some(
          (p) =>
            p.pubkey === agent.pubkey &&
            (p.status === "online" || p.status === "away"),
        )
      ) {
        results.push({ pubkey: agent.pubkey, status: "already_active" });
        continue;
      }
      try {
        await startManagedAgent(agent.pubkey, commandScope);
        results.push({ pubkey: agent.pubkey, status: "started" });
      } catch {
        results.push({ pubkey: agent.pubkey, status: "failed" });
      }
    }
    return { results, truncated: agents.length > 100 };
  }
  if (action === "agents.create") {
    if (
      "systemPrompt" in input &&
      (typeof input.systemPrompt !== "string" ||
        input.systemPrompt.length > 20_000)
    )
      throw new Error("invalid_request");
    const catalog = await discoverAcpRuntimes();
    const runtime = catalog.find(
      (r) =>
        r.id === required(input, "runtimeId") &&
        r.availability === "available" &&
        r.command,
    );
    if (!runtime?.command) throw new Error("runtime_unavailable");
    await scope.assertActive();
    const response = await createManagedAgent({
      name: required(input, "name", 120),
      systemPrompt:
        typeof input.systemPrompt === "string" &&
        input.systemPrompt.length <= 20_000
          ? input.systemPrompt
          : undefined,
      relayUrl: scope.relay,
      ...commandScope,
      agentCommand: runtime.command,
      agentArgs: runtime.defaultArgs,
      backend: { type: "local" },
      spawnAfterCreate: false,
      startOnAppLaunch: input.startOnAppLaunch === true,
    });
    // Never forward privateKeyNsec, env, provider configuration, native error text or file paths.
    return {
      agent: project(response.agent),
      profileSyncPending: !!response.profileSyncError,
    };
  }
  const agent = selected(agents, input);
  if (action === "agents.models")
    return { agent: project(agent), ...(await options(agent)) };
  if (
    action === "agents.start" ||
    action === "agents.stop" ||
    action === "agents.restart"
  ) {
    if (agent.backend.type !== "local")
      throw new Error("remote_lifecycle_unavailable");
    await scope.assertActive();
    if (action !== "agents.start") {
      await stopManagedAgent(agent.pubkey, commandScope);
      clearScopedActiveTurnsForAgentOnStop(
        agent.pubkey,
        scope.relay,
        scope.owner,
      );
    }
    if (action !== "agents.stop") {
      const presence = await listRelayAgents();
      if (
        action === "agents.start" &&
        presence.some(
          (p) =>
            p.pubkey === agent.pubkey &&
            (p.status === "online" || p.status === "away"),
        )
      )
        throw new Error("already_active");
      await scope.assertActive();
      await startManagedAgent(agent.pubkey, commandScope);
    }
    return { agent: project(selected(await inventory(scope), input)) };
  }
  if (action === "agents.attach") {
    await scope.assertActive();
    const result = await attachManagedAgentToChannel(
      required(input, "channelId"),
      { agent, ...commandScope, ensureRunning: false },
    );
    return { attached: true, result: { started: result.started } };
  }
  if (action !== "agents.update") throw new Error("action_unavailable");
  if (required(input, "expectedUpdatedAt") !== agent.updatedAt)
    throw new Error("revision_conflict");
  const update: UpdateManagedAgentInput = {
    pubkey: agent.pubkey,
    ...commandScope,
    expectedUpdatedAt: agent.updatedAt,
  };
  if ("name" in input) update.name = required(input, "name", 120);
  if ("systemPrompt" in input) {
    if (
      typeof input.systemPrompt !== "string" ||
      input.systemPrompt.length > 20_000
    )
      throw new Error("invalid_request");
    update.systemPrompt = input.systemPrompt || null;
  }
  if ("parallelism" in input) {
    const catalog = await discoverAcpRuntimes();
    const runtime =
      "runtimeId" in input
        ? catalog.find((r) => r.id === input.runtimeId)
        : runtimeFor(agent, catalog);
    if (
      !Number.isInteger(input.parallelism) ||
      Number(input.parallelism) < 1 ||
      Number(input.parallelism) > Math.min(32, runtime?.maxParallelism ?? 32)
    )
      throw new Error("parallelism_invalid");
    update.parallelism = Number(input.parallelism);
  }
  if ("runtimeId" in input) {
    const runtime = (await discoverAcpRuntimes()).find(
      (r) => r.id === input.runtimeId && r.availability === "available",
    );
    if (!runtime?.command) throw new Error("runtime_unavailable");
    update.agentCommand = runtime.command;
    update.agentArgs = runtime.defaultArgs;
    update.harnessOverride = true;
    update.model = null;
    update.provider = null;
  } else {
    for (const key of ["model", "provider"] as const) {
      if (key in input) {
        if (typeof input[key] !== "string" || String(input[key]).length > 300)
          throw new Error("invalid_request");
        update[key] = String(input[key]) || null;
      }
    }
    if ("effort" in input) {
      const config = await options({
        ...agent,
        model: update.model === undefined ? agent.model : update.model,
        provider:
          update.provider === undefined ? agent.provider : update.provider,
      });
      if (
        typeof input.effort !== "string" ||
        (!config.effortOptions.some((o) => o.id === input.effort) &&
          input.effort !== "")
      )
        throw new Error("effort_unavailable");
      if (config.effortKind === "native")
        update.effortLevel = input.effort || null;
      else if (config.effortKind === "env" && config.effortKey) {
        update.envVars = { ...agent.envVars };
        if (input.effort) update.envVars[config.effortKey] = input.effort;
        else delete update.envVars[config.effortKey];
      } else throw new Error("effort_unavailable");
    }
  }
  if ("respondTo" in input) {
    if (
      !["owner-only", "allowlist", "anyone"].includes(String(input.respondTo))
    )
      throw new Error("invalid_request");
    if ((await getAgentAccessOwnerOnly()) && input.respondTo !== "owner-only")
      throw new Error("owner_only_required");
    update.respondTo = input.respondTo as ManagedAgent["respondTo"];
    if ("respondToAllowlist" in input) {
      if (
        !Array.isArray(input.respondToAllowlist) ||
        input.respondToAllowlist.length > 50 ||
        !input.respondToAllowlist.every(
          (p) => typeof p === "string" && pubkey.test(p),
        )
      )
        throw new Error("invalid_request");
      update.respondToAllowlist = input.respondToAllowlist as string[];
    }
  }
  await scope.assertActive();
  const response = await updateManagedAgent(update);
  if (typeof input.startOnAppLaunch === "boolean") {
    await scope.assertActive();
    await setManagedAgentStartOnAppLaunch(agent.pubkey, input.startOnAppLaunch);
  }
  if (typeof input.autoRestartOnConfigChange === "boolean") {
    await scope.assertActive();
    await setManagedAgentAutoRestart(
      agent.pubkey,
      input.autoRestartOnConfigChange,
    );
  }
  return {
    agent: project(selected(await inventory(scope), input)),
    profileSyncPending: !!response.profileSyncError,
    applyOnNextStart: true,
  };
}
