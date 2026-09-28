import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, constants } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Type, type Static } from "typebox";
import {
  buildJsonPluginConfigSchema,
  definePluginEntry,
  type OpenClawConfig,
  type OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/core";
import { createAccountListHelpers } from "openclaw/plugin-sdk/account-helpers";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeOptionalAccountId,
} from "openclaw/plugin-sdk/account-id";
import { resolveSecretInputString } from "openclaw/plugin-sdk/secret-input";
import { toolPluginMetadataSymbol } from "openclaw/plugin-sdk/tool-plugin";

const execFile = promisify(execFileCallback);

const PLUGIN_VERSION = "0.2.2";
export const BUZZ_ADMIN_BUILD_IDENTITY =
  "0011f1410716da2542868c29a5530088c8601775210d36ae1f9849925c995f2e";
const LOADED_RUNTIME_ENTRY_SHA256 = createHash("sha256")
  .update(readFileSync(fileURLToPath(import.meta.url)))
  .digest("hex");
const DEFAULT_BUZZ_CLI = "/data/.openclaw/bin/buzz";
const DEFAULT_OPENCLAW_CLI = "/usr/local/bin/openclaw";
const HEX_EVENT_ID = /^[0-9a-f]{64}$/iu;
const CHANNEL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const CANONICAL_BUZZ_ACCOUNT_ID = /^(?!(?:constructor|prototype)$)[a-z0-9][a-z0-9_-]{0,63}$/u;
const OUTCOME_MAX_BYTES = 1024;
const REPORT_ITEM_MAX_BYTES = 2048;
const SUMMARY_MAX_BYTES = 16_000;

type UnknownRecord = Record<string, unknown>;

type BuzzAccount = {
  accountId?: string;
  enabled?: boolean;
  configured?: boolean;
  running?: boolean;
  connected?: boolean;
  lastError?: string | null;
  probe?: {
    ok?: boolean;
    roomCount?: number;
    rooms?: unknown[];
  };
};

type RuntimeCredentialState = {
  relayUrl: string;
  privateKey: string;
  authTag: string;
  accountId: string;
};

type CommandOptions = {
  env?: NodeJS.ProcessEnv;
  timeout: number;
  maxBuffer: number;
  encoding: "utf8";
};

type CommandResult = {
  stdout: string;
};

/** Injectable process seams used by the production plugin and focused tests. */
export type BuzzAdminDependencies = {
  runCommand: (file: string, args: string[], options: CommandOptions) => Promise<CommandResult>;
  isExecutable: (path: string) => Promise<boolean>;
};

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function canonicalBuzzAccountId(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const normalized = normalizeOptionalAccountId(value);
  if (!normalized || !CANONICAL_BUZZ_ACCOUNT_ID.test(normalized)) {
    throw new Error("Buzz account ID must be a valid account key.");
  }
  return normalized;
}

const { resolveDefaultAccountId: resolveDefaultBuzzAccountId } = createAccountListHelpers(
  "buzz",
  {
    normalizeAccountId,
    fallbackAccountIdWhenEmpty: false,
    implicitDefaultAccount: {
      channelKeys: ["relayUrl", "privateKey"],
      envVars: ["BUZZ_RELAY_URL", "BUZZ_PRIVATE_KEY"],
    },
  },
);

export function resolveBuzzCredentialState(
  config: UnknownRecord | undefined,
  requestedAccountId?: string,
): RuntimeCredentialState {
  const requestedId = canonicalBuzzAccountId(requestedAccountId);
  const accountId = requestedId ?? resolveDefaultBuzzAccountId((config ?? {}) as OpenClawConfig);
  if (!CANONICAL_BUZZ_ACCOUNT_ID.test(accountId)) {
    throw new Error("Buzz account ID must be a valid account key.");
  }

  const channels = asRecord(config?.channels);
  const root = asRecord(channels?.buzz) ?? {};
  const accounts = asRecord(root.accounts);
  const hasExplicitAccount = Object.hasOwn(accounts ?? {}, accountId);
  const allowEnv = accountId === DEFAULT_ACCOUNT_ID && !hasExplicitAccount;
  const identity = allowEnv
    ? root
    : (asRecord(accounts?.[accountId]) ?? {});
  const configPath = allowEnv ? "channels.buzz" : `channels.buzz.accounts.${accountId}`;
  const privateKeyResolution = resolveSecretInputString({
    value: identity.privateKey,
    path: `${configPath}.privateKey`,
    mode: "inspect",
  });
  const authTagResolution = resolveSecretInputString({
    value: identity.authTag,
    path: `${configPath}.authTag`,
    mode: "inspect",
  });

  return {
    relayUrl:
      asTrimmedString(identity.relayUrl) ||
      (allowEnv ? asTrimmedString(process.env.BUZZ_RELAY_URL) : ""),
    privateKey:
      privateKeyResolution.value ??
      (allowEnv && privateKeyResolution.status === "missing"
        ? asTrimmedString(process.env.BUZZ_PRIVATE_KEY)
        : ""),
    authTag:
      authTagResolution.value ??
      (allowEnv && authTagResolution.status === "missing"
        ? asTrimmedString(process.env.BUZZ_AUTH_TAG)
        : ""),
    accountId,
  };
}

function resolveRuntimeConfig(context: OpenClawPluginToolContext): UnknownRecord | undefined {
  return (context.getRuntimeConfig?.() ?? context.runtimeConfig ?? context.config) as
    | UnknownRecord
    | undefined;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function runCommand(
  file: string,
  args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const { stdout } = await execFile(file, args, options);
  return { stdout };
}

const productionDependencies: BuzzAdminDependencies = { runCommand, isExecutable };

function childEnv(credentials: RuntimeCredentialState): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "HOME",
    "TMPDIR",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
  ]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  env.BUZZ_RELAY_URL = credentials.relayUrl;
  env.BUZZ_PRIVATE_KEY = credentials.privateKey;
  if (credentials.authTag) env.BUZZ_AUTH_TAG = credentials.authTag;
  return env;
}

function requireCredentials(credentials: RuntimeCredentialState): void {
  if (!/^wss?:\/\//iu.test(credentials.relayUrl)) {
    throw new Error("The runtime Buzz relay URL is unavailable.");
  }
  if (!credentials.privateKey) {
    throw new Error(
      "The Buzz SecretRef is not resolved in this Gateway tool context. Reload OpenClaw secrets before retrying.",
    );
  }
}

function safeJson(value: string): UnknownRecord | undefined {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function requireAcceptedWriteEventId(value: string): string {
  const response = safeJson(value);
  if (response?.accepted !== true) {
    throw new Error("Buzz CLI did not confirm that the event was accepted.");
  }
  if (typeof response.event_id !== "string" || !HEX_EVENT_ID.test(response.event_id)) {
    throw new Error("Buzz CLI did not return an authoritative event ID.");
  }
  return response.event_id.toLowerCase();
}

function findEventId(value: unknown): string | undefined {
  if (typeof value === "string" && HEX_EVENT_ID.test(value)) return value.toLowerCase();
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = findEventId(item);
      if (match) return match;
    }
  }
  const record = asRecord(value);
  if (record) {
    for (const key of ["event_id", "eventId", "message_id", "messageId", "id", "event"]) {
      const match = findEventId(record[key]);
      if (match) return match;
    }
  }
  return undefined;
}

function cleanError(error: unknown, action: string): Error {
  const record = asRecord(error);
  const code = typeof record?.code === "number" || typeof record?.code === "string"
    ? ` (${String(record.code)})`
    : "";
  return new Error(`${action} failed${code}. Check the Gateway logs for the redacted command diagnostic.`);
}

function agentToolResult<T extends UnknownRecord>(details: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(details) }],
    details,
  };
}

function assertUtf8ByteLength(field: string, value: string, maxBytes: number): void {
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`${field} must be at most ${maxBytes} UTF-8 bytes.`);
  }
}

function assertWorkReportByteLengths(input: WorkReportInput): void {
  assertUtf8ByteLength("outcome", input.outcome, OUTCOME_MAX_BYTES);
  for (const field of [
    "deliverables",
    "decisions",
    "verification",
    "risks",
    "nextActions",
  ] as const) {
    input[field]?.forEach((value, index) => {
      assertUtf8ByteLength(`${field}[${index}]`, value, REPORT_ITEM_MAX_BYTES);
    });
  }
}

function safeCount(value: unknown, fallback: number, max: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, max)
    : Math.min(fallback, max);
}

export function buildWorkReportArgs(params: {
  channelId: string;
  threadRoot: string;
  status: string;
  outcome: string;
  deliverables?: string[];
  decisions?: string[];
  verification?: string[];
  risks?: string[];
  nextActions?: string[];
  prior?: string;
}): string[] {
  const args = [
    "messages",
    "report",
    "--channel",
    params.channelId,
    "--thread",
    params.threadRoot,
    "--status",
    params.status,
    "--outcome",
    params.outcome,
  ];
  const repeat = (flag: string, values: string[] | undefined) => {
    for (const value of values ?? []) args.push(flag, value);
  };
  repeat("--deliverable", params.deliverables);
  repeat("--decision", params.decisions);
  repeat("--verification", params.verification);
  repeat("--risk", params.risks);
  repeat("--next-action", params.nextActions);
  if (params.prior) args.push("--prior", params.prior);
  return args;
}

const boundedString = Type.String({ minLength: 1, maxLength: REPORT_ITEM_MAX_BYTES });
const boundedList = Type.Optional(Type.Array(boundedString, { maxItems: 20 }));
const accountId = Type.Optional(
  Type.String({
    minLength: 1,
    maxLength: 64,
    pattern: CANONICAL_BUZZ_ACCOUNT_ID.source,
  }),
);
const runtimeCheckParameters = Type.Object({ accountId }, { additionalProperties: false });
const workReportParameters = Type.Object(
  {
    accountId,
    channelId: Type.String({ pattern: CHANNEL_ID.source }),
    threadRoot: Type.String({ pattern: HEX_EVENT_ID.source }),
    status: Type.Union([
      Type.Literal("completed"),
      Type.Literal("in-review"),
      Type.Literal("needs-decision"),
      Type.Literal("blocked"),
      Type.Literal("failed"),
    ]),
    outcome: Type.String({ minLength: 1, maxLength: OUTCOME_MAX_BYTES }),
    deliverables: boundedList,
    decisions: boundedList,
    verification: boundedList,
    risks: boundedList,
    nextActions: boundedList,
    prior: Type.Optional(Type.String({ pattern: HEX_EVENT_ID.source })),
  },
  { additionalProperties: false },
);
const summaryParameters = Type.Object(
  {
    accountId,
    channelId: Type.String({ pattern: CHANNEL_ID.source }),
    threadRoot: Type.String({ pattern: HEX_EVENT_ID.source }),
    message: Type.String({ minLength: 1, maxLength: SUMMARY_MAX_BYTES }),
  },
  { additionalProperties: false },
);
const pluginConfigSchema = Type.Object({}, { additionalProperties: false });

type RuntimeCheckInput = Static<typeof runtimeCheckParameters>;
type WorkReportInput = Static<typeof workReportParameters>;
type SummaryInput = Static<typeof summaryParameters>;
type PluginConfig = Static<typeof pluginConfigSchema>;

const runtimeCheckDefinition = {
  name: "buzz_runtime_check",
  label: "Buzz Runtime Check",
  catalogMode: "direct-only" as const,
  description:
    "Run a live, read-only Buzz channel probe and verify that this Gateway can publish signed work reports. Secret and room identity values are never returned.",
  parameters: runtimeCheckParameters,
};

const workReportDefinition = {
  name: "buzz_publish_work_report",
  label: "Publish Buzz Work Report",
  description:
    "Publish a signed structured Buzz work report for an existing room thread. Use prior when updating an existing report.",
  parameters: workReportParameters,
};

const summaryDefinition = {
  name: "buzz_send_thread_summary",
  label: "Send Buzz Thread Summary",
  description:
    "Send the ordinary text summary that accompanies a structured work report in the same Buzz thread.",
  parameters: summaryParameters,
};

const toolDefinitions = [runtimeCheckDefinition, workReportDefinition, summaryDefinition];

function createRuntimeCheckTool(
  _config: PluginConfig,
  toolContext: OpenClawPluginToolContext,
  dependencies: BuzzAdminDependencies,
) {
  return {
    ...runtimeCheckDefinition,
    async execute(_toolCallId: string, params: unknown) {
      const input = params as RuntimeCheckInput;
      const openclawCli = DEFAULT_OPENCLAW_CLI;
      const buzzCli = DEFAULT_BUZZ_CLI;
      const credentials = resolveBuzzCredentialState(
        resolveRuntimeConfig(toolContext),
        asTrimmedString(input.accountId) || undefined,
      );
      const cliReady = await dependencies.isExecutable(buzzCli);
      const credentialReady = Boolean(
        /^wss?:\/\//iu.test(credentials.relayUrl) && credentials.privateKey,
      );

      try {
        const { stdout } = await dependencies.runCommand(
          openclawCli,
          ["channels", "status", "--channel", "buzz", "--probe", "--json"],
          { timeout: 45_000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" },
        );
        const status = JSON.parse(stdout) as {
          ts?: number;
          channels?: Record<string, { ok?: boolean }>;
          channelAccounts?: Record<string, BuzzAccount[]>;
          statusIssues?: unknown[];
        };
        const account = (status.channelAccounts?.buzz ?? []).find(
          (candidate) => candidate.accountId === credentials.accountId,
        );
        const fallbackRoomCount = Array.isArray(account?.probe?.rooms)
          ? account.probe.rooms.length
          : 0;
        const roomCount = safeCount(account?.probe?.roomCount, fallbackRoomCount, 1020);
        const hasAccountError = Boolean(asTrimmedString(account?.lastError));
        const connected = Boolean(
          status.channels?.buzz?.ok &&
            account?.enabled &&
            account?.configured &&
            account?.running &&
            account?.connected &&
            account?.probe?.ok &&
            !hasAccountError,
        );
        return agentToolResult({
          plugin: {
            id: "buzz-admin",
            version: PLUGIN_VERSION,
            buildIdentity: BUZZ_ADMIN_BUILD_IDENTITY,
            runtimeEntrySha256: LOADED_RUNTIME_ENTRY_SHA256,
          },
          ok: connected && cliReady && credentialReady,
          checkedAt: status.ts ?? Date.now(),
          channel: "buzz",
          accountId: credentials.accountId,
          connected,
          probeOk: Boolean(account?.probe?.ok),
          errorCode: hasAccountError
            ? "BUZZ_ACCOUNT_ERROR"
            : account
              ? null
              : "BUZZ_ACCOUNT_NOT_FOUND",
          roomCount,
          statusIssueCount: safeCount(status.statusIssues?.length, 0, 10_000),
          gateway: {
            buzzCliReady: cliReady,
            credentialReady,
            workReportReady: cliReady && credentialReady,
          },
        });
      } catch {
        return agentToolResult({
          plugin: {
            id: "buzz-admin",
            version: PLUGIN_VERSION,
            buildIdentity: BUZZ_ADMIN_BUILD_IDENTITY,
            runtimeEntrySha256: LOADED_RUNTIME_ENTRY_SHA256,
          },
          ok: false,
          channel: "buzz",
          accountId: credentials.accountId,
          errorCode: "BUZZ_STATUS_PROBE_FAILED",
          gateway: {
            buzzCliReady: cliReady,
            credentialReady,
            workReportReady: cliReady && credentialReady,
          },
        });
      }
    },
  };
}

function createWorkReportTool(
  _config: PluginConfig,
  toolContext: OpenClawPluginToolContext<2>,
  dependencies: BuzzAdminDependencies,
) {
  return {
    ...workReportDefinition,
    async execute(_toolCallId: string, params: unknown) {
      const input = params as WorkReportInput;
      assertWorkReportByteLengths(input);
      const buzzCli = DEFAULT_BUZZ_CLI;
      if (!(await dependencies.isExecutable(buzzCli))) {
        throw new Error("The pinned Buzz CLI is not installed in the Gateway runtime.");
      }
      const credentials = resolveBuzzCredentialState(
        resolveRuntimeConfig(toolContext),
        asTrimmedString(input.accountId) || undefined,
      );
      requireCredentials(credentials);
      const args = buildWorkReportArgs(input);
      const options: CommandOptions = {
        env: childEnv(credentials),
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
        encoding: "utf8",
      };

      toolContext.assertInvocationCurrent();
      try {
        const { stdout } = await dependencies.runCommand(buzzCli, args, options);
        const eventId = requireAcceptedWriteEventId(stdout.trim());
        return agentToolResult({
          ok: true,
          channelId: input.channelId.toLowerCase(),
          threadRoot: input.threadRoot.toLowerCase(),
          status: input.status,
          eventId,
        });
      } catch (error) {
        throw cleanError(error, "Buzz work report publication");
      }
    },
  };
}

function createSummaryTool(
  _config: PluginConfig,
  toolContext: OpenClawPluginToolContext<2>,
  dependencies: BuzzAdminDependencies,
) {
  return {
    ...summaryDefinition,
    async execute(_toolCallId: string, params: unknown) {
      const input = params as SummaryInput;
      assertUtf8ByteLength("message", input.message, SUMMARY_MAX_BYTES);
      const openclawCli = DEFAULT_OPENCLAW_CLI;
      const args = [
        "message",
        "send",
        "--channel",
        "buzz",
        "--target",
        `buzz:${input.channelId.toLowerCase()}`,
        "--reply-to",
        input.threadRoot.toLowerCase(),
        "--message",
        input.message,
        "--json",
      ];
      const selectedAccount = canonicalBuzzAccountId(input.accountId);
      if (selectedAccount) args.push("--account", selectedAccount);

      toolContext.assertInvocationCurrent();
      try {
        const { stdout } = await dependencies.runCommand(openclawCli, args, {
          timeout: 60_000,
          maxBuffer: 1024 * 1024,
          encoding: "utf8",
        });
        const response = safeJson(stdout.trim());
        return agentToolResult({
          ok: true,
          channelId: input.channelId.toLowerCase(),
          threadRoot: input.threadRoot.toLowerCase(),
          messageId: findEventId(response) ?? null,
        });
      } catch (error) {
        throw cleanError(error, "Buzz thread summary delivery");
      }
    },
  };
}

/** Builds the Buzz Admin plugin entry with versioned privileged tool descriptors. */
export function createBuzzAdminPlugin(
  dependencies: BuzzAdminDependencies = productionDependencies,
) {
  const configSchemaJson = pluginConfigSchema as unknown as Parameters<
    typeof buildJsonPluginConfigSchema
  >[0];
  const configSchema = buildJsonPluginConfigSchema(configSchemaJson);
  const entry = definePluginEntry({
    id: "buzz-admin",
    name: "Buzz Admin",
    description: "Inspect Buzz and publish signed work reports from the OpenClaw Gateway.",
    configSchema,
    register(api) {
      const config = (api.pluginConfig ?? {}) as PluginConfig;
      api.registerTool(
        (toolContext) => createRuntimeCheckTool(config, toolContext, dependencies),
        { name: runtimeCheckDefinition.name },
      );
      api.registerTool(
        {
          contextVersion: 2,
          create(toolContext: OpenClawPluginToolContext<2>) {
            if (toolContext.senderIsOwner !== true) return null;
            return createWorkReportTool(config, toolContext, dependencies);
          },
        },
        { name: workReportDefinition.name },
      );
      api.registerTool(
        {
          contextVersion: 2,
          create(toolContext: OpenClawPluginToolContext<2>) {
            if (toolContext.senderIsOwner !== true) return null;
            return createSummaryTool(config, toolContext, dependencies);
          },
        },
        { name: summaryDefinition.name },
      );
    },
  });

  Object.defineProperty(entry, toolPluginMetadataSymbol, {
    value: {
      id: "buzz-admin",
      name: "Buzz Admin",
      description: "Inspect Buzz and publish signed work reports from the OpenClaw Gateway.",
      activation: { onStartup: true },
      configSchema: entry.configSchema.jsonSchema ?? configSchemaJson,
      tools: toolDefinitions,
    },
    enumerable: false,
  });
  return entry;
}

export default createBuzzAdminPlugin();
