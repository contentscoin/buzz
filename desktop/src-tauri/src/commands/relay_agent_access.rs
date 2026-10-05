//! Explicit owner consent for independently operated relay agents.
//! This publishes a public response policy; it never creates a local runtime.

use nostr::{EventBuilder, Kind, Tag};
use tauri::{AppHandle, State};

use crate::{app_state::AppState, managed_agents, nostr_convert, relay};

/// Publish owner-only mention consent after refreshing the exact identity.
/// Existing observed policies are not overwritten by this enrollment command.
#[tauri::command]
pub async fn allow_owned_relay_agent_mentions(
    pubkey: String,
    expected_relay_url: String,
    expected_signer_pubkey: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let _workspace_guard = state.workspace_apply_lock.lock().await;
    if expected_relay_url.trim().is_empty() || expected_signer_pubkey.trim().is_empty() {
        return Err("커뮤니티와 계정 연결이 준비되지 않았습니다".into());
    }
    let pubkey = nostr::PublicKey::from_hex(&pubkey)
        .map_err(|_| "에이전트 식별자가 올바르지 않습니다".to_string())?
        .to_hex();
    relay::bind_expected_relay_scope(
        Some(&expected_relay_url),
        relay::relay_ws_url_with_override(&state),
    )?;
    let keys = state.signing_keys()?;
    let owner =
        relay::bind_expected_signer(Some(&expected_signer_pubkey), keys.public_key().to_hex())?
            .as_str()
            .to_string();
    {
        let _store_guard = state
            .managed_agents_store_lock
            .lock()
            .map_err(|e| e.to_string())?;
        if managed_agents::load_managed_agents(&app)?
            .iter()
            .any(|agent| agent.pubkey == pubkey)
        {
            return Err("이 기기에서 관리하는 에이전트는 편집 메뉴에서 권한을 설정하세요".into());
        }
    }
    let profiles = relay::query_relay(
        &state,
        &[serde_json::json!({
            "kinds": [0], "authors": [&pubkey], "limit": 1,
        })],
    )
    .await?;
    if nostr_convert::verified_agent_owners_from_profiles(&profiles).get(&pubkey) != Some(&owner) {
        return Err("현재 계정의 에이전트 소유권을 확인할 수 없습니다".into());
    }
    let policies = relay::query_relay(
        &state,
        &[serde_json::json!({
            "kinds": [30177], "authors": [&owner], "#d": [&pubkey], "limit": 1,
        })],
    )
    .await?;
    if !policies.is_empty() {
        let existing = nostr_convert::relay_agents_from_managed_agent_events(&policies, &profiles);
        return if existing.iter().any(|agent| {
            agent.pubkey == pubkey && agent.respond_to == Some(managed_agents::RespondTo::OwnerOnly)
        }) {
            Ok(())
        } else {
            Err("기존 응답 권한이 있습니다. 이 등록 메뉴로 덮어쓸 수 없습니다".into())
        };
    }
    let directories = relay::query_relay(
        &state,
        &[serde_json::json!({
            "kinds": [10100], "authors": [&pubkey], "limit": 1,
        })],
    )
    .await?;
    let agent = nostr_convert::relay_agents_from_directory_events(&directories, &[], &profiles)
        .into_iter()
        .find(|agent| agent.pubkey == pubkey)
        .ok_or_else(|| "에이전트 등록 정보를 확인할 수 없습니다".to_string())?;
    managed_agents::validate_managed_agent_definition_text(&agent.name, None, None)?;
    // The schema requires parallelism. This consent record does not assert or
    // alter the external process's concurrency, model, prompt or deployment.
    let content = managed_agents::agent_events::ManagedAgentEventContent {
        name: agent.name,
        persona_id: None,
        system_prompt: None,
        model: None,
        provider: None,
        persona_source_version: None,
        parallelism: 1,
        respond_to: managed_agents::RespondTo::OwnerOnly,
        respond_to_allowlist: Vec::new(),
    };
    let body = serde_json::to_string(&content).map_err(|e| e.to_string())?;
    let tag = Tag::parse(["d", pubkey.as_str()]).map_err(|e| e.to_string())?;
    let latest = relay::query_relay(
        &state,
        &[serde_json::json!({ "kinds": [30177], "authors": [&owner], "#d": [&pubkey], "limit": 1 })],
    ).await?;
    if !latest.is_empty() {
        return Err("응답 권한이 다른 연결에서 변경됐습니다. 목록을 새로 고침하세요".into());
    }
    // This relay has no cross-device CAS. Final revalidation still checks the
    // latest owner policy; enrollment is not atomic with another device's edit.
    relay::submit_event_with_keys(
        EventBuilder::new(Kind::Custom(30177), body).tags([tag]),
        &state,
        &keys,
        None,
    )
    .await?;
    // Verify visibility before acknowledging success; a lost response can be
    // retried because the latest identical owner-only policy is idempotent.
    let confirmed = relay::query_relay(
        &state,
        &[serde_json::json!({
            "kinds": [30177], "authors": [&owner], "#d": [&pubkey], "limit": 1,
        })],
    )
    .await?;
    let current_profiles = relay::query_relay(
        &state,
        &[serde_json::json!({ "kinds": [0], "authors": [&pubkey], "limit": 1 })],
    )
    .await?;
    let enrolled =
        nostr_convert::relay_agents_from_managed_agent_events(&confirmed, &current_profiles);
    if !enrolled.iter().any(|agent| {
        agent.pubkey == pubkey && agent.respond_to == Some(managed_agents::RespondTo::OwnerOnly)
    }) {
        return Err(
            "권한을 제출했지만 확인되지 않았습니다. 목록을 새로 고침한 뒤 다시 확인하세요".into(),
        );
    }
    Ok(())
}
