import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";

import entry, {
  BUZZ_ADMIN_BUILD_IDENTITY,
  buildWorkReportArgs,
  createBuzzAdminPlugin,
  resolveBuzzCredentialState,
  type BuzzAdminDependencies,
} from "./index.js";

const CHANNEL_ID = "11111111-1111-4111-8111-111111111111";
const THREAD_ROOT = "a".repeat(64);

type Registration = {
  tool: unknown;
  options?: { name?: string };
};

function registerTools(
  dependencies: BuzzAdminDependencies,
  pluginConfig: Record<string, unknown> = {},
): Map<string, unknown> {
  const registrations: Registration[] = [];
  const plugin = createBuzzAdminPlugin(dependencies);
  plugin.register({
    pluginConfig,
    registerTool(tool: unknown, options?: { name?: string }) {
      registrations.push({ tool, options });
    },
  } as never);
  return new Map(
    registrations.map((registration) => [registration.options?.name ?? "", registration.tool]),
  );
}

function dependenciesWith(runCommand = vi.fn(async () => ({ stdout: "{}" }))) {
  return {
    dependencies: {
      runCommand,
      isExecutable: vi.fn(async () => true),
    } satisfies BuzzAdminDependencies,
    runCommand,
  };
}

function ownerContext(
  assertInvocationCurrent: () => void = vi.fn(),
  runtimeConfig?: Record<string, unknown>,
) {
  return {
    senderIsOwner: true,
    assertInvocationCurrent,
    runtimeConfig: runtimeConfig ?? {
      channels: {
        buzz: {
          relayUrl: "wss://relay.example.test",
          privateKey: "resolved-key",
        },
      },
    },
  };
}

function validWorkReport(overrides: Record<string, unknown> = {}) {
  return {
    channelId: CHANNEL_ID,
    threadRoot: THREAD_ROOT,
    status: "completed",
    outcome: "done",
    ...overrides,
  };
}

function validSummary(overrides: Record<string, unknown> = {}) {
  return {
    channelId: CHANNEL_ID,
    threadRoot: THREAD_ROOT,
    message: "done",
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubEnv("BUZZ_RELAY_URL", "");
  vi.stubEnv("BUZZ_PRIVATE_KEY", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("buzz-admin metadata", () => {
  it("declares the operational Buzz tool surface", () => {
    expect(getToolPluginMetadata(entry)?.tools.map((tool) => tool.name)).toEqual([
      "buzz_runtime_check",
      "buzz_publish_work_report",
      "buzz_send_thread_summary",
    ]);
  });
});

describe("runtime credential selection", () => {
  it("reads the implicit root default account", () => {
    expect(
      resolveBuzzCredentialState({
        channels: {
          buzz: {
            relayUrl: "wss://relay.example.test",
            privateKey: "resolved-key",
            authTag: "resolved-auth",
          },
        },
      }),
    ).toEqual({
      relayUrl: "wss://relay.example.test",
      privateKey: "resolved-key",
      authTag: "resolved-auth",
      accountId: "default",
    });
  });

  it("uses environment credentials only for the implicit root account", () => {
    vi.stubEnv("BUZZ_RELAY_URL", "wss://env.example.test");
    vi.stubEnv("BUZZ_PRIVATE_KEY", "env-key");
    vi.stubEnv("BUZZ_AUTH_TAG", "env-auth");

    expect(resolveBuzzCredentialState({})).toEqual({
      relayUrl: "wss://env.example.test",
      privateKey: "env-key",
      authTag: "env-auth",
      accountId: "default",
    });
    expect(
      resolveBuzzCredentialState({
        channels: { buzz: { accounts: { default: {} } } },
      }),
    ).toEqual({ relayUrl: "", privateKey: "", authTag: "", accountId: "default" });
  });

  it("treats accounts.default as a complete identity", () => {
    expect(
      resolveBuzzCredentialState({
        channels: {
          buzz: {
            relayUrl: "wss://root.example.test",
            privateKey: "root-key",
            authTag: "root-auth",
            accounts: {
              default: {
                relayUrl: "wss://nested.example.test",
                privateKey: "nested-key",
              },
            },
          },
        },
      }),
    ).toEqual({
      relayUrl: "wss://nested.example.test",
      privateKey: "nested-key",
      authTag: "",
      accountId: "default",
    });
  });

  it("selects the sole named account when no root identity exists", () => {
    expect(
      resolveBuzzCredentialState({
        channels: {
          buzz: {
            accounts: {
              support: {
                relayUrl: "wss://support.example.test",
                privateKey: "support-key",
                authTag: "support-auth",
              },
            },
          },
        },
      }),
    ).toEqual({
      relayUrl: "wss://support.example.test",
      privateKey: "support-key",
      authTag: "support-auth",
      accountId: "support",
    });
  });

  it("honors defaultAccount and canonicalizes requested account IDs", () => {
    const config = {
      channels: {
        buzz: {
          defaultAccount: "beta",
          accounts: {
            alpha: { relayUrl: "wss://alpha.example.test", privateKey: "alpha-key" },
            beta: { relayUrl: "wss://beta.example.test", privateKey: "beta-key" },
          },
        },
      },
    };

    expect(resolveBuzzCredentialState(config).accountId).toBe("beta");
    expect(resolveBuzzCredentialState(config, " ALPHA ").accountId).toBe("alpha");
  });

  it("never borrows root identity fields for a named account", () => {
    vi.stubEnv("BUZZ_RELAY_URL", "wss://env.example.test");
    vi.stubEnv("BUZZ_PRIVATE_KEY", "env-key");
    vi.stubEnv("BUZZ_AUTH_TAG", "env-auth");

    expect(
      resolveBuzzCredentialState(
        {
          channels: {
            buzz: {
              relayUrl: "wss://root.example.test",
              privateKey: "root-key",
              authTag: "root-auth",
              accounts: {
                support: { relayUrl: "wss://support.example.test" },
              },
            },
          },
        },
        "SUPPORT",
      ),
    ).toEqual({
      relayUrl: "wss://support.example.test",
      privateKey: "",
      authTag: "",
      accountId: "support",
    });
  });

  it("does not stringify an unresolved SecretRef", () => {
    vi.stubEnv("BUZZ_PRIVATE_KEY", "env-key");
    expect(
      resolveBuzzCredentialState({
        channels: {
          buzz: {
            relayUrl: "wss://relay.example.test",
            privateKey: { source: "store", provider: "default", id: "BUZZ_KEY" },
          },
        },
      }).privateKey,
    ).toBe("");
  });

  it("rejects reserved account IDs", () => {
    expect(() => resolveBuzzCredentialState({}, "constructor")).toThrow(
      "Buzz account ID must be a valid account key.",
    );
  });
});

describe("tool authority", () => {
  it("keeps the read-only runtime check directly model-visible under Tool Search", () => {
    const { dependencies } = dependenciesWith();
    const tools = registerTools(dependencies);
    const factory = tools.get("buzz_runtime_check") as (
      context: Record<string, unknown>,
    ) => { catalogMode?: string };

    expect(factory(ownerContext()).catalogMode).toBe("direct-only");
  });

  it("registers both write tools as owner-only version 2 descriptors", () => {
    const { dependencies } = dependenciesWith();
    const tools = registerTools(dependencies);

    for (const name of ["buzz_publish_work_report", "buzz_send_thread_summary"]) {
      const descriptor = tools.get(name) as {
        contextVersion?: number;
        create: (context: Record<string, unknown>) => unknown;
      };
      expect(descriptor.contextVersion).toBe(2);
      expect(
        descriptor.create({ senderIsOwner: false, assertInvocationCurrent: vi.fn() }),
      ).toBeNull();
      expect(descriptor.create({ assertInvocationCurrent: vi.fn() })).toBeNull();
      expect(descriptor.create(ownerContext())).toBeTruthy();
    }
  });

  it("calls the current-invocation guard immediately before each write request", async () => {
    const guards = new Map<string, ReturnType<typeof vi.fn>>();
    const runCommand = vi.fn(async () => {
      expect([...guards.values()].some((guard) => guard.mock.calls.length === 1)).toBe(true);
      return { stdout: "{}" };
    });
    const { dependencies } = dependenciesWith(runCommand);
    const tools = registerTools(dependencies);

    const reportGuard = vi.fn();
    guards.set("report", reportGuard);
    const reportDescriptor = tools.get("buzz_publish_work_report") as {
      create: (context: Record<string, unknown>) => {
        execute: (id: string, params: unknown) => Promise<unknown>;
      };
    };
    await reportDescriptor.create(ownerContext(reportGuard)).execute("report", validWorkReport());
    expect(reportGuard).toHaveBeenCalledOnce();

    guards.clear();
    const summaryGuard = vi.fn();
    guards.set("summary", summaryGuard);
    const summaryDescriptor = tools.get("buzz_send_thread_summary") as {
      create: (context: Record<string, unknown>) => {
        execute: (id: string, params: unknown) => Promise<unknown>;
      };
    };
    await summaryDescriptor.create(ownerContext(summaryGuard)).execute("summary", validSummary());
    expect(summaryGuard).toHaveBeenCalledOnce();
    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  it("does not start either write when the invocation is stale", async () => {
    const { dependencies, runCommand } = dependenciesWith();
    const tools = registerTools(dependencies);
    const stale = () => {
      throw new Error("stale invocation");
    };

    const reportDescriptor = tools.get("buzz_publish_work_report") as {
      create: (context: Record<string, unknown>) => {
        execute: (id: string, params: unknown) => Promise<unknown>;
      };
    };
    await expect(
      reportDescriptor.create(ownerContext(stale)).execute("report", validWorkReport()),
    ).rejects.toThrow("stale invocation");

    const summaryDescriptor = tools.get("buzz_send_thread_summary") as {
      create: (context: Record<string, unknown>) => {
        execute: (id: string, params: unknown) => Promise<unknown>;
      };
    };
    await expect(
      summaryDescriptor.create(ownerContext(stale)).execute("summary", validSummary()),
    ).rejects.toThrow("stale invocation");
    expect(runCommand).not.toHaveBeenCalled();
  });
});

describe("runtime probe disclosure", () => {
  it("returns counts and a stable error code without room inventory or raw errors", async () => {
    const rawError = "relay rejected account with sensitive diagnostic";
    const roomId = "22222222-2222-4222-8222-222222222222";
    const roomName = "private-room-name";
    const { dependencies } = dependenciesWith(
      vi.fn(async () => ({
        stdout: JSON.stringify({
          ts: 123,
          channels: { buzz: { ok: true } },
          channelAccounts: {
            buzz: [
              {
                accountId: "default",
                enabled: true,
                configured: true,
                running: true,
                connected: true,
                lastError: rawError,
                probe: {
                  ok: true,
                  roomCount: 1,
                  rooms: [{ id: roomId, name: roomName }],
                },
              },
            ],
          },
        }),
      })),
    );
    const tools = registerTools(dependencies);
    const factory = tools.get("buzz_runtime_check") as (
      context: Record<string, unknown>,
    ) => { execute: (id: string, params: unknown) => Promise<{ details: Record<string, unknown> }> };
    const result = await factory({
      senderIsOwner: false,
      runtimeConfig: ownerContext().runtimeConfig,
    }).execute("check", {});
    const serialized = JSON.stringify(result);

    expect(result.details).toMatchObject({
      plugin: {
        id: "buzz-admin",
        version: "0.2.1",
        buildIdentity: BUZZ_ADMIN_BUILD_IDENTITY,
      },
      ok: false,
      roomCount: 1,
      errorCode: "BUZZ_ACCOUNT_ERROR",
    });
    expect(result.details).not.toHaveProperty("rooms");
    expect(result.details).not.toHaveProperty("lastError");
    expect(
      (result.details.plugin as { runtimeEntrySha256: string }).runtimeEntrySha256,
    ).toMatch(/^[0-9a-f]{64}$/u);
    expect(serialized).not.toContain(roomId);
    expect(serialized).not.toContain(roomName);
    expect(serialized).not.toContain(rawError);
  });
});

describe("UTF-8 byte limits", () => {
  it("rejects multibyte report fields before invoking the Buzz CLI", async () => {
    const { dependencies, runCommand } = dependenciesWith();
    const tools = registerTools(dependencies);
    const descriptor = tools.get("buzz_publish_work_report") as {
      create: (context: Record<string, unknown>) => {
        execute: (id: string, params: unknown) => Promise<unknown>;
      };
    };
    const guard = vi.fn();
    const tool = descriptor.create(ownerContext(guard));

    await expect(
      tool.execute("report", validWorkReport({ outcome: "한".repeat(342) })),
    ).rejects.toThrow("outcome must be at most 1024 UTF-8 bytes.");
    await expect(
      tool.execute("report", validWorkReport({ decisions: ["😀".repeat(513)] })),
    ).rejects.toThrow("decisions[0] must be at most 2048 UTF-8 bytes.");
    expect(guard).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("rejects a multibyte summary before invoking OpenClaw", async () => {
    const { dependencies, runCommand } = dependenciesWith();
    const tools = registerTools(dependencies);
    const descriptor = tools.get("buzz_send_thread_summary") as {
      create: (context: Record<string, unknown>) => {
        execute: (id: string, params: unknown) => Promise<unknown>;
      };
    };
    const guard = vi.fn();

    await expect(
      descriptor
        .create(ownerContext(guard))
        .execute("summary", validSummary({ message: "😀".repeat(4001) })),
    ).rejects.toThrow("message must be at most 16000 UTF-8 bytes.");
    expect(guard).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });
});

describe("work report arguments", () => {
  it("uses argv entries rather than shell interpolation", () => {
    expect(
      buildWorkReportArgs({
        channelId: CHANNEL_ID,
        threadRoot: THREAD_ROOT,
        status: "completed",
        outcome: "완료 $(touch /tmp/never)",
        deliverables: ["https://example.test/pr/1"],
        verification: ["CI passed"],
      }),
    ).toEqual([
      "messages",
      "report",
      "--channel",
      CHANNEL_ID,
      "--thread",
      THREAD_ROOT,
      "--status",
      "completed",
      "--outcome",
      "완료 $(touch /tmp/never)",
      "--deliverable",
      "https://example.test/pr/1",
      "--verification",
      "CI passed",
    ]);
  });
});
