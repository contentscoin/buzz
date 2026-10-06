# FMG Buzz changelog

## 0.5.26-fmg.21

Base: FMG desktop `0.5.26-fmg.20`.

- Connect Hostinger main schema 4 proposals to the private Markdown editor with
  separate per-task grants. OAuth clients retain their original token checks.
- Add direct Telegram `/fmg_document access/allow/revoke` commands with the full
  proposal hash, access revision and durable request UUID. Replaying a lost
  response returns the prior receipt and current state without reversing a
  later revocation. Grant commands are not exposed as LLM tools.
- Copy Desktop access commands only with a server-observed revision. Saving
  still requires verified successful terminal evidence and explicit access.
- Reuse immutable versions, hashes, save-response recovery and encrypted local
  drafts. Revocation preserves stored versions and downloaded drafts.
- Requires task server `0.8.1` and Supervisor plugin `0.9.1`. Source checks,
  deployment, installation and user workflow observations are separate evidence.

## 0.5.26-fmg.20

Base: FMG desktop `0.5.26-fmg.19`.

- Task observations add search, status counts and filters over the fetched recent
  25 tasks, plus requested effort and update time in each list row.
- Preserve and validate the Computer broker's existing schema 4 repository,
  commit, role branch and workspace binding instead of stripping them on parse.
  Show immutable proposal context separately from current execution evidence.
- Add explicit copy actions for owner Telegram approval, cancellation and
  reconciliation commands, with the exact task UUID and full proposal hash.
- Preview and manually copy a bounded mobile task summary, retaining uncertain,
  cancellation and truncated-result states. No automatic message publication.
- Explain the reserved Gateway proposal account's unsupported document save
  path without borrowing OAuth document access. Existing owner/community/Gateway
  authorization, local lifecycle, models and effort settings remain unchanged.
- Build, installation and actual UI observations are separate evidence.

## 0.5.26-fmg.19

Base: FMG desktop `0.5.26-fmg.18`.

- Local agent cards show the current community's local execution state beside
  their separate relay presence dot. Online presence alone cannot prove that
  a stopped local process is still running.
- Bulk Stop returns exact successfully stopped keys to clear old working badges
  for the captured owner, refreshes presence along with local state, and preserves
  native error messages. Failed terminations keep their working state.
- Existing session pause, launch preferences, and remote lifecycle boundaries
  remain in force. No model task or test suite was requested.

## 0.5.26-fmg.18

Base: FMG desktop `0.5.26-fmg.17`.

- 전체 로컬 에이전트 중지 drains this device's local runtime pairs in every
  community, using a distinct owner-bound native command. Remaining processes
  and partial failures are reported after termination, including valid orphan
  receipts belonging to this Desktop instance.
- Keep Stop visible even when the active community has no running pair. Bulk
  Stop pauses automatic starts until an explicit Start or app relaunch; the
  saved launch preference remains intact. Single-community Stop stays scoped.
- No remote Hostinger process shutdown, model task, or test suite was requested.

## 0.5.26-fmg.17

Base: FMG desktop `0.5.26-fmg.16`.

- Explicit local Start and runtime-pair Start/Restart save the launch restore
  preference. Internal reconciliation does not change manual preferences.
  The startup toggle can disable restore; ordinary Stop retains the preference.
- Agents adds 전체 에이전트 시작 to its header and compact action menu.
  Two concurrent starts skip running/deployed records, preserve owner/community
  and presence guards, and report progress and partial failures. External relay
  identities remain managed by their host.
- Static checks and native compilation are recorded separately from actual
  app-restart observation. No live model work or regression tests were requested.

## 0.5.26-fmg.16

Base: FMG desktop `0.5.26-fmg.15`.

- Windows runtime identity recognizes npm `.cmd` and `.bat` adapter shims.
  Resolved Codex adapter paths now retain the newest native CLI selection at
  both model discovery and agent spawn, preserving explicit `CODEX_PATH`.
- Instance editors match saved absolute adapter paths to the Rust catalog's
  binary path. Installed adapters no longer fall into the custom-runtime state
  with model/effort discovery disabled merely because their path was persisted.
- Installed `.15` discovery with the current native CLI returns all six
  GPT-6.1 SOL effort entries. The unselected CLI path can return base models
  without the legacy effort entries; model presence alone is insufficient.
- User-visible `.16` menus and saved next-session effort require separate
  observation after installation.

## 0.5.26-fmg.15

Base: FMG desktop `0.5.26-fmg.14`.

- Local instance effort uses choices from the applicable model's live catalog,
  including GPT-6.1 SOL, before consulting a matching session-native catalog.
  Stale session choices from another model cannot mask the selected model.
- Instance strengths save through the existing canonical effort column in the
  locked Save transaction, including persona-linked instances. Definition and
  defaults editors retain the adapter's encoded model/effort persistence.
- The effort section identifies its applicable model and explains definition
  ownership. Blank default-model forms use their effective inherited model.
- Definition editors show Model before Effort. Live conversation effort and
  remote Gateway role settings are unchanged.

## 0.5.26-fmg.14

Base: FMG desktop `0.5.26-fmg.13`.

- Agents shows verified owned relay identities, including an independently
  operated OpenClaw, without fabricating local runtime controls.
- Explicit owner-only mention enrollment publishes an owner-signed response
  policy in the selected community. Exact identity, current ownership and
  observed existing policy are checked before publication and again afterwards.
  Channel membership and final message authorization remain required.
- Windows Codex discovery and launch use the same newest version-probed native
  CLI in the standard install directories, preserving explicit `CODEX_PATH`.
- Edit, persona and defaults menus expose effort encoded in the adapter's
  discovered model catalog before the first live session. Choices save through
  the model field and never switch live conversation effort. Native session
  effort remains Save-gated and uses adapter-advertised choices.
- Build, installation, owner enrollment and actual mentioned replies are
  separate evidence. OpenClaw roles remain distinct from Buzz identities.

## 0.5.26-fmg.10

Base: FMG desktop `0.5.26-fmg.9`.

- FMG Center adds private Markdown drafts, immutable document versions,
  stored source summaries, version comparison and document-library pagination.
- Saves require a successful task with verified completion evidence. Each
  immutable version records SHA-256, byte count and a request UUID. Retries
  recover the same request; concurrent head changes require explicit review.
- Desktop document access is denied until the original proposing OAuth
  connection explicitly delegates that task. Current owner, community, Gateway,
  consent and delegation are checked again for reads, writes and retries.
- Local drafts and pending save requests are encrypted in IndexedDB before
  network saves. The UI exposes retry, response-loss recovery, local save status,
  bounded storage and confirmed local-draft cleanup.
- Requires dot-supervisor 0.7.0 and FMG Computer 0.3.0. Supervisor plugin 0.7.0
  and worker protocol 5 are retained. Installation and real completed-task
  document saves must be reported separately from source and build evidence.

## 0.5.26-fmg.9

Base: FMG desktop `0.5.26-fmg.8`.

- Adds GPT-6.1 Sol to the Codex persona model picker. Its capability record uses
  low, medium, high, xhigh or max with a medium default. Local adapter-advertised
  effort choices exclude none/minimal for this model; switching from an invalid
  local effort selects medium on Save.
- GPT dot task details display the approved requested effort. Telegram task
  replies and MCP proposals include the same value. Optional MCP `effort` selects
  a supported value; omission uses the configured role default.
- Supervisor 0.5.0 uses schema 3/protocol 4 and binds model, auth profile and role
  default effort before dispatch. The worker passes the approved effort instead
  of forcing medium. Computer 0.2.2 includes effort in encrypted task detail reads.
- Hostinger frontend, backend and live-gate roles target GPT-6.1 Sol with medium
  effort. Existing authentication and tool permissions are preserved. Catalog,
  configuration, deployed source and actual model execution are separate evidence.

## 0.5.26-fmg.8

Base: FMG desktop `0.5.26-fmg.7`.

- FMG Center adds an owner-only task list and result viewer for GPT dot proposals
  approved by the direct Telegram owner. Manual reads show recent 25 tasks,
  instructions, requested/actual model, execution ID, response and recovery history.
- The existing encrypted Buzz control transport carries task observations.
  The server validates the current owner, community and Gateway against both
  the signed Buzz profile and fresh Supervisor snapshot; operator tokens remain
  on Hostinger. Public MCP reads retain the proposing OAuth client boundary.
- Approval and recovery commands are displayed for manual Telegram use.
  The desktop does not execute task writes. Ambiguous runs retain their recovery
  block. Truncated result text is labeled and full results remain accessible to
  the original proposing client.
- Requires FMG Computer 0.2.0 and Supervisor server 0.3.1. Source, server deployment,
  candidate build, local installation and actual workflow evidence are separate.

## 0.5.26-fmg.7

Base: FMG live release `0.5.26-fmg.6`.

- FMG Center adds Server Computer: owner-only OpenClaw browser status, tabs,
  text snapshots, encrypted screenshots and recent query receipts.
- OpenDots observation UX adapted to Buzz NIP44 transport, with explicit
  refresh and optional visible-only state polling; pending requests and media
  are cleared on account/community/agent/tab/panel changes.
- Screenshot encryption and relay/scope/hash verification happen before
  display. The server broker runs in the existing Gateway process and observes
  the existing browser profile. No model invocation is needed for these reads.
- Gateway plugin `fmg-computer` 0.1.0 is a separate server installation.
  Browser control, terminal/files, job dispatch and GPT dot supervision remain
  subsequent development stages. Desktop/mobile installation state must be
  reported separately from source and server plugin state.
- Candidate builds can run from the explicit FMG development branch. Release
  promotion still requires main and an exact previously built installer.

## 0.5.26-fmg.6

Base: FMG live release `0.5.26-fmg.5`.

### Added

- FMG Center graph tasks now open a state-transition dialog. The packaged CLI
  checks authorization, dependency completion, cycles and the latest causal
  head before publication. Project Open/Closed status remains a separate view.
- Settings → Agents now saves a local Aside executable path, explicit disable,
  or inherited environment mode. One atomic save applies to the next local
  managed-agent start, without restarting running agents.

### Fixed

- Graph publication refuses capped histories and stale reviewed causal heads.
  Failed desktop requests require refreshing history before another attempt.
- Desktop graph requests capture the active community and signer, bound child
  process lifetime/output, and require an accepted relay event receipt.

### Deployment scope

- Desktop update only. Existing relay, OpenClaw and Sprig identities are retained.

## 0.5.26-fmg.5

Base: FMG live release `0.5.26-fmg.4`.

### Fixed

- Automatic local-agent restarts now record a durable, scope-isolated process
  generation before stop/start, preventing the same drift edge from replaying
  after FMG Buzz restarts.
- FMG Center and thread work-report views subscribe before history backfill,
  deduplicate events and repair their bounded history after relay reconnects.
- Managed-agent, persona and Huddle removal now remains bound to the captured
  community and signer, journals intent before local removal, and recovers the
  relay tombstone and identity archive after interruption.
- Project Git commands now enforce whole-process-tree containment, bounded
  output and explicit deadlines, including cleanup of credential and transport
  helpers.
- ACP messaging guidance now uses UTF-8 content files for multiline Korean,
  emoji and other shell-sensitive text on every supported operating system.

### Release engineering

- Fork Sprig image publication now defaults to the current repository owner's
  GHCR namespace.
- The FMG release receipt now records descriptor schema 2 and validates the
  pinned relay, Sprig, OpenClaw channel and repository-owned Buzz Admin
  identities before build or promotion.
- OpenClaw runtime installers and the live gate verify immutable package and
  executable hashes, the active Gateway generation, exact agent tool grants
  and rollback state.

### Deployment

- Hostinger now runs the official Buzz channel with the repository-owned
  `buzz-admin` `0.2.2` plugin and the pinned `sprig-v0.5.26-fmg.1` runtime.
- The full no-delivery live gate passed against the deployed OpenClaw runtime.
  The pinned relay digest and Sprig binary are unchanged for this desktop
  installer release.

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
