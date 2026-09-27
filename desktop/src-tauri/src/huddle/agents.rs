//! Agent enrollment for huddles.
//!
//! Mental model:
//!   add_agent_to_huddle → kind:9000 to ephemeral channel
//!                       → preserve existing parent membership, or
//!                         kind:9000 to parent channel (best-effort)
//!
//! ACP spawning is NOT needed here: the running agent process auto-subscribes
//! when it receives the kind:9000 membership notification. Huddle-specific
//! env vars (interrupt mode, custom system prompt) are a post-MVP enhancement.

use std::collections::HashSet;

use serde::Serialize;
use tauri::State;
use uuid::Uuid;

use crate::{
    app_state::AppState,
    events,
    huddle::relay_api::{validate_pubkey_hex, MAX_HUDDLE_AGENTS},
    relay::{query_relay_at_with_keys, submit_event_at_with_keys},
};

use super::{pipeline::start_auto_enabled_transcription, HuddlePhase};

// ── Constants ─────────────────────────────────────────────────────────────────

/// Voice-mode instructions posted as kind:48106 to the ephemeral channel at
/// huddle start. Agents load this event into the channel session system prompt.
///
/// Keep this deliberately short: the invariant that matters is that a directly
/// addressed user receives an immediate spoken response before any other work.
pub fn voice_mode_guidelines(parent_channel_id: &str) -> String {
    format!(
        "\
You are in a live voice huddle. Its attached main channel is {parent_channel_id}; that is not the live huddle channel.
The channel UUID in the current `[Context]` block is the live huddle channel. Only messages sent with `buzz messages send` to that current Context channel are spoken aloud, in the order sent; everything else you produce is silent.
When a user addresses you, your FIRST tool call must send a brief spoken reply to the current Context channel, before any file read, search, or other tool call. The usual rule against bare acknowledgments does not apply here; the pickup is the feedback that you heard them.
Then work, sending each useful sentence as its own message the moment it is ready—a few sentences per answer, not a monologue.
Speak plainly without markdown; post code or long detail to the attached main channel instead.
If you are not addressed, stay silent."
    )
}

// ── Agent enrollment ──────────────────────────────────────────────────────────

/// Result of adding an agent to a huddle.
///
/// **Invariant:** `ephemeral_added` is always `true` on success — the function
/// returns `Err` before constructing this struct if the ephemeral add fails.
/// The field exists for forward compatibility with future batch-add operations
/// where partial success may be meaningful.
///
/// `parent_added` reflects whether the parent already contained the agent or
/// the parent-channel add succeeded; `parent_error` carries the error string
/// when neither condition could be confirmed.
#[derive(Debug, Serialize)]
pub struct AgentAddResult {
    /// Always `true` — invariant guaranteed by [`add_agent_to_huddle`].
    pub ephemeral_added: bool,
    /// Whether the agent was also added to the parent channel (best-effort).
    pub parent_added: bool,
    /// Error from the parent-channel add, if it failed.
    pub parent_error: Option<String>,
}

/// Result of reconciling channel agent additions into the active Huddle.
#[derive(Debug, Serialize)]
pub struct AgentHuddleSyncResult {
    /// Whether `channel_id` belonged to the active Huddle.
    pub matched_active_huddle: bool,
    /// Agents newly enrolled in the Huddle's ephemeral channel.
    pub added: Vec<String>,
}

// Multiple frontend mutation paths can observe the same membership addition
// (for example, the member hook and the mention send flow). Serialize native
// reconciliation so they share the first result instead of racing duplicate
// membership events through a relay read that has not caught up yet.
static AGENT_SYNC_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Add an agent to both the ephemeral and parent huddle channels.
///
/// Returns `Err` only if the ephemeral-channel add fails (policy rejection or
/// network error). The parent-channel add is best-effort: failure is captured
/// in `AgentAddResult::parent_error` rather than propagated.
///
/// The running ACP process for this agent will auto-subscribe to the new
/// channel when it receives the kind:9000 membership notification.
pub async fn add_agent_to_huddle(
    ephemeral_channel_id: Uuid,
    parent_channel_id: Uuid,
    agent_pubkey: &str,
    state: &AppState,
    relay_base: &str,
    signing_keys: &nostr::Keys,
) -> Result<AgentAddResult, String> {
    // 1. Add agent to ephemeral channel (required — fail hard on rejection).
    let add_eph = events::build_add_member(ephemeral_channel_id, agent_pubkey, Some("bot"))?;
    submit_event_at_with_keys(add_eph, state, relay_base, signing_keys).await?;

    // 2. Preserve any active parent membership, regardless of role. Rewriting
    //    an existing DM member as `bot` is both unnecessary and forbidden for
    //    non-admins. Otherwise add the agent so it has full context.
    //    Best-effort: capture a real error but don't propagate it.
    let parent_channel_id_string = parent_channel_id.to_string();
    let parent_already_contains_agent = fetch_channel_members_with_roles_at(
        &parent_channel_id_string,
        state,
        relay_base,
        signing_keys,
    )
    .await
    .is_ok_and(|members| contains_member(&members, agent_pubkey));

    let (parent_added, parent_error) = if parent_already_contains_agent {
        (true, None)
    } else {
        let add_parent = events::build_add_member(parent_channel_id, agent_pubkey, Some("bot"))?;
        match submit_event_at_with_keys(add_parent, state, relay_base, signing_keys).await {
            Ok(_) => (true, None),
            Err(e) => {
                let active_after_error = fetch_channel_members_with_roles_at(
                    &parent_channel_id_string,
                    state,
                    relay_base,
                    signing_keys,
                )
                .await
                .is_ok_and(|members| contains_member(&members, agent_pubkey));
                if active_after_error {
                    (true, None)
                } else {
                    eprintln!("buzz-desktop: add agent to parent channel failed: {e}");
                    (false, Some(e))
                }
            }
        }
    };

    Ok(AgentAddResult {
        ephemeral_added: true,
        parent_added,
        parent_error,
    })
}

/// Reconcile explicitly added channel agents into the active Huddle.
///
/// The source channel may be either the Huddle's parent or its ephemeral chat.
/// Existing ephemeral membership is hydrated first so a mention sent from the
/// Huddle chat does not publish a duplicate membership event. Missing agents
/// are added through the same parent + ephemeral path as the Add agent picker.
pub(crate) async fn sync_agents_for_active_huddle(
    channel_id: &str,
    agent_pubkeys: Vec<String>,
    state: &AppState,
    relay_base: &str,
    signing_keys: &nostr::Keys,
) -> Result<AgentHuddleSyncResult, String> {
    let mut seen = HashSet::new();
    let mut requested = Vec::new();
    for pubkey in agent_pubkeys {
        let normalized = pubkey.to_ascii_lowercase();
        validate_pubkey_hex(&normalized)?;
        if seen.insert(normalized.clone()) {
            requested.push(normalized);
        }
    }
    if requested.is_empty() {
        return Ok(AgentHuddleSyncResult {
            matched_active_huddle: false,
            added: Vec::new(),
        });
    }
    let _sync_guard = AGENT_SYNC_LOCK.lock().await;

    let (ephemeral_channel_id, parent_channel_id, huddle_generation, state_agents) = {
        let huddle = state.huddle()?;
        if !matches!(huddle.phase, HuddlePhase::Connected | HuddlePhase::Active) {
            return Ok(AgentHuddleSyncResult {
                matched_active_huddle: false,
                added: Vec::new(),
            });
        }
        let ephemeral_channel_id = huddle
            .ephemeral_channel_id
            .clone()
            .ok_or("no ephemeral channel")?;
        let parent_channel_id = huddle
            .parent_channel_id
            .clone()
            .ok_or("no parent channel")?;
        if channel_id != ephemeral_channel_id && channel_id != parent_channel_id {
            return Ok(AgentHuddleSyncResult {
                matched_active_huddle: false,
                added: Vec::new(),
            });
        }
        let state_agents = huddle
            .agent_pubkeys
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        (
            ephemeral_channel_id,
            parent_channel_id,
            huddle.huddle_generation,
            state_agents,
        )
    };

    // Membership reads can lag a just-accepted write, so merge the relay view
    // with local state instead of allowing a stale snapshot to remove agents.
    let fresh_agents = fetch_channel_members_at(
        &ephemeral_channel_id,
        Some("bot"),
        state,
        relay_base,
        signing_keys,
    )
    .await
    .unwrap_or_default();
    let mut known_agents = HashSet::new();
    let mut merged_agents = Vec::new();
    for pubkey in state_agents.into_iter().chain(fresh_agents) {
        let normalized = pubkey.to_ascii_lowercase();
        if known_agents.insert(normalized.clone()) {
            merged_agents.push(normalized);
        }
    }
    let missing: Vec<String> = requested
        .into_iter()
        .filter(|pubkey| !known_agents.contains(pubkey))
        .collect();
    if known_agents.len() + missing.len() > MAX_HUDDLE_AGENTS {
        return Err(format!(
            "agent limit reached: {} requested with {} already present (max {})",
            missing.len(),
            known_agents.len(),
            MAX_HUDDLE_AGENTS
        ));
    }

    let ephemeral_uuid = Uuid::parse_str(&ephemeral_channel_id).map_err(|e| e.to_string())?;
    let parent_uuid = Uuid::parse_str(&parent_channel_id).map_err(|e| e.to_string())?;
    let mut added = Vec::new();
    for pubkey in missing {
        add_agent_to_huddle(
            ephemeral_uuid,
            parent_uuid,
            &pubkey,
            state,
            relay_base,
            signing_keys,
        )
        .await?;
        merged_agents.push(pubkey.clone());
        added.push(pubkey);
    }

    let (roster_changed, transcription_auto_enabled) = {
        let mut huddle = state.huddle()?;
        if !huddle.is_current_huddle(&ephemeral_channel_id, huddle_generation) {
            return Ok(AgentHuddleSyncResult {
                matched_active_huddle: true,
                added,
            });
        }
        let mut roster_changed = false;
        {
            let mut current_agents = huddle
                .agent_pubkeys
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if *current_agents != merged_agents {
                *current_agents = merged_agents.clone();
                roster_changed = true;
            }
        }
        for pubkey in &merged_agents {
            if !huddle.participants.contains(pubkey) {
                huddle.participants.push(pubkey.clone());
                roster_changed = true;
            }
        }
        (
            roster_changed,
            huddle.maybe_auto_enable_transcription_for_agents(),
        )
    };

    if transcription_auto_enabled {
        start_auto_enabled_transcription(state, &ephemeral_channel_id).await;
    } else if roster_changed {
        state.emit_huddle_state_changed();
    }

    Ok(AgentHuddleSyncResult {
        matched_active_huddle: true,
        added,
    })
}

#[tauri::command]
pub async fn sync_agents_to_active_huddle(
    channel_id: String,
    agent_pubkeys: Vec<String>,
    expected_relay_url: Option<String>,
    expected_signer_pubkey: Option<String>,
    state: State<'_, AppState>,
) -> Result<AgentHuddleSyncResult, String> {
    let _workspace_guard = state.workspace_apply_lock.lock().await;
    let relay_base = crate::relay::relay_api_base_url_with_override(&state);
    crate::relay::assert_expected_relay_scope(expected_relay_url.as_deref(), &relay_base)?;
    let signing_keys = state.signing_keys()?;
    crate::relay::assert_expected_signer(
        expected_signer_pubkey.as_deref(),
        &signing_keys.public_key().to_hex(),
    )?;
    sync_agents_for_active_huddle(
        &channel_id,
        agent_pubkeys,
        &state,
        &relay_base,
        &signing_keys,
    )
    .await
}

async fn fetch_channel_members_with_roles_at(
    channel_id: &str,
    state: &AppState,
    relay_base: &str,
    signing_keys: &nostr::Keys,
) -> Result<Vec<(String, Option<String>)>, String> {
    let filter = serde_json::json!({
        "kinds": [39002],
        "#d": [channel_id],
        "limit": 1,
    });
    let events = query_relay_at_with_keys(
        state,
        relay_base,
        std::slice::from_ref(&filter),
        signing_keys,
        None,
    )
    .await
    .map_err(|error| {
        eprintln!("buzz-desktop: fetch channel members failed: {error}");
        error
    })?;

    let Some(event) = events.first() else {
        return Ok(Vec::new());
    };

    let mut seen = std::collections::BTreeSet::new();
    let mut members = Vec::new();
    for tag in event.tags.iter() {
        let slice = tag.as_slice();
        if slice.first().map(String::as_str) != Some("p") {
            continue;
        }
        let Some(pubkey) = slice.get(1) else {
            continue;
        };
        if pubkey.is_empty() || !seen.insert(pubkey.clone()) {
            continue;
        }
        let role = slice.get(3).filter(|role| !role.is_empty()).cloned();
        members.push((pubkey.clone(), role));
    }
    Ok(members)
}

async fn fetch_channel_members_at(
    channel_id: &str,
    role_filter: Option<&str>,
    state: &AppState,
    relay_base: &str,
    signing_keys: &nostr::Keys,
) -> Result<Vec<String>, String> {
    let all =
        fetch_channel_members_with_roles_at(channel_id, state, relay_base, signing_keys).await?;
    Ok(all
        .into_iter()
        .filter(|(_, role)| role_filter.is_none_or(|filter| role.as_deref() == Some(filter)))
        .map(|(pubkey, _)| pubkey)
        .collect())
}

fn contains_member(members: &[(String, Option<String>)], pubkey: &str) -> bool {
    members
        .iter()
        .any(|(member_pubkey, _)| member_pubkey.eq_ignore_ascii_case(pubkey))
}

#[cfg(test)]
mod tests {
    use super::{contains_member, voice_mode_guidelines};

    #[test]
    fn voice_mode_guidelines_pin_spoken_reply_as_first_tool_call() {
        let guidelines = voice_mode_guidelines("parent-channel");
        assert_eq!(guidelines.lines().count(), 6);
        assert!(guidelines.contains("Its attached main channel is parent-channel"));
        assert!(guidelines.contains("that is not the live huddle channel"));
        assert!(guidelines.contains("current `[Context]` block is the live huddle channel"));
        assert!(guidelines.contains("buzz messages send` to that current Context channel"));
        assert!(guidelines.contains("your FIRST tool call must send a brief spoken reply"));
        assert!(guidelines.contains("before any file read, search, or other tool call"));
        assert!(guidelines.contains("rule against bare acknowledgments does not apply here"));
    }

    #[test]
    fn existing_parent_membership_is_preserved_regardless_of_role() {
        let members = vec![
            ("agent-member".to_owned(), Some("member".to_owned())),
            ("agent-bot".to_owned(), Some("bot".to_owned())),
        ];

        assert!(contains_member(&members, "AGENT-MEMBER"));
        assert!(contains_member(&members, "agent-bot"));
        assert!(!contains_member(&members, "missing"));
    }
}
