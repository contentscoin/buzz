use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::workspace_owner_hex;
use crate::{app_state::AppState, managed_agents::*};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StopAllLocalManagedAgentsResult {
    stopped_agents: usize,
    remaining_runtimes: usize,
    failures: Vec<LocalStopFailure>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalStopFailure {
    name: String,
    error: String,
}

/// Explicit device-wide control. Ordinary per-community Stop stays pair-scoped.
#[tauri::command]
pub async fn stop_all_local_managed_agents(
    expected_relay_url: String,
    expected_signer_pubkey: String,
    app: AppHandle,
) -> Result<StopAllLocalManagedAgentsResult, String> {
    if expected_relay_url.trim().is_empty() || expected_signer_pubkey.trim().is_empty() {
        return Err("전체 중지에는 현재 커뮤니티와 소유자 확인이 필요합니다.".into());
    }
    let state = app.state::<AppState>();
    let _workspace = state.workspace_apply_lock.lock().await;
    crate::relay::bind_expected_relay_scope(
        Some(&expected_relay_url),
        crate::relay::relay_ws_url_with_override(&state),
    )?;
    crate::relay::assert_expected_signer(
        Some(&expected_signer_pubkey),
        &workspace_owner_hex(&state)?,
    )?;
    let stop_app = app.clone();
    tokio::task::spawn_blocking(move || {
        let state = stop_app.state::<AppState>();
        let _transition = state
            .managed_agent_runtime_transition
            .lock()
            .map_err(|e| e.to_string())?;
        let _store = state
            .managed_agents_store_lock
            .lock()
            .map_err(|e| e.to_string())?;
        let mut records = load_managed_agents(&stop_app)?;
        let mut runtimes = state
            .managed_agent_processes
            .lock()
            .map_err(|e| e.to_string())?;
        let local_keys: std::collections::HashSet<_> = records
            .iter()
            .filter(|record| record.backend == BackendKind::Local)
            .map(|record| record.pubkey.clone())
            .collect();
        state
            .managed_agent_paused_pubkeys
            .lock()
            .map_err(|e| e.to_string())?
            .extend(local_keys.iter().cloned());
        let mut stopped_agents = 0;
        let mut failures = Vec::new();
        let affected_keys: Vec<_> = runtimes
            .keys()
            .filter(|key| local_keys.contains(&key.pubkey))
            .cloned()
            .collect();
        for record in records
            .iter_mut()
            .filter(|record| local_keys.contains(&record.pubkey))
        {
            match stop_managed_agent_process(&stop_app, record, &mut runtimes) {
                Ok(()) => {
                    state.clear_agent_session_caches(&record.pubkey);
                    stopped_agents += 1;
                }
                Err(error) => failures.push(LocalStopFailure {
                    name: record.name.clone(),
                    error,
                }),
            }
        }
        // Recover current-instance children recorded on disk but absent from the map.
        for (path, receipt) in read_all_agent_runtime_receipts(&stop_app) {
            if local_keys.contains(&receipt.key.pubkey)
                && !runtimes.contains_key(&receipt.key)
                && valid_agent_runtime_receipt(&path, &receipt, &current_instance_id(&stop_app))
            {
                if let Err(error) = terminate_untracked_pair_runtime(&stop_app, &receipt.key) {
                    let name = records
                        .iter()
                        .find(|record| record.pubkey == receipt.key.pubkey)
                        .map(|record| record.name.clone())
                        .unwrap_or_default();
                    failures.push(LocalStopFailure { name, error });
                }
            }
        }
        // Report actual tracked children, including failed terminations on other relays.
        let tracked_remaining: usize = runtimes
            .iter_mut()
            .filter(|(key, _)| local_keys.contains(&key.pubkey))
            .map(|(_, runtime)| usize::from(!matches!(runtime.child.try_wait(), Ok(Some(_)))))
            .sum();
        let orphan_remaining = read_all_agent_runtime_receipts(&stop_app)
            .into_iter()
            .filter(|(path, receipt)| {
                local_keys.contains(&receipt.key.pubkey)
                    && !runtimes.contains_key(&receipt.key)
                    && valid_agent_runtime_receipt(path, receipt, &current_instance_id(&stop_app))
            })
            .count();
        let remaining_runtimes = tracked_remaining + orphan_remaining;
        save_managed_agents(&stop_app, &records)?;
        let _ = stop_app.emit("agents-data-changed", ());
        for key in affected_keys {
            if let Some(record) = records.iter().find(|record| record.pubkey == key.pubkey) {
                emit_managed_agent_runtime_change(&stop_app, record, &key, runtimes.get(&key));
            }
        }
        Ok(StopAllLocalManagedAgentsResult {
            stopped_agents,
            remaining_runtimes,
            failures,
        })
    })
    .await
    .map_err(|error| format!("device stop failed: {error}"))?
}
