//! Prefer the current desktop-shipped Codex CLI over an older PATH copy.

use std::{
    path::PathBuf,
    process::Command,
    time::{Duration, Instant},
};

/// Resolve the newest verified native CLI in the normal Windows install dirs.
/// Executable probes are bounded and invoked only through cached discovery.
pub(super) fn current_windows_codex_cli() -> Option<PathBuf> {
    let local = PathBuf::from(std::env::var_os("LOCALAPPDATA")?);
    let mut candidates = vec![local.join("Programs/OpenAI/Codex/bin/codex.exe")];
    let root = local.join("OpenAI/Codex/bin");
    if let Ok(entries) = std::fs::read_dir(root) {
        let mut installed: Vec<_> = entries
            .flatten()
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .chars()
                    .all(|c| c.is_ascii_hexdigit())
            })
            .map(|entry| entry.path().join("codex.exe"))
            .filter(|path| path.is_file())
            .collect();
        installed.sort();
        candidates.extend(installed.into_iter().take(8));
    }
    let deadline = Instant::now() + Duration::from_secs(6);
    let mut newest = None;
    for path in candidates.into_iter().filter(|path| path.is_file()) {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        let mut command = Command::new(&path);
        command.arg("--version");
        let Some(output) =
            super::output_with_timeout(command, remaining.min(Duration::from_secs(2)))
        else {
            continue;
        };
        if !output.status.success() {
            continue;
        }
        let text = String::from_utf8_lossy(&output.stdout);
        let Some(version) = text.trim().strip_prefix("codex-cli ") else {
            continue;
        };
        let numbers: Option<Vec<u64>> = version.split('.').map(|part| part.parse().ok()).collect();
        let Some(numbers) = numbers.filter(|parts| parts.len() == 3) else {
            continue;
        };
        let version = (numbers[0], numbers[1], numbers[2]);
        if newest
            .as_ref()
            .is_none_or(|(previous, _)| version > *previous)
        {
            newest = Some((version, path));
        }
    }
    newest.map(|(_, path)| path)
}
