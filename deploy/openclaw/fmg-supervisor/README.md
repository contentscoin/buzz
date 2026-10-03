# FMG supervisor producer

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
