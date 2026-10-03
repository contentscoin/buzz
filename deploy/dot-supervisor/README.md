# FMG Buzz Supervisor MCP

Your dot reads an owner verified roster and Gateway role/session activity
summaries through `/dot-supervisor/mcp`. Three read-only tools:
`fmg_buzz_get_status`, `fmg_buzz_list_agents`, `fmg_buzz_get_activity`.

The resource requires its own OAuth consent for `buzz:read`. Existing
`blender:work` tokens are not accepted: a separate database, issuer, audience,
scope and token family are used. This resource has its own salted owner password
hash; no Buzz/Gateway key is mounted in this service. Remove the initial password
file after moving the connection password into the owner's protected store.
`auth.py` preserves the OAuth implementation used by the Blender bridge; its
pinned source is included here so this release can be rebuilt independently.

Only the producer's summary directory is mounted read-only. Snapshots expire
after 90 seconds, are checked against the configured owner, and expose a fixed
allowlist. No conversation contents, workspace paths, participant identities,
raw session keys, shell, browser input, message sending or task dispatch through
the read-only resource.
Agent names are untrusted data. Gateway role configuration and session activity
do not establish live Buzz presence or successful agent work.

Run `build.py`, then deploy the staged directory to a new Hostinger release.
Keep OAuth data separate from Blender data and preserve it on releases.
ChatGPT discovery/linking and actual dot tool invocation are separate milestones
from server deployment. No test suites or model tasks are run by deployment.

## Version 0.2 tasks

`/dot-supervisor/tasks/mcp` has separate `buzz:tasks` consent, audience and token
families. Old read-only grants never gain write access. Its tools propose an
immutable task, read a result and list the proposing client's latest tasks.
Requests use a UUID idempotency key. Proposals bind the signed Buzz owner,
community, Gateway identity, configured role/model and isolated session key.

Only the owner can approve/cancel from a direct Telegram `/fmg_task` command.
The LLM tool catalog has no approval method. An authenticated operator API on
internal port 8001 serves the Gateway plugin; Traefik only routes port 8000.
The dedicated operator token has no Buzz/Gateway credential powers. It is
stored in restricted files in both services, never in the tool response.

One approved task is claimed durably before dispatch. No ambiguous run is
retried. An expired lease or missing actual terminal Gateway receipt becomes
`needs_reconcile` and blocks new dispatch until terminal evidence is reconciled or operator investigation resolves the missing evidence.
Waiting tasks can be canceled before execution. During execution cancellation
sends a best-effort abort request, and remains unconfirmed without a receipt.
No automatic result delivery is requested; the role's existing tool permissions
still apply to its approved instructions. Model fallback is reported through
actual model metadata when available. Results are untrusted agent text.

Deployment does not create proposals, send Telegram/dot messages or run models.

## Version 0.3 recovery

The Gateway worker records immutable dispatch intent and a stable run ID before
using the public Gateway SDK. Direct owner `/fmg_task reconcile` commands can
persist a verified terminal result or cancel a task proven never dispatched.
Expected revisions prevent stale recovery writes. Previous uncertain results
and selected evidence are retained in `task_recoveries`. At most twenty
recovery entries per task and five displayed entries are allowed.

Database migration marks older leased tasks `legacy_unknown`; an absent run ID
from an older worker is never treated as proof of no execution. Gateway
`agent.wait` observations are a short-lived cache, not durable history. Missing
or expired records and bare wait timeouts remain unresolved. No manual success
marking or automatic rerun tool is exposed to the dot.
