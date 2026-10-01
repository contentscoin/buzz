# FMG Buzz live release

This runbook publishes FMG Buzz without changing the upstream release ledger.
The release descriptor is [`.release/fmg-live.json`](../.release/fmg-live.json).
The initial live desktop version was `0.5.26-fmg.1`; the current integrated
release is `0.5.26-fmg.6`.

## Release identity

| Item | Value |
| --- | --- |
| Upstream base | `desktop-v0.5.25` / `c8f73213089cbd5a0f1e675d3193558280d46e10` |
| Desktop version | `0.5.26-fmg.6` |
| Desktop tag | `fmg-desktop-v0.5.26-fmg.6` |
| Windows app identity | `Buzz` / `xyz.block.buzz.app` |
| Managed Git | Git for Windows MinGit `2.55.0.5`, pinned by SHA-256 in `scripts/windows-managed-git.json` |
| Relay image | `ghcr.io/contentscoin/buzz@sha256:eb2113d717d3c0d352f5d14793e0a3638a20597734d3756db040cbdf90430f39` |
| Relay source | `598d6aad833c755dbdedcddfeca8efaed0defb49` |
| Agent runtime | `sprig-v0.5.26-fmg.1`, archive size `6,567,959` bytes, archive SHA-256 `0d4c4fd86621734c6f3b640deab3eb6cd00e647eeb7639441ea37f3a40c4bfb0`, executable SHA-256 `c0dc492a5fd9eb1543472cfd57daa6a25da68707e3efcbfeef0cf342a821c773` |
| OpenClaw | `2026.9.6`, official Buzz channel plus `buzz-admin` `0.2.2` |
| Official Buzz runtime | `@openclaw/buzz@2026.9.6`, managed package tree SHA-256 `1e3ce21a8e32d54bda8d9ec3b6791477c28ba8136ef74fbe03c1d3cd5ad9aab7`, entry SHA-256 `67559e787eb7aaa459d69519b2c9b4c24ea0779557fc067047fef028ed7bbdb0` |
| Public relay | `wss://buzz-dnb0.srv2006121.hstgr.cloud` |

`0.5.26-fmg.6` is greater than the installed `0.5.26-fmg.5`, so the NSIS
installer follows the normal in-place upgrade path. Keeping the application
identifier preserves the existing desktop community and identity storage.

### Release scope

`0.5.26-fmg.6` delivers graph transition controls and local Aside settings listed in `FMG_CHANGELOG.md` and
records the completed, attested OpenClaw Buzz deployment. The official Buzz
channel, `buzz-admin` `0.2.2` and the dedicated no-delivery live-gate agent are
already deployed. Publishing the desktop candidate must not reinstall them.
The relay image and Sprig runtime remain pinned to their existing immutable
identities; change either only when a future descriptor assigns a new digest or
uniquely named runtime release.

## Implemented rollout controls

The release does not declare environment flags that the application ignores.

| Feature | Live state | Actual control |
| --- | --- | --- |
| Work reports | Enabled | Compiled desktop, relay, CLI and SDK support |
| Task graph | Operator preview | Desktop opens a transition dialog; the issue must carry the `graph` label and pass the packaged CLI preflight and reviewed-head check |
| Aside browser | Off | Settings → Agents → Aside browser saves an executable, explicit disable or inherited `BUZZ_ACP_ASIDE_COMMAND`; applies on the next local agent start |
| Mobile report summary | ACP agent policy | After a confirmed report, the agent is instructed to attempt one concise ordinary reply in the same thread |

## Build and publish the Windows app

1. Merge the reviewed FMG integration commits and this release configuration
   into `contentscoin/buzz` `main`.
2. Open **Actions → FMG Desktop Release → Run workflow** on `main`.
3. Run once with `publish=false`. Download the workflow artifact and install it
   over the existing Buzz installation. Record the candidate run ID and the
   installer SHA-256 printed in the workflow summary.
4. Confirm the installed version is `0.5.26-fmg.6`, the **FMG 센터** entry is
   visible, the existing communities remain available, and the Hostinger
   community reconnects. In **Settings → Agents**, confirm Codex offers
   `GPT-6 Sol` and `GPT-6 Luna`, Claude offers `Claude Opus 5.5`, and both
   runtimes report Ready after **Check again**. Open a Hostinger-backed project
   repository and confirm its files load through the bundled Git runtime.
   Confirm the installation contains
   `resources/fmg-managed-git/cmd/git.exe`,
   `resources/fmg-managed-git/LICENSE.txt`, and
   `resources/fmg-managed-git/etc/package-versions.txt`; running the installed
   `git.exe --version` must report `2.55.0.windows.5`. In **Tasks**, switch
   between **List** and **Board** and open a card. In **FMG
   센터**, confirm a `graph` task shows its dependency state and opens the transition dialog in the
   preview. Verify an authorized transition in a disposable test task, then confirm a stale reviewed head is rejected. In **Settings → Agents**, verify Aside save and explicit disable; restart a disposable local agent to apply it.
5. Re-run the workflow on the same `main` commit with `publish=true`, supplying
   the recorded `candidate_run_id` and `candidate_sha256`. The publish job does
   not rebuild. It downloads that immutable Actions artifact, verifies its
   receipt, source commit and hash, then creates
   `fmg-desktop-v0.5.26-fmg.6`.
6. If the tag or release already exists, the workflow resolves the tag to its
   commit and byte-compares the existing assets. It succeeds only when they are
   identical; it never replaces an existing release asset.

The workflow creates a non-updating, unsigned x64 NSIS installer. It does not
promote the build into the upstream `buzz-desktop-latest` updater channel.

## Build and deploy the relay (not part of 0.5.26-fmg.6)

Skip this section for `0.5.26-fmg.6`. Use it only for a release that explicitly
changes the relay image recorded in the release descriptor.

1. Let the existing **Docker image** workflow complete for the same `main`
   commit. The fork-owned image path is selected with repository variable
   `GHCR_IMAGE=ghcr.io/contentscoin/buzz`.
2. Record the exact `ghcr.io/contentscoin/buzz@sha256:...` digest from that run.
3. In Hostinger, replace only the Buzz image reference with that digest. Keep
   the existing database, Redis, object storage, relay identity and secrets.
4. Keep the values in [`deploy/fmg/hostinger.env.example`](../deploy/fmg/hostinger.env.example).
   The file intentionally contains no credentials.
5. Redeploy the project and record the running image digest with the desktop
   receipt. Do not use a mutable `main` or `latest` tag as the deployment record.

## OpenClaw Buzz deployment and future ACP runtime rollout

The live integration uses OpenClaw's official `@openclaw/buzz` channel. There
is no separate `buzz-openclaw-agent` Compose service. The immutable Sprig
archive supplies the `buzz` CLI inside the persistent OpenClaw `/data` volume,
and the repository-owned `buzz-admin` plugin exposes the narrow operational
tools needed by an OpenClaw agent. Replacing only the relay image does not
update this Gateway runtime.

For `0.5.26-fmg.6`, the `buzz-admin` `0.2.2` deployment described below is
complete and the full live gate has passed. Do not repeat it during desktop
promotion. `sprig-v0.5.26-fmg.1` is an existing immutable release and must not
be recreated, moved, or replaced. A future agent runtime rollout must first
record a new unique Sprig tag, asset, source commit and SHA-256 in the release
descriptor.

1. Read the new Sprig tag and source commit from the release descriptor. Create
   that previously unused tag at the recorded commit, then verify the tag
   resolves to the same commit. Never derive the runtime commit from a
   desktop-only candidate receipt.
2. Let the **Sprig** tag workflow publish the uniquely named asset recorded in
   the descriptor and its SHA-256 file.
   Download the immutable Actions artifact from that workflow, independently
   calculate the archive SHA-256, and record it as `BUZZ_SPRIG_SHA256`. Record
   the GitHub release asset byte size as `BUZZ_SPRIG_ARCHIVE_SIZE_BYTES`; it
   must equal the descriptor's `agent_runtime.archive_size_bytes`. Record the
   descriptor's runtime source commit as `BUZZ_SPRIG_GIT_SHA` and its runtime
   version as `BUZZ_SPRIG_VERSION` in Hostinger.
3. Wait for current Buzz tool calls to finish. If `buzz-admin` is present, run
   `openclaw plugins disable buzz-admin`; an absent plugin is already quiesced.
   Then confirm this authoritative Gateway query succeeds:

   ```bash
   openclaw gateway call plugins.list --params '{}' --json \
     --expect-url ws://127.0.0.1:18789
   ```

   Its result must contain either no `buzz-admin` entry or exactly one with
   `enabled: false` and `runtime.state` equal to `disabled` or `unloaded`. Set
   `FMG_OPENCLAW_GATEWAY_URL` to the exact `ws://127.0.0.1:<port>` loopback URL
   when the Gateway uses a non-default port. Keep the running Gateway and the
   plugin quiesced during the runtime installation; the disable lifecycle waits
   for admitted plugin work to drain. Copy the reviewed release descriptor into
   the OpenClaw container and run `scripts/install-openclaw-buzz-runtime.sh`
   there. The installer obtains the same authoritative Gateway inventory and
   fails if that RPC is unavailable or reports an active plugin. It downloads
   the versioned archive with a 15-second connection timeout, a 120-second
   total timeout, HTTPS-only redirects and an expected-size hard limit. It
   requires the downloaded byte count to equal the descriptor before checking
   SHA-256 or reading the tar archive. It then rejects unexpected or unsafe tar
   members before extracting selected regular files, checks `sprig.json`, and
   verifies the `sprig` executable SHA-256. A new
   version directory is published once, then `/data/.openclaw/bin/buzz` is
   activated with a temporary symlink and atomic rename. An exact rerun keeps
   the immutable directory and repairs the public link. A same-version
   executable or metadata mismatch fails closed; publish a new unique runtime
   version for a repair. Keep the OpenClaw identity volume, channel SecretRef
   and all provider credentials unchanged. If this Sprig runtime step fails,
   leave `buzz-admin` disabled until the runtime checks succeed.
4. The installer fails before extraction unless this check succeeds:

   ```bash
   test "$(wc -c < "$archive" | tr -d '[:space:]')" = "$BUZZ_SPRIG_ARCHIVE_SIZE_BYTES"
   printf '%s  %s\n' "$BUZZ_SPRIG_SHA256" "$archive" | sha256sum -c -
   ```

   After extraction, it fails unless `sprig.json` contains the exact
   `BUZZ_SPRIG_VERSION` and `BUZZ_SPRIG_GIT_SHA` and the executable bytes match
   `agent_runtime.executable_sha256`.
   Reading the `.sha256` file again from the same release is not a substitute
   for the separately recorded Hostinger value.
5. Copy `deploy/openclaw/buzz-admin`,
    `scripts/install-openclaw-buzz-admin-plugin.sh` and
    `scripts/openclaw-buzz-admin-reconcile.mjs` from the same reviewed
    repository commit into the container, keeping both scripts in one
    directory. Then run `scripts/install-openclaw-buzz-admin-plugin.sh`.
    The installer verifies the descriptor-pinned source tree before executing
    package scripts, uses the committed lockfile, runs tests and OpenClaw
    validation, verifies the compiled entrypoint hash and npm-pack SHA-512
    integrity, and installs the package
    through OpenClaw's managed `npm-pack:` route with explicit capability
    acceptance. The private pack directory is created under `/data/.openclaw`
    and owned by that state tree's numeric UID:GID so the running Gateway can
    read it even when the installer is executed as root. It removes only the
    exact legacy `plugin-src/buzz-admin` load
    path and preserves that directory under `plugin-rollbacks` when present.
    If a managed lifecycle command reports an error, rerun the same installer.
    It reconciles an exact descriptor-pinned package, version and integrity in
    either disabled/unloaded or enabled/active state without forcing another
    install. It refuses to resume mismatched active code and never restores only
    a stale config snapshot over a possibly committed managed install.
    Restart only the OpenClaw Gateway after both managed package installs are
    complete. The live gate requires the Gateway process start time to be at or
    after the newest official Buzz package mtime, so an in-place install without
    a subsequent Gateway restart fails closed. Then confirm the official Buzz
    channel reconnects to the existing room. The plugin passes
    the resolved channel credential only to the short-lived `buzz` child
    process; it does not print or persist the value as an environment setting.
6. Agents with a restrictive tool profile need the three exact Buzz tool names
   in `agents.entries.<id>.tools.alsoAllow`. Add them with `openclaw config set`
   for each FMG agent that publishes reports, then restart the Gateway. Avoid a
   broad `group:plugins` grant when only these tools are required.
7. Create a dedicated `fmg-live-gate` agent, pin its model to
   `openai/gpt-6-sol`, set that model's `agentRuntime.id` to `openclaw` and
   `codeMode` to `false`, and set its absolute
   `agents.entries.fmg-live-gate.tools.allow` list to exactly
   `["buzz_runtime_check"]`. Do not add `alsoAllow` at that scope. The live gate
    refuses to run through a general-purpose agent. The plugin marks only the
    read-only `buzz_runtime_check` tool as `catalogMode: "direct-only"`, keeping
    the single intended call model-visible without changing global Tool Search
    behavior for operational agents.

## Live checks

After deployment, confirm all of the following before treating the release as
live:

- `node scripts/validate-fmg-live-release.mjs` succeeds.
- `scripts/fmg-hostinger-live-gate.sh` succeeds with the exact SSH target and
  container names supplied through its `FMG_*` environment variables. It must
  report the descriptor's relay digest, OpenClaw version, Buzz channel state,
  plugin tool set and Sprig version without printing credentials. Remote checks
  are mandatory unless the operator explicitly sets `FMG_PUBLIC_ONLY=1` for an
  endpoint-only probe.
- `GET /` and `GET /health` return success.
- WebSocket upgrades succeed on the relay root and `/pair`.
- CORS echoes each configured origin: the public HTTPS origin,
  `tauri://localhost`, and `http://tauri.localhost`.
- OpenClaw reports the expected community and channel, and the dedicated
  `fmg-live-gate` agent has an absolute one-tool allowlist. Its no-delivery
  turn is sent through the exact loopback Gateway transport, invokes
  `buzz_runtime_check`, and
  returns `credentialReady: true` and `workReportReady: true`.
- Desktop can post and receive a normal message.
- A signed work report appears as a result card on desktop.
- For a confirmed agent-authored work report, the ACP agent attempts one
  ordinary reply in the same thread containing the status, core outcome and
  primary deliverable link. This is prompt-enforced best effort; a dedicated
  mobile work-report card and programmatic delivery guarantee are later client
  enhancements.

### Official Buzz active-code evidence

OpenClaw `2026.9.6` does not expose the active plugin registry's source path or
source digest through a read-only Gateway RPC. The gate therefore uses the
descriptor's `gateway-pid-started-after-package-and-stable-generation` policy:

- authoritative `plugins.list` must report one active official Buzz record and
  the same nonzero registry generation before and after the live turn;
- authoritative `plugins.inspect` must report the exact npm package, version and
  SHA-512 install integrity;
- a fresh local loader scan must resolve the exact descriptor-pinned managed
  install path and `dist/index.js` source. Its persisted npm install record must
  contain that same path, package, version and integrity, with `resolvedAt` no
  later than `installedAt` and `installedAt` no later than Gateway process
  start. The record is checked again after the live turn;
- the package manifest, runtime entry and deterministic package tree hashes must
  match the descriptor. The tree hash covers all 1,493 regular package files,
  including the implementation chunks and bundled dependencies. It excludes
  only the installer-created `node_modules/openclaw` peer link, whose exact
  absolute target is checked separately against the pinned OpenClaw image; and
- the newest package filesystem mtime must be no later than the unchanged Gateway
  process start time, and the package tree is hashed again after the live turn.

Together these checks show that the pinned package bytes were present before
the current Gateway process loaded its unchanged active generation, and that a
fresh loader resolves the same entry. This is the strongest fail-closed bridge
available without the registry's internal `sourceDigest` being projected by a
read-only RPC. It is operational provenance rather than in-process memory
attestation: it assumes the container host and filesystem timestamps are
trusted. A future OpenClaw endpoint that returns the active root, entry and
`sourceDigest` should replace this bridge.

## Rollback

1. Change Hostinger back to the previously recorded image digest and redeploy.
2. Execute the descriptor's `disable-and-uninstall` policy for `buzz-admin`:
   run `openclaw plugins disable buzz-admin`, wait until authoritative
   `plugins.list` reports it unloaded, then run
   `openclaw plugins uninstall buzz-admin --force`. Restart the Gateway and
   verify through `plugins.list` and `plugins.inspect` that `buzz-admin` is
   absent. Remove all three Buzz Admin names from the five FMG agents'
   `tools.alsoAllow` lists and remove the dedicated `fmg-live-gate` agent. The
   official `@openclaw/buzz` channel must remain enabled, active and connected.
3. Restore the Sprig rollback URL, SHA-256, version and source commit as one
   set of `BUZZ_SPRIG_*` controls, then run
   `scripts/install-openclaw-buzz-runtime.sh --rollback /tmp/fmg-live.json`.
   This reads the distinct `.rollback.agent_runtime` identity, verifies and
   installs that immutable version when absent, and atomically repoints
   `/data/.openclaw/bin/buzz`. Keep `buzz-admin` uninstalled: signed work-report
   publication and its runtime-check tool are intentionally unavailable on this
   fallback. The preserved baseline is release
   `sprig-rollback-9f47e98`, asset
   `sprig-x86_64-unknown-linux-musl.tar.gz`, size `6,567,967` bytes, SHA-256
   `c3af280e7dbb1dde6bec6623a8730c7d34b0b60a9855a3687ca26e2a4579cd46`,
   executable SHA-256
   `54c9f5419eccc9f8de3a605636d32176204f869b571678ca5cd88b4d153781d8`,
   version `0.1.0+git.9f47e98`, source
   `9f47e983c6212d2ac2837e46b6c263081ffd53c3`.
4. Reinstall the previous saved desktop installer if the desktop must also be
   rolled back.
5. Keep the existing volumes and identity material. A rollback changes binaries,
   not community state.
6. Record both the failed and restored relay digests and Sprig versions in the
   release notes.
