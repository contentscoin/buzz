use std::path::Path;

/// Return the adapter install commands for a resolved runtime, or `None` when
/// the installed adapter is already usable. Missing adapters retain the
/// catalog-provided installation plan.
pub(super) fn plan_adapter_install<'c>(
    runtime_id: &str,
    adapter_path: Option<&Path>,
    adapter_install_commands: &'c [&'c str],
    adapter_probe_path: Option<&str>,
) -> Option<Vec<&'c str>> {
    match adapter_path {
        Some(_) if !matches!(runtime_id, "codex" | "claude") => None,
        Some(path)
            if !crate::managed_agents::cli_adapter_is_outdated_with_path(
                runtime_id,
                path,
                adapter_probe_path,
            ) =>
        {
            None
        }
        Some(_) if runtime_id == "codex" => Some(vec![
            "npm uninstall -g @zed-industries/codex-acp",
            "npm install -g @agentclientprotocol/codex-acp",
        ]),
        Some(_) if runtime_id == "claude" => Some(vec![
            "npm uninstall -g @zed-industries/claude-agent-acp @zed-industries/claude-code-acp",
            "npm install -g @agentclientprotocol/claude-agent-acp",
        ]),
        Some(_) => None,
        None => Some(adapter_install_commands.to_vec()),
    }
}
