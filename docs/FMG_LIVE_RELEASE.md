# FMG Buzz live release

This runbook publishes FMG Buzz without changing the upstream release ledger.
The release descriptor is [`.release/fmg-live.json`](../.release/fmg-live.json).
The initial live desktop version was `0.5.26-fmg.1`; the current desktop-only
update is `0.5.26-fmg.4`.

## Release identity

| Item | Value |
| --- | --- |
| Upstream base | `desktop-v0.5.25` / `c8f73213089cbd5a0f1e675d3193558280d46e10` |
| Desktop version | `0.5.26-fmg.4` |
| Desktop tag | `fmg-desktop-v0.5.26-fmg.4` |
| Windows app identity | `Buzz` / `xyz.block.buzz.app` |
| Managed Git | Git for Windows MinGit `2.55.0.5`, pinned by SHA-256 in `scripts/windows-managed-git.json` |
| Relay image | `ghcr.io/contentscoin/buzz` pinned by digest |
| Agent runtime | `sprig-v0.5.26-fmg.1` release asset pinned by SHA-256 |
| Public relay | `wss://buzz-dnb0.srv2006121.hstgr.cloud` |

`0.5.26-fmg.4` is greater than the installed `0.5.26-fmg.3`, so the NSIS
installer follows the normal in-place upgrade path. Keeping the application
identifier preserves the existing desktop community and identity storage.

### Release scope

`0.5.26-fmg.4` changes only the Windows desktop app. Run the desktop candidate
and publish procedure below, but do not redeploy the relay, OpenClaw service, or
Sprig runtime for this version. The relay and agent-runtime procedures apply
only when a future release descriptor assigns them a new immutable image digest
or a new uniquely named runtime release.

## Implemented rollout controls

The release does not declare environment flags that the application ignores.

| Feature | Live state | Actual control |
| --- | --- | --- |
| Work reports | Enabled | Compiled desktop, relay, CLI and SDK support |
| Task graph | Operator preview | Desktop shows a read-only graph preview; the issue must carry the `graph` label before the CLI accepts a transition |
| Aside browser | Off | `BUZZ_ACP_ASIDE_COMMAND` is empty; set it to the trusted Aside executable to opt in |
| Mobile report summary | ACP agent policy | After a confirmed report, the agent is instructed to attempt one concise ordinary reply in the same thread |

## Build and publish the Windows app

1. Merge the reviewed FMG integration commits and this release configuration
   into `contentscoin/buzz` `main`.
2. Open **Actions → FMG Desktop Release → Run workflow** on `main`.
3. Run once with `publish=false`. Download the workflow artifact and install it
   over the existing Buzz installation. Record the candidate run ID and the
   installer SHA-256 printed in the workflow summary.
4. Confirm the installed version is `0.5.26-fmg.4`, the **FMG 센터** entry is
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
   센터**, confirm a `graph` task shows its dependency state in the read-only
   preview.
5. Re-run the workflow on the same `main` commit with `publish=true`, supplying
   the recorded `candidate_run_id` and `candidate_sha256`. The publish job does
   not rebuild. It downloads that immutable Actions artifact, verifies its
   receipt, source commit and hash, then creates
   `fmg-desktop-v0.5.26-fmg.4`.
6. If the tag or release already exists, the workflow resolves the tag to its
   commit and byte-compares the existing assets. It succeeds only when they are
   identical; it never replaces an existing release asset.

The workflow creates a non-updating, unsigned x64 NSIS installer. It does not
promote the build into the upstream `buzz-desktop-latest` updater channel.

## Build and deploy the relay (not part of 0.5.26-fmg.4)

Skip this section for `0.5.26-fmg.4`. Use it only for a release that explicitly
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

## Build and deploy the ACP agent runtime (not part of 0.5.26-fmg.4)

The Hostinger `buzz-openclaw-agent` service downloads `buzz-acp` from a Sprig
release when the container starts. Replacing only the relay image does not
update this agent runtime.

Skip this section for `0.5.26-fmg.4`. `sprig-v0.5.26-fmg.1` is an existing
immutable release and must not be recreated, moved, or replaced. A future agent
runtime rollout must first record a new unique Sprig tag, asset, source commit,
and SHA-256 in the release descriptor.

1. Read the new Sprig tag and source commit from the release descriptor. Create
   that previously unused tag at the recorded commit, then verify the tag
   resolves to the same commit. Never derive the runtime commit from a
   desktop-only candidate receipt.
2. Let the **Sprig** tag workflow publish the uniquely named asset recorded in
   the descriptor and its SHA-256 file.
   Download the immutable Actions artifact from that workflow, independently
   calculate the archive SHA-256, and record it as `BUZZ_SPRIG_SHA256`. Record
   the descriptor's runtime source commit as `BUZZ_SPRIG_GIT_SHA` and its
   runtime version as `BUZZ_SPRIG_VERSION` in Hostinger.
3. In the Hostinger Compose command for `buzz-openclaw-agent`, replace the
   rolling `sprig-latest/sprig-x86_64-unknown-linux-musl.tar.gz` URL with that
   new versioned asset URL. Keep its identity volume, owner,
   OpenClaw gateway token and all other environment values unchanged. Add the
   three `BUZZ_SPRIG_*` controls from
   [`deploy/fmg/hostinger.env.example`](../deploy/fmg/hostinger.env.example).
4. Make the startup command download the archive to a file and fail before
   extraction unless this check succeeds:

   ```bash
   printf '%s  %s\n' "$BUZZ_SPRIG_SHA256" "$archive" | sha256sum -c -
   ```

   After extraction, fail unless `sprig.json` contains the exact
   `BUZZ_SPRIG_VERSION` and `BUZZ_SPRIG_GIT_SHA`, then execute `buzz-acp`.
   Reading the `.sha256` file again from the same release is not a substitute
   for the separately recorded Hostinger value.
5. Redeploy so Compose recreates `buzz-openclaw-agent`. Confirm the running
   container's `/tmp/buzz-sprig/sprig.json` matches both controls, then confirm
   ACP reconnects to the existing channel.

## Live checks

After deployment, confirm all of the following before treating the release as
live:

- `GET /` and `GET /health` return success.
- WebSocket upgrades succeed on the relay root and `/pair`.
- CORS echoes each configured origin: the public HTTPS origin,
  `tauri://localhost`, and `http://tauri.localhost`.
- OpenClaw ACP reconnects and reports the expected community and channel.
- Desktop can post and receive a normal message.
- A signed work report appears as a result card on desktop.
- For a confirmed agent-authored work report, the ACP agent attempts one
  ordinary reply in the same thread containing the status, core outcome and
  primary deliverable link. This is prompt-enforced best effort; a dedicated
  mobile work-report card and programmatic delivery guarantee are later client
  enhancements.

## Rollback

1. Change Hostinger back to the previously recorded image digest and redeploy.
2. Restore the Sprig rollback URL, SHA-256, version and source commit as one
   set of `BUZZ_SPRIG_*` controls, then recreate `buzz-openclaw-agent` if the
   agent runtime must be rolled back. The preserved baseline is release
   `sprig-rollback-9f47e98`, asset
   `sprig-x86_64-unknown-linux-musl.tar.gz`, SHA-256
   `c3af280e7dbb1dde6bec6623a8730c7d34b0b60a9855a3687ca26e2a4579cd46`,
   version `0.1.0+git.9f47e98`, source
   `9f47e983c6212d2ac2837e46b6c263081ffd53c3`.
3. Reinstall the previous saved desktop installer if the desktop must also be
   rolled back.
4. Keep the existing volumes and identity material. A rollback changes binaries,
   not community state.
5. Record both the failed and restored relay digests and Sprig versions in the
   release notes.
