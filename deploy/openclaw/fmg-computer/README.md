# Community task/document brokers 0.4.0

Uses only explicitly registered Supervisor community accounts. The default broker
keeps its existing browser/profile/receipt storage. Additional brokers expose only
`capabilities.get`, task reads and explicitly delegated document actions. They use
isolated audience-hashed receipt directories, exact relay checks, signed requests,
NIP-44 responses and live owner verification. No browser actions are permitted.
Startup checks duplicate audiences before creating brokers; partial startup closes
all created services. A missing broker/expired snapshot is unavailable, not an empty
success. Desktop .21 task/document RPC requires no binary change for this server slice.

## Earlier implementation notes

# FMG Server Computer 0.3.0

## Private result documents (source implementation; deployment is separate)

Requires dot-supervisor 0.7.0 and the updated Desktop sources. Browser/task
observations retain their existing behavior. The document broker adds only
private document operations; it cannot approve, dispatch or rerun a task.

The original proposing `buzz:tasks` connection must explicitly call
`fmg_buzz_get_document_desktop_access` then
`fmg_buzz_set_document_desktop_access` with the task ID, enabled flag and expected
revision. Default is denied. Revocation, expired/revoked proposing OAuth consent,
or a changed owner/community/Gateway denies reads and writes. The Desktop never
chooses or receives the original OAuth client ID or credentials.

Actions: `documents.access`, `documents.list`, `documents.get`,
`documents.versions`, `documents.source`, `documents.task_source`,
`documents.by_request`, `documents.save`. The signed encrypted broker binds
every request to the current owner and Gateway. Document retries reauthorize
at the server instead of replaying a cached response after access revocation.

Markdown and source text use bounded base64 fields to prevent control-character
JSON expansion from exceeding NIP-44. Original replies are fetched separately
from Markdown versions; no source truncation is silently performed. Every
projection is capped at 56,000 bytes before the 60,000-byte telemetry frame cap.
Document calls permit a burst of at most 30 per minute; ordinary browser/task
reads keep the existing one-second spacing.

This section describes the new code, not a confirmed installation, real
completed document save, Telegram invocation or Desktop runtime verification.

Task detail projections include the approved `requested_effort` for Desktop .9.
Older proposals may show null; the broker does not infer a missing effort.

First OpenDots-derived slice: Buzz FMG center → server browser observation.
Uses existing OpenClaw Buzz identity **in the same Gateway process**, owner
attestation verified against the latest signed kind:0 profile on every request.
The configured browser profile is observed; this service cannot start, stop,
navigate, type, execute JavaScript, run shell commands, or dispatch jobs.

Actions: `capabilities.get`, `state.get`, `tabs.list`, `tab.read`,
`screen.capture`, `transcript.list`, `tasks.list`, `tasks.get`. Fixed browser CLI
argv only. Task reads call the existing private Supervisor operator endpoint,
using only `view_list` / `view_get` with owner, community and Gateway bindings.
The operator token stays on the server. Kind:24200/NIP44
request/response transport. Request UUID receipts store encrypted signed response
events in SQLite WAL (24 hours / at most 1,000 requests); identical IDs return the same event, conflicting arguments
are rejected. Completed means response recorded, not delivery acknowledged.
An interrupted request remains unconfirmed; a new manual read uses a new UUID.
Rate-limited reads receive a signed encrypted error immediately, so the desktop
can show retry guidance without waiting for its response deadline.

Screenshots are AES-256-GCM encrypted before Blossom upload. The owner receives
the key, IV, AAD and hashes only through NIP44. Desktop validates relay origin,
scope, generation, byte count, ciphertext/plaintext hash and JPEG header before
creating a temporary blob URL. Maximum screenshot: 2MiB. Each request's raw browser
capture is removed after its bounded read; remote encrypted blobs
currently follow the relay's normal retention, with no promised automatic TTL.
The desktop clears pending requests/media on tab, agent, account, community or
dialog changes. Optional four-second state polling is visible-panel-only,
completion-spaced; screenshots are refreshed manually. No model invocation.

## Task observations in desktop 0.5.26-fmg.8

FMG center has a separate task-list/result dialog. Reads are manual, recent 25
tasks only, and old tasks bound to a different owner/community/Gateway are denied.
Details show instructions, requested/actual model, run ID, state, response text,
and up to five recovery summaries. Response text is limited to 30KB and reduced
further if JSON encoding requires it; truncation is explicit. Full results remain
available to the original proposing OAuth client through FMG Buzz Tasks.
Approval/recovery commands are displayed as text for the direct Telegram owner;
the desktop cannot propose, approve, cancel, reconcile or execute a task.
Explicitly delegated document saves in 0.3.0 are independent of task execution.
Requires enabled fmg-supervisor 0.3.0 and dot-supervisor server 0.3.1 or later.

Install: build with `node scripts/build.mjs`, `npm pack`, then OpenClaw's plugin
installer. Add `fmg-computer` to `plugins.allow`, enable its entry and configure
`ownerPubkey` from the verified attestation and `browserProfile: openclaw`.
Requires OpenClaw 2026.9.6, Node 24, existing `channels.buzz`, the existing
single-value Buzz key file under `/data/.openclaw/secrets`, and installed Buzz CLI.
Do not copy its private key into another service. Restart/reload the Gateway.

## OpenDots attribution / adaptation boundary

UX reference: CopilotKit/OpenDots commit
`b01ac1f6a903e5e56c119d960901353ac0a3d171`, `ComputerPanel.tsx` and computer-types.
Buzz implementation uses its own owner relay/native media APIs. No OpenDots
server runtime, arbitrary terminal/file access, agent supervisor, write approval
outbox, dedicated job profile, job dispatch or mobile menus have been implemented
by this slice. These remain subsequent backlog items.
