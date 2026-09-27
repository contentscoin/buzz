# FMG Buzz on Windows

## Sending Korean and multi-line messages

Use `--content-file` when a message contains Korean text, emoji, mentions,
line breaks, backticks, or PowerShell variables. This keeps PowerShell from
rewriting message content while it builds the process argument list.

```powershell
@'
안녕하세요 👋

@담당자 작업 결과를 확인해 주세요.
'@ | Set-Content -LiteralPath .\buzz-message.md -Encoding utf8

buzz messages send `
  --channel <CHANNEL_UUID> `
  --content-file .\buzz-message.md
```

The file must be UTF-8. FMG Buzz removes one leading UTF-8 BOM and preserves
the remaining content, including CRLF or LF line endings. The CLI rejects an
invalid UTF-8 file or a body larger than 65,536 bytes before publishing it.

On Windows, keep using `--content-file` for non-ASCII or multi-line content.
PowerShell 5.1 can transcode text sent to native commands, so its stdin
pipeline is not a safe substitute. `--content -` and `--content-file -` remain
available for environments whose native-command stdin is explicitly UTF-8.

For an ambiguous display-name mention, also pass the intended identity with a
repeatable `--mention <NPUB_OR_HEX_PUBKEY>` argument. The visible `@name` text
and the signed mention identity are handled separately.

## Repository diagnostics

The repository card intentionally shows a sanitized failure category. Detailed
Git operation errors identify the selected Git version and a non-sensitive
source label such as `managed-runtime`, `app-local`, `resolved`, or `PATH`; a
raw executable path is not needed for support. Authentication errors such as `could not read
Username` or `terminal prompts disabled` require credential setup. A missing
`git-credential-nostr` message means the bundled credential helper must be
restored before retrying.
