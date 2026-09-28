//! Shared git subprocess plumbing for the project commands.
//!
//! Runs a compatible `git` with an ephemeral, env-only auth configuration:
//! the identity nsec is handed to `git-credential-nostr` via environment
//! variables so nothing key-related ever touches disk or global git config.

use crate::{
    app_state::AppState,
    managed_agents::{resolve_command, BoundedChild},
};
use nostr::{Keys, ToBech32};
use std::io::{ErrorKind, Read};
use std::path::PathBuf;
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use url::Url;

/// Wall-clock cap for a single git invocation. Remote operations talk to
/// relay-supplied clone URLs, so a slow or adversarial remote must not pin
/// `spawn_blocking` threads indefinitely.
const LOCAL_GIT_TIMEOUT: Duration = Duration::from_secs(60);
const REMOTE_GIT_TIMEOUT: Duration = Duration::from_secs(300);
const MIN_NOSTR_GIT_VERSION: (u64, u64, u64) = (2, 46, 0);

/// Maximum payload retained from each of stdout and stderr. The fixed-size
/// truncation marker is appended outside this budget, so each captured stream
/// remains bounded by this value plus a short diagnostic.
const GIT_STREAM_CAPTURE_LIMIT: usize = 4 * 1024 * 1024;
const GIT_POLL_INTERVAL: Duration = Duration::from_millis(50);

#[cfg(unix)]
const GIT_DRAIN_IDLE_POLL: Duration = Duration::from_millis(5);

#[derive(Clone)]
struct GitExecutable {
    path: PathBuf,
    source: &'static str,
    version: (u64, u64, u64),
}

impl GitExecutable {
    fn diagnostic_label(&self) -> String {
        let (major, minor, patch) = self.version;
        format!("Git {major}.{minor}.{patch} ({})", self.source)
    }
}

#[derive(Clone)]
struct GitCandidate {
    path: PathBuf,
    source: &'static str,
}

fn parse_git_version(output: &str) -> Option<(u64, u64, u64)> {
    let version = output
        .split_whitespace()
        .find(|part| part.chars().next().is_some_and(|c| c.is_ascii_digit()))?;
    let mut parts = version.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts
        .next()?
        .chars()
        .take_while(|character| character.is_ascii_digit())
        .collect::<String>()
        .parse()
        .ok()?;
    Some((major, minor, patch))
}

fn probe_git_candidate(candidate: GitCandidate) -> Result<GitExecutable, String> {
    let auth = GitAuthConfig {
        git_path: candidate.path.clone(),
        git_diagnostic: format!("Git candidate ({})", candidate.source),
        credential_helper: None,
        nsec: String::new(),
        allow_file_transport: false,
    };
    let stdout = run_git(&["--version"], None, &auth)
        .map_err(|_| format!("{} version check failed", candidate.source))?;
    let version = parse_git_version(&stdout)
        .ok_or_else(|| format!("{} returned an unrecognized version", candidate.source))?;
    Ok(GitExecutable {
        path: candidate.path,
        source: candidate.source,
        version,
    })
}

fn push_git_candidate(candidates: &mut Vec<GitCandidate>, path: PathBuf, source: &'static str) {
    if path.is_file() && !candidates.iter().any(|candidate| candidate.path == path) {
        candidates.push(GitCandidate { path, source });
    }
}

fn app_local_executable(command: &str) -> Option<PathBuf> {
    let executable_name = format!("{command}{}", std::env::consts::EXE_SUFFIX);
    let path = std::env::current_exe()
        .ok()?
        .parent()?
        .join(executable_name);
    path.is_file().then_some(path)
}

fn packaged_managed_git() -> Option<PathBuf> {
    let path = std::env::current_exe()
        .ok()?
        .parent()?
        .join("resources")
        .join("fmg-managed-git")
        .join("cmd")
        .join(format!("git{}", std::env::consts::EXE_SUFFIX));
    path.is_file().then_some(path)
}

fn git_candidates() -> Vec<GitCandidate> {
    let mut candidates = Vec::new();
    let executable_name = format!("git{}", std::env::consts::EXE_SUFFIX);
    // Use the packaged runtime directly for desktop project operations. The
    // app-local `git.exe` remains a sidecar launcher for child tools, but
    // selecting the real binary here lets timeout handling terminate Git
    // itself instead of leaving a launcher child behind.
    if let Some(path) = packaged_managed_git() {
        push_git_candidate(&mut candidates, path, "managed-runtime");
    }
    if let Some(path) = app_local_executable("git") {
        push_git_candidate(&mut candidates, path, "app-local");
    }
    if let Some(path) = resolve_command("git") {
        push_git_candidate(&mut candidates, path, "resolved");
    }
    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path) {
            push_git_candidate(&mut candidates, directory.join(&executable_name), "PATH");
        }
    }
    candidates
}

fn select_git_executable_uncached(require_nostr_auth: bool) -> Result<GitExecutable, String> {
    let candidates = git_candidates();
    if candidates.is_empty() {
        return Err(
            "Git was not found. Install Git and restart Buzz, or place a compatible Git executable next to the Buzz app."
                .to_string(),
        );
    }

    let mut diagnostics = Vec::new();
    for candidate in candidates {
        match probe_git_candidate(candidate) {
            Ok(git) if !require_nostr_auth || git.version >= MIN_NOSTR_GIT_VERSION => {
                let (major, minor, patch) = git.version;
                tracing::info!(
                    git_source = git.source,
                    git_version = %format!("{major}.{minor}.{patch}"),
                    "selected Git executable for project operations"
                );
                return Ok(git);
            }
            Ok(git) => {
                let (major, minor, patch) = git.version;
                diagnostics.push(format!(
                    "{} Git {major}.{minor}.{patch} is too old",
                    git.source
                ));
            }
            Err(error) => diagnostics.push(error),
        }
    }

    let requirement = if require_nostr_auth {
        "Nostr-authenticated Buzz repositories require Git 2.46 or newer. "
    } else {
        ""
    };
    Err(format!(
        "Buzz could not find a compatible Git executable. {requirement}Install or replace Git, then restart Buzz. Checked: {}.",
        diagnostics.join("; ")
    ))
}

fn select_git_executable(require_nostr_auth: bool) -> Result<GitExecutable, String> {
    static NOSTR_GIT: OnceLock<GitExecutable> = OnceLock::new();
    static BASIC_GIT: OnceLock<GitExecutable> = OnceLock::new();
    let cache = if require_nostr_auth {
        &NOSTR_GIT
    } else {
        &BASIC_GIT
    };
    if let Some(git) = cache.get() {
        return Ok(git.clone());
    }
    let selected = select_git_executable_uncached(require_nostr_auth)?;
    let _ = cache.set(selected.clone());
    Ok(cache.get().cloned().unwrap_or(selected))
}

fn git_subcommand<'a>(args: &'a [&str]) -> Option<&'a str> {
    let mut index = 0;
    while let Some(argument) = args.get(index).copied() {
        match argument {
            "-c" | "--config" | "-C" | "--git-dir" | "--work-tree" => index += 2,
            "--no-pager" | "--paginate" | "--end-of-options" => index += 1,
            argument
                if argument.starts_with("--config=")
                    || argument.starts_with("--git-dir=")
                    || argument.starts_with("--work-tree=") =>
            {
                index += 1;
            }
            argument if argument.starts_with('-') => index += 1,
            subcommand => return Some(subcommand),
        }
    }
    None
}

fn git_needs_credentials(args: &[&str]) -> bool {
    matches!(
        git_subcommand(args),
        Some("clone" | "fetch" | "push" | "pull" | "ls-remote" | "merge")
    )
}

pub(crate) struct GitAuthConfig {
    git_path: std::path::PathBuf,
    git_diagnostic: String,
    credential_helper: Option<std::path::PathBuf>,
    nsec: String,
    allow_file_transport: bool,
}

#[derive(Debug)]
struct CapturedGitStream {
    bytes: Vec<u8>,
    truncated: bool,
}

#[derive(Debug)]
struct GitCommandOutput {
    status: ExitStatus,
    stdout: String,
    stderr: String,
}

/// Drain a child stream while retaining at most `capture_limit` bytes.
///
/// The reader keeps draining after the retention cap so a finite, chatty Git
/// command can still finish. After teardown raises `stop`, Unix drains all
/// already-buffered output until `WouldBlock`; a continuously-writing process
/// group escapee is cut off once it crosses the capture cap. Windows waits for
/// EOF because descendants cannot escape the non-breakaway Job Object.
fn spawn_git_drain<R: Read + Send + 'static>(
    mut reader: R,
    capture_limit: usize,
    stop: Arc<AtomicBool>,
) -> JoinHandle<std::io::Result<CapturedGitStream>> {
    #[cfg(windows)]
    let _ = &stop;
    std::thread::spawn(move || {
        let mut bytes = Vec::with_capacity(capture_limit.min(64 * 1024));
        let mut truncated = false;
        let mut chunk = [0u8; 8192];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => return Ok(CapturedGitStream { bytes, truncated }),
                Ok(read) => {
                    let remaining = capture_limit.saturating_sub(bytes.len());
                    let keep = remaining.min(read);
                    bytes.extend_from_slice(&chunk[..keep]);
                    truncated |= keep < read;
                    #[cfg(unix)]
                    if stop.load(Ordering::Relaxed) && truncated {
                        return Ok(CapturedGitStream { bytes, truncated });
                    }
                }
                Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                #[cfg(unix)]
                Err(error) if error.kind() == ErrorKind::WouldBlock => {
                    if stop.load(Ordering::Relaxed) {
                        return Ok(CapturedGitStream { bytes, truncated });
                    }
                    std::thread::sleep(GIT_DRAIN_IDLE_POLL);
                }
                Err(error) => return Err(error),
            }
        }
    })
}

fn render_git_stream(mut capture: CapturedGitStream, capture_limit: usize) -> String {
    if capture.truncated {
        capture.bytes.extend_from_slice(
            format!("\n[output truncated by Buzz after {capture_limit} bytes]\n").as_bytes(),
        );
    }
    String::from_utf8_lossy(&capture.bytes).to_string()
}

fn join_git_drain(
    drain: JoinHandle<std::io::Result<CapturedGitStream>>,
    stream: &str,
    diagnostic: &str,
    capture_limit: usize,
) -> Result<String, String> {
    let capture = drain
        .join()
        .map_err(|_| format!("{diagnostic} {stream} reader panicked"))?
        .map_err(|error| format!("failed to read {diagnostic} {stream}: {error}"))?;
    Ok(render_git_stream(capture, capture_limit))
}

enum GitWaitOutcome {
    Exited(ExitStatus),
    TimedOut,
    Failed(std::io::Error),
}

fn run_contained_git_command_with_limit(
    mut command: Command,
    diagnostic: &str,
    timeout: Duration,
    capture_limit: usize,
) -> Result<GitCommandOutput, String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::util::configure_no_window(&mut command);

    let mut child = BoundedChild::try_spawn(command)
        .map_err(|error| format!("failed to run {diagnostic}: {error}"))?;
    let Some(stdout_pipe) = child.take_stdout() else {
        child.kill_tree();
        child.reap();
        return Err(format!("failed to capture {diagnostic} stdout"));
    };
    let Some(stderr_pipe) = child.take_stderr() else {
        child.kill_tree();
        child.reap();
        return Err(format!("failed to capture {diagnostic} stderr"));
    };

    #[cfg(unix)]
    if !(crate::managed_agents::set_bounded_command_pipe_nonblocking(&stdout_pipe)
        && crate::managed_agents::set_bounded_command_pipe_nonblocking(&stderr_pipe))
    {
        child.kill_tree();
        child.reap();
        return Err(format!(
            "failed to configure bounded output capture for {diagnostic}"
        ));
    }

    let stop = Arc::new(AtomicBool::new(false));
    let stdout_drain = spawn_git_drain(stdout_pipe, capture_limit, stop.clone());
    let stderr_drain = spawn_git_drain(stderr_pipe, capture_limit, stop.clone());

    let deadline = Instant::now() + timeout;
    let outcome = loop {
        match child.try_wait() {
            Ok(Some(status)) => break GitWaitOutcome::Exited(status),
            Ok(None) if Instant::now() >= deadline => {
                child.terminate_timed_out();
                break GitWaitOutcome::TimedOut;
            }
            Ok(None) => std::thread::sleep(GIT_POLL_INTERVAL),
            Err(error) => {
                child.kill_tree();
                break GitWaitOutcome::Failed(error);
            }
        }
    };

    // Even a successful Git root may have launched a background credential or
    // transport helper. Tear down the owned tree before joining readers, then
    // tell nonblocking Unix drains that no more output is required.
    child.kill_tree();
    child.reap();
    stop.store(true, Ordering::Relaxed);

    let stdout = join_git_drain(stdout_drain, "stdout", diagnostic, capture_limit);
    let stderr = join_git_drain(stderr_drain, "stderr", diagnostic, capture_limit);

    match outcome {
        GitWaitOutcome::TimedOut => Err(format!(
            "{diagnostic} timed out after {}s",
            timeout.as_secs()
        )),
        GitWaitOutcome::Failed(error) => Err(format!("failed to wait for {diagnostic}: {error}")),
        GitWaitOutcome::Exited(status) => Ok(GitCommandOutput {
            status,
            stdout: stdout?,
            stderr: stderr?,
        }),
    }
}

fn run_contained_git_command(
    command: Command,
    diagnostic: &str,
    timeout: Duration,
) -> Result<GitCommandOutput, String> {
    run_contained_git_command_with_limit(command, diagnostic, timeout, GIT_STREAM_CAPTURE_LIMIT)
}

pub(crate) fn run_git(
    args: &[&str],
    cwd: Option<&std::path::Path>,
    auth: &GitAuthConfig,
) -> Result<String, String> {
    let mut command = Command::new(&auth.git_path);
    command.args(args);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let needs_credentials = git_needs_credentials(args);
    let timeout = if needs_credentials {
        REMOTE_GIT_TIMEOUT
    } else {
        LOCAL_GIT_TIMEOUT
    };
    configure_git_auth(&mut command, auth, needs_credentials);

    let output = run_contained_git_command(command, &auth.git_diagnostic, timeout)?;
    if !output.status.success() {
        let stderr = output.stderr.trim().to_string();
        return Err(if stderr.is_empty() {
            format!(
                "{} exited with status {}",
                auth.git_diagnostic, output.status
            )
        } else {
            format!("{} failed: {stderr}", auth.git_diagnostic)
        });
    }
    Ok(output.stdout)
}

fn configure_git_auth(command: &mut Command, auth: &GitAuthConfig, needs_credentials: bool) {
    command.env("GIT_TERMINAL_PROMPT", "0");
    command.env("GIT_CONFIG_NOSYSTEM", "1");
    for key in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_SSH_COMMAND",
        "GIT_EXTERNAL_DIFF",
    ] {
        command.env_remove(key);
    }
    // Git for Windows maps `/dev/null` to `NUL` internally, so this value
    // disables the global config file on every platform.
    command.env("GIT_CONFIG_GLOBAL", "/dev/null");

    // Base entries: disable any inherited credential helper, and neutralize
    // repo-local hooks — every process git spawns inherits our environment
    // (including NOSTR_PRIVATE_KEY below), and a cloned repository's hooks
    // must never run with the identity key in reach.
    let mut entries: Vec<(&str, String)> = vec![
        ("credential.helper", String::new()),
        ("core.hooksPath", "/dev/null".to_string()),
        ("core.fsmonitor", "false".to_string()),
        ("protocol.allow", "never".to_string()),
        ("protocol.http.allow", "always".to_string()),
        ("protocol.https.allow", "always".to_string()),
        ("protocol.ext.allow", "never".to_string()),
        (
            "protocol.file.allow",
            if auth.allow_file_transport {
                "always"
            } else {
                "never"
            }
            .to_string(),
        ),
    ];
    if needs_credentials {
        let Some(cred_helper) = &auth.credential_helper else {
            return apply_git_config(command, &entries);
        };
        command.env("NOSTR_PRIVATE_KEY", &auth.nsec);
        entries.push((
            "credential.helper",
            credential_helper_config_value(cred_helper),
        ));
        entries.push(("credential.useHttpPath", "true".to_string()));
    }
    apply_git_config(command, &entries);
}

/// Format a path as an explicit shell command for git `credential.helper`.
///
/// Git appends the credential operation and executes helpers through a shell.
/// A bare absolute path is therefore split when an install or profile path
/// contains spaces. The `!` form preserves a shell snippet; single-quoting it
/// keeps the path one argument. Git for Windows invokes the snippet through
/// MinGW sh, where forward slashes avoid backslash escaping.
fn credential_helper_config_value(path: &std::path::Path) -> String {
    let normalized = path.to_string_lossy().replace('\\', "/");
    let quoted = normalized.replace('\'', "'\"'\"'");
    format!("!'{quoted}'")
}

fn apply_git_config(command: &mut Command, entries: &[(&str, String)]) {
    command.env("GIT_CONFIG_COUNT", entries.len().to_string());
    for (index, (key, value)) in entries.iter().enumerate() {
        command.env(format!("GIT_CONFIG_KEY_{index}"), key);
        command.env(format!("GIT_CONFIG_VALUE_{index}"), value);
    }
}

pub(crate) fn build_git_auth_config(state: &AppState) -> Result<GitAuthConfig, String> {
    let keys = state.signing_keys()?;
    build_git_auth_config_for_keys(&keys)
}

pub(crate) fn build_git_clone_auth_config(
    clone_url: &str,
    state: &AppState,
) -> Result<GitAuthConfig, String> {
    if validate_github_clone_url(clone_url).is_ok() {
        let git = select_git_executable(false)?;
        return Ok(GitAuthConfig {
            git_path: git.path.clone(),
            git_diagnostic: git.diagnostic_label(),
            credential_helper: None,
            nsec: String::new(),
            allow_file_transport: false,
        });
    }
    build_git_auth_config(state)
}

pub(crate) fn build_git_auth_config_for_keys(keys: &Keys) -> Result<GitAuthConfig, String> {
    build_git_auth_config_for_keys_with_requirement(keys, true)
}

fn build_git_auth_config_for_keys_with_requirement(
    keys: &Keys,
    require_nostr_auth: bool,
) -> Result<GitAuthConfig, String> {
    let git = select_git_executable(require_nostr_auth)?;
    let credential_helper = match app_local_executable("git-credential-nostr")
        .or_else(|| resolve_command("git-credential-nostr"))
    {
        Some(helper) => Some(helper),
        None if require_nostr_auth => {
            return Err(
                "Buzz could not find git-credential-nostr. Reinstall Buzz or restore its bundled credential helper, then restart Buzz."
                    .to_string(),
            );
        }
        None => None,
    };
    let nsec = keys
        .secret_key()
        .to_bech32()
        .map_err(|error| format!("encode identity key: {error}"))?;
    Ok(GitAuthConfig {
        git_path: git.path.clone(),
        git_diagnostic: git.diagnostic_label(),
        credential_helper,
        nsec,
        allow_file_transport: false,
    })
}

#[cfg(test)]
pub(crate) fn build_test_git_auth_config() -> Result<GitAuthConfig, String> {
    let mut auth = build_git_auth_config_for_keys_with_requirement(&Keys::generate(), false)?;
    auth.allow_file_transport = true;
    Ok(auth)
}

/// Normalizes and validates a relay-supplied branch name. Strips a
/// `refs/heads/` prefix, then rejects anything outside a conservative
/// character allowlist, path traversal (`..`), leading/trailing `/`, and
/// flag-shaped values (leading `-`) so a branch can never reach git as an
/// option instead of a positional argument.
pub(crate) fn clean_branch(value: Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.trim_start_matches("refs/heads/"))
        .filter(|value| {
            !value.is_empty()
                && !value.starts_with('-')
                && !value.contains("..")
                && !value.starts_with('/')
                && !value.ends_with('/')
                && value
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '.' | '-'))
        })
        .map(ToString::to_string)
}

pub(crate) fn clean_target_ref(value: Option<String>) -> Option<String> {
    let value = value?.trim().to_string();
    for prefix in ["refs/tags/", "refs/nostr/"] {
        if let Some(name) = value.strip_prefix(prefix) {
            let clean_name = clean_branch(Some(name.to_string()))?;
            return (clean_name == name).then_some(format!("{prefix}{clean_name}"));
        }
    }
    None
}

pub(crate) fn validate_clone_url(clone_url: &str) -> Result<(), String> {
    let parsed = Url::parse(clone_url).map_err(|error| format!("invalid clone URL: {error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("clone URL must be http or https".into());
    }
    // Buzz git remotes are served at `…/git/<owner-pubkey>/<repo-id>` — a
    // literal `git` segment followed by the 64-hex owner pubkey and a
    // non-empty repository id (the relay may live under a path prefix).
    let segments = parsed
        .path_segments()
        .map(|segments| segments.filter(|s| !s.is_empty()).collect::<Vec<_>>())
        .unwrap_or_default();
    let is_buzz_repo_path = segments
        .iter()
        .rposition(|segment| *segment == "git")
        .filter(|index| segments.len() == index + 3)
        .map(|index| {
            segments[index + 1].len() == 64
                && segments[index + 1].chars().all(|c| c.is_ascii_hexdigit())
                && !segments[index + 2].is_empty()
        })
        .unwrap_or(false);
    if !is_buzz_repo_path {
        return Err("clone URL must point at a Buzz git repository".into());
    }
    Ok(())
}

fn validate_github_clone_url(clone_url: &str) -> Result<(), String> {
    let parsed = Url::parse(clone_url).map_err(|error| format!("invalid clone URL: {error}"))?;
    if parsed.scheme() != "https"
        || parsed.host_str() != Some("github.com")
        || parsed.port().is_some()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err("GitHub clone URL must use public https://github.com/owner/repository".into());
    }
    let segments = parsed
        .path_segments()
        .map(|segments| {
            segments
                .filter(|segment| !segment.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let valid_segment = |segment: &&str| {
        !segment.starts_with('-')
            && !segment.contains("..")
            && segment.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
            })
    };
    if segments.len() != 2 || !segments.iter().all(valid_segment) {
        return Err("GitHub clone URL must name one owner and repository".into());
    }
    Ok(())
}

pub(crate) fn validate_local_clone_url(clone_url: &str) -> Result<(), String> {
    if validate_clone_url(clone_url).is_ok() || validate_github_clone_url(clone_url).is_ok() {
        return Ok(());
    }
    Err("clone URL must point at a Buzz repository or public GitHub repository".into())
}

pub(crate) fn validate_local_clone_url_for_workspace(
    clone_url: &str,
    state: &AppState,
) -> Result<(), String> {
    if validate_github_clone_url(clone_url).is_ok() {
        return Ok(());
    }
    validate_workspace_clone_url(clone_url, state)
}

pub(crate) fn clone_url_owner(clone_url: &str) -> Option<String> {
    let parsed = Url::parse(clone_url).ok()?;
    let segments = parsed
        .path_segments()?
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    let index = segments.iter().rposition(|segment| *segment == "git")?;
    (segments.len() == index + 3).then(|| segments[index + 1].to_ascii_lowercase())
}

pub(crate) fn validate_workspace_clone_url(
    clone_url: &str,
    state: &AppState,
) -> Result<(), String> {
    let relay_base = crate::relay::relay_api_base_url_with_override(state);
    validate_clone_url_against_relay(clone_url, &relay_base)
}

fn validate_clone_url_against_relay(clone_url: &str, relay_base: &str) -> Result<(), String> {
    validate_clone_url(clone_url)?;
    let clone = Url::parse(clone_url).map_err(|error| format!("invalid clone URL: {error}"))?;
    let relay = Url::parse(relay_base)
        .map_err(|error| format!("configured relay URL is invalid: {error}"))?;
    if clone.scheme() != relay.scheme()
        || clone.host_str() != relay.host_str()
        || clone.port_or_known_default() != relay.port_or_known_default()
    {
        return Err("clone URL must use the active workspace relay".into());
    }
    let relay_path = relay.path().trim_end_matches('/');
    if !relay_path.is_empty() && !clone.path().starts_with(&format!("{relay_path}/")) {
        return Err("clone URL must use the active workspace relay path".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const GIT_FIXTURE_MODE: &str = "BUZZ_PROJECT_GIT_EXEC_FIXTURE";

    fn git_fixture_command(mode: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().expect("current test executable"));
        command.args(["git_subprocess_fixture", "--nocapture", "--test-threads=1"]);
        command.env(GIT_FIXTURE_MODE, mode);
        command
    }

    /// Subprocess fixture for the production command runner. Invoking the test
    /// executable avoids shell-specific quoting and gives every platform the
    /// same descendant and large-output behavior.
    #[test]
    fn git_subprocess_fixture() {
        use std::io::Write as _;

        let Ok(mode) = std::env::var(GIT_FIXTURE_MODE) else {
            return;
        };
        match mode.as_str() {
            "large-output" => {
                std::io::stdout()
                    .write_all(&[b'o'; 4096])
                    .expect("write fixture stdout");
                std::io::stdout().flush().expect("flush fixture stdout");
                std::io::stderr()
                    .write_all(&[b'e'; 4096])
                    .expect("write fixture stderr");
                std::io::stderr().flush().expect("flush fixture stderr");
            }
            "descendant" => loop {
                std::thread::sleep(Duration::from_millis(100));
            },
            "root-success" | "root-timeout" => {
                let child = git_fixture_command("descendant")
                    .spawn()
                    .expect("spawn fixture descendant");
                drop(child);
                if mode == "root-timeout" {
                    loop {
                        std::thread::sleep(Duration::from_millis(100));
                    }
                }
            }
            other => panic!("unknown Git subprocess fixture mode: {other}"),
        }
    }

    #[test]
    fn command_capture_bounds_and_marks_both_streams() {
        let output = run_contained_git_command_with_limit(
            git_fixture_command("large-output"),
            "Git output fixture",
            Duration::from_secs(10),
            128,
        )
        .expect("large finite output should complete");
        let marker = "\n[output truncated by Buzz after 128 bytes]\n";
        assert!(output.status.success());
        assert!(output.stdout.ends_with(marker));
        assert!(output.stderr.ends_with(marker));
        assert!(output.stdout.len() <= 128 + marker.len());
        assert!(output.stderr.len() <= 128 + marker.len());
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn successful_root_reaps_descendant_before_reader_join() {
        let command = git_fixture_command("root-success");

        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let result = run_contained_git_command_with_limit(
                command,
                "Git descendant fixture",
                Duration::from_secs(10),
                4096,
            );
            let _ = tx.send(result);
        });
        let result = rx
            .recv_timeout(Duration::from_secs(15))
            .expect("reader joins must not wait on a background descendant")
            .expect("the fixture root exits successfully");
        assert!(result.status.success());
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn timeout_reaps_descendant_and_returns_without_reader_hang() {
        let command = git_fixture_command("root-timeout");

        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let result = run_contained_git_command_with_limit(
                command,
                "Git timeout fixture",
                Duration::from_secs(3),
                4096,
            );
            let _ = tx.send(result);
        });
        let error = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("timeout teardown and reader joins must remain bounded")
            .expect_err("the fixture must hit the command deadline");
        assert!(error.contains("timed out after 3s"), "{error}");
    }

    #[cfg(windows)]
    #[test]
    fn containment_setup_failure_is_an_error() {
        let result = BoundedChild::try_spawn_windows_with(
            git_fixture_command("large-output"),
            |_| -> Option<crate::managed_agents::JobHandle> { None },
            |_| true,
        );
        let error = match result {
            Ok(_) => panic!("Git must not run without whole-tree containment"),
            Err(error) => error,
        };
        assert!(
            error.contains("whole-process-tree Job Object containment setup failed"),
            "{error}"
        );
    }

    #[test]
    fn credential_helper_config_value_shell_quotes_forward_slash_path() {
        let path = std::path::PathBuf::from(
            r"C:\Users\Buzz User\AppData\Local\Buzz\git-credential-nostr.exe",
        );
        assert_eq!(
            credential_helper_config_value(&path),
            "!'C:/Users/Buzz User/AppData/Local/Buzz/git-credential-nostr.exe'",
        );
    }

    #[test]
    fn git_subcommand_skips_global_config_options() {
        assert_eq!(
            git_subcommand(&[
                "-c",
                "user.name=Buzz User",
                "-c",
                "user.email=user@example.com",
                "merge",
                "HEAD",
            ]),
            Some("merge")
        );
        assert_eq!(
            git_subcommand(&["--config=credential.useHttpPath=true", "fetch", "origin"]),
            Some("fetch")
        );
    }

    #[test]
    fn remote_and_promisor_operations_receive_credentials() {
        assert!(git_needs_credentials(&["fetch", "origin"]));
        assert!(git_needs_credentials(&[
            "-c",
            "user.name=Buzz User",
            "merge",
            "HEAD"
        ]));
        assert!(!git_needs_credentials(&["rev-parse", "HEAD"]));
    }

    #[test]
    fn clean_branch_accepts_plain_and_prefixed_names() {
        assert_eq!(
            clean_branch(Some("refs/heads/feature/x-1".into())),
            Some("feature/x-1".to_string())
        );
        assert_eq!(
            clean_branch(Some(" main ".into())),
            Some("main".to_string())
        );
    }

    #[test]
    fn clean_branch_rejects_flag_shaped_and_traversal_values() {
        assert_eq!(clean_branch(Some("--upload-pack=/tmp/evil".into())), None);
        assert_eq!(clean_branch(Some("-x".into())), None);
        assert_eq!(clean_branch(Some("a/../b".into())), None);
        assert_eq!(clean_branch(Some("/leading".into())), None);
        assert_eq!(clean_branch(Some("trailing/".into())), None);
        assert_eq!(clean_branch(Some("bad name".into())), None);
        assert_eq!(clean_branch(None), None);
    }

    #[test]
    fn clean_target_ref_accepts_only_tags_and_pull_request_refs() {
        assert_eq!(
            clean_target_ref(Some("refs/tags/v1.0.0".into())),
            Some("refs/tags/v1.0.0".to_string())
        );
        assert_eq!(
            clean_target_ref(Some("refs/nostr/abc123".into())),
            Some("refs/nostr/abc123".to_string())
        );
        assert_eq!(clean_target_ref(Some("refs/heads/main".into())), None);
        assert_eq!(clean_target_ref(Some("refs/tags/../main".into())), None);
    }

    #[test]
    fn validate_clone_url_requires_buzz_repo_shape() {
        let owner = "a".repeat(64);
        assert!(validate_clone_url(&format!("https://relay.example/git/{owner}/repo")).is_ok());
        assert!(
            validate_clone_url(&format!("https://relay.example/prefix/git/{owner}/repo")).is_ok()
        );
        assert!(validate_clone_url("https://relay.example/git/short/repo").is_err());
        assert!(validate_clone_url("https://evil.example/has/git/inpath").is_err());
        assert!(validate_clone_url(&format!("ssh://relay.example/git/{owner}/repo")).is_err());
        assert!(validate_clone_url(&format!(
            "https://relay.example/git/{owner}/repo/unexpected"
        ))
        .is_err());
    }

    #[test]
    fn workspace_clone_url_requires_exact_relay_origin_and_prefix() {
        let owner = "a".repeat(64);
        let valid = format!("https://relay.example/prefix/git/{owner}/repo");
        assert!(validate_clone_url_against_relay(&valid, "https://relay.example/prefix").is_ok());
        assert!(validate_clone_url_against_relay(&valid, "http://relay.example/prefix").is_err());
        assert!(
            validate_clone_url_against_relay(&valid, "https://relay.example:8443/prefix").is_err()
        );
        assert!(validate_clone_url_against_relay(&valid, "https://relay.example/other").is_err());
        assert!(validate_clone_url_against_relay(
            &format!("https://evil.example/prefix/git/{owner}/repo"),
            "https://relay.example/prefix",
        )
        .is_err());
    }

    #[test]
    fn local_clone_url_allows_only_public_github_https_urls() {
        assert!(validate_local_clone_url("https://github.com/block/buzz").is_ok());
        assert!(validate_local_clone_url("https://github.com/block/buzz.git").is_ok());
        assert!(validate_local_clone_url("http://github.com/block/buzz").is_err());
        assert!(validate_local_clone_url("https://github.com/block/buzz/issues").is_err());
        assert!(validate_local_clone_url("https://user@github.com/block/buzz").is_err());
        assert!(validate_local_clone_url("https://github.com.evil.test/block/buzz").is_err());
        assert!(validate_local_clone_url("https://gitlab.com/block/buzz").is_err());
    }
}
