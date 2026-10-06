import { createHash } from "node:crypto";
import { execFile as callbackExecFile } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "typebox";
import { identity, profileOwner } from "../../fmg-computer/src/binding.mjs";
import { ownerObservationFactory } from "./gateway-status.mjs";
import { roleModel } from "./model-binding.mjs";
import { projectBindings } from "./project-binding.mjs";
import { operatorRequest } from "../../fmg-computer/src/task-view.mjs";

const execFile = promisify(callbackExecFile);
const id = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const roomId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const normalized = (value) => String(value ?? "").replace(/^telegram:/, "");

/** Explicit community/role registry; a registry entry never grants execution. */
export const projectsSchema = {
  type: "array",
  minItems: 1,
  maxItems: 4,
  items: {
    type: "object",
    properties: {
      id: { type: "string", pattern: id.source },
      name: { type: "string", minLength: 1, maxLength: 80 },
      buzzAccountId: { type: "string", pattern: id.source },
      roleIds: {
        type: "array",
        maxItems: 12,
        uniqueItems: true,
        items: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,63}$" },
      },
    },
    required: ["id", "name", "buzzAccountId", "roleIds"],
    additionalProperties: false,
  },
};

/** Private owner catalog: separately verifies each configured Buzz account. */
export const gatewayProjectsDefinition = {
  name: "fmg_buzz_gateway_projects",
  label: "Buzz Project Registry",
  description:
    "Read explicitly registered projects, separately verified community connections, allowed mention rooms, role models/effort and legacy task-ledger scope. Direct Telegram owner main conversation only. Registry and connectivity do not grant execution or prove project repository access. No dispatch, approval, message delivery, transcripts or credentials.",
  parameters: Type.Object({}, { additionalProperties: false }),
  optional: true,
};

function requireValue(condition, code) {
  if (!condition) throw new Error(code);
}

function cleanLabel(value) {
  return Array.from(value.slice(0, 120))
    .filter((char) => char.codePointAt(0) >= 32 && char.codePointAt(0) !== 127)
    .join("");
}

function settingsOf(config) {
  const plugin = config?.plugins?.entries?.["fmg-supervisor"];
  requireValue(
    plugin?.enabled === true &&
      /^[0-9a-f]{64}$/.test(plugin.config?.ownerPubkey) &&
      /^[1-9][0-9]{0,19}$/.test(plugin.config?.telegramOwnerId),
    "project_owner_unavailable",
  );
  return plugin.config;
}

function registry(config) {
  const projects = settingsOf(config).projects;
  requireValue(
    Array.isArray(projects) && projects.length > 0 && projects.length <= 4,
    "project_registry_unconfigured",
  );
  const ids = new Set(),
    accounts = new Set(),
    roles = new Set();
  for (const project of projects) {
    requireValue(
      project &&
        Object.keys(project).sort().join(",") ===
          "buzzAccountId,id,name,roleIds" &&
        id.test(project.id) &&
        id.test(project.buzzAccountId) &&
        typeof project.name === "string" &&
        project.name.length > 0 &&
        project.name.length <= 80 &&
        cleanLabel(project.name) === project.name &&
        Array.isArray(project.roleIds) &&
        project.roleIds.length <= 12 &&
        !ids.has(project.id) &&
        !accounts.has(project.buzzAccountId),
      "project_registry_invalid",
    );
    ids.add(project.id);
    accounts.add(project.buzzAccountId);
    for (const role of project.roleIds) {
      requireValue(
        /^[a-z0-9][a-z0-9_-]{0,63}$/.test(role) &&
          role !== "main" &&
          !roles.has(role) &&
          config.agents?.entries?.[role],
        "project_role_mapping_invalid",
      );
      roles.add(role);
    }
  }
  return projects;
}

function accountConfig(config, accountId) {
  const base = config.channels?.buzz;
  const override = base?.accounts?.[accountId];
  requireValue(
    base?.enabled === true &&
      (accountId === "default" || (override && typeof override === "object")),
    "project_account_unavailable",
  );
  const channel = { ...base, ...override };
  delete channel.accounts;
  requireValue(channel.enabled !== false, "project_account_disabled");
  return { ...config, channels: { ...config.channels, buzz: channel } };
}

function fingerprint(config) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        settings: settingsOf(config),
        buzz: config.channels?.buzz,
        agents: config.agents,
        providers: config.secrets?.providers,
      }),
    )
    .digest("hex");
}

async function connections(signal) {
  const { stdout } = await execFile(
    "/usr/local/bin/openclaw",
    ["channels", "status", "--channel", "buzz", "--probe", "--json"],
    { timeout: 20000, maxBuffer: 262144, signal, encoding: "utf8" },
  );
  const start = stdout.indexOf("{");
  requireValue(start >= 0, "project_connection_observation_invalid");
  const accounts = JSON.parse(stdout.slice(start)).channelAccounts?.buzz;
  requireValue(
    Array.isArray(accounts) && accounts.length <= 20,
    "project_connection_observation_invalid",
  );
  return accounts;
}

async function observeProject(config, project, statuses, signal) {
  const scoped = accountConfig(config, project.buzzAccountId);
  const binding = await identity(scoped);
  try {
    const owner = settingsOf(config).ownerPubkey;
    requireValue(
      (await profileOwner(binding, signal)) === owner,
      "project_owner_binding_changed",
    );
    const matches = statuses.filter(
      (row) => row.accountId === project.buzzAccountId,
    );
    requireValue(
      matches.length === 1,
      "project_connection_observation_missing",
    );
    const status = matches[0];
    requireValue(
      status.probe?.publicKey === binding.agent,
      "project_gateway_identity_changed",
    );
    const channel = scoped.channels.buzz;
    const allowedRooms = Object.entries(channel.groups ?? {}).filter(
      ([key, group]) => roomId.test(key) && group?.enabled === true,
    );
    requireValue(
      allowedRooms.length <= 50 &&
        Array.isArray(status.probe.rooms) &&
        status.probe.rooms.length <= 50,
      "project_room_limit",
    );
    const roles = project.roleIds.map((roleId) => {
      const model = roleModel(config, roleId);
      return {
        role_id: roleId,
        configured_model: model.model,
        configured_effort: model.effort,
        supported_efforts: model.supportedEfforts,
      };
    });
    await profileOwner(binding, signal).then((value) =>
      requireValue(value === owner, "project_owner_binding_changed"),
    );
    const connected =
      status.enabled === true &&
      status.configured === true &&
      status.running === true &&
      status.connected === true &&
      status.probe.ok === true;
    let ledger = "unavailable";
    try {
      const result = await operatorRequest(
        config,
        { owner, agent: binding.agent, origin: binding.origin },
        "view_list",
        {},
        signal,
      );
      requireValue(
        Array.isArray(result.tasks) && result.tasks.length <= 25,
        "project_ledger_invalid",
      );
      ledger = "community_isolated";
    } catch {
      signal.throwIfAborted();
    }
    return {
      project_id: project.id,
      name: project.name,
      account_id: project.buzzAccountId,
      status: connected ? "connected" : "disconnected",
      owner_binding_verified: true,
      relay_origin: binding.origin,
      gateway_agent_pubkey: binding.agent,
      reply_rooms: allowedRooms.map(([key, group]) => {
        const rooms = status.probe.rooms.filter((room) => room.id === key);
        const name =
          rooms.length === 1 && typeof rooms[0].name === "string"
            ? cleanLabel(rooms[0].name)
            : null;
        return {
          room_id: key,
          name,
          observed_in_probe: rooms.length === 1,
          require_mention:
            group.requireMention ?? channel.requireMention ?? null,
        };
      }),
      roles,
      task_ledger_scope: ledger,
      project_execution: "not_configured",
      repository_binding: "not_configured",
    };
  } finally {
    binding.key.fill(0);
  }
}

async function collect(config, ledgerOrigin, signal) {
  const projects = registry(config),
    observedAt = new Date().toISOString();
  const statuses = await connections(signal);
  const results = await Promise.allSettled(
    projects.map((project) =>
      observeProject(config, project, statuses, signal),
    ),
  );
  signal.throwIfAborted();
  const entries = results.map((result, index) =>
    result.status === "fulfilled"
      ? result.value
      : {
          project_id: projects[index].id,
          name: projects[index].name,
          account_id: projects[index].buzzAccountId,
          status: "unavailable",
          owner_binding_verified: false,
          error_code: "project_observation_unavailable",
          project_execution: "not_configured",
          repository_binding: "not_configured",
        },
  );
  return {
    schema: 1,
    read_only: true,
    observed_at: observedAt,
    expires_at: new Date(Date.parse(observedAt) + 90000).toISOString(),
    legacy_task_ledger_origin: ledgerOrigin,
    projects: entries,
    managed_code_project: {
      project_id: "buzz",
      manager: "main",
      execution_host: "hostinger",
      task_ledger_scope: "selected_registered_community",
      observed_role_bindings: await projectBindings(config, signal),
      dispatch: "direct_owner_hash_approval_required",
      execution_completed: false,
    },
    source_content:
      "Community connections are distinct from the managed Buzz code project. Connectivity does not prove task completion. Explicit community selection binds each new proposal and private document scope. Legacy OAuth remains default-community-only. Coding role worktrees still belong to the shared Buzz repository, not independent community repositories.",
  };
}

/** Register owner-only, read-only multi-community project observations. */
export function registerProjectTools(api) {
  api.registerTool(
    {
      contextVersion: 2,
      create(context) {
        const observation = ownerObservationFactory.create(context);
        if (!observation) return null;
        return {
          ...gatewayProjectsDefinition,
          hideFromChannelProgress: true,
          async execute(callId, input, signal) {
            requireValue(
              input &&
                typeof input === "object" &&
                !Array.isArray(input) &&
                Object.keys(input).length === 0,
              "unknown_tool_arguments",
            );
            const combined = AbortSignal.any([
              AbortSignal.timeout(55000),
              ...(signal ? [signal] : []),
            ]);
            const current = () =>
              context.getRuntimeConfig?.() ??
              context.runtimeConfig ??
              context.config;
            const before = (await observation.execute(callId, {}, combined))
              .details;
            const config = current(),
              expected = fingerprint(config);
            const details = await collect(
              config,
              before.relay_origin,
              combined,
            );
            const after = (await observation.execute(callId, {}, combined))
              .details;
            requireValue(
              before.generation === after.generation &&
                before.relay_origin === after.relay_origin &&
                before.gateway_agent_pubkey === after.gateway_agent_pubkey &&
                fingerprint(current()) === expected,
              "project_configuration_changed",
            );
            combined.throwIfAborted();
            context.assertInvocationCurrent();
            const text = JSON.stringify(details);
            requireValue(
              Buffer.byteLength(text) <= 32768,
              "project_response_limit",
            );
            return { content: [{ type: "text", text }], details };
          },
        };
      },
    },
    { name: gatewayProjectsDefinition.name, optional: true },
  );
}

function directOwner(context, settings) {
  requireValue(
    context.channel === "telegram" &&
      context.isAuthorizedSender === true &&
      context.agentId === "main" &&
      normalized(context.senderId) === settings.telegramOwnerId &&
      normalized(context.from) === settings.telegramOwnerId,
    "direct_owner_command_required",
  );
  context.assertOwnerCurrent?.();
}

/** Human-invoked fallback for project reads; never edits project configuration. */
export function registerProjectCommand(api) {
  api.registerCommand({
    name: "fmg_project",
    channels: ["telegram"],
    description:
      "프로젝트별 Buzz 연결·역할·작업 원장 범위 조회 (소유자 개인 채팅)",
    acceptsArgs: true,
    requireAuth: true,
    async handler(context) {
      try {
        const config = context.config,
          settings = settingsOf(config);
        directOwner(context, settings);
        const args = (context.args ?? "").trim().split(/\s+/);
        if (
          !(args.length === 1 && args[0] === "list") &&
          !(args.length === 2 && args[0] === "get" && id.test(args[1]))
        )
          return {
            text: "사용법: /fmg_project list\n/fmg_project get <프로젝트 ID>\n조회 명령이며 작업을 배정·승인·실행하지 않습니다.",
          };
        const expected = fingerprint(config),
          signal = AbortSignal.timeout(40000);
        const binding = await identity(config);
        try {
          requireValue(
            (await profileOwner(binding, signal)) === settings.ownerPubkey,
            "owner_binding_changed",
          );
          const result = await collect(config, binding.origin, signal);
          requireValue(
            (await profileOwner(binding, signal)) === settings.ownerPubkey,
            "owner_binding_changed",
          );
          directOwner(context, settingsOf(context.config));
          requireValue(
            fingerprint(context.config) === expected,
            "project_configuration_changed",
          );
          signal.throwIfAborted();
          const entries =
            args[0] === "list"
              ? result.projects
              : result.projects.filter(
                  (project) => project.project_id === args[1],
                );
          requireValue(entries.length > 0, "project_unavailable");
          return {
            text:
              entries
                .map((project) =>
                  [
                    `커뮤니티 연결: ${project.name} (${project.project_id})`,
                    `연결: ${project.status === "connected" ? "정상" : project.status === "disconnected" ? "끊김" : "조회 불가"}`,
                    `소유권: ${project.owner_binding_verified ? "검증됨" : "확인 불가"}`,
                    `응답 방: ${project.reply_rooms?.map((room) => `${room.name ?? room.room_id}${room.require_mention === true ? " (멘션 필요)" : ""}`).join(", ") || "확인 불가"}`,
                    `역할: ${project.roles?.map((role) => `${role.role_id} · ${role.configured_model} · ${role.configured_effort}`).join("\n") || "배정 없음 또는 조회 불가"}`,
                    `작업 원장: ${project.task_ledger_scope === "community_isolated" ? "커뮤니티별 분리 원장 · 현재 조회 확인" : "이 커뮤니티 원장 조회 불가 · 최신 소유권 snapshot 확인 필요"}`,
                    "코드 프로젝트와 커뮤니티 연결은 별개입니다.",
                  ].join("\n"),
                )
                .join("\n\n") +
              `\n\n중앙 코드 프로젝트: buzz (contentscoin/buzz)\n총괄: Hostinger main\n작업 공간 확인: ${result.managed_code_project.observed_role_bindings.length}/5개 역할\n제안: 소유자 Telegram 개인 대화에서 총괄자에게 요청\n실행: 직접 /fmg_task 해시 승인 필요\n원장: community_id로 선택 · 생략하면 BD · 커뮤니티별 기록과 문서 권한 분리\n코드 작업 공간: 공용 buzz 저장소 · 커뮤니티별 별도 저장소와 자동 보고는 미구현\n연결 정상과 작업 공간 확인은 실제 실행 완료를 뜻하지 않습니다.`,
          };
        } finally {
          binding.key.fill(0);
        }
      } catch {
        return {
          text: "프로젝트를 조회하지 못했습니다. 소유자 Telegram 개인 채팅, 프로젝트 ID와 현재 소유권·연결 설정을 확인하세요. 빈 목록이나 정상 상태로 처리하지 않았습니다.",
        };
      }
    },
  });
}
