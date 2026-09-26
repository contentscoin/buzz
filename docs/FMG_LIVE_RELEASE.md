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
| Mobile report fallback | Pending | Add to the release descriptor only after the mobile client consumes it |

## Build and publish the Windows app

1. Merge the reviewed FMG integration commits and this release configuration
   into `contentscoin/buzz` `main`.
2. Open **Actions → FMG Desktop Release → Run workflow** on `main`.
3. Run once with `publish=false`. Download the workflow artifact and install it
   over the existing Buzz installation.
4. Confirm the installed version is `0.5.26-fmg.1`, the existing communities
   remain available, and the Hostinger community reconnects.
5. Re-run the same commit with `publish=true`. The workflow creates or verifies
   `fmg-desktop-v0.5.26-fmg.1`, uploads the installer and writes
   `fmg-release-receipt.json` containing the source commit and installer hash.

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
- Mobile can receive the corresponding conversation content. A dedicated
  mobile work-report representation remains a separate release gate.

## Rollback

1. Change Hostinger back to the previously recorded image digest and redeploy.
2. Reinstall the previous saved desktop installer if the desktop must also be
   rolled back.
3. Keep the existing volumes and identity material. A rollback changes binaries,
   not community state.
4. Record both the failed and restored digests in the release notes.
