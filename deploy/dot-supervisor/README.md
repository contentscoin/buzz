# GPT dot community selection 0.10.0

Task and private document MCP tools accept optional `community_id` (`bd`, `fmg`,
or another explicitly registered ID). Omission preserves default BD. The new
`fmg_buzz_list_communities` reports only this original OAuth connection's access
and readiness. It cannot grant permission or run a task.

Existing OAuth consent does not automatically enable additional communities.
Owner-configured per-connection grants bind the owner/community/Gateway scope.
`/fmg_dot access/allow/revoke` requires the direct human Telegram main context;
UUID receipts and revision CAS make lost-response recovery safe. Replaying a prior
allow reports that receipt and current access, never re-enables a revoked grant.
Only an active original `buzz:tasks` OAuth connection is eligible. The default
consent is revoked through its original OAuth flow. Community consent does not
inherit per-task Desktop document delegation or another proposing account's access.

Public community registration is generated with the current Gateway generation.
Each selected audience also requires its fresh, signed-owner-verified snapshot.
Removed/unknown registrations, mismatched generations, expired snapshots, revoked
community permission or OAuth consent deny access without fallback. Default legacy
snapshots remain supported during rollout. UUID task replay also checks the stored
audience, and task lists filter by original client plus audience before the 25 limit.
Private document source/version/request rules and success receipt admission remain.

No OAuth token is moved, replaced or broadened by deployment. Only a directly
authorized original connection may receive a separate additive community grant.
No task execution, model/effort mutation or implicit document delegation occurs.

Earlier implementation notes:

# Community operator scopes 0.9.0

Private operator task/document actions select producer-written audience-hashed
snapshots with the existing 90-second owner verification. Missing or invalid scopes
deny access; no fallback to default. OAuth tasks/documents continue to use the
default snapshot and original proposing client. Schema 3/4 proposals remain intact.
Protocol 7 is required to claim work after this deployment; old workers fail closed.
Main proposal UUID deduplication and document CAS/immutable receipts remain scoped
to owner/community/Gateway. No existing tasks, grants, result sources or documents
are moved to another community. Physical coding worktrees remain shared per role.

## Earlier implementation notes

# FMG Buzz Supervisor MCP

## Desktop document connection (server 0.7.0 source)

New task-resource tools: `fmg_buzz_list_document_library`,
`fmg_buzz_get_document_desktop_access`, `fmg_buzz_set_document_desktop_access`.
The existing task/document tools remain; `buzz:read` never gains document access.
Desktop access is denied by default, granted per task by the original proposing
client using an expected revision, and requires active OAuth authorization for
that same task resource. The private operator accepts only bound document
actions; a broker credential alone does not bypass the proposing-client grant.

Stored sources are read independently of the recent-25 task window. A changed
live result is reported as `needs_reconcile`, without replacing the stored
source; new versions still require matching successful completion evidence.
Same-head identical Markdown maps a new request UUID to the existing version.
Request recovery preserves its originally committed version and head; normal
document reads report the current head. Old request rows are preserved.

Limits: 32KiB Markdown/version, 20 versions/document, 32MiB content per
client/audience, 256MiB global content, 1,000 global documents and 50,000 global
request records. No automatic eviction. Deployment must preserve the existing
database, auth profiles, model settings, worker protocol and approved proposals.

The source implements this connection. Deployment and live workflow evidence
are separate; no real task is approved or replayed by building these sources.

## Private result documents (server 0.6.0)

The task resource adds `fmg_buzz_save_document`, `fmg_buzz_get_document`,
`fmg_buzz_get_document_by_request` and `fmg_buzz_list_documents`. Existing
`buzz:read` grants still expose only the three observation tools. Document
access uses the original task's proposing `buzz:tasks` client, current verified
owner/community/Gateway, and a proven succeeded task. No execution, approval,
publication, sharing or document deletion operation is added.

Protocol 5 workers persist a bounded completion attestation in the task result:
immutable proposal/run/model/effort binding, receipt hash, exact stored reply
hash, validation contract and real observation time. Recovery uses the same
contract with its actual Gateway end time. Attestations come from the existing
authenticated worker; they are not Gateway signatures. Raw receipts and auth
profiles are never exported. Replies are explicitly `stored_summary`, not a
claim of complete model output. Older successful rows without this evidence
cannot become documents and are never backfilled or rerun.

SQLite stores immutable source records, immutable versions and immutable request
receipts. A save transaction uses `BEGIN IMMEDIATE`, rechecks OAuth and the live
owner snapshot before commit, compares the expected head, applies quotas, and
commits version/head/request together. The same request and input return the
original version before checking the current head; changed input conflicts.
Lost responses recover with the original UUID. Store the complete original
save input with that UUID until confirmation. Do not create a fresh UUID on a
network error. Version reads check source/result/content hashes.

Limits: exact UTF-8 Markdown 32 KiB per version, 20 versions per document,
one document per task/client/audience, 1,000 documents and 32 MiB of stored
source/version content. No automatic eviction. New edits use the document ID,
new request UUID and exact current version. Missing evidence, capacity,
conflicts and unavailable documents return bounded error codes; errors never
become empty success. Schema and contents survive service restarts in the
existing private WAL database. Desktop .9 retains task reads; document editing
and signed desktop document writes are a separate subsequent release.

## Reasoning effort (server 0.5.0)

`fmg_buzz_propose_task` accepts optional `effort`: low, medium, high, xhigh or
max. Omit it to use the role default. The fresh snapshot advertises supported
values; unsupported choices are rejected. Schema 3 proposals show the chosen
effort and include it in the approval hash. Protocol 4 claims bind the model,
authentication profile and role default; changed settings stop dispatch.
The worker sends the approved effort, rather than forcing medium. Desktop .9
displays requested effort; .8 can still read tasks but does not display that field.

## Model binding (server 0.4.0)

Schema 2 proposals show public model IDs and bind the approved role's exact model
reference through an opaque fingerprint. Protocol 3 claims require both values
to match the fresh owner snapshot. Changed bindings enter `needs_reconcile` and
cannot run automatically. Authentication profile suffixes are not exposed in the
roster, proposals or result model metadata. Desktop 0.5.26-fmg.8 remains compatible.

## Desktop task observations (introduced in server 0.3.1)

The private operator supports `view_list` / `view_get`, requiring the exact
current owner public key, relay origin and Gateway identity from a fresh snapshot.
Only proposals with that same audience are returned. FMG Computer 0.2.0 uses
these reads for desktop 0.5.26-fmg.8. The encrypted desktop transport has no task
write operation. Public MCP result access remains restricted to the original
proposing OAuth client; no token, scope or consent migration is required.

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
