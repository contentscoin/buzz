use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;

fn packaged_git() -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?;
    let app_dir = executable.parent()?;
    let path = app_dir
        .join("resources")
        .join("fmg-managed-git")
        .join("cmd")
        .join("git.exe");
    path.is_file().then_some(path)
}

fn legacy_managed_git() -> Option<PathBuf> {
    let profile = std::env::var_os("USERPROFILE")?;
    let root = Path::new(&profile)
        .join(".buzz")
        .join("TOOLS")
        .join("git-runtime");
    let mut candidates = std::fs::read_dir(root)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path().join("cmd").join("git.exe"))
        .filter(|path| path.is_file())
        .collect::<Vec<_>>();
    candidates.sort();
    candidates.pop()
}

fn managed_git() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("BUZZ_GIT_EXECUTABLE") {
        let path = PathBuf::from(explicit);
        if path.is_file() {
            return Some(path);
        }
    }
    packaged_git().or_else(legacy_managed_git)
}

fn main() {
    let Some(git) = managed_git() else {
        eprintln!(
            "Buzz managed Git runtime was not found; reinstall FMG Buzz to restore its packaged runtime"
        );
        std::process::exit(127);
    };
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    match Command::new(git).args(args).status() {
        Ok(status) => std::process::exit(status.code().unwrap_or(1)),
        Err(error) => {
            eprintln!("failed to launch Buzz managed Git runtime: {error}");
            std::process::exit(126);
        }
    }
}
