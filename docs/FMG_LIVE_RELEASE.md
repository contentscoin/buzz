# FMG Buzz live release

This runbook publishes FMG Buzz without changing the upstream release ledger.
The release descriptor is [`.release/fmg-live.json`](../.release/fmg-live.json),
and the initial live desktop version is `0.5.26-fmg.1`.

## Release identity

| Item | Value |
| --- | --- |
| Upstream base | `desktop-v0.5.25` / `c8f73213089cbd5a0f1e675d3193558280d46e10` |
| Desktop version | `0.5.26-fmg.1` |
| Desktop tag | `fmg-desktop-v0.5.26-fmg.1` |
| Windows app identity | `Buzz` / `xyz.block.buzz.app` |
| Relay image | `ghcr.io/contentscoin/buzz` pinned by digest |
| Agent runtime | `sprig-v0.5.26-fmg.1` release asset pinned by SHA-256 |
| Public relay | `wss://buzz-dnb0.srv2006121.hstgr.cloud` |

`0.5.26-fmg.1` is greater than the installed `0.5.25-test.3`, so the NSIS
installer follows the normal in-place upgrade path. Keeping the application
identifier preserves the existing desktop community and identity storage.

## Implemented rollout controls

The release does not declare environment flags that the application ignores.

| Feature | Live state | Actual control |
| --- | --- | --- |
| Work reports | Enabled | Compiled desktop, relay, CLI and SDK support |
| Task graph | Operator preview | The issue must carry the `graph` label before `buzz issues transition` accepts it |
| Aside browser | Off | `BUZZ_ACP_ASIDE_COMMAND` is empty; set it to the trusted Aside executable to opt in |
| Mobile report summary | ACP agent policy | After a confirmed report, the agent is instructed to attempt one concise ordinary reply in the same thread |

## Build and publish the Windows app

1. Merge the reviewed FMG integration commits and this release configuration
   into `contentscoin/buzz` `main`.
2. Open **Actions → FMG Desktop Release → Run workflow** on `main`.
3. Run once with `publish=false`. Download the workflow artifact and install it
   over the existing Buzz installation. Record the candidate run ID and the
   installer SHA-256 printed in the workflow summary.
4. Confirm the installed version is `0.5.26-fmg.1`, the existing communities
   remain available, and the Hostinger community reconnects.
5. Re-run the workflow on the same `main` commit with `publish=true`, supplying
   the recorded `candidate_run_id` and `candidate_sha256`. The publish job does
   not rebuild. It downloads that immutable Actions artifact, verifies its
   receipt, source commit and hash, then creates
   `fmg-desktop-v0.5.26-fmg.1`.
6. If the tag or release already exists, the workflow resolves the tag to its
   commit and byte-compares the existing assets. It succeeds only when they are
   identical; it never replaces an existing release asset.

The workflow creates a non-updating, unsigned x64 NSIS installer. It does not
promote the build into the upstream `buzz-desktop-latest` updater channel.

## Build and deploy the relay

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

## Build and deploy the ACP agent runtime

The Hostinger `buzz-openclaw-agent` service downloads `buzz-acp` from a Sprig
release when the container starts. Replacing only the relay image does not
update this agent runtime.

1. Read the source commit from the verified desktop candidate receipt. Create
   `sprig-v0.5.26-fmg.1` at that exact commit, then verify
   `git rev-parse 'sprig-v0.5.26-fmg.1^{commit}'` prints the receipt commit.
2. Let the **Sprig** tag workflow publish
   `sprig-0.5.26-fmg.1-x86_64-unknown-linux-musl.tar.gz` and its SHA-256 file.
   Download the immutable Actions artifact from that workflow, independently
   calculate the archive SHA-256, and record it as `BUZZ_SPRIG_SHA256`. Record
   the receipt commit as `BUZZ_SPRIG_GIT_SHA` and `0.5.26-fmg.1` as
   `BUZZ_SPRIG_VERSION` in Hostinger.
3. In the Hostinger Compose command for `buzz-openclaw-agent`, replace the
   rolling `sprig-latest/sprig-x86_64-unknown-linux-musl.tar.gz` URL with the
   versioned `sprig-v0.5.26-fmg.1` asset URL. Keep its identity volume, owner,
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
2. Restore the Sprig rollback URL and its recorded SHA-256 as one pair, then
   recreate `buzz-openclaw-agent` if the agent runtime must be rolled back. The
   preserved baseline is release `sprig-rollback-e0705ff`, asset
   `sprig-x86_64-unknown-linux-musl.tar.gz`, SHA-256
   `c3af280e7dbb1dde6bec6623a8730c7d34b0b60a9855a368054f70b60518e29`,
   source `e0705ff114669c2bc73477a007aafe4be8726961`.
3. Reinstall the previous saved desktop installer if the desktop must also be
   rolled back.
4. Keep the existing volumes and identity material. A rollback changes binaries,
   not community state.
5. Record both the failed and restored relay digests and Sprig versions in the
   release notes.
