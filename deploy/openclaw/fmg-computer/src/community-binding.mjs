import { createHash } from "node:crypto";
import { identity } from "./binding.mjs";

const id = /^[a-z0-9][a-z0-9_-]{0,39}$/;
function requireValue(condition) {
  if (!condition) throw new Error("community_binding_unavailable");
}

/** Resolve only explicitly registered communities; no relay URL comes from a caller. */
export function communityConfigs(config) {
  const projects =
    config.plugins?.entries?.["fmg-supervisor"]?.config?.projects ?? [];
  requireValue(Array.isArray(projects) && projects.length <= 4);
  const ids = new Set(),
    accounts = new Set();
  const entries = projects.map((project) => {
    requireValue(
      project &&
        id.test(project.id) &&
        id.test(project.buzzAccountId) &&
        !ids.has(project.id) &&
        !accounts.has(project.buzzAccountId),
    );
    ids.add(project.id);
    accounts.add(project.buzzAccountId);
    const base = config.channels?.buzz;
    const override = base?.accounts?.[project.buzzAccountId];
    requireValue(
      base?.enabled === true &&
        (project.buzzAccountId === "default" ||
          (override &&
            typeof override === "object" &&
            !Array.isArray(override))),
    );
    const channel = {
      ...base,
      ...(project.buzzAccountId === "default" ? {} : override),
    };
    delete channel.accounts;
    requireValue(channel.enabled !== false);
    return {
      id: project.id,
      accountId: project.buzzAccountId,
      config: { ...config, channels: { ...config.channels, buzz: channel } },
    };
  });
  // The legacy default account remains available without inventing a project registration.
  if (!accounts.has("default"))
    entries.unshift({ id: null, accountId: "default", config });
  return entries;
}

/** Deny duplicate audience registrations before starting services or writing receipts. */
export async function distinctCommunities(config) {
  const entries = communityConfigs(config),
    scopes = new Set();
  for (const entry of entries) {
    const binding = await identity(entry.config);
    try {
      const scope = `${binding.origin}:${binding.agent}`;
      requireValue(!scopes.has(scope));
      scopes.add(scope);
    } finally {
      binding.key.fill(0);
    }
  }
  return entries;
}

/** Close every community even when one connection's shutdown fails. */
export async function closeCommunities(closers) {
  const results = await Promise.allSettled(closers.map((close) => close()));
  if (results.some((result) => result.status === "rejected"))
    throw new Error("community_shutdown_unconfirmed");
}

/** Missing selection preserves the legacy default; an unknown selection fails closed. */
export function communityConfig(config, communityId) {
  const entries = communityConfigs(config);
  const selected =
    communityId === undefined
      ? entries.find((entry) => entry.accountId === "default")
      : entries.find((entry) => entry.id === communityId);
  requireValue(selected);
  return selected.config;
}

/** Public audience digest matches Python's sorted, compact canonical JSON. */
export function audienceScope(audience) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        gateway_agent_pubkey: audience.gateway_agent_pubkey,
        owner_pubkey: audience.owner_pubkey,
        relay_origin: audience.relay_origin,
      }),
    )
    .digest("hex");
}

/** Find exactly one configured audience, without retaining any private key. */
export async function audienceConfig(config, owner, expected) {
  const matches = [];
  requireValue(expected?.owner_pubkey === owner);
  for (const entry of communityConfigs(config)) {
    const binding = await identity(entry.config);
    try {
      if (
        binding.origin === expected.relay_origin &&
        binding.agent === expected.gateway_agent_pubkey
      )
        matches.push(entry.config);
    } finally {
      binding.key.fill(0);
    }
  }
  requireValue(matches.length === 1);
  return matches[0];
}
