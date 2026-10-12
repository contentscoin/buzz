# FMG app update channel

The dedicated `/fmg-updates/` HTTP surface distributes public application binaries
and version metadata. It carries no Buzz account, task, OAuth or pairing data.
The read-only service uses its own container and does not change the community,
Gateway or task server. Version feeds are replaced atomically only after binary
hash, package identity and signing checks. Published artifact paths contain their
SHA-256 and remain immutable; a version cannot be overwritten or downgraded.

Desktop uses the existing Tauri updater with the FMG public key and endpoint from
`.release/fmg-updates.json`. GitHub repository secrets contain the encrypted
signing key/password. The release workflow produces an installer and `.sig`.
Automatic startup/six-hour checks download signed updates; the in-app update
button applies/restarts, so active agent work is not interrupted without a click.
The initial updater-capable build must be installed once over the old manual build.

Android FMG 1.2.0+3 automatically checks on startup and foreground resumes, bounded
to six hours. Wi-Fi downloads are automatic; other networks offer a download
button. The FMG menu provides enable/disable, retry and install controls even
without pairing. APKs are capped at 100 MiB, downloaded only from the pinned HTTPS
origin/hash path and verified against SHA-256, application ID, increasing build
number and the existing FMG release signing certificate. Android performs the
final signature check in its installation UI. The first install permission is
granted in Android settings; afterwards the app opens the installer directly.

The official mobile build does not acquire install permission. APK updates retain
the FMG ID/signature, existing account, pairing, drafts and settings. Downloaded
APKs survive app restarts in a bounded app-owned cache and are reverified before
installation. The old APK-only build must receive 1.2.0 once to enable this path.

No APK key, desktop private signing key or server authorization token is placed in
the feed, binary URL or repo. Bootstrap installation and future installation
confirmation are distinct from Buzz task approval; no owner password is requested
for app updates.
