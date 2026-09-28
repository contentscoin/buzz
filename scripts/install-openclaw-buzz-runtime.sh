#!/usr/bin/env bash
# Install the immutable Sprig bundle used by the FMG OpenClaw Buzz tools.
# Run this inside the OpenClaw container. The /data volume persists the result.
set -euo pipefail

export LC_ALL=C

install_mode=current
if [[ "${1:-}" == "--rollback" ]]; then
    install_mode=rollback
    shift
elif [[ "${1:-}" == --* ]]; then
    echo "error: usage: $0 [--rollback] [release-descriptor]" >&2
    exit 2
fi
[[ "$#" -le 1 ]] || {
    echo "error: usage: $0 [--rollback] [release-descriptor]" >&2
    exit 2
}

MANIFEST="${1:-/tmp/fmg-live.json}"
RUNTIME_ROOT="${FMG_OPENCLAW_RUNTIME_ROOT:-/data/.openclaw/runtimes/sprig}"
BIN_ROOT="${FMG_OPENCLAW_BIN_ROOT:-/data/.openclaw/bin}"
GATEWAY_EXPECT_URL="${FMG_OPENCLAW_GATEWAY_URL:-ws://127.0.0.1:18789}"

for command in chmod cmp cp curl cut flock jq ln mkdir mktemp mv openclaw readlink realpath rm sha256sum tar; do
    command -v "$command" >/dev/null || {
        echo "error: required command is unavailable: $command" >&2
        exit 2
    }
done
[[ -f "$MANIFEST" ]] || { echo "error: descriptor not found: $MANIFEST" >&2; exit 2; }
MANIFEST="$(realpath -e -- "$MANIFEST")"
[[ "$RUNTIME_ROOT" == /* && "$BIN_ROOT" == /* ]] || {
    echo "error: runtime and bin roots must be absolute paths" >&2
    exit 2
}
[[ "$GATEWAY_EXPECT_URL" =~ ^ws://127\.0\.0\.1:([1-9][0-9]{0,4})$ ]] || {
    echo "error: FMG_OPENCLAW_GATEWAY_URL must be an exact ws://127.0.0.1:<port> URL" >&2
    exit 2
}
gateway_port="${BASH_REMATCH[1]}"
(( 10#$gateway_port <= 65535 )) || {
    echo "error: FMG_OPENCLAW_GATEWAY_URL port is out of range" >&2
    exit 2
}

runtime_selector='.agent_runtime'
if [[ "$install_mode" == rollback ]]; then
    runtime_selector='.rollback.agent_runtime'
fi
release="$(jq -er "${runtime_selector}.release" "$MANIFEST")"
asset="$(jq -er "${runtime_selector}.asset" "$MANIFEST")"
expected_sha="$(jq -er "${runtime_selector}.sha256" "$MANIFEST")"
expected_executable_sha="$(jq -er "${runtime_selector}.executable_sha256" "$MANIFEST")"
expected_version="$(jq -er "${runtime_selector}.version" "$MANIFEST")"
expected_git_sha="$(jq -er "${runtime_selector}.source_commit" "$MANIFEST")"

# Validate every descriptor value used in a URL or filesystem path here. The
# repository validator is a release-time check; this installer is a separate
# trust boundary and may be run with a copied or modified descriptor.
if [[ "$install_mode" == current ]]; then
    [[ "$expected_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+-fmg\.[0-9]+$ ]] || {
        echo "error: invalid FMG Sprig version" >&2
        exit 2
    }
    [[ "$release" == "sprig-v${expected_version}" ]] || {
        echo "error: Sprig release does not match the FMG version" >&2
        exit 2
    }
    [[ "$asset" == "sprig-${expected_version}-x86_64-unknown-linux-musl.tar.gz" ]] || {
        echo "error: Sprig asset is not the exact versioned Linux musl archive" >&2
        exit 2
    }
else
    [[ "$expected_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+\+git\.([0-9a-f]{7,40})$ ]] || {
        echo "error: invalid git-qualified rollback Sprig version" >&2
        exit 2
    }
    rollback_prefix="${BASH_REMATCH[1]}"
    [[ "$release" == "sprig-rollback-${rollback_prefix}" ]] || {
        echo "error: rollback Sprig release does not match its version commit prefix" >&2
        exit 2
    }
    [[ "$asset" == "sprig-x86_64-unknown-linux-musl.tar.gz" ]] || {
        echo "error: rollback Sprig asset is not the exact Linux musl archive" >&2
        exit 2
    }
fi
[[ "$expected_sha" =~ ^[0-9a-f]{64}$ && ! "$expected_sha" =~ ^0+$ ]] || {
    echo "error: invalid archive SHA-256" >&2
    exit 2
}
[[ "$expected_executable_sha" =~ ^[0-9a-f]{64}$ && ! "$expected_executable_sha" =~ ^0+$ ]] || {
    echo "error: invalid Sprig executable SHA-256" >&2
    exit 2
}
[[ "$expected_git_sha" =~ ^[0-9a-f]{40}$ && ! "$expected_git_sha" =~ ^0+$ ]] || {
    echo "error: invalid source commit" >&2
    exit 2
}
if [[ "$install_mode" == rollback && "$expected_git_sha" != "$rollback_prefix"* ]]; then
    echo "error: rollback Sprig source commit does not match its version prefix" >&2
    exit 2
fi

mkdir -p "$RUNTIME_ROOT" "$BIN_ROOT"
RUNTIME_ROOT="$(realpath -e -- "$RUNTIME_ROOT")"
BIN_ROOT="$(realpath -e -- "$BIN_ROOT")"
[[ "$RUNTIME_ROOT" != / && "$BIN_ROOT" != / ]] || {
    echo "error: runtime and bin roots must not resolve to the filesystem root" >&2
    exit 2
}

candidate_install_path="$RUNTIME_ROOT/$expected_version"
resolved_install_path="$(realpath -m -- "$candidate_install_path")"
[[ "$resolved_install_path" != "$RUNTIME_ROOT" &&
    "${resolved_install_path%/*}" == "$RUNTIME_ROOT" &&
    "$resolved_install_path" == "$candidate_install_path" ]] || {
    echo "error: Sprig install path escapes the runtime root" >&2
    exit 2
}
expected_install_path="$candidate_install_path"
expected_cli_path="$BIN_ROOT/buzz"
if [[ "$install_mode" == current ]]; then
    descriptor_install_path="$(jq -er '.agent_runtime.install_path' "$MANIFEST")"
    descriptor_cli_path="$(jq -er '.agent_runtime.buzz_cli_path' "$MANIFEST")"
    [[ "$descriptor_install_path" == "$expected_install_path" ]] || {
        echo "error: descriptor install path does not match runtime root" >&2
        exit 2
    }
    [[ "$descriptor_cli_path" == "$expected_cli_path" ]] || {
        echo "error: descriptor CLI path does not match bin root" >&2
        exit 2
    }
fi

download_url="https://github.com/contentscoin/buzz/releases/download/${release}/${asset}"
lock_path="$RUNTIME_ROOT/.install.lock"
if [[ ! -e "$lock_path" && ! -L "$lock_path" ]]; then
    # noclobber uses exclusive creation, so a pre-existing symlink is never
    # followed while establishing the persistent lock inode.
    (umask 077; set -o noclobber; : > "$lock_path") 2>/dev/null || true
fi
[[ -f "$lock_path" && ! -L "$lock_path" ]] || {
    echo "error: Sprig installer lock is not a regular file" >&2
    exit 1
}
exec 9<"$lock_path"
[[ "$(realpath -e -- "/proc/$$/fd/9")" == "$lock_path" ]] || {
    echo "error: Sprig installer lock changed while it was opened" >&2
    exit 1
}
flock -n 9 || {
    echo "error: another Sprig runtime installation is in progress" >&2
    exit 1
}
tmp="$(mktemp -d "$RUNTIME_ROOT/.install-${expected_version}.XXXXXX")"
cli_work="$(mktemp -d "$BIN_ROOT/.buzz-activate.XXXXXX")"
tmp="$(realpath -e -- "$tmp")"
cli_work="$(realpath -e -- "$cli_work")"
[[ "${tmp%/*}" == "$RUNTIME_ROOT" &&
    "${tmp##*/}" == ".install-${expected_version}."* ]] || {
    echo "error: installer temporary directory escaped the runtime root" >&2
    exit 1
}
[[ "${cli_work%/*}" == "$BIN_ROOT" && "${cli_work##*/}" == .buzz-activate.* ]] || {
    echo "error: CLI activation directory escaped the bin root" >&2
    exit 1
}
chmod 0700 "$tmp"
chmod 0700 "$cli_work"
payload="$tmp/payload"
archive="$tmp/$asset"
install_had_previous=0
install_rollback_armed=0
cli_had_previous=0
cli_rollback_armed=0
cli_restore="$cli_work/previous-buzz"
cli_directory_obstruction=0

path_exists() {
    [[ -e "$1" || -L "$1" ]]
}

remove_path() {
    local path="$1"
    case "$path" in
        "$expected_install_path"|"$expected_cli_path"|"$tmp"|"$cli_work") ;;
        *)
            echo "error: refusing to remove an unowned installer path: $path" >&2
            return 1
            ;;
    esac
    if path_exists "$path"; then
        rm -rf -- "$path"
    fi
}

cleanup() {
    local status=$?
    local rollback_failed=0
    local cli_rollback_succeeded=1
    trap - EXIT
    set +e

    if (( status != 0 )); then
        # Restore the public entry before removing bytes it may still reference.
        # If that rollback fails, retain the newly published immutable runtime
        # so the public CLI cannot be left pointing at a path we deleted.
        if (( cli_rollback_armed == 1 )); then
            if (( cli_had_previous == 1 )); then
                if path_exists "$cli_restore"; then
                    if (( cli_directory_obstruction == 1 )); then
                        remove_path "$expected_cli_path"
                    fi
                    if ! mv -Tf -- "$cli_restore" "$expected_cli_path"; then
                        echo "error: failed to restore the previous Buzz CLI entry" >&2
                        rollback_failed=1
                        cli_rollback_succeeded=0
                    fi
                elif ! path_exists "$expected_cli_path"; then
                    echo "error: previous Buzz CLI entry is unavailable for rollback" >&2
                    rollback_failed=1
                    cli_rollback_succeeded=0
                fi
            elif ! remove_path "$expected_cli_path"; then
                echo "error: failed to remove the incomplete Buzz CLI activation" >&2
                rollback_failed=1
                cli_rollback_succeeded=0
            fi
        fi

        # Remove only a new version path created by this attempt. Existing
        # version directories are immutable and are never moved or rewritten.
        if (( cli_rollback_succeeded == 1 && install_rollback_armed == 1 )); then
            if (( install_had_previous == 0 )) && ! path_exists "$payload"; then
                if ! remove_path "$expected_install_path"; then
                    echo "error: failed to remove the incomplete Sprig activation" >&2
                    rollback_failed=1
                fi
            fi
        fi
    fi

    if (( rollback_failed == 0 )); then
        remove_path "$tmp"
        remove_path "$cli_work"
    else
        echo "error: rollback state was preserved under $tmp and $cli_work" >&2
    fi
    exit "$status"
}
trap cleanup EXIT

atomic_cli_link() {
    local target="$1"
    local next_link="$cli_work/next-buzz"
    rm -f -- "$next_link"
    ln -s -- "$target" "$next_link"
    # next_link and the public link are on the same filesystem. mv -T replaces
    # a file or symlink with one rename, so callers never observe a missing CLI.
    mv -Tf -- "$next_link" "$expected_cli_path"
}

runtime_matches_expected() {
    local runtime="$1"
    local link actual_sha

    [[ -d "$runtime" && ! -L "$runtime" ]] || return 1
    [[ -f "$runtime/sprig" && ! -L "$runtime/sprig" && -x "$runtime/sprig" ]] || return 1
    [[ -f "$runtime/sprig.json" && ! -L "$runtime/sprig.json" ]] || return 1
    cmp -s "$runtime/sprig.json" "$payload/sprig.json" || return 1
    actual_sha="$(sha256sum "$runtime/sprig" | cut -d' ' -f1)"
    [[ "$actual_sha" == "$expected_executable_sha" ]] || return 1
    for link in buzz-acp buzz-agent buzz-dev-mcp; do
        [[ -L "$runtime/$link" ]] || return 1
        [[ "$(readlink "$runtime/$link")" == sprig ]] || return 1
    done
}

require_buzz_admin_quiesced() {
    local response payload

    if ! response="$(openclaw gateway call plugins.list --params '{}' --json \
        --expect-url "$GATEWAY_EXPECT_URL")"; then
        echo "error: authoritative OpenClaw Gateway plugin inventory is unavailable" >&2
        exit 1
    fi
    if ! payload="$(printf '%s' "$response" | jq -ce '
        def inventory:
            type == "object" and
            ((.generation | type) == "number" or
             ((.generation | type) == "string" and (.generation | length) > 0)) and
            (.plugins | type == "array") and
            (.diagnostics | type == "array") and
            (.mutationAllowed | type == "boolean");
        def direct: inventory;
        def wrapped: type == "object" and (.result | inventory);
        if (direct and wrapped) then error("ambiguous plugins.list response")
        elif direct then .
        elif wrapped then .result
        else error("invalid plugins.list response")
        end
    ')"; then
        echo "error: invalid authoritative OpenClaw Gateway plugin inventory" >&2
        exit 1
    fi
    if ! printf '%s' "$payload" | jq -e '
        [.plugins[] | select(.id == "buzz-admin")] as $matches |
        ($matches | length) == 0 or
        (($matches | length) == 1 and
         $matches[0].enabled == false and
         ($matches[0].runtime.state == "disabled" or
          $matches[0].runtime.state == "unloaded"))
    ' >/dev/null; then
        echo "error: buzz-admin must be disabled and runtime-quiesced by the running Gateway" >&2
        exit 1
    fi
}

curl --fail --location --silent --show-error "$download_url" --output "$archive"
printf '%s  %s\n' "$expected_sha" "$archive" | sha256sum -c - >/dev/null

# Audit the complete member list before reading any payload bytes. Only the
# seven entries emitted by scripts/build-sprig.sh are accepted. Explicit path
# checks reject traversal and control-character tricks before extraction.
member_list="$tmp/archive.members"
detail_list="$tmp/archive.details"
tar -tzf "$archive" > "$member_list"
tar -tvzf "$archive" > "$detail_list"
mapfile -t members < "$member_list"
mapfile -t details < "$detail_list"
[[ "${#members[@]}" -eq 7 && "${#details[@]}" -eq 7 ]] || {
    echo "error: Sprig archive has an unexpected member count" >&2
    exit 1
}
declare -A seen_members=()
for index in "${!members[@]}"; do
    member="${members[$index]}"
    if [[ -z "$member" || "$member" == /* || "$member" == ".." ||
        "$member" == ../* || "$member" == */../* || "$member" == */.. ||
        "$member" == *\\* || "$member" =~ [[:cntrl:]] ]]; then
        echo "error: unsafe Sprig archive member: $member" >&2
        exit 1
    fi
    [[ -z "${seen_members[$member]+present}" ]] || {
        echo "error: duplicate Sprig archive member: $member" >&2
        exit 1
    }
    seen_members["$member"]=1

    case "$member" in
        ./) expected_type=d ;;
        ./README.md|./sprig|./sprig.json) expected_type=- ;;
        ./buzz-acp|./buzz-agent|./buzz-dev-mcp) expected_type=l ;;
        *)
            echo "error: unexpected Sprig archive member: $member" >&2
            exit 1
            ;;
    esac
    [[ "${details[$index]:0:1}" == "$expected_type" ]] || {
        echo "error: unexpected type for Sprig archive member: $member" >&2
        exit 1
    }
done

mkdir "$payload"
chmod 0755 "$payload"
# Stream only the reviewed regular members into paths chosen by this script.
# Archive-owned paths, permissions, symlinks, devices and owners are never
# materialized, which keeps a crafted tar header from escaping the stage.
tar -xOzf "$archive" -- ./sprig > "$payload/sprig"
tar -xOzf "$archive" -- ./sprig.json > "$payload/sprig.json"
tar -xOzf "$archive" -- ./README.md > "$payload/README.md"
chmod 0755 "$payload/sprig"
chmod 0644 "$payload/sprig.json" "$payload/README.md"
for link in buzz-acp buzz-agent buzz-dev-mcp; do
    ln -s sprig "$payload/$link"
done

jq -e --arg version "$expected_version" --arg sha "$expected_git_sha" \
    --arg executable_sha "$expected_executable_sha" \
    '.name == "sprig" and
     .version == $version and
     .git_sha == $sha and
     .target == "x86_64-unknown-linux-musl" and
     any(.binaries[]; .name == "sprig" and .sha256 == $executable_sha)' \
    "$payload/sprig.json" >/dev/null
actual_executable_sha="$(sha256sum "$payload/sprig" | cut -d' ' -f1)"
[[ "$actual_executable_sha" == "$expected_executable_sha" ]] || {
    echo "error: Sprig executable SHA-256 does not match the release descriptor" >&2
    exit 1
}
# Exercise the `buzz` multicall personality without adding a synthetic entry to
# the immutable archive layout. Linux preserves the invoked symlink as argv[0].
ln -s "$payload/sprig" "$cli_work/buzz"
"$cli_work/buzz" --help >/dev/null
rm -f -- "$cli_work/buzz"

if path_exists "$expected_cli_path"; then
    cli_had_previous=1
    if [[ -d "$expected_cli_path" && ! -L "$expected_cli_path" ]]; then
        cli_directory_obstruction=1
    else
        cp -a --no-dereference "$expected_cli_path" "$cli_restore"
    fi
fi

if path_exists "$expected_install_path"; then
    install_had_previous=1
    if ! runtime_matches_expected "$expected_install_path"; then
        echo "error: immutable Sprig version path differs from the verified release; publish a new version to repair it" >&2
        exit 1
    fi
fi

# Perform this authoritative RPC preflight immediately before the first
# runtime-visible change. Local plugin inspection loads a separate registry and
# is not evidence about the running Gateway's admissions or runtime state.
require_buzz_admin_quiesced

# A version directory is written once. Exact reruns leave it untouched; a
# mismatch above fails closed instead of replacing bytes under an immutable
# name. Arm removal before publishing a new directory.
if (( install_had_previous == 0 )); then
    install_rollback_armed=1
    mv -T -- "$payload" "$expected_install_path"
fi

cli_rollback_armed=1
if (( cli_directory_obstruction == 1 )); then
    # A directory cannot be atomically replaced by mv -T. It is not a usable
    # CLI entry, so preserve it after arming rollback, then install the link.
    mv -T -- "$expected_cli_path" "$cli_restore"
fi
atomic_cli_link "$expected_install_path/sprig"
"$expected_cli_path" --help >/dev/null
[[ "$(sha256sum "$expected_cli_path" | cut -d' ' -f1)" == "$expected_executable_sha" ]] || {
    echo "error: installed Buzz CLI SHA-256 does not match the release descriptor" >&2
    exit 1
}

install_rollback_armed=0 cli_rollback_armed=0

printf 'installed_version=%s\nsource_commit=%s\narchive_sha256=%s\nexecutable_sha256=%s\ncli_path=%s\n' \
    "$expected_version" "$expected_git_sha" "$expected_sha" \
    "$expected_executable_sha" "$expected_cli_path"
