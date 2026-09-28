# FMG OpenClaw Buzz Admin

This trusted local OpenClaw plugin adds the operational surface that the
official `@openclaw/buzz` channel does not expose:

- `buzz_runtime_check` probes the native channel and verifies the Gateway-side
  CLI and resolved credential snapshot without returning secret values. Its
  result includes the immutable plugin build identity used by the live gate to
  reject a stale in-memory Gateway generation. It also captures the executing
entrypoint's SHA-256 when the module loads, so replacing files on disk cannot
make an older active generation pass the release gate.
- `buzz_publish_work_report` invokes the immutable FMG `buzz` CLI with the
  channel credential only in the child process environment.
- `buzz_send_thread_summary` sends the ordinary thread reply used by clients
  that do not render structured work-report cards.

The plugin requires OpenClaw `2026.9.6` and the pinned Sprig runtime installed
with its documented `buzz` helper link at `/data/.openclaw/bin/buzz`. It never
reads the write-only secret store. The Gateway must supply a runtime-resolved
Buzz channel config to the tool factory.

TypeBox is bundled into the single compiled entrypoint. Runtime imports are
limited to Node built-ins and the OpenClaw plugin SDK, so the descriptor-pinned
entrypoint hash covers the plugin's third-party runtime code.
The two executable paths are fixed at `/data/.openclaw/bin/buzz` and
`/usr/local/bin/openclaw`; plugin configuration cannot redirect a channel
credential into another executable.
