#!/usr/bin/env bash
# Build, test and install the repository-owned Buzz tools through OpenClaw's
# managed npm-pack route. Run this inside the OpenClaw container, then restart
# the Gateway so every agent sees the new runtime inventory.
set -euo pipefail

SOURCE="${1:-/tmp/buzz-admin}"
MANIFEST="${2:-/tmp/fmg-live.json}"
STATE_ROOT="/data/.openclaw"
LEGACY_PATH="$STATE_ROOT/plugin-src/buzz-admin"
ROLLBACK_ROOT="$STATE_ROOT/plugin-rollbacks"
GATEWAY_URL="${FMG_OPENCLAW_GATEWAY_URL:-ws://127.0.0.1:18789}"
EXPECTED_RECONCILE_HELPER_SHA256="0a16b533d852df7c93351b708765da393774da29014e7b96525e710640580388"

[[ -z "${FMG_OPENCLAW_STATE_ROOT:-}" || "$FMG_OPENCLAW_STATE_ROOT" == "$STATE_ROOT" ]] || {
    echo "error: buzz-admin installation is pinned to /data/.openclaw" >&2
    exit 2
}
[[ -z "${OPENCLAW_STATE_DIR:-}" || "$OPENCLAW_STATE_DIR" == "$STATE_ROOT" ]] || {
    echo "error: OPENCLAW_STATE_DIR does not match the pinned OpenClaw state directory" >&2
    exit 2
}
[[ -z "${OPENCLAW_CONFIG_PATH:-}" || "$OPENCLAW_CONFIG_PATH" == "$STATE_ROOT/openclaw.json" ]] || {
    echo "error: OPENCLAW_CONFIG_PATH does not match the pinned OpenClaw config" >&2
    exit 2
}
export OPENCLAW_STATE_DIR="$STATE_ROOT"
export OPENCLAW_CONFIG_PATH="$STATE_ROOT/openclaw.json"

[[ "$GATEWAY_URL" =~ ^ws://127\.0\.0\.1:([1-9][0-9]{0,4})$ ]] || {
    echo "error: FMG_OPENCLAW_GATEWAY_URL must be an exact ws://127.0.0.1:<port> URL" >&2
    exit 2
}
gateway_port="${BASH_REMATCH[1]}"
(( 10#$gateway_port <= 65535 )) || {
    echo "error: FMG_OPENCLAW_GATEWAY_URL port is out of range" >&2
    exit 2
}

for command in chown cut flock id jq node npm openclaw realpath sha256sum stat; do
    command -v "$command" >/dev/null || {
        echo "error: required command is unavailable: $command" >&2
        exit 2
    }
done
installer_path="$(realpath -e -- "${BASH_SOURCE[0]}")"
installer_root="${installer_path%/*}"
RECONCILE_HELPER_SOURCE="$installer_root/openclaw-buzz-admin-reconcile.mjs"
[[ -f "$RECONCILE_HELPER_SOURCE" && ! -L "$RECONCILE_HELPER_SOURCE" &&
    "$(realpath -e -- "$RECONCILE_HELPER_SOURCE")" == "$RECONCILE_HELPER_SOURCE" ]] || {
    echo "error: buzz-admin reconciliation helper is missing or unsafe" >&2
    exit 2
}
helper_source_mode="$(stat -Lc '%a' -- "$RECONCILE_HELPER_SOURCE")"
helper_source_owner="$(stat -Lc '%u' -- "$RECONCILE_HELPER_SOURCE")"
if [[ "$helper_source_owner" != "$(id -u)" ]] || (( (8#$helper_source_mode & 022) != 0 )); then
    echo "error: buzz-admin reconciliation helper has an unsafe owner or mode" >&2
    exit 2
fi
[[ -d "$SOURCE" ]] || { echo "error: plugin source directory not found: $SOURCE" >&2; exit 2; }
[[ -f "$MANIFEST" ]] || { echo "error: descriptor not found: $MANIFEST" >&2; exit 2; }

[[ -d "$STATE_ROOT" && ! -L "$STATE_ROOT" ]] || {
    echo "error: pinned OpenClaw state directory must be a real directory" >&2
    exit 1
}
[[ "$(realpath -e -- "$STATE_ROOT")" == "$STATE_ROOT" ]] || {
    echo "error: pinned OpenClaw state directory must not traverse symlinks" >&2
    exit 1
}
lock_path="$STATE_ROOT/.buzz-admin-install.lock"
if [[ ! -e "$lock_path" && ! -L "$lock_path" ]]; then
    # noclobber uses exclusive creation, so a pre-existing symlink is never
    # followed while establishing the persistent lock inode.
    (umask 077; set -o noclobber; : > "$lock_path") 2>/dev/null || true
fi
[[ -f "$lock_path" && ! -L "$lock_path" ]] || {
    echo "error: buzz-admin installer lock is not a regular file" >&2
    exit 1
}
lock_mode="$(stat -Lc '%a' -- "$lock_path")"
if (( (8#$lock_mode & 022) != 0 )); then
    echo "error: buzz-admin installer lock must not be group- or world-writable" >&2
    exit 1
fi
lock_identity="$(stat -Lc '%d:%i' -- "$lock_path")"
exec 9<"$lock_path"
opened_lock_identity="$(stat -Lc '%d:%i' -- "/proc/$$/fd/9")"
current_lock_identity="$(stat -Lc '%d:%i' -- "$lock_path")"
[[ ! -L "$lock_path" && "$opened_lock_identity" == "$lock_identity" &&
    "$current_lock_identity" == "$lock_identity" ]] || {
    echo "error: buzz-admin installer lock changed while it was opened" >&2
    exit 1
}
flock -n 9 || {
    echo "error: another buzz-admin installation is in progress" >&2
    exit 1
}
[[ ! -L "$lock_path" && "$(stat -Lc '%d:%i' -- "$lock_path")" == "$opened_lock_identity" ]] || {
    echo "error: buzz-admin installer lock path changed during acquisition" >&2
    exit 1
}

stage=""
pack_root=""
helper_stage=""
success=0
lifecycle_started=0
config_backup=""
legacy_backup=""
cleanup() {
    status=$?
    if (( status != 0 && success == 0 )); then
        # Before a managed lifecycle command starts, these are only our own
        # preparatory edits and can be restored. Once uninstall/install starts,
        # OpenClaw owns config, payload, installed-index and runtime-generation
        # consistency; a post-commit error must not be "rolled back" by copying
        # only openclaw.json.
        if (( lifecycle_started == 0 )) && [[ -n "$config_backup" && -f "$config_backup" ]]; then
            restore_config="$STATE_ROOT/.openclaw.json.restore.$$"
            cp -p "$config_backup" "$restore_config"
            mv -f "$restore_config" "$STATE_ROOT/openclaw.json"
        fi
        if (( lifecycle_started == 0 )) && \
            [[ -n "$legacy_backup" && -d "$legacy_backup" && ! -e "$LEGACY_PATH" ]]; then
            mkdir -p "$(dirname "$LEGACY_PATH")"
            mv "$legacy_backup" "$LEGACY_PATH"
        fi
    fi
    if [[ -n "${stage:-}" && -d "$stage" ]]; then rm -rf -- "$stage"; fi
    if [[ -n "${pack_root:-}" && -d "$pack_root" ]]; then rm -rf -- "$pack_root"; fi
    if [[ -n "${helper_stage:-}" && -d "$helper_stage" ]]; then rm -rf -- "$helper_stage"; fi
    exit "$status"
}
trap cleanup EXIT

helper_stage="$(mktemp -d "${TMPDIR:-/tmp}/buzz-admin-reconcile.XXXXXX")"
chmod 0700 "$helper_stage"
RECONCILE_HELPER="$helper_stage/openclaw-buzz-admin-reconcile.mjs"
helper_source_identity_before="$(stat -Lc '%d:%i:%s' -- "$RECONCILE_HELPER_SOURCE")"
helper_source_sha_before="$(sha256sum "$RECONCILE_HELPER_SOURCE" | cut -d' ' -f1)"
cp -- "$RECONCILE_HELPER_SOURCE" "$RECONCILE_HELPER"
chmod 0500 "$RECONCILE_HELPER"
helper_source_identity_after="$(stat -Lc '%d:%i:%s' -- "$RECONCILE_HELPER_SOURCE")"
helper_source_sha_after="$(sha256sum "$RECONCILE_HELPER_SOURCE" | cut -d' ' -f1)"
helper_private_sha="$(sha256sum "$RECONCILE_HELPER" | cut -d' ' -f1)"
[[ "$helper_source_identity_before" == "$helper_source_identity_after" &&
    "$helper_source_sha_before" == "$EXPECTED_RECONCILE_HELPER_SHA256" &&
    "$helper_source_sha_before" == "$helper_source_sha_after" &&
    "$helper_private_sha" == "$helper_source_sha_before" ]] || {
    echo "error: buzz-admin reconciliation helper changed while it was staged" >&2
    exit 1
}

stage="$(mktemp -d "${TMPDIR:-/tmp}/buzz-admin-install.XXXXXX")"
chmod 0700 "$stage"

# OpenClaw's managed lifecycle consumes the npm-pack path in the running Gateway
# context. Keep the archive in the shared persistent state mount, and give it
# the state tree's numeric owner because the installer may run as root while the
# Gateway runs as the state owner. Retain it until the install and postcondition
# have both completed.
state_owner="$(stat -Lc '%u:%g' -- "$STATE_ROOT")"
[[ "$state_owner" =~ ^[0-9]+:[0-9]+$ ]] || {
    echo "error: pinned OpenClaw state directory has an invalid numeric owner" >&2
    exit 1
}
pack_root="$(mktemp -d "$STATE_ROOT/.buzz-admin-pack.XXXXXX")"
pack_root="$(realpath -e -- "$pack_root")"
[[ -d "$pack_root" && ! -L "$pack_root" &&
    "${pack_root%/*}" == "$STATE_ROOT" &&
    "${pack_root##*/}" == .buzz-admin-pack.* ]] || {
    echo "error: npm-pack staging directory escaped the pinned OpenClaw state directory" >&2
    exit 1
}
chown "$state_owner" "$pack_root"
chmod 0700 "$pack_root"
[[ "$(stat -Lc '%u:%g' -- "$pack_root")" == "$state_owner" &&
    "$(stat -Lc '%a' -- "$pack_root")" == 700 ]] || {
    echo "error: npm-pack staging directory owner or mode is not private" >&2
    exit 1
}

# Snapshot only attested source inputs. The copy rejects links and special
# files; hashing the private stage after the copy closes the source TOCTOU.
node --input-type=module - "$SOURCE" "$stage" <<'NODE'
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const source = resolve(process.argv[2]);
const stage = resolve(process.argv[3]);
const excluded = new Set(["node_modules", "dist", ".pack"]);
function copyTree(from, to) {
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.isDirectory() && excluded.has(entry.name)) continue;
    const sourcePath = join(from, entry.name);
    const stagePath = join(to, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(stagePath, { mode: 0o755 });
      copyTree(sourcePath, stagePath);
    } else if (entry.isFile()) {
      copyFileSync(sourcePath, stagePath);
    } else {
      throw new Error(`unsupported plugin source-tree entry: ${sourcePath}`);
    }
  }
}
copyTree(source, stage);
NODE

[[ -f "$stage/package.json" && ! -L "$stage/package.json" && \
    -f "$stage/package-lock.json" && ! -L "$stage/package-lock.json" && \
    -f "$stage/openclaw.plugin.json" && ! -L "$stage/openclaw.plugin.json" ]] || {
    echo "error: staged plugin source is incomplete" >&2
    exit 2
}

expected_version="$(jq -er '.openclaw.buzz_admin_plugin.version' "$MANIFEST")"
expected_package="$(jq -er '.openclaw.buzz_admin_plugin.package' "$MANIFEST")"
expected_integrity="$(jq -er '.openclaw.buzz_admin_plugin.integrity' "$MANIFEST")"
expected_build_identity="$(jq -er '.openclaw.buzz_admin_plugin.build_identity' "$MANIFEST")"
expected_source_tree_sha="$(jq -er '.openclaw.buzz_admin_plugin.source_tree_sha256' "$MANIFEST")"
expected_runtime_entry_sha="$(jq -er '.openclaw.buzz_admin_plugin.runtime_entry_sha256' "$MANIFEST")"
expected_tools_json="$(jq -ce '
  .openclaw.buzz_admin_plugin.tools |
  if type != "array" then error("buzz-admin tools must be an array")
  elif length == 0 then error("buzz-admin tools must not be empty")
  elif any(.[]; type != "string" or length == 0) then
    error("buzz-admin tools must contain non-empty strings")
  elif (unique | length) != length then error("buzz-admin tools must be unique")
  else sort
  end
' "$MANIFEST")"
package_version="$(jq -er '.version' "$stage/package.json")"
package_name="$(jq -er '.name' "$stage/package.json")"
plugin_version="$(jq -er '.version' "$stage/openclaw.plugin.json")"
[[ "$expected_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
    echo "error: invalid buzz-admin version" >&2
    exit 2
}
[[ "$expected_package" == "openclaw-plugin-buzz-admin" &&
    "$package_name" == "$expected_package" &&
    "$package_version" == "$expected_version" && "$plugin_version" == "$expected_version" ]] || {
    echo "error: plugin version does not match the release descriptor" >&2
    exit 1
}
[[ "$expected_integrity" =~ ^sha512-[A-Za-z0-9+/]{86}==$ ]] || {
    echo "error: invalid buzz-admin package integrity" >&2
    exit 2
}
[[ "$expected_source_tree_sha" =~ ^[0-9a-f]{64}$ && ! "$expected_source_tree_sha" =~ ^0+$ ]] || {
    echo "error: invalid buzz-admin source tree SHA-256" >&2
    exit 2
}
[[ "$expected_build_identity" =~ ^[0-9a-f]{64}$ && ! "$expected_build_identity" =~ ^0+$ ]] || {
    echo "error: invalid buzz-admin build identity" >&2
    exit 2
}
[[ "$expected_runtime_entry_sha" =~ ^[0-9a-f]{64}$ && ! "$expected_runtime_entry_sha" =~ ^0+$ ]] || {
    echo "error: invalid buzz-admin runtime entry SHA-256" >&2
    exit 2
}

actual_source_tree_sha="$(node --input-type=module - "$stage" <<'NODE'
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const root = resolve(process.argv[2]);
const files = [];
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute);
    else if (entry.isFile()) files.push(absolute);
    else throw new Error(`unsupported staged source-tree entry: ${absolute}`);
  }
}
walk(root);
const digest = createHash("sha256");
for (const file of files.sort()) {
  const name = relative(root, file).split(sep).join("/");
  const fileDigest = createHash("sha256").update(readFileSync(file)).digest("hex");
  digest.update(name).update("\0").update(fileDigest).update("\n");
}
process.stdout.write(digest.digest("hex"));
NODE
)"
[[ "$actual_source_tree_sha" == "$expected_source_tree_sha" ]] || {
    echo "error: buzz-admin source tree SHA-256 does not match the release descriptor" >&2
    exit 1
}

(
    cd "$stage"
    npm ci --ignore-scripts
    npm test
    npm run plugin:validate
)

actual_runtime_entry_sha="$(sha256sum "$stage/dist/index.js" | cut -d' ' -f1)"
[[ "$actual_runtime_entry_sha" == "$expected_runtime_entry_sha" ]] || {
    echo "error: buzz-admin runtime entry SHA-256 does not match the release descriptor" >&2
    exit 1
}
node --input-type=module - "$stage/dist/index.js" "$expected_build_identity" <<'NODE'
import { readFileSync } from "node:fs";
const [entry, expected] = process.argv.slice(2);
if (!readFileSync(entry, "utf8").includes(expected)) {
  throw new Error("compiled buzz-admin entrypoint is missing the descriptor build identity");
}
NODE

mode="$(stat -c '%a' "$stage")"
if (( (8#$mode & 2) != 0 )); then
    echo "error: staged OpenClaw plugin directory is world-writable" >&2
    exit 1
fi

pack_json="$(cd "$stage" && npm pack --ignore-scripts --json --pack-destination "$pack_root")"
pack_file="$(printf '%s' "$pack_json" | jq -er '.[0].filename')"
[[ "$pack_file" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$ ]] || {
    echo "error: npm pack returned an unsafe archive basename" >&2
    exit 1
}
package_archive="$pack_root/$pack_file"
[[ -f "$package_archive" && ! -L "$package_archive" &&
    "$(realpath -e -- "$package_archive")" == "$package_archive" ]] || {
    echo "error: npm pack did not create a regular archive in the private staging directory" >&2
    exit 1
}
chown "$state_owner" "$package_archive"
chmod 0600 "$package_archive"
[[ "$(stat -Lc '%u:%g' -- "$package_archive")" == "$state_owner" &&
    "$(stat -Lc '%a' -- "$package_archive")" == 600 ]] || {
    echo "error: npm-pack archive owner or mode is not private" >&2
    exit 1
}
actual_package_integrity="$(node --input-type=module - "$package_archive" <<'NODE'
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
process.stdout.write(`sha512-${createHash("sha512").update(readFileSync(process.argv[2])).digest("base64")}`);
NODE
)"
[[ "$actual_package_integrity" == "$expected_integrity" ]] || {
    echo "error: buzz-admin npm-pack integrity does not match the release descriptor" >&2
    exit 1
}

# Consult the running Gateway for every lifecycle decision. The helper accepts
# only one documented response envelope, a positive generation and either a
# fully quiescent or fully active record. Exact installs are resumable after a
# caller disconnects from an already committed managed lifecycle.
gateway_plugins_list() {
    openclaw gateway call plugins.list --params '{}' --json \
        --expect-url "$GATEWAY_URL" --timeout 30000
}

gateway_plugin_inspect() {
    openclaw gateway call plugins.inspect --params '{"pluginId":"buzz-admin"}' --json \
        --expect-url "$GATEWAY_URL" --timeout 30000
}

classify_gateway_state() {
    local phase="$1"
    local list_json list_after_json probe_json probe_state inspect_json payload
    list_json="$(gateway_plugins_list)"
    probe_json="$(jq -cn --argjson list "$list_json" '{phase:"probe", list:$list}' |
        node "$RECONCILE_HELPER")"
    probe_state="$(printf '%s' "$probe_json" | jq -er '.state')"
    inspect_json=null
    if [[ "$probe_state" != "absent" ]]; then
        inspect_json="$(gateway_plugin_inspect)"
    fi
    list_after_json="$(gateway_plugins_list)"
    payload="$(jq -cn \
        --arg phase "$phase" --argjson list "$list_json" \
        --argjson listAfter "$list_after_json" --argjson inspect "$inspect_json" \
        --arg package "$expected_package" --arg version "$expected_version" \
        --arg integrity "$expected_integrity" --argjson tools "$expected_tools_json" \
        '{phase:$phase, list:$list, listAfter:$listAfter, inspect:$inspect,
          expected:{package:$package,version:$version,integrity:$integrity,tools:$tools}}')"
    printf '%s' "$payload" | node "$RECONCILE_HELPER"
}

initial_reconciliation="$(classify_gateway_state initial)"
initial_action="$(printf '%s' "$initial_reconciliation" | jq -er '.action')"

needs_install=0
case "$initial_action" in
    install)
        needs_install=1
        ;;
    resume-disabled)
        echo "info: resuming the exact disabled buzz-admin managed install" >&2
        ;;
    resume-active)
        echo "info: reconciling postconditions for the exact active buzz-admin managed install" >&2
        ;;
    *)
        echo "error: unsupported initial buzz-admin reconciliation action" >&2
        exit 1
        ;;
esac

if (( needs_install == 1 )); then
    mkdir -p "$ROLLBACK_ROOT"
    if [[ -f "$STATE_ROOT/openclaw.json" ]]; then
        config_backup="$stage/openclaw.json.before-install"
        cp -p "$STATE_ROOT/openclaw.json" "$config_backup"
        chmod 0600 "$config_backup"
    fi
    if [[ -f "$STATE_ROOT/openclaw.json" ]] && \
        jq -e --arg path "$LEGACY_PATH" '(.plugins.load.paths // []) | index($path) != null' \
            "$STATE_ROOT/openclaw.json" >/dev/null; then
        remaining_paths="$(jq -c --arg path "$LEGACY_PATH" \
            '(.plugins.load.paths // []) | map(select(. != $path))' "$STATE_ROOT/openclaw.json")"
        if [[ "$remaining_paths" == "[]" ]]; then
            openclaw config unset plugins.load.paths >/dev/null
        else
            openclaw config set plugins.load.paths "$remaining_paths" --strict-json --replace >/dev/null
        fi
    fi
    if [[ -d "$LEGACY_PATH" ]]; then
        legacy_backup="$ROLLBACK_ROOT/buzz-admin.legacy.$(date -u +%Y%m%dT%H%M%SZ)-$$"
        mv "$LEGACY_PATH" "$legacy_backup"
        printf 'legacy_rollback_path=%s\n' "$legacy_backup"
    fi
fi

# OpenClaw stages dependencies and applies the managed package and runtime
# generation transactionally. OpenClaw 2026.9.6 resolves npm-pack:<path> to
# source=npm-pack and reads archivePath in the running Gateway context, which is
# why the shared owner and mode checks above are part of the install contract.
if (( needs_install == 1 )); then
    # Re-evaluate twice after every preparatory edit and immediately before the
    # lifecycle call. This closes the list/inspect gap and refuses a concurrent
    # generation or state change, including activation by another operator.
    preinstall_reconciliation="$(classify_gateway_state initial)"
    preinstall_confirm="$(classify_gateway_state initial)"
    preinstall_action="$(printf '%s' "$preinstall_reconciliation" | jq -er '.action')"
    preinstall_confirm_action="$(printf '%s' "$preinstall_confirm" | jq -er '.action')"
    preinstall_identity="$(printf '%s' "$preinstall_reconciliation" | jq -cer \
        '[.generation,.state,.match]')"
    preinstall_confirm_identity="$(printf '%s' "$preinstall_confirm" | jq -cer \
        '[.generation,.state,.match]')"
    [[ "$preinstall_action" == "install" &&
        "$preinstall_confirm_action" == "install" &&
        "$preinstall_identity" == "$preinstall_confirm_identity" ]] || {
        echo "error: buzz-admin Gateway generation or quiescent state changed before installation" >&2
        exit 1
    }
    lifecycle_started=1
    if ! openclaw plugins install --force --accept-capabilities \
        --acknowledge-install-policy-warning "npm-pack:$package_archive" >/dev/null; then
        echo "error: OpenClaw plugin install failed; rerun this installer to reconcile an exact committed package or inspect a mismatched lifecycle state" >&2
        exit 1
    fi
fi

# Make the enable decision from the running Gateway, never from the persisted
# cold inventory. A failed prior enable can persist desired=true while the live
# generation is still disabled; this path converges that split view.
post_lifecycle_reconciliation="$(classify_gateway_state post)"
post_lifecycle_action="$(printf '%s' "$post_lifecycle_reconciliation" | jq -er '.action')"
case "$post_lifecycle_action" in
    enable)
        lifecycle_started=1
        if ! openclaw plugins enable buzz-admin --accept-capabilities >/dev/null; then
            echo "error: managed buzz-admin package could not be enabled; rerun this installer to reconcile the exact committed package" >&2
            exit 1
        fi
        active_reconciliation="$(classify_gateway_state post)"
        [[ "$(printf '%s' "$active_reconciliation" | jq -er '.action')" == "verify" ]] || {
            echo "error: live Gateway did not activate the exact buzz-admin package" >&2
            exit 1
        }
        ;;
    verify)
        active_reconciliation="$post_lifecycle_reconciliation"
        ;;
    *)
        echo "error: unsupported post-lifecycle buzz-admin reconciliation action" >&2
        exit 1
        ;;
esac
active_generation="$(printf '%s' "$active_reconciliation" | jq -er '.generation')"

# The cold inventory proves the persisted desired state and dependency health.
# The runtime inspection then imports the exact installed package, verifies its
# registered tools, and checks the managed install record and accepted surface.
installed_plugins="$(openclaw plugins list --json)"
printf '%s' "$installed_plugins" | jq -e \
  --arg version "$expected_version" --argjson tools "$expected_tools_json" '
  if type != "object" or (.plugins | type) != "array" or
     (.diagnostics | type) != "array" then
    error("invalid plugins list schema")
  else .
  end |
  [.plugins[]? | select(.id == "buzz-admin")] as $matches |
  ($matches | length) == 1 and
  $matches[0].enabled == true and
  $matches[0].status == "loaded" and
  $matches[0].origin == "global" and
  ($matches[0].version | tostring) == $version and
  $matches[0].dependencyStatus.installed == true and
  $matches[0].dependencyStatus.requiredInstalled == true and
  (($matches[0].toolNames | type) == "array") and
  (($matches[0].toolNames | sort) == $tools) and
  ([.diagnostics[]? |
    select(.pluginId == "buzz-admin" and .level == "error")] | length) == 0
' >/dev/null || {
    echo "error: managed buzz-admin inventory is not enabled and healthy at the expected version and tool set" >&2
    exit 1
}

installed_inspect="$(openclaw plugins inspect buzz-admin --runtime --json)"
printf '%s' "$installed_inspect" | jq -e \
  --arg package "$expected_package" --arg version "$expected_version" \
  --argjson tools "$expected_tools_json" '
  if type != "object" or (.plugin | type) != "object" or
     (.install | type) != "object" or (.tools | type) != "array" or
     (.diagnostics | type) != "array" then
    error("invalid plugin inspect schema")
  else .
  end |
  .plugin.id == "buzz-admin" and
  .plugin.packageName == $package and
  (.plugin.version | tostring) == $version and
  .plugin.origin == "global" and
  .plugin.enabled == true and
  .plugin.status == "loaded" and
  .plugin.imported == true and
  .plugin.dependencyStatus.installed == true and
  .plugin.dependencyStatus.requiredInstalled == true and
  ((.plugin.toolNames | type) == "array") and
  ((.plugin.toolNames | sort) == $tools) and
  (([.tools[]? | .names[]?] | unique | sort) == $tools) and
  .install.source == "npm" and
  (.install.version | tostring) == $version and
  .install.artifactKind == "npm-pack" and
  .install.artifactFormat == "tgz" and
  .install.acceptedSurface == {
    channels: [],
    providers: [],
    tools: $tools,
    contracts: ($tools | map("tools: " + .)),
    hooks: [],
    mcpServers: [],
    cliCommands: [],
    cliBackends: [],
    skills: [],
    dangerousConfigFlags: []
  } and
  ([.diagnostics[]? | select(.level == "error")] | length) == 0
' >/dev/null || {
    echo "error: runtime inspection did not confirm the managed npm-pack provenance, active package, dependencies, and exact accepted tools" >&2
    exit 1
}

installed_gateway_inspect="$(openclaw gateway call plugins.inspect \
    --params '{"pluginId":"buzz-admin"}' --json \
    --expect-url "$GATEWAY_URL" --timeout 30000)"
printf '%s' "$installed_gateway_inspect" | jq -e \
  --arg package "$expected_package" --arg version "$expected_version" \
  --arg integrity "$expected_integrity" --argjson tools "$expected_tools_json" '
  if type != "object" or (.plugin | type) != "object" or
     (.source | type) != "object" or (.declared | type) != "object" then
    error("invalid authoritative plugin inspect schema")
  else .
  end |
  .ok == true and
  .plugin.id == "buzz-admin" and .plugin.installed == true and
  .plugin.enabled == true and (.plugin.version | tostring) == $version and
  .source.kind == "npm" and .source.packageName == $package and
  .source.spec == ($package + "@" + $version) and
  .source.integrity == $integrity and .source.integrityKind == "ssri" and
  ((.declared.tools | type) == "array") and
  ((.declared.tools | sort) == $tools) and
  .declared.dangerousConfigFlags == []
' >/dev/null || {
    echo "error: live Gateway did not confirm the exact managed buzz-admin source and integrity" >&2
    exit 1
}

final_reconciliation="$(classify_gateway_state post)"
[[ "$(printf '%s' "$final_reconciliation" | jq -er '.action')" == "verify" &&
    "$(printf '%s' "$final_reconciliation" | jq -er '.generation')" == "$active_generation" ]] || {
    echo "error: buzz-admin Gateway generation or active state changed during verification" >&2
    exit 1
}
success=1

printf 'plugin_id=buzz-admin\nplugin_version=%s\ninstall_route=npm-pack\nrestart_required=true\n' \
    "$expected_version"
