#!/usr/bin/env bash
# Read-only release gate. Set FMG_SSH_TARGET and FMG_SSH_KEY to include the
# Hostinger container checks. This script prints no credential values.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="${FMG_LIVE_MANIFEST:-$ROOT/.release/fmg-live.json}"
node "$ROOT/scripts/validate-fmg-live-release.mjs" "$MANIFEST"

origin="$(node -p "require(process.argv[1]).relay.public_origin" "$MANIFEST")"

# Exercise the same public contracts used by desktop and pairing clients. Node's
# HTTPS client does not follow redirects, and the TLS socket probe closes as soon
# as it has authenticated the complete RFC 6455 upgrade response.
node - "$origin" <<'NODE'
const crypto = require("node:crypto");
const https = require("node:https");
const tls = require("node:tls");

const origin = process.argv[2];
const base = new URL(origin);
if (base.protocol !== "https:" || base.username || base.password || base.search ||
    base.hash || base.pathname !== "/") {
  throw new Error("relay public origin must be a credential-free HTTPS origin");
}

function request(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(new URL(path, base), {
      method: "GET",
      headers,
      timeout: 12_000,
    }, (res) => {
      const chunks = [];
      let bytes = 0;
      res.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 1_048_576) {
          req.destroy(new Error("public probe response exceeded 1 MiB"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.once("timeout", () => req.destroy(new Error(`HTTPS timeout for ${path}`)));
    req.once("error", reject);
    req.end();
  });
}

function oneHeader(headers, name) {
  const value = headers[name];
  if (Array.isArray(value)) throw new Error(`duplicate ${name} response header`);
  return value;
}

async function websocketUpgrade(path) {
  const key = crypto.randomBytes(16).toString("base64");
  const expectedAccept = crypto.createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  await new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: base.hostname,
      port: base.port ? Number(base.port) : 443,
      servername: base.hostname,
      rejectUnauthorized: true,
    });
    const timer = setTimeout(() => socket.destroy(new Error(`WebSocket timeout for ${path}`)), 12_000);
    let response = Buffer.alloc(0);
    const finish = (error) => {
      clearTimeout(timer);
      socket.destroy();
      error ? reject(error) : resolve();
    };
    socket.once("secureConnect", () => {
      socket.write([
        `GET ${path} HTTP/1.1`,
        `Host: ${base.host}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        `Origin: ${origin}`,
        "",
        "",
      ].join("\r\n"));
    });
    socket.on("data", (chunk) => {
      response = Buffer.concat([response, chunk]);
      if (response.length > 65_536) return finish(new Error(`oversized WebSocket response for ${path}`));
      const boundary = response.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      const lines = response.subarray(0, boundary).toString("latin1").split("\r\n");
      if (lines.shift() !== "HTTP/1.1 101 Switching Protocols") {
        return finish(new Error(`WebSocket upgrade failed for ${path}`));
      }
      const headers = new Map();
      for (const line of lines) {
        const separator = line.indexOf(":");
        if (separator <= 0) return finish(new Error(`malformed WebSocket header for ${path}`));
        const name = line.slice(0, separator).trim().toLowerCase();
        const value = line.slice(separator + 1).trim();
        if (headers.has(name)) return finish(new Error(`duplicate WebSocket header ${name}`));
        headers.set(name, value);
      }
      if (headers.get("upgrade")?.toLowerCase() !== "websocket" ||
          !headers.get("connection")?.toLowerCase().split(/\s*,\s*/u).includes("upgrade") ||
          headers.get("sec-websocket-accept") !== expectedAccept) {
        return finish(new Error(`invalid WebSocket upgrade headers for ${path}`));
      }
      finish();
    });
    socket.once("error", (error) => finish(error));
    socket.once("end", () => finish(new Error(`WebSocket closed before upgrade for ${path}`)));
  });
}

(async () => {
  const root = await request("/", { Accept: "application/nostr+json" });
  if (root.status !== 200 || !oneHeader(root.headers, "content-type")?.toLowerCase().startsWith("application/json")) {
    throw new Error("relay root did not return direct JSON HTTP 200");
  }
  const body = JSON.parse(root.body);
  const expectedPairing = origin.replace(/^https:/u, "wss:") + "/pair";
  if (!(body?.name === "Buzz Relay" && body?.software === "https://github.com/block/buzz" &&
        body?.limitation?.auth_required === true && body?.limitation?.restricted_writes === true &&
        Array.isArray(body?.supported_nips) && body.supported_nips.includes(29) &&
        Array.isArray(body?.supported_extensions) && body.supported_extensions.includes("nip-er") &&
        body?.pairing_relay_url === expectedPairing)) {
    throw new Error("relay root capability document does not match Buzz");
  }

  const health = await request("/health", { Accept: "text/plain" });
  if (health.status !== 200 || health.body !== "ok" ||
      !oneHeader(health.headers, "content-type")?.toLowerCase().startsWith("text/plain")) {
    throw new Error("relay health response is not exact text/plain ok");
  }

  for (const requestOrigin of [origin, "tauri://localhost", "http://tauri.localhost"]) {
    const response = await request("/", {
      Accept: "application/nostr+json",
      Origin: requestOrigin,
    });
    if (response.status !== 200 || oneHeader(response.headers, "access-control-allow-origin") !== requestOrigin) {
      throw new Error("relay CORS origin echo check failed");
    }
  }

  await websocketUpgrade("/");
  await websocketUpgrade("/pair");
  process.stdout.write("http_path=/ status=200\nhttp_path=/health status=200\n" +
    "websocket_path=/ status=101\nwebsocket_path=/pair status=101\n" +
    "cors_origins=verified\n");
})().catch((error) => {
  process.stderr.write(`error: ${error.message}\n`);
  process.exitCode = 1;
});
NODE

if [[ -z "${FMG_SSH_TARGET:-}" ]]; then
    if [[ "${FMG_PUBLIC_ONLY:-0}" == "1" ]]; then
        echo "remote_checks=explicitly_skipped"
        exit 0
    fi
    echo "error: set FMG_SSH_TARGET and FMG_SSH_KEY, or explicitly set FMG_PUBLIC_ONLY=1" >&2
    exit 2
fi
: "${FMG_SSH_KEY:?set FMG_SSH_KEY when FMG_SSH_TARGET is set}"
: "${FMG_RELAY_CONTAINER:?set the exact relay container name}"
: "${FMG_OPENCLAW_CONTAINER:?set the exact OpenClaw container name}"

expected_ref="$(node -p "require(process.argv[1]).relay.immutable_ref" "$MANIFEST")"
expected_commit="$(node -p "require(process.argv[1]).relay.source_commit" "$MANIFEST")"
expected_openclaw="$(node -p "require(process.argv[1]).openclaw.version" "$MANIFEST")"
expected_openclaw_build="$(node -p "require(process.argv[1]).openclaw.server_build_id" "$MANIFEST")"
expected_openclaw_configured_ref="$(node -p "require(process.argv[1]).openclaw.container_image.configured_reference" "$MANIFEST")"
expected_openclaw_image_id="$(node -p "require(process.argv[1]).openclaw.container_image.immutable_image_id" "$MANIFEST")"
expected_openclaw_source_revision="$(node -p "require(process.argv[1]).openclaw.container_image.source_revision" "$MANIFEST")"
expected_websocket_url="$(node -p "require(process.argv[1]).relay.websocket_url" "$MANIFEST")"
expected_channel_package="$(node -p "require(process.argv[1]).openclaw.buzz_channel_plugin.package" "$MANIFEST")"
expected_channel_plugin="$(node -p "require(process.argv[1]).openclaw.buzz_channel_plugin.version" "$MANIFEST")"
expected_channel_integrity="$(node -p "require(process.argv[1]).openclaw.buzz_channel_plugin.integrity" "$MANIFEST")"
expected_channel_install_path="$(node -p "require(process.argv[1]).openclaw.buzz_channel_plugin.install_path" "$MANIFEST")"
expected_channel_package_json_sha="$(node -p "require(process.argv[1]).openclaw.buzz_channel_plugin.package_json_sha256" "$MANIFEST")"
expected_channel_package_tree_sha="$(node -p "require(process.argv[1]).openclaw.buzz_channel_plugin.package_tree_sha256" "$MANIFEST")"
expected_channel_runtime_entry="$(node -p "require(process.argv[1]).openclaw.buzz_channel_plugin.runtime_entry" "$MANIFEST")"
expected_channel_runtime_entry_sha="$(node -p "require(process.argv[1]).openclaw.buzz_channel_plugin.runtime_entry_sha256" "$MANIFEST")"
expected_channel_activation_policy="$(node -p "require(process.argv[1]).openclaw.buzz_channel_plugin.activation_policy" "$MANIFEST")"
expected_buzz_account="$(node -p "require(process.argv[1]).openclaw.buzz_channel_plugin.account_id" "$MANIFEST")"
expected_room_name="$(node -p "require(process.argv[1]).openclaw.buzz_channel_plugin.required_room_name" "$MANIFEST")"
expected_room_id_sha="$(node -p "require(process.argv[1]).openclaw.buzz_channel_plugin.required_room_id_sha256" "$MANIFEST")"
expected_admin="$(node -p "require(process.argv[1]).openclaw.buzz_admin_plugin.version" "$MANIFEST")"
expected_admin_package="$(node -p "require(process.argv[1]).openclaw.buzz_admin_plugin.package" "$MANIFEST")"
expected_admin_integrity="$(node -p "require(process.argv[1]).openclaw.buzz_admin_plugin.integrity" "$MANIFEST")"
expected_admin_build_identity="$(node -p "require(process.argv[1]).openclaw.buzz_admin_plugin.build_identity" "$MANIFEST")"
expected_admin_runtime_entry_sha="$(node -p "require(process.argv[1]).openclaw.buzz_admin_plugin.runtime_entry_sha256" "$MANIFEST")"
expected_admin_tools_csv="$(node -p "require(process.argv[1]).openclaw.buzz_admin_plugin.tools.join(',')" "$MANIFEST")"
expected_admin_agent_ids_csv="$(node -p "require(process.argv[1]).openclaw.buzz_admin_plugin.agent_ids.join(',')" "$MANIFEST")"
expected_live_gate_agent="$(node -p "require(process.argv[1]).openclaw.live_gate_agent.id" "$MANIFEST")"
expected_live_gate_model="$(node -p "require(process.argv[1]).openclaw.live_gate_agent.model" "$MANIFEST")"
expected_live_gate_runtime="$(node -p "require(process.argv[1]).openclaw.live_gate_agent.runtime" "$MANIFEST")"
expected_live_gate_code_mode="$(node -p "require(process.argv[1]).openclaw.live_gate_agent.code_mode" "$MANIFEST")"
expected_live_gate_tool="$(node -p "require(process.argv[1]).openclaw.live_gate_agent.tools[0]" "$MANIFEST")"
expected_runtime="$(node -p "require(process.argv[1]).agent_runtime.version" "$MANIFEST")"
expected_runtime_sha="$(node -p "require(process.argv[1]).agent_runtime.sha256" "$MANIFEST")"
expected_runtime_executable_sha="$(node -p "require(process.argv[1]).agent_runtime.executable_sha256" "$MANIFEST")"
expected_runtime_commit="$(node -p "require(process.argv[1]).agent_runtime.source_commit" "$MANIFEST")"

require_safe_value() {
    local name="$1"
    local value="$2"
    local pattern="$3"
    [[ "$value" =~ $pattern ]] || {
        echo "error: $name contains an unsafe or unsupported value" >&2
        exit 2
    }
}

require_safe_value FMG_RELAY_CONTAINER "$FMG_RELAY_CONTAINER" '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$'
require_safe_value FMG_OPENCLAW_CONTAINER "$FMG_OPENCLAW_CONTAINER" '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$'
require_safe_value FMG_SSH_TARGET "$FMG_SSH_TARGET" '^[A-Za-z_][A-Za-z0-9._-]{0,31}@[A-Za-z0-9][A-Za-z0-9.-]{0,252}$'
require_safe_value relay.immutable_ref "$expected_ref" '^ghcr\.io/[a-z0-9._-]+/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$'
require_safe_value relay.source_commit "$expected_commit" '^[0-9a-f]{40}$'
require_safe_value openclaw.version "$expected_openclaw" '^[0-9]+\.[0-9]+\.[0-9]+([+.-][0-9A-Za-z.-]+)?$'
require_safe_value openclaw.server_build_id "$expected_openclaw_build" '^[0-9]+\.[0-9]+\.[0-9]+-release-[0-9a-f]{12}-[0-9TZ.-]+$'
require_safe_value openclaw.container_image.configured_reference "$expected_openclaw_configured_ref" '^ghcr\.io/[a-z0-9._-]+/[a-z0-9._/-]+:[0-9A-Za-z._-]+$'
require_safe_value openclaw.container_image.immutable_image_id "$expected_openclaw_image_id" '^sha256:[0-9a-f]{64}$'
require_safe_value openclaw.container_image.source_revision "$expected_openclaw_source_revision" '^[0-9a-f]{40}$'
require_safe_value relay.websocket_url "$expected_websocket_url" '^wss://[A-Za-z0-9.-]+(:[0-9]{1,5})?/?$'
require_safe_value openclaw.buzz_channel_plugin.package "$expected_channel_package" '^@[a-z0-9._-]+/[a-z0-9._-]+$'
require_safe_value openclaw.buzz_channel_plugin.version "$expected_channel_plugin" '^[0-9]+\.[0-9]+\.[0-9]+([+.-][0-9A-Za-z.-]+)?$'
require_safe_value openclaw.buzz_channel_plugin.integrity "$expected_channel_integrity" '^sha512-[A-Za-z0-9+/]{86}==$'
require_safe_value openclaw.buzz_channel_plugin.install_path "$expected_channel_install_path" '^/data/\.openclaw/npm/projects/[A-Za-z0-9@._/-]+$'
require_safe_value openclaw.buzz_channel_plugin.package_json_sha256 "$expected_channel_package_json_sha" '^[0-9a-f]{64}$'
require_safe_value openclaw.buzz_channel_plugin.package_tree_sha256 "$expected_channel_package_tree_sha" '^[0-9a-f]{64}$'
require_safe_value openclaw.buzz_channel_plugin.runtime_entry "$expected_channel_runtime_entry" '^dist/[A-Za-z0-9._/-]+\.js$'
require_safe_value openclaw.buzz_channel_plugin.runtime_entry_sha256 "$expected_channel_runtime_entry_sha" '^[0-9a-f]{64}$'
require_safe_value openclaw.buzz_channel_plugin.activation_policy "$expected_channel_activation_policy" '^[a-z0-9-]+$'
require_safe_value openclaw.buzz_channel_plugin.account_id "$expected_buzz_account" '^[a-z0-9][a-z0-9._-]{0,63}$'
require_safe_value openclaw.buzz_channel_plugin.required_room_name "$expected_room_name" '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
require_safe_value openclaw.buzz_channel_plugin.required_room_id_sha256 "$expected_room_id_sha" '^[0-9a-f]{64}$'
require_safe_value openclaw.buzz_admin_plugin.version "$expected_admin" '^[0-9]+\.[0-9]+\.[0-9]+([+.-][0-9A-Za-z.-]+)?$'
require_safe_value openclaw.buzz_admin_plugin.package "$expected_admin_package" '^[a-z0-9][a-z0-9._-]{0,127}$'
require_safe_value openclaw.buzz_admin_plugin.integrity "$expected_admin_integrity" '^sha512-[A-Za-z0-9+/]{86}==$'
require_safe_value openclaw.buzz_admin_plugin.build_identity "$expected_admin_build_identity" '^[0-9a-f]{64}$'
require_safe_value openclaw.buzz_admin_plugin.runtime_entry_sha256 "$expected_admin_runtime_entry_sha" '^[0-9a-f]{64}$'
require_safe_value openclaw.buzz_admin_plugin.tools "$expected_admin_tools_csv" '^[a-z0-9_]+(,[a-z0-9_]+)*$'
require_safe_value openclaw.buzz_admin_plugin.agent_ids "$expected_admin_agent_ids_csv" '^[a-z0-9_-]+(,[a-z0-9_-]+)*$'
require_safe_value openclaw.live_gate_agent.id "$expected_live_gate_agent" '^[a-z0-9][a-z0-9_-]{0,63}$'
require_safe_value openclaw.live_gate_agent.model "$expected_live_gate_model" '^[a-z0-9][a-z0-9._-]{0,63}/[a-z0-9][a-z0-9._-]{0,127}$'
require_safe_value openclaw.live_gate_agent.runtime "$expected_live_gate_runtime" '^[a-z0-9][a-z0-9_-]{0,63}$'
require_safe_value openclaw.live_gate_agent.code_mode "$expected_live_gate_code_mode" '^[a-z-]+$'
require_safe_value openclaw.live_gate_agent.tools "$expected_live_gate_tool" '^[a-z0-9_]+$'
require_safe_value agent_runtime.version "$expected_runtime" '^[0-9]+\.[0-9]+\.[0-9]+([+.-][0-9A-Za-z.-]+)?$'
require_safe_value agent_runtime.sha256 "$expected_runtime_sha" '^[0-9a-f]{64}$'
require_safe_value agent_runtime.executable_sha256 "$expected_runtime_executable_sha" '^[0-9a-f]{64}$'
require_safe_value agent_runtime.source_commit "$expected_runtime_commit" '^[0-9a-f]{40}$'

# OpenSSH reconstructs post-host arguments as a remote shell command. Encode the
# complete argument vector so manifest values never become remote shell syntax.
# MSYS shells rewrite POSIX-looking arguments passed to Windows executables.
# Suppress that rewrite so the descriptor's container paths remain byte-exact.
payload_b64="$(MSYS2_ARG_CONV_EXCL='*' node -e '
const keys = [
  "relay", "openclaw", "expected_ref", "expected_commit", "expected_openclaw",
  "expected_openclaw_build", "expected_openclaw_configured_ref", "expected_openclaw_image_id",
  "expected_openclaw_source_revision", "expected_websocket_url", "expected_channel_package",
  "expected_channel_plugin", "expected_channel_integrity", "expected_channel_install_path",
  "expected_channel_package_json_sha", "expected_channel_package_tree_sha",
  "expected_channel_runtime_entry", "expected_channel_runtime_entry_sha",
  "expected_channel_activation_policy", "expected_buzz_account",
  "expected_room_name", "expected_room_id_sha", "expected_admin", "expected_admin_package",
  "expected_admin_integrity", "expected_admin_build_identity", "expected_admin_runtime_entry_sha", "expected_admin_tools_csv",
  "expected_admin_agent_ids_csv", "expected_live_gate_agent", "expected_live_gate_model",
  "expected_live_gate_runtime", "expected_live_gate_code_mode", "expected_live_gate_tool",
  "expected_runtime", "expected_runtime_sha",
  "expected_runtime_executable_sha", "expected_runtime_commit",
];
const payload = Object.fromEntries(keys.map((key, index) => [key, process.argv[index + 1]]));
process.stdout.write(Buffer.from(JSON.stringify(payload), "utf8").toString("base64"));
' "$FMG_RELAY_CONTAINER" "$FMG_OPENCLAW_CONTAINER" "$expected_ref" \
    "$expected_commit" "$expected_openclaw" "$expected_openclaw_build" \
    "$expected_openclaw_configured_ref" "$expected_openclaw_image_id" \
    "$expected_openclaw_source_revision" "$expected_websocket_url" \
    "$expected_channel_package" "$expected_channel_plugin" "$expected_channel_integrity" \
    "$expected_channel_install_path" "$expected_channel_package_json_sha" \
    "$expected_channel_package_tree_sha" "$expected_channel_runtime_entry" \
    "$expected_channel_runtime_entry_sha" "$expected_channel_activation_policy" \
    "$expected_buzz_account" "$expected_room_name" "$expected_room_id_sha" "$expected_admin" \
    "$expected_admin_package" "$expected_admin_integrity" \
    "$expected_admin_build_identity" "$expected_admin_runtime_entry_sha" \
    "$expected_admin_tools_csv" "$expected_admin_agent_ids_csv" "$expected_live_gate_agent" \
    "$expected_live_gate_model" "$expected_live_gate_runtime" "$expected_live_gate_code_mode" \
    "$expected_live_gate_tool" "$expected_runtime" \
    "$expected_runtime_sha" "$expected_runtime_executable_sha" "$expected_runtime_commit")"
require_safe_value remote_payload "$payload_b64" '^[A-Za-z0-9+/]+={0,2}$'

ssh -i "$FMG_SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=yes \
    -o IdentitiesOnly=yes -o ConnectTimeout=12 -o ProxyCommand=none \
    -o PermitLocalCommand=no -o ClearAllForwardings=yes -o RequestTTY=no \
    -o ForwardAgent=no -o ForwardX11=no \
    "$FMG_SSH_TARGET" bash -s -- \
    "$payload_b64" <<'REMOTE'
set -euo pipefail
payload_b64="$1"
[[ "$payload_b64" =~ ^[A-Za-z0-9+/]+={0,2}$ ]]
payload_file="$(mktemp)"
openclaw=""
gate_export_root=""
cleanup_remote() {
    rm -f -- "$payload_file"
    if [[ -n "$openclaw" && "$gate_export_root" =~ ^/tmp/fmg-live-gate-trajectory\.[A-Za-z0-9]+$ ]]; then
        docker exec "$openclaw" rm -rf -- "$gate_export_root" >/dev/null 2>&1 || true
    fi
}
trap cleanup_remote EXIT HUP INT TERM
trap 'status=$?; printf "error: remote live gate failed at line %s (exit %s)\n" "$LINENO" "$status" >&2; exit "$status"' ERR
printf '%s' "$payload_b64" | base64 --decode >"$payload_file"

payload_value() {
    python3 -c '
import json,sys
with open(sys.argv[1], encoding="utf-8") as handle:
    value=json.load(handle)[sys.argv[2]]
if not isinstance(value,str):
    raise SystemExit("invalid remote payload value")
print(value,end="")
' "$payload_file" "$1"
}

relay="$(payload_value relay)"
openclaw="$(payload_value openclaw)"
expected_ref="$(payload_value expected_ref)"
expected_commit="$(payload_value expected_commit)"
expected_openclaw="$(payload_value expected_openclaw)"
expected_openclaw_build="$(payload_value expected_openclaw_build)"
expected_openclaw_configured_ref="$(payload_value expected_openclaw_configured_ref)"
expected_openclaw_image_id="$(payload_value expected_openclaw_image_id)"
expected_openclaw_source_revision="$(payload_value expected_openclaw_source_revision)"
expected_websocket_url="$(payload_value expected_websocket_url)"
expected_channel_package="$(payload_value expected_channel_package)"
expected_channel_plugin="$(payload_value expected_channel_plugin)"
expected_channel_integrity="$(payload_value expected_channel_integrity)"
expected_channel_install_path="$(payload_value expected_channel_install_path)"
expected_channel_package_json_sha="$(payload_value expected_channel_package_json_sha)"
expected_channel_package_tree_sha="$(payload_value expected_channel_package_tree_sha)"
expected_channel_runtime_entry="$(payload_value expected_channel_runtime_entry)"
expected_channel_runtime_entry_sha="$(payload_value expected_channel_runtime_entry_sha)"
expected_channel_activation_policy="$(payload_value expected_channel_activation_policy)"
expected_buzz_account="$(payload_value expected_buzz_account)"
expected_room_name="$(payload_value expected_room_name)"
expected_room_id_sha="$(payload_value expected_room_id_sha)"
expected_admin="$(payload_value expected_admin)"
expected_admin_package="$(payload_value expected_admin_package)"
expected_admin_integrity="$(payload_value expected_admin_integrity)"
expected_admin_build_identity="$(payload_value expected_admin_build_identity)"
expected_admin_runtime_entry_sha="$(payload_value expected_admin_runtime_entry_sha)"
expected_admin_tools_csv="$(payload_value expected_admin_tools_csv)"
expected_admin_agent_ids_csv="$(payload_value expected_admin_agent_ids_csv)"
expected_live_gate_agent="$(payload_value expected_live_gate_agent)"
expected_live_gate_model="$(payload_value expected_live_gate_model)"
expected_live_gate_runtime="$(payload_value expected_live_gate_runtime)"
expected_live_gate_code_mode="$(payload_value expected_live_gate_code_mode)"
expected_live_gate_tool="$(payload_value expected_live_gate_tool)"
expected_runtime="$(payload_value expected_runtime)"
expected_runtime_sha="$(payload_value expected_runtime_sha)"
expected_runtime_executable_sha="$(payload_value expected_runtime_executable_sha)"
expected_runtime_commit="$(payload_value expected_runtime_commit)"

actual_ref="$(docker inspect "$relay" --format '{{.Config.Image}}')"
actual_commit="$(docker inspect "$relay" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
[[ "$actual_ref" = "$expected_ref" ]]
[[ "$actual_commit" = "$expected_commit" ]]

actual_openclaw_ref="$(docker inspect "$openclaw" --format '{{.Config.Image}}')"
actual_openclaw_image_id="$(docker inspect "$openclaw" --format '{{.Image}}')"
actual_openclaw_source_revision="$(docker image inspect "$actual_openclaw_image_id" \
    --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
[[ "$actual_openclaw_ref" = "$expected_openclaw_configured_ref" ]]
[[ "$actual_openclaw_image_id" = "$expected_openclaw_image_id" ]]
[[ "$actual_openclaw_source_revision" = "$expected_openclaw_source_revision" ]]

# OpenClaw 2026.9.6 does not expose the loaded plugin source path through a
# Gateway RPC. Bind the authoritative active registry checks below to the one
# Gateway process that started after the exact managed package bytes instead.
find_gateway_pid() {
    docker exec "$openclaw" node -e '
const fs = require("node:fs");
const matches = [];
for (const entry of fs.readdirSync("/proc")) {
  if (!/^\d+$/u.test(entry)) continue;
  try {
    const argv = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8")
      .split("\0").filter(Boolean).map((value) => value.trimEnd());
    if (argv.length === 1 && argv[0] === "openclaw-gateway") matches.push(entry);
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "EACCES") throw error;
  }
}
if (matches.length !== 1) throw new Error("expected exactly one OpenClaw Gateway process");
process.stdout.write(matches[0]);
'
}
gateway_pid="$(find_gateway_pid)"
[[ "$gateway_pid" =~ ^[1-9][0-9]*$ ]]
gateway_process_identity() {
    docker exec "$openclaw" node -e '
const fs = require("node:fs");
const pid = process.argv[1];
if (!/^[1-9][0-9]*$/u.test(pid)) throw new Error("invalid Gateway PID");
const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8").trim();
const commEnd = stat.lastIndexOf(")");
if (commEnd < 0) throw new Error("invalid Gateway process stat");
const fields = stat.slice(commEnd + 2).split(/\s+/u);
const startTicks = fields[19];
if (!/^[1-9][0-9]*$/u.test(startTicks)) throw new Error("invalid Gateway process start ticks");
process.stdout.write(`${bootId} ${startTicks}`);
' "$1"
}
read -r gateway_boot_id gateway_start_ticks <<EOF
$(gateway_process_identity "$gateway_pid")
EOF
[[ "$gateway_boot_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]
[[ "$gateway_start_ticks" =~ ^[1-9][0-9]*$ ]]
gateway_process_started_epoch() {
    docker exec "$openclaw" sh -lc '
pid="$1"
case "$pid" in *[!0-9]*|"") exit 2 ;; esac
started="$(ps -o lstart= -p "$pid")"
test -n "$started"
date -d "$started" +%s
' sh "$1"
}
gateway_started_epoch="$(gateway_process_started_epoch "$gateway_pid")"
[[ "$gateway_started_epoch" =~ ^[1-9][0-9]*$ ]]

version="$(docker exec "$openclaw" sh -lc 'openclaw --version' | head -n 1)"
if [[ "$version" != "$expected_openclaw" ]]; then
    read -r version_name version_number version_build version_extra <<EOF
$version
EOF
    [[ "$version_name" = "OpenClaw" && "$version_number" = "$expected_openclaw" ]]
    [[ "$version_build" =~ ^\([0-9a-f]+\)$ && -z "${version_extra:-}" ]]
fi

gateway_probe="$(docker exec "$openclaw" openclaw gateway probe --json --port 18789 --timeout 15000)"
printf '%s' "$gateway_probe" | python3 -c '
import json,sys
d=json.load(sys.stdin)
expected_version,expected_build=sys.argv[1:]
targets=d.get("targets")
if not isinstance(targets,list) or len(targets)!=1:
    raise SystemExit("Gateway probe did not return exactly one target")
t=targets[0]
if not (d.get("primaryTargetId")=="localLoopback" and
        t.get("id")=="localLoopback" and t.get("kind")=="localLoopback" and
        t.get("active") is True and t.get("url")=="ws://127.0.0.1:18789" and
        t.get("connect",{}).get("ok") is True and
        t.get("server",{}).get("version")==expected_version and
        t.get("server",{}).get("buildId")==expected_build):
    raise SystemExit("active Gateway identity does not match the release descriptor")
' "$expected_openclaw" "$expected_openclaw_build"

gateway_call() {
    docker exec "$openclaw" openclaw gateway call "$1" --params "$2" --json \
        --expect-url ws://127.0.0.1:18789 --timeout 30000
}

plugins_list="$(gateway_call plugins.list '{}')"
plugin_generation="$(printf '%s' "$plugins_list" | python3 -c '
import json,sys
d=json.load(sys.stdin)
expected_channel_version,expected_admin_version=sys.argv[1:]
if not isinstance(d.get("generation"),int) or d["generation"] < 1:
    raise SystemExit("Gateway plugin generation is unavailable")
plugins=d.get("plugins")
if not isinstance(plugins,list):
    raise SystemExit("Gateway plugin list is unavailable")
def one(plugin_id):
    found=[p for p in plugins if p.get("id")==plugin_id]
    if len(found)!=1:
        raise SystemExit(f"expected exactly one {plugin_id} plugin")
    return found[0]
channel=one("buzz")
admin=one("buzz-admin")
if not (channel.get("installed") is True and channel.get("enabled") is True and
        channel.get("state")=="enabled" and channel.get("runtime",{}).get("state")=="active" and
        channel.get("packageName")=="@openclaw/buzz" and
        str(channel.get("version"))==expected_channel_version):
    raise SystemExit("official Buzz plugin is not active in the Gateway generation")
if not (admin.get("installed") is True and admin.get("enabled") is True and
        admin.get("state")=="enabled" and admin.get("runtime",{}).get("state")=="active" and
        admin.get("packageName")=="openclaw-plugin-buzz-admin" and
        str(admin.get("version"))==expected_admin_version):
    raise SystemExit("Buzz Admin plugin is not active in the Gateway generation")
print(d["generation"],end="")
' "$expected_channel_plugin" "$expected_admin")"

channel_inspect="$(gateway_call plugins.inspect '{"pluginId":"buzz"}')"
printf '%s' "$channel_inspect" | python3 -c '
import json,sys
d=json.load(sys.stdin)
package,version,integrity=sys.argv[1:]
p=d.get("plugin",{})
s=d.get("source",{})
declared=d.get("declared",{})
if not (d.get("ok") is True and p.get("id")=="buzz" and p.get("installed") is True and
        p.get("enabled") is True and str(p.get("version"))==version and
        s.get("kind")=="npm" and s.get("spec")==f"{package}@{version}" and
        s.get("packageName")==package and s.get("integrity")==integrity and
        s.get("integrityKind")=="ssri" and declared.get("channels")==["buzz"] and
        declared.get("tools")==[]):
    raise SystemExit("official Buzz plugin source identity check failed")
' "$expected_channel_package" "$expected_channel_plugin" "$expected_channel_integrity"

# A separate CLI scan resolves the package path that a fresh loader selects.
# The Gateway PID ordering and stable generation checks bridge that path to the
# authoritative active registry in this OpenClaw version.
validate_channel_info() {
    printf '%s' "$1" | python3 -c '
import datetime,hashlib,json,sys
d=json.load(sys.stdin)
p=d.get("plugin",{})
install=d.get("install",{})
package,version,integrity,host_version,install_path,runtime_entry,gateway_started=sys.argv[1:]
trust=p.get("trust",{})
checks={
    "runtime-state": (
        p.get("id")=="buzz" and p.get("enabled") is True and
        p.get("activated") is True and p.get("imported") is True and
        p.get("status")=="loaded" and p.get("error") is None
    ),
    "package-version": (
        p.get("origin")=="global" and p.get("kind")=="bundled-channel-entry" and
        p.get("packageName")==package and str(p.get("packageVersion"))==version and
        str(p.get("version"))==version and p.get("builtWithOpenClawVersion")==host_version
    ),
    "loader-path": (
        p.get("rootDir")==install_path and
        p.get("source")==f"{install_path}/{runtime_entry}" and
        p.get("channelIds")==["buzz"]
    ),
    "official-trust": (
        p.get("trustedOfficialInstall") is True and
        trust.get("reason")=="trusted-official" and trust.get("origin")=="global" and
        trust.get("installSource")=="npm"
    ),
    "install-source": (
        install.get("source")=="npm" and install.get("spec")==package and
        install.get("resolvedSpec")==f"{package}@{version}" and
        install.get("resolvedName")==package
    ),
    "install-version-integrity": (
        str(install.get("resolvedVersion"))==version and
        str(install.get("version"))==version and install.get("integrity")==integrity and
        install.get("installPath")==install_path
    ),
}
failed=[name for name,valid in checks.items() if not valid]
if failed:
    raise SystemExit("official Buzz local loader identity check failed: "+",".join(failed))
def parse_timestamp(name):
    value=install.get(name)
    if not isinstance(value,str) or not value.endswith("Z"):
        raise SystemExit(f"official Buzz install record has invalid {name}")
    try:
        parsed=datetime.datetime.fromisoformat(value[:-1]+"+00:00").timestamp()
    except ValueError as error:
        raise SystemExit(f"official Buzz install record has invalid {name}") from error
    return parsed
resolved_at=parse_timestamp("resolvedAt")
installed_at=parse_timestamp("installedAt")
if not (resolved_at <= installed_at <= int(gateway_started)):
    raise SystemExit("official Buzz install record does not predate the Gateway process")
identity={key:install.get(key) for key in (
    "source","spec","resolvedSpec","resolvedName","resolvedVersion","version",
    "integrity","installPath","resolvedAt","installedAt"
)}
print(hashlib.sha256(json.dumps(identity,sort_keys=True,separators=(",",":")).encode("utf-8")).hexdigest(),end="")
' "$expected_channel_package" "$expected_channel_plugin" "$expected_channel_integrity" \
        "$expected_openclaw" "$expected_channel_install_path" \
        "$expected_channel_runtime_entry" "$gateway_started_epoch"
}

[[ "$expected_channel_activation_policy" = \
    "gateway-pid-started-after-package-and-stable-generation" ]]
channel_info="$(docker exec "$openclaw" sh -lc 'openclaw plugins info buzz --runtime --json')"
channel_install_record_sha="$(validate_channel_info "$channel_info")"
[[ "$channel_install_record_sha" =~ ^[0-9a-f]{64}$ ]]

channel_root_realpath="$(docker exec "$openclaw" realpath "$expected_channel_install_path")"
[[ "$channel_root_realpath" = "$expected_channel_install_path" ]]
actual_channel_package_json_sha="$(docker exec "$openclaw" sha256sum \
    "$expected_channel_install_path/package.json" | cut -d' ' -f1)"
actual_channel_runtime_entry_sha="$(docker exec "$openclaw" sha256sum \
    "$expected_channel_install_path/$expected_channel_runtime_entry" | cut -d' ' -f1)"
[[ "$actual_channel_package_json_sha" = "$expected_channel_package_json_sha" ]]
[[ "$actual_channel_runtime_entry_sha" = "$expected_channel_runtime_entry_sha" ]]
docker exec "$openclaw" node -e '
const fs = require("node:fs");
const [path, expectedPackage, expectedVersion, expectedEntry, expectedHost] = process.argv.slice(1);
const value = JSON.parse(fs.readFileSync(path, "utf8"));
if (!(value?.name === expectedPackage && value?.version === expectedVersion &&
      JSON.stringify(value?.openclaw?.runtimeExtensions) === JSON.stringify([`./${expectedEntry}`]) &&
      value?.openclaw?.build?.openclawVersion === expectedHost)) {
  throw new Error("official Buzz package manifest does not match the release descriptor");
}
' "$expected_channel_install_path/package.json" "$expected_channel_package" \
    "$expected_channel_plugin" "$expected_channel_runtime_entry" "$expected_openclaw"

hash_channel_package_tree() {
    docker exec "$openclaw" node -e '
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[1];
const files = [];
let bytes = 0;
let maxMtimeMs = fs.lstatSync(root).mtimeMs;
let peerLinkSeen = false;
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    const stat = fs.lstatSync(absolute);
    maxMtimeMs = Math.max(maxMtimeMs, stat.mtimeMs);
    if (entry.isDirectory()) {
      walk(absolute);
    } else if (entry.isFile()) {
      if (stat.nlink !== 1) throw new Error(`hardlinked file in Buzz package: ${relative}`);
      bytes += stat.size;
      if (files.length >= 5000 || bytes > 100000000) throw new Error("Buzz package tree exceeds gate limits");
      files.push(absolute);
    } else if (entry.isSymbolicLink() && relative === "node_modules/openclaw" &&
               fs.readlinkSync(absolute) === "/usr/local/lib/node_modules/openclaw" &&
               fs.realpathSync(absolute) === "/usr/local/lib/node_modules/openclaw") {
      if (peerLinkSeen) throw new Error("duplicate OpenClaw peer link");
      peerLinkSeen = true;
    } else {
      throw new Error(`unsupported Buzz package entry: ${relative}`);
    }
  }
}
walk(root);
if (!peerLinkSeen) throw new Error("managed Buzz package is missing its exact OpenClaw peer link");
const digest = crypto.createHash("sha256");
for (const file of files.sort()) {
  const relative = path.relative(root, file).split(path.sep).join("/");
  const fileDigest = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  digest.update(relative).update("\0").update(fileDigest).update("\n");
}
process.stdout.write(`${digest.digest("hex")} ${Math.ceil(maxMtimeMs / 1000)}`);
' "$expected_channel_install_path"
}

read -r actual_channel_package_tree_sha channel_package_mtime_epoch <<EOF
$(hash_channel_package_tree)
EOF
[[ "$actual_channel_package_tree_sha" = "$expected_channel_package_tree_sha" ]]
[[ "$channel_package_mtime_epoch" =~ ^[1-9][0-9]*$ ]]
(( channel_package_mtime_epoch <= gateway_started_epoch ))

admin_inspect="$(gateway_call plugins.inspect '{"pluginId":"buzz-admin"}')"
printf '%s' "$admin_inspect" | python3 -c '
import json,sys
d=json.load(sys.stdin)
version,package,integrity=sys.argv[1:4]
expected_tools=sys.argv[4].split(",")
p=d.get("plugin",{})
source=d.get("source",{})
declared=d.get("declared",{})
tools=declared.get("tools")
if not (d.get("ok") is True and p.get("id")=="buzz-admin" and
        p.get("installed") is True and p.get("enabled") is True and
        str(p.get("version"))==version and
        source.get("kind")=="npm" and source.get("packageName")==package and
        source.get("spec")==f"{package}@{version}" and
        source.get("integrity")==integrity and source.get("integrityKind")=="ssri" and
        isinstance(tools,list) and len(tools)==len(expected_tools) and
        set(tools)==set(expected_tools) and declared.get("dangerousConfigFlags")==[]):
    raise SystemExit("Buzz Admin declared tool contract check failed")
' "$expected_admin" "$expected_admin_package" "$expected_admin_integrity" "$expected_admin_tools_csv"

status="$(gateway_call channels.status '{"channel":"buzz","probe":true,"timeoutMs":15000}')"
printf '%s' "$status" | python3 -c '
import hashlib,json,sys
d=json.load(sys.stdin)
accounts=d.get("channelAccounts",{}).get("buzz",[])
account_id,room_name,room_hash=sys.argv[1:]
selected=[a for a in accounts if a.get("accountId")==account_id]
if len(selected)!=1:
    raise SystemExit("expected exactly one configured Buzz account")
a=selected[0]
rooms=a.get("probe",{}).get("rooms")
if not isinstance(rooms,list):
    raise SystemExit("Buzz room inventory is unavailable")
matches=[r for r in rooms if r.get("name")==room_name]
if len(matches)!=1:
    raise SystemExit("required Buzz workspace is unavailable")
room_id=matches[0].get("id")
actual_hash=hashlib.sha256(str(room_id).encode("utf-8")).hexdigest() if room_id else ""
ready=(d.get("channels",{}).get("buzz",{}).get("ok") is True and
       a.get("enabled") is True and a.get("configured") is True and
       a.get("running") is True and a.get("connected") is True and
       not a.get("lastError") and a.get("probe",{}).get("ok") is True and
       a.get("probe",{}).get("roomCount")==len(rooms) and actual_hash==room_hash and
       not d.get("statusIssues"))
if not ready:
    raise SystemExit("Buzz account, room identity, or channel probe check failed")
' "$expected_buzz_account" "$expected_room_name" "$expected_room_id_sha"

# This local inspection verifies the installed file root and tool registry. The
# authoritative running generation was checked above through the Gateway RPC.
info="$(docker exec "$openclaw" sh -lc 'openclaw plugins info buzz-admin --runtime --json')"
printf '%s' "$info" | python3 -c '
import json,sys
d=json.load(sys.stdin)
p=d.get("plugin",{})
names=set(p.get("toolNames",[]))
names.update(name for tool in d.get("tools",[]) for name in tool.get("names",[]))
required=set(sys.argv[2].split(","))
ready=(p.get("id")=="buzz-admin" and p.get("enabled") is True and
       p.get("activated") is True and p.get("status")=="loaded" and
       p.get("error") is None and str(p.get("version"))==sys.argv[1] and
       names == required)
if not ready:
    raise SystemExit("Buzz Admin plugin runtime check failed")
' "$expected_admin" "$expected_admin_tools_csv"
admin_root="$(printf '%s' "$info" | python3 -c '
import json,sys
root=str(json.load(sys.stdin).get("plugin",{}).get("rootDir", ""))
if not (root.startswith("/data/.openclaw/") and ".." not in root.split("/")):
    raise SystemExit("Buzz Admin plugin root is outside the managed state directory")
print(root)
')"
actual_admin_runtime_entry_sha="$(docker exec "$openclaw" sha256sum \
    "$admin_root/dist/index.js" | cut -d' ' -f1)"
[[ "$actual_admin_runtime_entry_sha" = "$expected_admin_runtime_entry_sha" ]]

docker exec "$openclaw" sh -lc 'test -x /data/.openclaw/bin/buzz'
actual_runtime_executable_sha="$(docker exec "$openclaw" sha256sum \
    "/data/.openclaw/runtimes/sprig/$expected_runtime/sprig" | cut -d' ' -f1)"
actual_cli_sha="$(docker exec "$openclaw" sha256sum /data/.openclaw/bin/buzz | cut -d' ' -f1)"
[[ "$actual_runtime_executable_sha" = "$expected_runtime_executable_sha" ]]
[[ "$actual_cli_sha" = "$expected_runtime_executable_sha" ]]
runtime_manifest="$(docker exec "$openclaw" cat "/data/.openclaw/runtimes/sprig/$expected_runtime/sprig.json")"
printf '%s' "$runtime_manifest" | python3 -c '
import json,sys
d=json.load(sys.stdin)
binaries=d.get("binaries")
if not (d.get("version")==sys.argv[1] and d.get("git_sha")==sys.argv[2] and
        isinstance(binaries,list) and
        any(b.get("name")=="sprig" and b.get("sha256")==sys.argv[3] for b in binaries)):
    raise SystemExit("Sprig runtime manifest does not match the release descriptor")
' "$expected_runtime" "$expected_runtime_commit" "$expected_runtime_executable_sha"

config_snapshot="$(gateway_call config.get '{}')"
config_revision="$(printf '%s' "$config_snapshot" | python3 -c '
import json,sys
d=json.load(sys.stdin)
relay_url,agent_ids_csv,admin_tools_csv,gate_id,gate_model,gate_runtime,gate_code_mode,gate_tool=sys.argv[1:]
revision=d.get("configRevisionHash")
applied=d.get("appliedConfigHash")
if not (d.get("valid") is True and isinstance(revision,str) and revision and revision==applied):
    raise SystemExit("Gateway configuration revision is not fully applied")
runtime=d.get("runtimeConfig")
if not isinstance(runtime,dict):
    raise SystemExit("Gateway runtime configuration is unavailable")
buzz=runtime.get("channels",{}).get("buzz",{})
if not (buzz.get("enabled") is True and buzz.get("relayUrl")==relay_url):
    raise SystemExit("active Buzz relay selection does not match the release descriptor")
plugins=runtime.get("plugins",{})
allow=plugins.get("allow")
entries=plugins.get("entries",{})
if not (isinstance(allow,list) and "buzz" in allow and "buzz-admin" in allow and
        entries.get("buzz",{}).get("enabled") is True and
        entries.get("buzz-admin",{}).get("enabled") is True):
    raise SystemExit("active Gateway plugin policy does not enable both Buzz plugins")
agents_root=runtime.get("agents")
if not isinstance(agents_root,dict):
    raise SystemExit("active Gateway agent roster is unavailable")
has_entries="entries" in agents_root
has_list="list" in agents_root
if has_entries == has_list:
    raise SystemExit("active Gateway agent roster shape is missing or ambiguous")
if has_entries:
    entries=agents_root.get("entries")
    if not isinstance(entries,dict) or not all(
        isinstance(agent_id,str) and isinstance(entry,dict) and
        entry.get("id",agent_id)==agent_id for agent_id,entry in entries.items()
    ):
        raise SystemExit("active Gateway agents.entries roster contains invalid IDs")
    by_id={agent_id:{"id":agent_id,**entry} for agent_id,entry in entries.items()}
else:
    entries=agents_root.get("list")
    if not isinstance(entries,list):
        raise SystemExit("active Gateway agents.list roster is not an array")
    by_id={entry.get("id"):entry for entry in entries if isinstance(entry,dict)}
    if len(by_id)!=len(entries) or not all(isinstance(agent_id,str) and agent_id for agent_id in by_id):
        raise SystemExit("active Gateway agents.list roster contains invalid or duplicate IDs")
gate=by_id.get(gate_id,{})
gate_tools=gate.get("tools",{})
gate_models=gate.get("models")
expected_gate_models={gate_model:{"agentRuntime":{"id":gate_runtime},"codeMode":False}}
if not (gate_code_mode=="disabled" and gate.get("model")==gate_model and
        gate_models==expected_gate_models and
        gate_tools.get("allow")==[gate_tool] and
        "alsoAllow" not in gate_tools and "profile" not in gate_tools):
    raise SystemExit("the live-gate agent must have the pinned model/runtime and exact one-tool allowlist")
expected_tools=admin_tools_csv.split(",")
for agent_id in agent_ids_csv.split(","):
    tools=by_id.get(agent_id,{}).get("tools",{})
    if not (tools.get("profile")=="coding" and tools.get("alsoAllow")==expected_tools and
            "allow" not in tools):
        raise SystemExit(f"{agent_id} does not have the exact FMG Buzz tool grant")
print(revision,end="")
' "$expected_websocket_url" "$expected_admin_agent_ids_csv" "$expected_admin_tools_csv" \
    "$expected_live_gate_agent" "$expected_live_gate_model" "$expected_live_gate_runtime" \
    "$expected_live_gate_code_mode" "$expected_live_gate_tool")"

gate_nonce="$(date -u +%s)-$$"
gate_session="agent:$expected_live_gate_agent:release-check-$gate_nonce"
gate_run_id="$expected_live_gate_agent-$gate_nonce"
agent_params="$(python3 -c '
import json,sys
session_key,run_id,agent_id,tool_name=sys.argv[1:]
print(json.dumps({
    "message":f"Call {tool_name} exactly once with an empty input object. Return only its JSON result. Do not call any other tool and do not send any message.",
    "agentId":agent_id,
    "sessionKey":session_key,
    "deliver":False,
    "timeout":120,
    "idempotencyKey":run_id,
},separators=(",",":")),end="")
' "$gate_session" "$gate_run_id" "$expected_live_gate_agent" "$expected_live_gate_tool")"
runtime_check_status=0
runtime_check="$(docker exec "$openclaw" openclaw gateway call agent \
    --params "$agent_params" --json --expect-final \
    --expect-url ws://127.0.0.1:18789 --timeout 135000)" || runtime_check_status=$?
if (( runtime_check_status != 0 )); then
    printf '%s' "$runtime_check" | python3 -c '
import json,re,sys
try:
    code=json.load(sys.stdin).get("error",{}).get("code")
except (AttributeError,json.JSONDecodeError):
    code=None
if not isinstance(code,str) or not re.fullmatch(r"[A-Z0-9_]{1,64}",code):
    code="UNKNOWN"
print(f"Gateway live-gate agent call failed with code {code}",file=sys.stderr)
'
    exit "$runtime_check_status"
fi
printf '%s' "$runtime_check" | python3 -c '
import json,sys
root=json.load(sys.stdin)
run_id,tool_name=sys.argv[1:]
meta=root.get("result",{}).get("meta",{})
summary=meta.get("toolSummary",{})
receipt=meta.get("agentMeta",{}).get("terminalReceipt",{})
valid=(root.get("runId")==run_id and root.get("status")=="ok" and
       root.get("summary")=="completed" and
       summary.get("calls")==1 and summary.get("tools")==[tool_name] and
       summary.get("failures")==0 and not summary.get("unresolvedError") and
       receipt.get("successfulToolNames")==[tool_name])
if not valid:
    raise SystemExit("Gateway turn did not execute exactly one successful runtime check")
' "$gate_run_id" "$expected_live_gate_tool"

config_after="$(gateway_call config.get '{}')"
printf '%s' "$config_after" | python3 -c '
import json,sys
d=json.load(sys.stdin)
if not (d.get("valid") is True and d.get("configRevisionHash")==sys.argv[1] and
        d.get("appliedConfigHash")==sys.argv[1]):
    raise SystemExit("Gateway configuration changed during the runtime-check turn")
' "$config_revision"

# The agent's final prose is model-generated. Export the canonical session
# trajectory and validate the persisted toolResult.details instead.
gate_export_root="$(docker exec "$openclaw" sh -c '
set -eu
root="$(mktemp -d /tmp/fmg-live-gate-trajectory.XXXXXX)"
owner="$(stat -c "%u:%g" /data/.openclaw)"
uid="${owner%:*}"
gid="${owner#*:}"
case "$uid" in ""|*[!0-9]*) exit 2 ;; esac
case "$gid" in ""|*[!0-9]*) exit 2 ;; esac
chown "$uid:$gid" "$root"
chmod 0700 "$root"
printf "%s" "$root"
')"
[[ "$gate_export_root" =~ ^/tmp/fmg-live-gate-trajectory\.[A-Za-z0-9]+$ ]]
docker exec "$openclaw" openclaw sessions export-trajectory \
    --agent "$expected_live_gate_agent" --session-key "$gate_session" \
    --workspace "$gate_export_root" --output evidence --json >/dev/null
events_path="$gate_export_root/.openclaw/trajectory-exports/evidence/events.jsonl"
docker exec "$openclaw" node -e '
const fs = require("node:fs");
const [path, expectedSession, expectedTool, expectedAccount, expectedVersion, expectedBuild, expectedEntrySha] = process.argv.slice(1);
const events = fs.readFileSync(path, "utf8").split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
const calls = events.filter((event) =>
  event.traceSchema === "openclaw-trajectory" && event.schemaVersion === 1 &&
  event.source === "transcript" && event.type === "tool.call" &&
  event.sessionKey === expectedSession
);
if (calls.length !== 1 || calls[0].data?.name !== expectedTool) {
  throw new Error("expected exactly one persisted Buzz runtime-check call");
}
const args = calls[0].data?.arguments;
if (!args || Array.isArray(args) || typeof args !== "object" || Object.keys(args).length !== 0) {
  throw new Error("persisted Buzz runtime-check input was not the exact empty object");
}
const results = events.filter((event) =>
  event.traceSchema === "openclaw-trajectory" && event.schemaVersion === 1 &&
  event.source === "transcript" && event.type === "tool.result" &&
  event.sessionKey === expectedSession && event.data?.message?.role === "toolResult" &&
  event.data.message.toolName === expectedTool
);
if (results.length !== 1) throw new Error("expected exactly one persisted Buzz runtime-check result");
const message = results[0].data.message;
if (message.isError !== false) throw new Error("persisted Buzz runtime check is an error result");
const callId = calls[0].data?.toolCallId;
const resultId = message.toolCallId;
if (!(typeof callId === "string" && callId.length > 0 &&
      typeof resultId === "string" && resultId.length > 0 && callId === resultId)) {
  throw new Error("persisted Buzz runtime-check call/result identity mismatch");
}
const result = message.details;
const gateway = result?.gateway;
if (!(result?.ok === true && result?.connected === true && result?.probeOk === true &&
      result?.accountId === expectedAccount && result?.plugin?.id === "buzz-admin" &&
      result?.plugin?.version === expectedVersion && result?.plugin?.buildIdentity === expectedBuild &&
      result?.plugin?.runtimeEntrySha256 === expectedEntrySha &&
      Number.isSafeInteger(result?.roomCount) && result.roomCount > 0 &&
      gateway?.buzzCliReady === true && gateway?.credentialReady === true &&
      gateway?.workReportReady === true)) {
  throw new Error("persisted Buzz runtime check did not report ready state");
}
' "$events_path" "$gate_session" "$expected_live_gate_tool" "$expected_buzz_account" "$expected_admin" \
    "$expected_admin_build_identity" "$expected_admin_runtime_entry_sha"

gateway_pid_after="$(find_gateway_pid)"
gateway_started_epoch_after="$(gateway_process_started_epoch "$gateway_pid_after")"
read -r gateway_boot_id_after gateway_start_ticks_after <<EOF
$(gateway_process_identity "$gateway_pid_after")
EOF
[[ "$gateway_pid_after" = "$gateway_pid" ]]
[[ "$gateway_started_epoch_after" = "$gateway_started_epoch" ]]
[[ "$gateway_boot_id_after" = "$gateway_boot_id" ]]
[[ "$gateway_start_ticks_after" = "$gateway_start_ticks" ]]

plugins_after="$(gateway_call plugins.list '{}')"
printf '%s' "$plugins_after" | python3 -c '
import json,sys
d=json.load(sys.stdin)
generation=int(sys.argv[1])
channel_version,admin_version=sys.argv[2:]
plugins=d.get("plugins")
if not (d.get("generation")==generation and isinstance(plugins,list)):
    raise SystemExit("Gateway plugin generation changed during the live gate")
def one(plugin_id):
    found=[p for p in plugins if p.get("id")==plugin_id]
    if len(found)!=1:
        raise SystemExit(f"expected exactly one {plugin_id} plugin after the live turn")
    return found[0]
channel=one("buzz")
admin=one("buzz-admin")
if not (channel.get("installed") is True and channel.get("enabled") is True and
        channel.get("state")=="enabled" and channel.get("runtime",{}).get("state")=="active" and
        channel.get("packageName")=="@openclaw/buzz" and str(channel.get("version"))==channel_version and
        admin.get("installed") is True and admin.get("enabled") is True and
        admin.get("state")=="enabled" and admin.get("runtime",{}).get("state")=="active" and
        admin.get("packageName")=="openclaw-plugin-buzz-admin" and
        str(admin.get("version"))==admin_version):
    raise SystemExit("Gateway plugin state changed during the live gate")
' "$plugin_generation" "$expected_channel_plugin" "$expected_admin"

channel_info_after="$(docker exec "$openclaw" sh -lc 'openclaw plugins info buzz --runtime --json')"
channel_install_record_sha_after="$(validate_channel_info "$channel_info_after")"
[[ "$channel_install_record_sha_after" = "$channel_install_record_sha" ]]

read -r final_channel_package_tree_sha final_channel_package_mtime_epoch <<EOF
$(hash_channel_package_tree)
EOF
[[ "$final_channel_package_tree_sha" = "$expected_channel_package_tree_sha" ]]
[[ "$final_channel_package_mtime_epoch" = "$channel_package_mtime_epoch" ]]
(( final_channel_package_mtime_epoch <= gateway_started_epoch_after ))

# End on fresh authoritative snapshots after the comparatively long package
# hash. PID start ticks prevent same-PID, same-second process replacement from
# satisfying the process-stability check.
final_plugins="$(gateway_call plugins.list '{}')"
printf '%s' "$final_plugins" | python3 -c '
import json,sys
d=json.load(sys.stdin)
generation=int(sys.argv[1])
channel_version,admin_version=sys.argv[2:]
plugins=d.get("plugins")
if not (d.get("generation")==generation and isinstance(plugins,list)):
    raise SystemExit("Gateway plugin generation changed after the package proof")
def one(plugin_id):
    found=[p for p in plugins if p.get("id")==plugin_id]
    if len(found)!=1:
        raise SystemExit(f"expected exactly one {plugin_id} plugin in the final Gateway snapshot")
    return found[0]
channel=one("buzz")
admin=one("buzz-admin")
if not (channel.get("installed") is True and channel.get("enabled") is True and
        channel.get("state")=="enabled" and channel.get("runtime",{}).get("state")=="active" and
        channel.get("packageName")=="@openclaw/buzz" and str(channel.get("version"))==channel_version and
        admin.get("installed") is True and admin.get("enabled") is True and
        admin.get("state")=="enabled" and admin.get("runtime",{}).get("state")=="active" and
        admin.get("packageName")=="openclaw-plugin-buzz-admin" and
        str(admin.get("version"))==admin_version):
    raise SystemExit("Gateway plugin state changed after the package proof")
' "$plugin_generation" "$expected_channel_plugin" "$expected_admin"

final_config="$(gateway_call config.get '{}')"
printf '%s' "$final_config" | python3 -c '
import json,sys
d=json.load(sys.stdin)
if not (d.get("valid") is True and d.get("configRevisionHash")==sys.argv[1] and
        d.get("appliedConfigHash")==sys.argv[1]):
    raise SystemExit("Gateway configuration changed after the package proof")
' "$config_revision"

final_gateway_pid="$(find_gateway_pid)"
final_gateway_started_epoch="$(gateway_process_started_epoch "$final_gateway_pid")"
read -r final_gateway_boot_id final_gateway_start_ticks <<EOF
$(gateway_process_identity "$final_gateway_pid")
EOF
[[ "$final_gateway_pid" = "$gateway_pid" ]]
[[ "$final_gateway_started_epoch" = "$gateway_started_epoch" ]]
[[ "$final_gateway_boot_id" = "$gateway_boot_id" ]]
[[ "$final_gateway_start_ticks" = "$gateway_start_ticks" ]]

printf 'relay_ref=%s\nrelay_source_commit=%s\nopenclaw_version=%s\nopenclaw_build_id=%s\nopenclaw_image_id=%s\nbuzz_channel=connected\nbuzz_channel_runtime_entry_sha256=%s\nbuzz_channel_package_tree_sha256=%s\ngateway_plugin_generation=%s\nbuzz_admin_version=%s\nbuzz_admin_runtime_entry_sha256=%s\nbuzz_runtime_check=ready\nruntime_version=%s\nruntime_archive_sha256=%s\nruntime_executable_sha256=%s\n' \
    "$actual_ref" "$actual_commit" "$expected_openclaw" "$expected_openclaw_build" \
    "$actual_openclaw_image_id" "$expected_channel_runtime_entry_sha" \
    "$expected_channel_package_tree_sha" "$plugin_generation" "$expected_admin" \
    "$expected_admin_runtime_entry_sha" "$expected_runtime" "$expected_runtime_sha" \
    "$expected_runtime_executable_sha"
REMOTE
