use std::{process::Command, time::Duration};

use nostr::ToBech32;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::app_state::AppState;
use crate::managed_agents::retention::{active_retention_scope, RetentionScope};

/// Task and caller scope captured when the transition dialog is opened.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GraphTask {
    issue: String,
    repo_owner: String,
    repo_id: String,
    relay_url: String,
    signer_pubkey: String,
}

/// Verified causal graph state, independently of the project's NIP-34 status.
#[derive(Deserialize, Serialize)]
pub(crate) struct GraphContext {
    state: Option<String>,
    head: Option<String>,
}

/// A reviewed transition bound to its observed causal head.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GraphTransition {
    task: GraphTask,
    from: String,
    to: String,
    content: String,
    gate: Option<String>,
    expected_head: Option<String>,
}

fn same_scope(task: &GraphTask, scope: &RetentionScope) -> Result<(), String> {
    let normalize = |value: &str| {
        buzz_core_pkg::relay::normalize_relay_url(value).map_err(|error| error.to_string())
    };
    if normalize(&task.relay_url)? != normalize(&scope.relay_url)?
        || !task
            .signer_pubkey
            .eq_ignore_ascii_case(&scope.owner_keys.public_key().to_hex())
    {
        return Err("커뮤니티 또는 계정이 변경됐습니다. 작업을 다시 여세요".into());
    }
    Ok(())
}

fn validate_task(task: &GraphTask) -> Result<(), String> {
    for value in [&task.issue, &task.repo_owner, &task.signer_pubkey] {
        if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("작업 또는 계정 식별자가 올바르지 않습니다".into());
        }
    }
    if task.repo_id.is_empty()
        || task.repo_id.len() > 256
        || task.repo_id.chars().any(char::is_control)
    {
        return Err("저장소 식별자가 올바르지 않습니다".into());
    }
    Ok(())
}

fn command_for(task: &GraphTask, scope: &RetentionScope) -> Result<Command, String> {
    validate_task(task)?;
    same_scope(task, scope)?;
    // Never pass the user's signing key to a PATH-selected or user-controlled CLI.
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let directory = exe.parent().ok_or("앱 설치 경로를 찾지 못했습니다")?;
    let cli = directory.join(if cfg!(windows) { "buzz.exe" } else { "buzz" });
    if !cli.is_file() {
        return Err("내장 Buzz CLI를 찾지 못했습니다. 데스크톱 앱을 다시 설치하세요".into());
    }
    let mut command = Command::new(cli);
    command.current_dir(directory);
    command.env(
        "BUZZ_PRIVATE_KEY",
        scope
            .owner_keys
            .secret_key()
            .to_bech32()
            .map_err(|error| error.to_string())?,
    );
    command.env(
        "BUZZ_RELAY_URL",
        crate::relay::relay_http_base_url(&scope.relay_url),
    );
    command.env("BUZZ_TIMEOUT_SECS", "20");
    command.env("BUZZ_CONNECT_TIMEOUT_SECS", "10");
    for key in [
        "BUZZ_AUTH_TAG",
        "BUZZ_API_TOKEN",
        "BUZZ_DEV_PUBKEY",
        "NOSTR_PRIVATE_KEY",
        "BUZZ_GIT_ORIGIN_CHANNEL_ID",
    ] {
        command.env_remove(key);
    }
    command.args([
        "issues",
        "transition",
        "--issue",
        &task.issue,
        "--repo-owner",
        &task.repo_owner,
    ]);
    command.arg(format!("--repo-id={}", task.repo_id));
    Ok(command)
}

fn run(command: Command) -> Result<serde_json::Value, String> {
    let output = crate::managed_agents::output_with_timeout(command, Duration::from_secs(60))
        .ok_or(
        "작업 요청을 완료하지 못했습니다. 전송 여부가 불확실할 수 있으니 이력을 새로 확인하세요",
    )?;
    if !output.status.success() {
        // CLI errors are structured; do not return arbitrary child output or environment values.
        let error: serde_json::Value = serde_json::from_slice(&output.stderr).unwrap_or_default();
        let message = error
            .get("message")
            .and_then(|value| value.as_str())
            .or_else(|| {
                error
                    .get("error")
                    .and_then(|value| value.get("message"))
                    .and_then(|value| value.as_str())
            })
            .unwrap_or(
                "그래프 검증 또는 전송에 실패했습니다. 작업 권한·의존성·연결 상태를 확인하세요",
            );
        return Err(message.chars().take(1024).collect());
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|_| "작업 응답을 읽지 못했습니다. 이력을 새로 확인하세요".into())
}

/// Inspect graph state through the packaged CLI's complete transition preflight.
#[tauri::command]
pub(crate) async fn get_fmg_graph_context(
    app: AppHandle,
    state: State<'_, AppState>,
    task: GraphTask,
) -> Result<GraphContext, String> {
    let scope = {
        let _guard = state.workspace_apply_lock.lock().await;
        active_retention_scope(&app, &state)?
    };
    let mut command = command_for(&task, &scope)?;
    command.args([
        "--from",
        "pending",
        "--to",
        "in-progress",
        "--content",
        "Inspect graph context",
        "--inspect",
    ]);
    tokio::task::spawn_blocking(move || {
        serde_json::from_value(run(command)?).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Publish only after the CLI rechecks authorization, dependencies and causal head.
#[tauri::command]
pub(crate) async fn transition_fmg_graph_task(
    app: AppHandle,
    state: State<'_, AppState>,
    transition: GraphTransition,
) -> Result<serde_json::Value, String> {
    if transition.content.trim().is_empty()
        || transition.content.trim() == "-"
        || transition.content.len() > 16 * 1024
        || transition.content.chars().count() > 4096
    {
        return Err("전환 사유를 1~4096자로 입력하세요".into());
    }
    for slug in [&transition.from, &transition.to]
        .into_iter()
        .chain(transition.gate.as_ref())
    {
        if slug.len() > 64
            || !slug
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        {
            return Err(
                "상태·검증 항목은 영문 소문자·숫자·하이픈으로 64자 이내로 입력하세요".into(),
            );
        }
    }
    if transition
        .expected_head
        .as_ref()
        .is_some_and(|head| head.len() != 64 || !head.bytes().all(|byte| byte.is_ascii_hexdigit()))
    {
        return Err("전환 이력 식별자가 올바르지 않습니다".into());
    }
    let scope = {
        let _guard = state.workspace_apply_lock.lock().await;
        active_retention_scope(&app, &state)?
    };
    let mut command = command_for(&transition.task, &scope)?;
    command.args([
        format!("--from={}", transition.from),
        format!("--to={}", transition.to),
        format!("--content={}", transition.content),
    ]);
    command.args([
        "--expected-head",
        transition.expected_head.as_deref().unwrap_or("initial"),
    ]);
    if let Some(gate) = transition.gate.as_deref().filter(|value| !value.is_empty()) {
        command.arg(format!("--gate={gate}"));
    }
    tokio::task::spawn_blocking(move || {
        let response = run(command)?;
        validate_receipt(&response)?;
        Ok(response)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn validate_receipt(response: &serde_json::Value) -> Result<(), String> {
    let event_id = response.get("event_id").and_then(|value| value.as_str());
    if response.get("accepted").and_then(|value| value.as_bool()) != Some(true)
        || !event_id
            .is_some_and(|id| id.len() == 64 && id.bytes().all(|byte| byte.is_ascii_hexdigit()))
    {
        return Err("릴레이의 전환 승인 기록을 확인하지 못했습니다. 이력을 다시 확인하세요".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn receipt_requires_acceptance_and_an_event_id() {
        let id = "a".repeat(64);
        assert!(validate_receipt(&serde_json::json!({"accepted":true,"event_id":id})).is_ok());
        for response in [
            serde_json::json!({"accepted":false,"event_id":id}),
            serde_json::json!({"accepted":true}),
            serde_json::json!({"accepted":true,"event_id":"invalid"}),
        ] {
            assert!(validate_receipt(&response).is_err());
        }
    }

    #[test]
    fn scope_refuses_another_community_or_signer() {
        let keys = nostr::Keys::generate();
        let scope = RetentionScope {
            db_path: "unused".into(),
            relay_url: "wss://a.example".into(),
            owner_keys: keys.clone(),
        };
        let mut task = GraphTask {
            issue: "a".repeat(64),
            repo_owner: "b".repeat(64),
            repo_id: "repo".into(),
            relay_url: "wss://a.example/".into(),
            signer_pubkey: keys.public_key().to_hex(),
        };
        assert!(same_scope(&task, &scope).is_ok());
        task.relay_url = "wss://b.example".into();
        assert!(same_scope(&task, &scope).is_err());
        task.relay_url = scope.relay_url.clone();
        task.signer_pubkey = nostr::Keys::generate().public_key().to_hex();
        assert!(same_scope(&task, &scope).is_err());
    }
}
