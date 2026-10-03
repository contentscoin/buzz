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

Version 0.2 also registers a direct Telegram owner command `/fmg_task` and a
background durable-task worker. Set `telegramOwnerId` from trusted human
identity, `operatorUrl` to `http://fmg-dot-supervisor:8001/operator`, and
`tokenFile` to `/data/.openclaw/secrets/fmg-supervisor-operator.token`.
Other senders, group conversations and non-main routes are rejected.

The worker rechecks the signed owner and immutable community/Gateway binding,
then invokes the configured role through `openclaw agent` with a fixed session,
model, 120-second deadline and no automatic delivery. The task database is
claimed before invoking the CLI. Lost receipts, restart or lease expiry never
cause an automatic rerun. Temporary instructions are outside the summary
directory and are removed after execution. Only bounded text and actual run/model
metadata are stored, with no automatic external publication. Cancellation during
execution requests an abort but is not reported as confirmed termination.

Syntax/bundle/lint and service health checks do not constitute a ChatGPT tool
invocation, Telegram owner-command verification or completed model task.
