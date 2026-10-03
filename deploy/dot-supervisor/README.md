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
raw session keys, shell, browser input, message sending or task dispatch.
Agent names are untrusted data. Gateway role configuration and session activity
do not establish live Buzz presence or successful agent work.

Run `build.py`, then deploy the staged directory to a new Hostinger release.
Keep OAuth data separate from Blender data and preserve it on releases.
ChatGPT discovery/linking and actual dot tool invocation are separate milestones
from server deployment. No test suites or model tasks are run by deployment.
