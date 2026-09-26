use serde::Serialize;

const ASIDE_BROWSER_COMMAND_ENV: &str = "BUZZ_ACP_ASIDE_COMMAND";

/// Non-sensitive runtime capability flags for the FMG desktop surface.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FmgRuntimeStatus {
    aside_browser_configured: bool,
}

/// Return the FMG capabilities configured for this desktop process.
#[tauri::command]
pub(crate) fn get_fmg_runtime_status() -> FmgRuntimeStatus {
    FmgRuntimeStatus {
        aside_browser_configured: std::env::var(ASIDE_BROWSER_COMMAND_ENV)
            .is_ok_and(|command| !command.trim().is_empty()),
    }
}
