import { identity } from "../../fmg-computer/src/binding.mjs";
import { communityConfigs } from "../../fmg-computer/src/community-binding.mjs";

export const codingRoles = [
  "fmg-planner",
  "fmg-frontend",
  "fmg-backend",
  "fmg-qa",
  "fmg-release",
];

function requireValue(condition, code) {
  if (!condition) throw new Error(code);
}

/** Resolve an explicit community-to-code-project mapping; default BD stays compatible. */
export function communityProject(config, communityId, legacyDefault = false) {
  const entries = communityConfigs(config);
  const matches = entries.filter((entry) =>
    communityId === undefined
      ? entry.accountId === "default"
      : entry.id === communityId,
  );
  requireValue(matches.length === 1, "project_community_unavailable");
  const entry = matches[0];
  const rows = (
    config.plugins?.entries?.["fmg-supervisor"]?.config?.projects ?? []
  ).filter((row) => row.id === entry.id);
  requireValue(rows.length <= 1, "project_registry_invalid");
  const row = rows[0];
  if (row?.codeProjectId === undefined) {
    if (legacyDefault && entry.accountId === "default")
      return { projectId: "buzz", roleIds: codingRoles, legacy: true };
    return null;
  }
  requireValue(
    row.codeProjectId === "buzz" &&
      Array.isArray(row.roleIds) &&
      row.roleIds.length <= 12 &&
      new Set(row.roleIds).size === row.roleIds.length &&
      row.roleIds.every((role) => config.agents?.entries?.[role]),
    "project_execution_mapping_invalid",
  );
  return {
    projectId: row.codeProjectId,
    roleIds: row.roleIds.filter((role) => codingRoles.includes(role)),
    legacy: false,
  };
}

/** Export only the worktrees admitted for this community's configured code project. */
export function scopedProjectBindings(
  config,
  communityId,
  bindings,
  legacyDefault = false,
) {
  const mapping = communityProject(config, communityId, legacyDefault);
  return mapping
    ? bindings.filter(
        (binding) =>
          binding.project_id === mapping.projectId &&
          mapping.roleIds.includes(binding.role_id),
      )
    : [];
}

/** New repository proposals require an assigned coding role in the selected community. */
export function requireCommunityProject(
  config,
  communityId,
  roleId,
  projectId,
) {
  const mapping = communityProject(config, communityId, true);
  requireValue(
    mapping?.projectId === projectId && mapping.roleIds.includes(roleId),
    "project_community_execution_unconfigured",
  );
  return mapping;
}

/** Report observed admission readiness; registration never proves a completed run. */
export function projectExecutionObservation(config, communityId, bindings) {
  const mapping = communityProject(config, communityId);
  if (!mapping)
    return {
      code_project_id: null,
      repository_binding: "not_configured",
      project_execution: "not_configured",
      observed_role_bindings: [],
      execution_completed: false,
    };
  const observed = scopedProjectBindings(config, communityId, bindings);
  const ready =
    mapping.roleIds.length > 0 && observed.length === mapping.roleIds.length;
  const settings = config.plugins.entries["fmg-supervisor"].config;
  return {
    code_project_id: mapping.projectId,
    repository_url: "https://github.com/contentscoin/buzz.git",
    repository_binding: ready ? "verified" : "requires_review",
    project_execution:
      ready &&
      settings.telegramOwnerId &&
      settings.operatorUrl &&
      settings.tokenFile
        ? "ready_direct_owner_approval_required"
        : "unavailable",
    expected_coding_roles: mapping.roleIds,
    observed_role_bindings: observed,
    execution_contract: "schema4_repository_bound_proposal",
    execution_completed: false,
  };
}

/** Recheck the approved immutable audience against current explicit execution routing. */
export async function assertAudienceProject(config, proposal) {
  const entries = communityConfigs(config);
  const matches = [];
  requireValue(
    proposal.owner_pubkey ===
      config.plugins?.entries?.["fmg-supervisor"]?.config?.ownerPubkey,
    "project_owner_changed",
  );
  for (const entry of entries) {
    const binding = await identity(entry.config);
    try {
      if (
        binding.origin === proposal.relay_origin &&
        binding.agent === proposal.gateway_agent_pubkey
      )
        matches.push(entry);
    } finally {
      binding.key.fill(0);
    }
  }
  requireValue(matches.length === 1, "project_audience_changed");
  requireCommunityProject(
    config,
    matches[0].id ?? undefined,
    proposal.role_id,
    proposal.project?.project_id,
  );
}
