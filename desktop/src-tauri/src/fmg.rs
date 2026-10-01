use serde::{Deserialize, Serialize};
use tauri::AppHandle;

pub(crate) mod graph;

static CONFIG_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

const ASIDE_BROWSER_COMMAND_ENV: &str = "BUZZ_ACP_ASIDE_COMMAND";

/// Non-sensitive runtime capability flags for the FMG desktop surface.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FmgRuntimeStatus {
    aside_browser_configured: bool,
}

/// Desktop-owned browser configuration; the environment value is never exposed.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FmgBrowserConfig {
    #[serde(default)]
    mode: BrowserMode,
    #[serde(default)]
    command: String,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum BrowserMode {
    #[default]
    Environment,
    Disabled,
    Custom,
}

fn config_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(crate::managed_agents::managed_agents_base_dir(app)?.join("fmg-browser.json"))
}

fn load_config(app: &AppHandle) -> Result<FmgBrowserConfig, String> {
    let path = config_path(app)?;
    load_config_at(&path)
}

fn load_config_at(path: &std::path::Path) -> Result<FmgBrowserConfig, String> {
    use std::io::Read;
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(FmgBrowserConfig::default());
        }
        Err(error) => return Err(format!("Aside 설정을 읽지 못했습니다: {error}")),
    };
    let mut bytes = Vec::new();
    file.take(8193)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Aside 설정을 읽지 못했습니다: {error}"))?;
    if bytes.len() > 8192 {
        return Err("Aside 설정 파일이 너무 큽니다".into());
    }
    let config = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Aside 설정을 읽지 못했습니다: {error}"))?;
    validate_config_path(config, false)
}

fn validate_config(config: FmgBrowserConfig) -> Result<FmgBrowserConfig, String> {
    validate_config_path(config, true)
}

fn validate_config_path(
    mut config: FmgBrowserConfig,
    require_existing: bool,
) -> Result<FmgBrowserConfig, String> {
    config.command = config.command.trim().to_string();
    if matches!(config.mode, BrowserMode::Custom) {
        if config.command.len() > 4096 || config.command.chars().any(char::is_control) {
            return Err("Aside 실행 파일 경로가 올바르지 않습니다".into());
        }
        let path = std::path::Path::new(&config.command);
        if !path.is_absolute() || (require_existing && !path.is_file()) {
            return Err("설치된 Aside 실행 파일의 전체 경로를 입력하세요".into());
        }
    } else {
        config.command.clear();
    }
    Ok(config)
}

fn effective_command(config: &FmgBrowserConfig, inherited: Option<String>) -> Option<String> {
    match config.mode {
        BrowserMode::Environment => inherited.filter(|value| !value.trim().is_empty()),
        BrowserMode::Disabled => None,
        BrowserMode::Custom => Some(config.command.clone()),
    }
}

/// Read saved settings without returning inherited command values.
#[tauri::command]
pub(crate) fn get_fmg_browser_config(app: AppHandle) -> Result<FmgBrowserConfig, String> {
    let _guard = CONFIG_LOCK.lock().map_err(|error| error.to_string())?;
    load_config(&app)
}

/// Atomically save the browser settings applied to newly started local agents.
#[tauri::command]
pub(crate) fn set_fmg_browser_config(
    app: AppHandle,
    config: FmgBrowserConfig,
) -> Result<(), String> {
    let config = validate_config(config)?;
    let _guard = CONFIG_LOCK.lock().map_err(|error| error.to_string())?;
    let bytes = serde_json::to_vec_pretty(&config).map_err(|error| error.to_string())?;
    if bytes.len() > 8192 {
        return Err("Aside 설정 파일이 너무 큽니다".into());
    }
    crate::managed_agents::storage::atomic_write_json_restricted(&config_path(&app)?, &bytes)
}

/// Set the desktop-owned Aside command after user environment merging.
pub(crate) fn apply_browser_config(
    app: &AppHandle,
    command: &mut std::process::Command,
) -> Result<(), String> {
    let _guard = CONFIG_LOCK.lock().map_err(|error| error.to_string())?;
    apply_browser_config_at(
        &config_path(app)?,
        command,
        std::env::var(ASIDE_BROWSER_COMMAND_ENV).ok(),
    )
}

fn apply_browser_config_at(
    path: &std::path::Path,
    command: &mut std::process::Command,
    inherited: Option<String>,
) -> Result<(), String> {
    let config = load_config_at(path)?;
    let resolved = effective_command(&config, inherited);
    if let Some(value) = resolved {
        command.env(ASIDE_BROWSER_COMMAND_ENV, value);
    } else {
        command.env_remove(ASIDE_BROWSER_COMMAND_ENV);
    }
    Ok(())
}

/// Return the FMG capabilities configured for this desktop process.
#[tauri::command]
pub(crate) fn get_fmg_runtime_status(app: AppHandle) -> Result<FmgRuntimeStatus, String> {
    let _guard = CONFIG_LOCK.lock().map_err(|error| error.to_string())?;
    let config = load_config(&app)?;
    Ok(FmgRuntimeStatus {
        aside_browser_configured: effective_command(
            &config,
            std::env::var(ASIDE_BROWSER_COMMAND_ENV).ok(),
        )
        .is_some(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_disable_removes_merged_env_and_oversized_storage_fails() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("browser.json");
        let bytes = serde_json::to_vec(&FmgBrowserConfig {
            mode: BrowserMode::Disabled,
            command: String::new(),
        })
        .expect("json");
        crate::managed_agents::storage::atomic_write_json_restricted(&path, &bytes)
            .expect("persist");
        let mut command = std::process::Command::new("unused");
        command.env(ASIDE_BROWSER_COMMAND_ENV, "merged");
        apply_browser_config_at(&path, &mut command, Some("inherited".into())).expect("apply");
        let value = command
            .get_envs()
            .find(|(key, _)| *key == ASIDE_BROWSER_COMMAND_ENV)
            .expect("explicit removal")
            .1;
        assert!(value.is_none());
        std::fs::write(&path, vec![b' '; 8193]).expect("large file");
        assert!(apply_browser_config_at(&path, &mut command, None).is_err());
    }

    #[test]
    fn explicit_disable_overrides_environment_and_custom_preserves_spaces() {
        let temp = tempfile::tempdir().expect("tempdir");
        let exe = temp.path().join("aside browser.exe");
        std::fs::write(&exe, []).expect("file");
        let custom = validate_config(FmgBrowserConfig {
            mode: BrowserMode::Custom,
            command: exe.to_string_lossy().into_owned(),
        })
        .expect("valid config");
        assert_eq!(
            effective_command(&custom, Some("ambient".into())),
            Some(exe.to_string_lossy().into_owned())
        );
        let disabled = validate_config(FmgBrowserConfig {
            mode: BrowserMode::Disabled,
            command: "stale".into(),
        })
        .expect("disable");
        assert_eq!(disabled.command, "");
        assert_eq!(effective_command(&disabled, Some("ambient".into())), None);
        assert_eq!(
            effective_command(&FmgBrowserConfig::default(), Some("ambient".into())),
            Some("ambient".into())
        );
    }

    #[test]
    fn config_rejects_relative_paths_arguments_and_corrupt_storage() {
        for command in ["aside", "aside --mcp", "C:\\aside.exe\u{0} --anything"] {
            assert!(validate_config(FmgBrowserConfig {
                mode: BrowserMode::Custom,
                command: command.into()
            })
            .is_err());
        }
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("browser.json");
        assert!(load_config_at(&path).is_ok());
        std::fs::write(&path, "corrupt").expect("file");
        assert!(load_config_at(&path).is_err());
        std::fs::write(
            &path,
            serde_json::to_vec(&FmgBrowserConfig {
                mode: BrowserMode::Disabled,
                command: String::new(),
            })
            .expect("json"),
        )
        .expect("file");
        assert!(matches!(
            load_config_at(&path).expect("load").mode,
            BrowserMode::Disabled
        ));
    }
}
