import { identity, profileOwner } from "./binding.mjs";
import {
  randomUUID,
  randomBytes,
  createHash,
  createCipheriv,
} from "node:crypto";
import { mkdir, realpath, open, writeFile, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import WebSocket from "ws";
import { finalizeEvent, verifyEvent, nip44 } from "nostr-tools";
import {
  definePluginEntry,
  buildJsonPluginConfigSchema,
} from "openclaw/plugin-sdk/core";

const execFile = promisify(execFileCallback);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const schema = {
  type: "object",
  properties: {
    ownerPubkey: { type: "string", pattern: "^[0-9a-f]{64}$" },
    browserProfile: { type: "string", pattern: "^[a-z0-9_-]{1,64}$" },
  },
  required: ["ownerPubkey", "browserProfile"],
  additionalProperties: false,
};
const actions = new Set([
  "capabilities.get",
  "state.get",
  "tabs.list",
  "tab.read",
  "screen.capture",
  "transcript.list",
]);

function requireCondition(condition, code) {
  if (!condition) throw new Error(code);
}
function safeUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.origin + url.pathname.slice(0, 500)
      : url.protocol;
  } catch {
    return "";
  }
}

/** One service instance owns its lease, connection, queue, and encrypted receipts. */
async function createBroker(context, settings) {
  const binding = await identity(context.config);
  const { key, agent, origin, encoded } = binding,
    owner = settings.ownerPubkey;
  const conversation = nip44.v2.utils.getConversationKey(key, owner);
  const env = {
    ...process.env,
    BUZZ_RELAY_URL: origin,
    BUZZ_PRIVATE_KEY: encoded,
    BUZZ_AUTH_TAG: binding.authTag ? JSON.stringify(binding.authTag) : "",
  };
  const root = "/data/.openclaw/fmg-computer";
  await mkdir(root, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(root, "receipts.sqlite"));
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, hash TEXT NOT NULL, event TEXT, at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY, seq INTEGER NOT NULL); INSERT OR IGNORE INTO counter VALUES (1,0);",
  );
  const lease = new AbortController();
  let stopped = false,
    socket,
    reconnect,
    heartbeat,
    queue = Promise.resolve(),
    pending = 0;
  let generation = randomUUID(),
    fingerprint = "",
    handles = new Map(),
    lastRequest = 0;
  const live = () => requireCondition(!stopped, "service_stopped");
  const sign = (kind, tags, content) =>
    finalizeEvent(
      { kind, tags, content, created_at: Math.floor(Date.now() / 1000) },
      key,
    );
  async function checkOwner() {
    live();
    requireCondition(
      (await profileOwner(
        binding,
        AbortSignal.any([lease.signal, AbortSignal.timeout(8000)]),
      )) === owner,
      "owner_binding_changed",
    );
    live();
  }
  async function browser(args) {
    live();
    const { stdout } = await execFile(
      "/usr/local/bin/openclaw",
      [
        "browser",
        "--browser-profile",
        settings.browserProfile,
        ...args,
        "--json",
      ],
      {
        timeout: 15000,
        maxBuffer: 262144,
        signal: lease.signal,
        encoding: "utf8",
      },
    );
    live();
    return JSON.parse(stdout);
  }
  async function tabs() {
    const state = await browser(["status"]);
    const nextFingerprint = JSON.stringify([
      state.running,
      state.cdpReady,
      state.cdpPort,
      state.profile,
    ]);
    if (fingerprint && fingerprint !== nextFingerprint) {
      generation = randomUUID();
      handles.clear();
    }
    fingerprint = nextFingerprint;
    const raw = state.running ? await browser(["tabs"]) : { tabs: [] };
    const pages = (raw.tabs ?? [])
      .filter((tab) => tab.type === "page")
      .slice(0, 20);
    const existing = new Map(
      [...handles].map(([handle, tab]) => [tab.targetId, handle]),
    );
    handles = new Map(
      pages.map((tab) => [existing.get(tab.targetId) ?? randomUUID(), tab]),
    );
    return {
      generation,
      profile: settings.browserProfile,
      running: state.running === true,
      ready: state.cdpReady === true,
      tabs: [...handles].map(([handle, tab]) => ({
        handle,
        title: String(tab.title ?? "제목 없음").slice(0, 200),
        url: safeUrl(tab.url),
      })),
    };
  }
  async function selected(request) {
    await tabs();
    requireCondition(request.generation === generation, "stale_generation");
    const tab = handles.get(request.tabHandle);
    requireCondition(
      tab && /^[a-zA-Z0-9_-]{1,128}$/.test(tab.targetId),
      "tab_unavailable",
    );
    return tab;
  }
  async function unchanged(request, before) {
    await tabs();
    requireCondition(
      request.generation === generation &&
        handles.get(request.tabHandle)?.targetId === before.targetId &&
        handles.get(request.tabHandle)?.url === before.url,
      "tab_changed",
    );
  }
  async function capture(request) {
    const tab = await selected(request);
    const image = await browser([
      "screenshot",
      tab.targetId,
      "--type",
      "jpeg",
      "--timeout",
      "10000",
    ]);
    const mediaRoot = await realpath("/data/.openclaw/media/browser");
    const path = await realpath(image.path);
    const delta = relative(mediaRoot, path);
    requireCondition(
      delta && !delta.startsWith("..") && !isAbsolute(delta),
      "capture_path_invalid",
    );
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let plain;
    try {
      const stat = await file.stat();
      requireCondition(
        stat.isFile() && stat.size > 3 && stat.size <= 2097152,
        "capture_size_limit",
      );
      plain = await file.readFile();
    } finally {
      await file.close();
      // This file was created by this request's fixed screenshot command.
      await unlink(path).catch(() => undefined);
    }
    requireCondition(
      plain[0] === 255 && plain[1] === 216 && plain[2] === 255,
      "capture_format_invalid",
    );
    await unchanged(request, tab);
    const secret = randomBytes(32),
      iv = randomBytes(12);
    const aad = JSON.stringify({
      schemaVersion: 1,
      requestId: request.requestId,
      owner,
      agent,
      relay: origin,
      generation,
      sha256: sha(plain),
    });
    const cipher = createCipheriv("aes-256-gcm", secret, iv);
    cipher.setAAD(Buffer.from(aad));
    const bytes = Buffer.concat([
      cipher.update(plain),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    plain.fill(0);
    const encryptedPath = join(root, `${randomUUID()}.bin`);
    await writeFile(encryptedPath, bytes, { mode: 0o600, flag: "wx" });
    try {
      const { stdout } = await execFile(
        "/data/.openclaw/bin/buzz",
        ["upload", "file", "--file", encryptedPath],
        {
          env,
          timeout: 15000,
          maxBuffer: 65536,
          signal: lease.signal,
          encoding: "utf8",
        },
      );
      live();
      const blob = JSON.parse(stdout);
      requireCondition(
        new URL(blob.url).origin === origin &&
          blob.sha256 === sha(bytes) &&
          blob.size === bytes.length,
        "blob_receipt_invalid",
      );
      await unchanged(request, tab);
      return {
        url: blob.url,
        size: bytes.length,
        cipherSha256: sha(bytes),
        key: secret.toString("base64"),
        iv: iv.toString("base64"),
        aad,
        mime: "image/jpeg",
      };
    } finally {
      secret.fill(0);
      await unlink(encryptedPath).catch(() => undefined);
    }
  }
  async function run(request) {
    if (request.action === "capabilities.get")
      return {
        actions: [...actions],
        browserProfile: settings.browserProfile,
        readOnly: true,
      };
    if (request.action === "state.get" || request.action === "tabs.list")
      return await tabs();
    if (request.action === "screen.capture") return await capture(request);
    if (request.action === "tab.read") {
      const tab = await selected(request);
      const value = await browser([
        "snapshot",
        "--target-id",
        tab.targetId,
        "--format",
        "ai",
        "--compact",
        "--limit",
        "150",
        "--timeout",
        "10000",
      ]);
      await unchanged(request, tab);
      return { text: String(value.snapshot ?? "").slice(0, 8000) };
    }
    return {
      receipts: db
        .prepare(
          "SELECT id, at, event IS NOT NULL AS completed FROM receipts ORDER BY at DESC LIMIT 30",
        )
        .all(),
    };
  }
  function publish(event) {
    live();
    if (socket?.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify(["EVENT", event]));
  }
  async function receive(event) {
    live();
    if (
      event.kind !== 24200 ||
      event.pubkey !== owner ||
      !verifyEvent(event) ||
      Math.abs(event.created_at - Date.now() / 1000) > 60
    )
      return;
    const tag = (name) => event.tags.filter((t) => t[0] === name);
    if (
      ![
        ["p", agent],
        ["agent", agent],
        ["frame", "control"],
      ].every(
        ([name, value]) => tag(name).length === 1 && tag(name)[0][1] === value,
      )
    )
      return;
    let request;
    try {
      request = JSON.parse(nip44.v2.decrypt(event.content, conversation));
    } catch {
      return;
    }
    if (request?.type !== "fmg.computer.request") return; // Existing agent controls keep their current handler.
    requireCondition(
      request.schemaVersion === 1 &&
        uuid.test(request.requestId) &&
        request.relay === origin &&
        actions.has(request.action),
      "invalid_request",
    );
    requireCondition(
      Object.keys(request).every((k) =>
        [
          "type",
          "schemaVersion",
          "requestId",
          "relay",
          "expiresAt",
          "action",
          "generation",
          "tabHandle",
        ].includes(k),
      ),
      "invalid_request",
    );
    const expires = Date.parse(request.expiresAt);
    requireCondition(
      expires > Date.now() && expires < Date.now() + 60000,
      "request_expired",
    );
    if (["tab.read", "screen.capture"].includes(request.action))
      requireCondition(
        uuid.test(request.generation) && uuid.test(request.tabHandle),
        "invalid_target",
      );
    await checkOwner();
    const hash = sha(
      JSON.stringify([
        request.action,
        request.generation ?? null,
        request.tabHandle ?? null,
        request.relay,
      ]),
    );
    const prior = db
      .prepare("SELECT * FROM receipts WHERE id=?")
      .get(request.requestId);
    if (prior) {
      requireCondition(prior.hash === hash, "request_conflict");
      if (prior.event) publish(JSON.parse(prior.event));
      return;
    }
    requireCondition(Date.now() - lastRequest >= 1000, "rate_limited");
    lastRequest = Date.now();
    db.prepare("INSERT INTO receipts VALUES (?,?,NULL,?)").run(
      request.requestId,
      hash,
      Date.now(),
    );
    let result, error;
    try {
      result = await run(request);
    } catch (failure) {
      error = /^[a-z_]+$/.test(failure.message)
        ? failure.message
        : "browser_operation_failed";
    }
    live();
    await checkOwner();
    const seq = Number(
      db
        .prepare("UPDATE counter SET seq=MAX(seq+1,?) WHERE id=1 RETURNING seq")
        .get(Date.now()).seq,
    );
    const payload = {
      schemaVersion: 1,
      requestId: request.requestId,
      action: request.action,
      relay: origin,
      generation,
      checkedAt: new Date().toISOString(),
      ok: !error,
      result,
      error,
    };
    const frame = JSON.stringify({
      seq,
      timestamp: payload.checkedAt,
      kind: "fmg_computer_result",
      agentIndex: null,
      channelId: null,
      sessionId: null,
      turnId: null,
      payload,
    });
    requireCondition(Buffer.byteLength(frame) <= 60000, "response_size_limit");
    const response = sign(
      24200,
      [
        ["p", owner],
        ["agent", agent],
        ["frame", "telemetry"],
      ],
      nip44.v2.encrypt(frame, conversation),
    );
    db.prepare("UPDATE receipts SET event=? WHERE id=?").run(
      JSON.stringify(response),
      request.requestId,
    );
    db.prepare("DELETE FROM receipts WHERE at < ?").run(Date.now() - 86400000);
    db.prepare(
      "DELETE FROM receipts WHERE id NOT IN (SELECT id FROM receipts ORDER BY at DESC LIMIT 1000)",
    ).run();
    publish(response);
  }
  function connect() {
    if (stopped) return;
    const url = new URL(origin);
    url.protocol = "wss:";
    socket = new WebSocket(url, {
      maxPayload: 200000,
      perMessageDeflate: false,
      handshakeTimeout: 10000,
    });
    const current = socket;
    const subscribe = () => {
      if (!stopped && current.readyState === WebSocket.OPEN)
        current.send(
          JSON.stringify([
            "REQ",
            "fmg-computer",
            {
              kinds: [24200],
              authors: [owner],
              "#p": [agent],
              "#frame": ["control"],
              since: Math.floor(Date.now() / 1000),
            },
          ]),
        );
    };
    current.on("open", subscribe);
    let authId;
    current.on("message", (raw) => {
      if (stopped || current !== socket) return;
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (message[0] === "AUTH") {
        const auth = sign(
          22242,
          [
            ["relay", url.href],
            ["challenge", message[1]],
            ...(binding.authTag ? [binding.authTag] : []),
          ],
          "",
        );
        authId = auth.id;
        current.send(JSON.stringify(["AUTH", auth]));
      }
      if (message[0] === "OK" && message[1] === authId) {
        if (message[2] === true) {
          context.logger.info("FMG Computer relay authenticated.");
          subscribe();
        } else
          context.logger.warn("FMG Computer relay authentication rejected.");
      }
      if (
        message[0] === "EVENT" &&
        message[1] === "fmg-computer" &&
        pending < 8
      ) {
        pending++;
        queue = queue
          .then(() => receive(message[2]))
          .catch(() => {
            if (!stopped)
              context.logger.warn(
                "FMG Computer request rejected or unavailable.",
              );
          })
          .finally(() => pending--);
      }
    });
    current.on("error", () => {});
    current.on("close", () => {
      clearInterval(heartbeat);
      if (!stopped) reconnect = setTimeout(connect, 5000);
    });
    heartbeat = setInterval(() => {
      if (current.readyState === WebSocket.OPEN) current.ping();
    }, 25000);
  }
  try {
    await checkOwner();
    connect();
  } catch (error) {
    db.close();
    key.fill(0);
    throw error;
  }
  context.logger.info("FMG Computer read-only owner broker started.");
  return async () => {
    stopped = true;
    lease.abort();
    clearTimeout(reconnect);
    clearInterval(heartbeat);
    socket?.terminate();
    await queue;
    db.close();
    key.fill(0);
    conversation.fill(0);
  };
}

export default definePluginEntry({
  id: "fmg-computer",
  name: "FMG Server Computer",
  configSchema: buildJsonPluginConfigSchema(schema),
  register(api) {
    let stop;
    api.registerService({
      id: "fmg-computer",
      reload: {
        configPrefixes: [
          "channels.buzz",
          "secrets.providers",
          "plugins.entries.fmg-computer",
        ],
      },
      async start(context) {
        stop = await createBroker(context, api.pluginConfig);
      },
      async stop() {
        await stop?.();
        stop = undefined;
      },
    });
  },
});
