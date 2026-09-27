# FMG Buzz changelog

## 0.5.26-fmg.4

Base: FMG live release `0.5.26-fmg.3`.

### Added

- A six-column project task board that opens the existing task detail,
  discussion, activity and comment workflow.
- Durable, one-time recovery controls for failed local-agent restarts and
  actionable provider, model, runtime and community error routing.
- `buzz messages send --content-file` for bounded UTF-8 Korean, emoji,
  mention and multiline input on Windows.

### Fixed

- Project repository operations now use the compatible MinGit runtime bundled
  with FMG Buzz, require the Nostr credential helper, and classify
  non-interactive Git authentication failures correctly.
- Agent lifecycle and channel-membership writes remain bound to the community
  and signing identity that scheduled them, including automatic restart,
  explicit retry, attach and removal paths.
- The **FMG 센터** task-graph preview remains read-only while transition
  publishing requires the CLI's complete relay preflight and conflict checks.

### Deployment

- This is a desktop-only update. The Hostinger relay, OpenClaw service and
  pinned `sprig-v0.5.26-fmg.1` agent runtime remain unchanged.
- The release lane silent-installs each Windows candidate and verifies the app,
  Nostr credential helper, managed Git launcher and pinned MinGit runtime before
  it writes the immutable release receipt.

## 0.5.26-fmg.3

Base: FMG live release `0.5.26-fmg.2`.

### Added

- Latest Codex choices for `GPT-6 Sol` and `GPT-6 Luna` in agent model
  selectors.
- `Claude Opus 5.5` as the current Claude Code model choice.
- Curated recovery choices when live ACP model discovery is unavailable, while
  preserving the signed-in adapter catalog whenever discovery succeeds.
- Compatibility gates that upgrade Codex ACP below `1.13.1` and Claude ACP
  below `0.81.2` to the maintained `@agentclientprotocol` adapters.

### Deployment

- This is a desktop-only update. The Hostinger relay, OpenClaw service and
  pinned `sprig-v0.5.26-fmg.1` agent runtime remain unchanged.

## 0.5.26-fmg.2

Base: FMG live release `0.5.26-fmg.1`.

### Added

- An always-visible **FMG 센터** sidebar entry so the custom desktop build is
  immediately distinguishable from the official Buzz client.
- A live FMG dashboard for the active community, relay connection, discovered
  relay agents and locally managed agent counts.
- A recent work-results list backed by signed kind `40009` events, with direct
  navigation to each source thread.
- A read-only task-graph preview for issues carrying the `graph` label.
- A non-sensitive Aside status probe that reports whether
  `BUZZ_ACP_ASIDE_COMMAND` is configured without exposing its value.
- Clear mobile-summary and operator-boundary copy so best-effort or external
  state is not presented as confirmed runtime health.

### Deployment

- This is a desktop-only update. The Hostinger relay image and the pinned
  `sprig-v0.5.26-fmg.1` agent runtime remain unchanged.

## 0.5.26-fmg.1

Base: upstream `desktop-v0.5.25` (`c8f73213089cbd5a0f1e675d3193558280d46e10`).

### Added

- Structured work reports for completed, blocked, review and decision outcomes, including desktop result cards and signed CLI/SDK publication.
- Graph-mode task transitions with dependency, authorization, stale-state and cycle checks. The command is available only for issues carrying the `graph` label.
- Optional Aside browser MCP injection for ACP sessions through `BUZZ_ACP_ASIDE_COMMAND`.
- Mobile-compatible agent report summaries: after a confirmed structured work
  report, the ACP policy instructs agents to attempt one short ordinary reply
  in the same thread with the status, core outcome and primary deliverable link.
- A fork-safe Windows build lane and fork-owner GHCR image paths.

### Deployment

- Windows keeps the existing `Buzz` product name and `xyz.block.buzz.app` identifier, so this release upgrades the current installation and retains the existing local community data.
- The Windows installer is unsigned and does not use the upstream auto-updater. Updates are installed manually from the FMG GitHub prerelease.
- The relay is deployed from `ghcr.io/contentscoin/buzz` by immutable digest. Database, Redis, object-storage volumes and relay identity remain outside the image.
- The Hostinger ACP agent is deployed from the versioned
  `sprig-v0.5.26-fmg.1` release asset, verifies a separately recorded SHA-256
  before extraction, and is recreated without replacing its identity volume or
  OpenClaw gateway configuration.

### Rollout controls

- Work reports are compiled in and enabled.
- Task graph remains an operator preview gated per issue by the `graph` label.
- Aside remains off while `BUZZ_ACP_ASIDE_COMMAND` is empty.
- Mobile report summaries are a prompt-enforced ACP agent policy and use
  ordinary thread messages understood by the official mobile client.

### Known limits

- Task graph has CLI and SDK support; it does not yet have a desktop board or transition controls.
- Aside does not yet have a desktop settings screen.
- The official mobile app shows the concise ordinary summary rather than the
  desktop work-report card.
- Ordinary summary delivery is best effort because the behavior is enforced by
  the agent prompt rather than a programmatic post-publish hook.
