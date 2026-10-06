# Community ledger 0.10.0

Task server 0.9.0 and protocol 7 select a fresh owner/community/Gateway snapshot.
Gateway status, proposal and task read tools accept optional `community_id` from
the explicit project registry (for example `fmg`). Omission preserves default BD.
`/fmg_task list fmg` reads only that community; IDs select their immutable stored
audience for approval, recovery and `/fmg_document` commands. Existing OAuth
resources remain default-community-only; fmg cannot borrow their tasks/grants.
Desktop .21 already binds each request and encrypted draft to its active community.
Computer 0.4.0 adds separate signed connections and receipt databases for registered
communities, exposing only task/document actions on non-default communities.
No browser profile, navigation, transcripts or implicit document grants cross scopes.
Expiry, owner revocation, unknown/duplicate registrations and stale generations deny
access without default fallback. Successful terminal receipts still gate document saves.
Coding worktrees remain the shared Buzz repository. This does not provision a separate
repository for BD/fmg, automate role scheduling, send summaries or prove a model ran.
Build/deployment evidence must be reported separately from Desktop and execution use.

## Earlier implementation notes

# FMG supervisor producer

## Version 0.9.1 main proposal document delegation

Task server 0.8.1 accepts direct-owner `/fmg_document access`, `allow` and
`revoke` commands for the current audience's reserved main proposal account.
Changes bind the exact task/proposal hash, expected access revision and request
UUID. Same-input replay returns the immutable receipt plus current access;
replaying a prior allow cannot undo a later revoke. No grant tool is registered
for models or the Computer broker. Existing OAuth delegation stays separate.
Desktop 0.5.26-fmg.21 copies commands and opens the existing Markdown editor.
Document save still requires successful terminal evidence. Revocation denies
server access; it does not erase immutable documents or downloaded local drafts.
Source/build/deployment evidence must not be reported as an observed owner
command or completed Desktop save workflow.

## Hostinger central manager and code preparation

The human owner selected the Hostinger OpenClaw `main` as the central manager.
fmg and BD are conversation connections, not an assertion of separate code
projects. The current managed source is `contentscoin/buzz` on
`feat/fmg-desktop-graph-aside`.

`scripts/prepare-buzz-workspaces.mjs COMMIT REQUEST_UUID` runs inside the Linux
Gateway container as the actual Gateway runtime user, UID 1000 (`docker exec
--user 1000:1000`, never the default root exec user). The script rejects other
users before creating files. It clones a shallow bare source and creates separate branches
and worktrees for main and the five existing coding roles. live-gate retains its
existing observation-only permissions and receives no coding grant. The script
uses the official role workspace catalog, requires a matching immutable commit,
rejects existing targets and links, bounds child process trees and output, and
preserves existing guidance with private backups and a preparation journal.
Guide pointers follow guide installation. Failed preparation stays `needs_review`;
there is no automatic reset, deletion or rerun of a model. A crash leaves the
exclusive preparation lock for operator review.

The private manifest at `/data/.openclaw/projects/buzz/manifest.json` records
prepared worktrees, not task execution. Existing models, effort, tool permissions
and the approval protocol are unchanged. Each new execution still needs proposal
binding to repository/baseline/role branch before admission. Version 0.9.0 adds
that binding for explicit central proposals, not autonomous multi-role scheduling.
Preparation itself does not merge, push, publish messages or run tests/models.

## Version 0.9.0 central coding proposals

The optional `fmg_buzz_gateway_propose_task` uses the admitted private Telegram
owner main context, live ownership fences and independently observed clean role
worktrees. It persists schema 4 proposals only: project `buzz`, repository URL,
current commit, role branch, an opaque workspace binding, full execution prompt,
model/auth binding and requested effort are covered by the immutable hash.
Only direct human `/fmg_task approve ID HASH` admits a run. UUID retries return
the original proposal; changed inputs conflict. The operator namespace is scoped
to owner/community/Gateway and cannot borrow OAuth document rights.

Server 0.8.0 accepts protocol 6 workers and preserves schema 3 legacy proposals.
The worker rechecks repository/branch/HEAD/clean state before checkpoint and
SDK admission. Changed bindings remain uncertain for direct recovery; there is
no reset or automatic rerun. Durable intent and terminal completion contracts
remain unchanged. An admission binding is not proof of code edits or tests.

The private snapshot contains up to five observed coding bindings, without
private paths or credentials. `/fmg_project list` distinguishes conversation
connections from this central code project and reports independently observed
worktree counts. The ledger remains bound to the default BD audience; fmg does
not gain cross-community task/document access. No automatic report publication,
Gateway document saving, branch merging or multi-role scheduling is introduced.

## Version 0.8.0 project registry (first management stage)

The optional `projects` registry explicitly binds up to four project IDs to
distinct Buzz account IDs and non-overlapping configured Gateway role IDs.
The direct Telegram owner can use `/fmg_project list` or `/fmg_project get ID`.
Main can read `fmg_buzz_gateway_projects` after that exact optional tool is
granted. Its version 2 factory reuses the admitted owner status observation,
checks signed ownership twice per account, probes each account's identity and
connection, and rejects configuration/generation changes before returning.
An account failure is explicit `unavailable`, never an empty healthy roster.
Names are display data, not routing authority. Credentials and private workspace
paths are not exported. Reads have bounded deadlines, outputs and registry sizes.

Registering a project does not authorize execution. The existing task ledger
still has its single community boundary and no project/repository binding.
The catalog exposes `legacy_community_only` versus `not_bound` so a connected
fmg account cannot be mistaken for a working fmg task queue. Both registered
projects report `project_execution=not_configured` and
`repository_binding=not_configured` until a separate project-bound execution
implementation is delivered. Assigned role metadata is configuration, not proof
of task dispatch, running jobs, repository access or result delivery.

Example of the explicit registry (no repository is inferred):

```json
{
  "projects": [
    {"id":"bd","name":"BD","buzzAccountId":"default","roleIds":[]},
    {"id":"fmg","name":"fmg","buzzAccountId":"fmg","roleIds":["fmg-planner","fmg-frontend","fmg-backend","fmg-qa","fmg-release","fmg-live-gate"]}
  ]
}
```

The unchanged `/fmg_task` command cannot select a project. Do not use it as a
cross-project dispatcher. No task approvals, reruns, role tool grants, model
changes, messages, or automatic mirrors are introduced by this registry.

## Version 0.7.1 normal stop and persisted recovery

An OpenAI `stop` is a normal final answer, not a cancellation. Worker success
requires the SDK's final `ok/completed` response, its bound terminal receipt,
and no abort, timeout, pending tools, errors or continuation.

When the `agent.wait` cache has expired, direct owner `/fmg_task reconcile`
can validate a persisted no-tool, single-turn OpenAI runtime trajectory.
This bounded recovery checks five runtime records, session/run identity,
exact prompt, actual model, requested effort, final answer phase, provider
response completion and an unaborted successful `session.ended`. It reads the
agent SQLite database without writes or migrations. Tool workflows, multi-turn
sessions, oversized, missing or mismatched evidence stay uncertain. This source
uses `gateway.runtime.no_tools` / `fmg-terminal-v2`. Older validated final/wait
evidence remains supported. No raw receipts, transcripts or auth profiles leave
the Gateway.

Recovery never reruns a model. Only the current direct Telegram owner may
commit the recovered result; ordinary MCP reads cannot commit it.

Regression checks:

```sh
node --test deploy/openclaw/fmg-supervisor/test/terminal.test.mjs
python -m unittest discover -s deploy/dot-supervisor -p test_completion.py
```

## Version 0.7.0 durable completion evidence

Protocol 5 workers attach a bounded `completion_evidence` to successful task
results. It binds the actual final receipt hash and exact stored reply hash to
the immutable proposal/run/model/effort and records an honest `stored_summary`
source. Failed, pending, aborted or continued runs never gain success evidence.
Normal final responses record observation time without inventing an end time;
`agent.wait` recovery records its verified real end time and the same contract.
No raw receipts, transcripts or auth profiles are exported. The task server
validates and saves result and evidence together; private result documents
require this proof. Protocol 4 workers cannot claim new work from server 0.6.0.
Upgrade the server before this plugin with no approved, running or ambiguous
task, preserve pending proposal hashes, and hot apply when retained work ends.

## Version 0.6.1 private owner task reads

Adds `fmg_buzz_gateway_get_task` and `fmg_buzz_gateway_list_tasks` for main's
direct Telegram owner conversation. Both reuse the version 2 status factory's
live owner authority and fresh signed-owner observations before and after the
audience-bound `view_get` / `view_list` read. They reuse the encrypted desktop
broker's bounded field projection; no tokens, raw session keys or auth profiles
are exported. Detail includes full proposal instructions and hash, model, effort
and bounded results. Neither tool proposes, approves, cancels, reconciles or
executes a task. The human's direct `/fmg_task` command remains required.

## Version 0.5 reasoning effort

Role snapshots expose configured effort and supported choices. Schema 3
proposals bind `requested_effort` along with model, role and auth profile. Optional
MCP `effort` selects a supported effort; omission uses the role's configured
default. Protocol 4 workers pass the approved effort to the local Gateway instead
of forcing medium. The binding includes the role default, so changing it after
approval blocks dispatch. Telegram get/approval replies show the chosen effort.
GPT-6.1 Sol supports low, medium, high, xhigh and max; none/minimal are rejected.
Model registration and effort selection do not prove account access or execution.

## Version 0.4 model binding

Model observations and proposals export only `provider/model`, without the
authentication profile suffix. The producer verifies the CLI observation against
the configured role and records an opaque SHA-256 binding for that role's exact
model reference. Schema 2 proposals include this binding in the approved hash.
Protocol 3 workers resolve the current local reference before the dispatch
checkpoint and again immediately before calling the Gateway. The selected
authentication profile stays inside the Gateway. Changed model/profile bindings
and legacy proposals cannot be dispatched automatically. Result model metadata
also excludes profile suffixes. Existing role tool permissions are unchanged.

OpenClaw 2026.9.6 background service. It reuses the existing Buzz identity in the
Gateway process and verifies its current signed owner profile before and after
each observation. No private key is exported to the MCP service.

Every completed observation atomically replaces a bounded snapshot at
`/data/.openclaw/fmg-supervisor/snapshot.json`. Only that directory is mounted
read-only in the separate supervisor MCP service. Stopped, failed or expired
observations are not presented as current state.

Buzz roster candidates are selected by verified owner attestations from a bounded
community profile scan, then latest profiles are re-read to detect revoked
bindings. The scan is capped at 201, the roster at 50, and truncation is explicit.
Presence is not observed.
Gateway roles are a separate concept from Buzz identities. The latest 100
session metadata records contribute counts and timestamps only: no transcripts,
raw session keys, participant identities, credentials or workspace paths.
Configured models and activity are not proof of model execution or running jobs.

Version 0.3 registers the direct Telegram owner command `/fmg_task` and a
background durable-task worker. Configure `telegramOwnerId` from trusted human
identity, `operatorUrl` as `http://fmg-dot-supervisor:8001/operator`, and
`tokenFile` as `/data/.openclaw/secrets/fmg-supervisor-operator.token`.
Other senders, group conversations and non-main routes are rejected.

The worker rechecks the signed owner and immutable community/Gateway binding.
It saves the run ID before invoking the public SDK's local Gateway `agent` RPC
with that idempotency key, a fixed role/session/model and 120-second deadline.
No automatic delivery is requested. Execution is never retried. Cancellation
requests `chat.abort` for only that session/run; a request is not a terminal
receipt. No temporary prompt file or subprocess is needed for dispatch.

`/fmg_task reconcile <task UUID> <proposal hash>` reads `agent.wait` for only the
persisted run. Successful recovery requires the actual terminal receipt,
matching requested model and terminal reply. Settled error/cancellation requires
a matching ended run with no pending error or yielded continuation. Timeout or
missing evidence never releases the block. The Gateway observation cache lasts
approximately ten minutes and is not durable across restarts; missing records
remain `needs_reconcile`. A task with durable proof that dispatch intent was
never recorded can be canceled without running it. Older leased tasks are
explicitly marked `legacy_unknown` and cannot use that proof.

Recovery uses the expected task revision and archives the previous uncertain
result and bounded evidence. Late ambiguous persistence cannot undo recovery.
Only bounded text and run/model metadata are exported. Agent results are
untrusted output; existing role tool permissions still apply.

Syntax/bundle/lint and service health checks do not constitute a ChatGPT tool
invocation, Telegram owner-command verification or completed model task.

Version 0.6.0 adds the optional Gateway tool `fmg_buzz_gateway_status`. Grant
only this name in main's `tools.alsoAllow`. Its version 2 factory requires the
trusted Telegram owner sender and matching private chat ID, main agent, and
live invocation authority. It checks the current signed Buzz owner twice,
bounded fresh snapshots, current role bindings and Gateway/community identity,
then returns allowlisted status/model/effort/activity summaries. It does not
call the operator API, approve tasks, invoke a model, or send chat messages.
No credentials, profile suffixes, transcript or raw session identifiers are
returned. Missing/expired observations fail; they are never empty success.
Metadata/catalog discovery alone is not proof of an admitted Telegram call.
See the [official version 2 tool contract](https://docs.openclaw.ai/plugins/tool-plugins).

`WORKFLOW.md` supplies owner-session guidance for current snapshot reads,
ChatGPT MCP versus Gateway tool exposure, model/effort binding, direct Telegram
approval and uncertain-result recovery. Install it with
`python3 scripts/install-workspace.py EXISTING_MAIN_WORKSPACE`. The installer
preserves existing guidance and Blender sections, creates private backups and
a durable progress receipt, then installs `BUZZ_SUPERVISOR.md` before adding its
managed pointer in `AGENTS.md`. No Gateway restart or tool grant is required.
