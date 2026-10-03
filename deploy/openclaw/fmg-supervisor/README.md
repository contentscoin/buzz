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

No task dispatch, browser input, message posting, agent creation or stop tools
are supplied in this release. Syntax/bundle/lint checks do not constitute a
ChatGPT invocation or full runtime test.
