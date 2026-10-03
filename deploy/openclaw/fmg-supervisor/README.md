# FMG supervisor producer

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
