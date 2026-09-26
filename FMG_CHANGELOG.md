# FMG Buzz changelog

## 0.5.26-fmg.1

Base: upstream `desktop-v0.5.25` (`c8f73213089cbd5a0f1e675d3193558280d46e10`).

### Added

- Structured work reports for completed, blocked, review and decision outcomes, including desktop result cards and signed CLI/SDK publication.
- Graph-mode task transitions with dependency, authorization, stale-state and cycle checks. The command is available only for issues carrying the `graph` label.
- Optional Aside browser MCP injection for ACP sessions through `BUZZ_ACP_ASIDE_COMMAND`.
- A fork-safe Windows build lane and fork-owner GHCR image paths.

### Deployment

- Windows keeps the existing `Buzz` product name and `xyz.block.buzz.app` identifier, so this release upgrades the current installation and retains the existing local community data.
- The Windows installer is unsigned and does not use the upstream auto-updater. Updates are installed manually from the FMG GitHub prerelease.
- The relay is deployed from `ghcr.io/contentscoin/buzz` by immutable digest. Database, Redis, object-storage volumes and relay identity remain outside the image.

### Rollout controls

- Work reports are compiled in and enabled.
- Task graph remains an operator preview gated per issue by the `graph` label.
- Aside remains off while `BUZZ_ACP_ASIDE_COMMAND` is empty.
- Mobile report fallback remains pending until its mobile implementation lands in this release branch.

### Known limits

- Task graph has CLI and SDK support; it does not yet have a desktop board or transition controls.
- Aside does not yet have a desktop settings screen.
- The official mobile app does not render the desktop work-report card.
