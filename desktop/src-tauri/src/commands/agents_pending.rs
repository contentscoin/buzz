//! Retention-queue helpers for managed-agent lifecycle events: pending
//! upserts, NIP-09 tombstones, and NIP-IA archive requests. Split from
//! `agents.rs` (which mounts this as `mod pending`) purely along the
//! retention seam; every function runs inside the
//! `managed_agents_store_lock`-held body and NEVER across an `.await`.

use std::collections::HashSet;

use rusqlite::{params, OptionalExtension, TransactionBehavior};
use tauri::{AppHandle, Manager};

use crate::{app_state::AppState, managed_agents::ManagedAgentRecord};

/// Retain a freshly authored managed-agent event in the local store, flagged
/// for relay sync. MUST be called inside the `managed_agents_store_lock`-held
/// body after `save_managed_agents`, NEVER across an `.await`: it acquires
/// `state.keys` and a retention-db connection, both `std::sync` guards, and
/// drops them before returning.
///
/// Owner-authored, mirroring `commands::personas::retain_persona_pending`: the
/// owner keys sign, the d_tag is the agent's pubkey, so the coordinate is
/// `30177:<owner>:<agent_pubkey>`. The event content is the opt-IN
/// [`agent_event_content`] projection — the retention upsert's content-equality
/// guard compares this projection, so an operational start/stop that mutates
/// only runtime fields produces an identical row and never re-enqueues a
/// publish. Best-effort: a failure here is logged and swallowed so a retention
/// hiccup never blocks the disk-authoritative write.
pub(crate) fn retain_managed_agent_pending(
    app: &AppHandle,
    state: &AppState,
    record: &ManagedAgentRecord,
) {
    use crate::managed_agents::{reconcile::retain_agent_record, retention::open_retention_db};

    let result = (|| -> Result<(), String> {
        let scope = crate::managed_agents::retention::active_retention_scope(app, state)?;
        let conn = open_retention_db(&scope.db_path)?;
        // Shared engine with the boot-time reconcile: projection content diff
        // (no republish for runtime-only churn) + monotonic created_at bump
        // past the retained head (NIP-AP step 3).
        retain_agent_record(&conn, &scope.owner_keys, record).map(|_| ())
    })();
    if let Err(e) = result {
        eprintln!("buzz-desktop: agent-retain: {e}");
    }
}

/// Name of the scope-local SQLite table that journals committed agent
/// deletions until both relay effects are durably queued.
const DELETE_INTENT_TABLE: &str = "managed_agent_delete_intents";

/// Durable witness that an agent record is being deleted from one scoped
/// workspace. The row is written before the JSON record or key is removed and
/// is deleted in the same SQLite transaction that enqueues the kind:5 and
/// kind:9035 events.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ManagedAgentDeleteIntent {
    pub agent_pubkey: String,
    pub persona_id: Option<String>,
}

impl ManagedAgentDeleteIntent {
    pub(crate) fn new(agent_pubkey: &str, persona_id: Option<&str>) -> Self {
        Self {
            agent_pubkey: agent_pubkey.trim().to_ascii_lowercase(),
            persona_id: persona_id
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string),
        }
    }
}

fn ensure_delete_intent_table(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS {DELETE_INTENT_TABLE} (
             agent_pubkey TEXT PRIMARY KEY,
             persona_id TEXT
         );"
    ))
    .map_err(|error| format!("failed to create managed-agent delete journal: {error}"))
}

/// Stage one or more deletions durably before their local records or keys are
/// removed. A persona cascade stages the whole set in one transaction.
pub(crate) fn stage_managed_agent_delete_intents_at(
    db_path: &std::path::Path,
    intents: &[ManagedAgentDeleteIntent],
) -> Result<(), String> {
    use crate::managed_agents::retention::open_retention_db;

    if intents.is_empty() {
        return Ok(());
    }
    let mut conn = open_retention_db(db_path)?;
    ensure_delete_intent_table(&conn)?;
    let transaction = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("failed to begin managed-agent delete journal: {error}"))?;
    for intent in intents {
        transaction
            .execute(
                &format!(
                    "INSERT INTO {DELETE_INTENT_TABLE} (agent_pubkey, persona_id)
                     VALUES (?1, ?2)
                     ON CONFLICT(agent_pubkey) DO UPDATE SET
                         persona_id = excluded.persona_id"
                ),
                params![&intent.agent_pubkey, intent.persona_id.as_deref()],
            )
            .map_err(|error| {
                format!(
                    "failed to stage managed-agent deletion for {}: {error}",
                    intent.agent_pubkey
                )
            })?;
    }
    transaction
        .commit()
        .map_err(|error| format!("failed to commit managed-agent delete journal: {error}"))
}

fn load_managed_agent_delete_intents(
    conn: &rusqlite::Connection,
) -> Result<Vec<ManagedAgentDeleteIntent>, String> {
    ensure_delete_intent_table(conn)?;
    let mut statement = conn
        .prepare(&format!(
            "SELECT agent_pubkey, persona_id
             FROM {DELETE_INTENT_TABLE}
             ORDER BY agent_pubkey"
        ))
        .map_err(|error| format!("failed to read managed-agent delete journal: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok(ManagedAgentDeleteIntent {
                agent_pubkey: row.get(0)?,
                persona_id: row.get(1)?,
            })
        })
        .map_err(|error| format!("failed to query managed-agent delete journal: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to decode managed-agent delete journal: {error}"))
}

/// Remove staged intents whose local record is still live. Recovery makes this
/// decision from authoritative disk state, so an ambiguous write failure never
/// drops the only witness for a deletion that may actually have committed.
fn clear_managed_agent_delete_intents_at(
    db_path: &std::path::Path,
    agent_pubkeys: &[String],
) -> Result<(), String> {
    use crate::managed_agents::retention::open_retention_db;

    if agent_pubkeys.is_empty() {
        return Ok(());
    }
    let mut conn = open_retention_db(db_path)?;
    ensure_delete_intent_table(&conn)?;
    let transaction = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| {
            format!("failed to begin managed-agent delete-journal cleanup: {error}")
        })?;
    for pubkey in agent_pubkeys {
        transaction
            .execute(
                &format!("DELETE FROM {DELETE_INTENT_TABLE} WHERE agent_pubkey = ?1"),
                [pubkey.trim().to_ascii_lowercase()],
            )
            .map_err(|error| {
                format!("failed to clear managed-agent delete intent for {pubkey}: {error}")
            })?;
    }
    transaction
        .commit()
        .map_err(|error| format!("failed to commit managed-agent delete-journal cleanup: {error}"))
}

/// Scope-free core for the atomic purge-and-enqueue operation, so its
/// future-dated-head domination and durable intent consumption can be asserted
/// directly against a retention database.
///
/// Enqueues TWO durable effects for the deleted agent in ONE transaction: the
/// NIP-09 kind:5 tombstone AND the NIP-IA kind:9035 archive request that stops
/// the identity appearing in member pickers. They were previously two
/// independent best-effort calls — a crash between them could tombstone the
/// 30177 head while leaving the identity live, with no boot path to reconstruct
/// the archive. The archive's `persona_id` comes from the staged delete intent,
/// falling back to the retained 30177 head for legacy callers. Managed-agent
/// heads cannot be swept by absence alone because another device may own the
/// local key; only this explicit journal authorizes boot-time recovery.
pub(crate) fn tombstone_managed_agent_at(
    db_path: &std::path::Path,
    keys: &nostr::Keys,
    agent_pubkey: &str,
    persona_id: Option<&str>,
) -> Result<(), String> {
    use crate::managed_agents::{
        agent_events::build_agent_delete,
        persona_events::monotonic_created_at,
        retention::{
            delete_retained_event, get_retained_event, open_retention_db, retain_event,
            tombstone_retention_d_tag, RetainedEvent,
        },
    };
    use buzz_core_pkg::kind::{KIND_IA_ARCHIVE_REQUEST, KIND_MANAGED_AGENT};
    use nostr::JsonUtil;

    const KIND_DELETE: u32 = 5;

    let owner_pubkey = keys.public_key().to_hex();
    let mut conn = open_retention_db(db_path)?;
    ensure_delete_intent_table(&conn)?;
    // Single transaction: a kill between the head purge and the tombstone
    // enqueue would otherwise leave the 30177 head live with no local retry
    // witness. Reading the head's `created_at` inside the same `BEGIN
    // IMMEDIATE` closes both the crash window and the read-then-sign race —
    // and lets the kind:5 be signed strictly past a future-dated head
    // (`retain_agent_record` bumps a same-second re-publish past the prior
    // head) so it cannot survive its own tombstone once the head row is
    // purged. Mirrors the persona/team tombstone helpers.
    let transaction = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| format!("failed to begin managed-agent tombstone transaction: {e}"))?;
    let result = (|| -> Result<(), String> {
        let prior_head = get_retained_event(
            &transaction,
            KIND_MANAGED_AGENT,
            &owner_pubkey,
            agent_pubkey,
        )?;
        let event = build_agent_delete(agent_pubkey, &owner_pubkey)?
            .custom_created_at(monotonic_created_at(
                prior_head.as_ref().map(|row| row.created_at),
            ))
            .sign_with_keys(keys)
            .map_err(|e| format!("failed to sign managed-agent tombstone: {e}"))?;
        // Prefer the command's staged record snapshot. The retained head is a
        // compatibility fallback for callers that predate the delete journal.
        let journal_persona_id = transaction
            .query_row(
                &format!("SELECT persona_id FROM {DELETE_INTENT_TABLE} WHERE agent_pubkey = ?1"),
                [agent_pubkey.trim().to_ascii_lowercase()],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|error| format!("failed to read managed-agent delete intent: {error}"))?
            .flatten();
        let persona_id = persona_id
            .map(str::to_string)
            .or(journal_persona_id)
            .or_else(|| {
                prior_head
                    .as_ref()
                    .and_then(|row| persona_id_from_head(&row.content))
            });
        let archive = build_agent_archive_request(keys, agent_pubkey, persona_id.as_deref())?;
        delete_retained_event(
            &transaction,
            KIND_MANAGED_AGENT,
            &owner_pubkey,
            agent_pubkey,
        )?;
        retain_event(
            &transaction,
            &RetainedEvent {
                kind: KIND_DELETE,
                pubkey: owner_pubkey.clone(),
                // Key by the target coordinate so cross-kind d-tag tombstones
                // occupy distinct rows (F2c).
                d_tag: tombstone_retention_d_tag(KIND_MANAGED_AGENT, agent_pubkey),
                content: event.content.to_string(),
                created_at: event.created_at.as_secs() as i64,
                raw_event: event.as_json(),
                pending_sync: true,
            },
        )?;
        retain_event(
            &transaction,
            &RetainedEvent {
                kind: KIND_IA_ARCHIVE_REQUEST,
                pubkey: owner_pubkey.clone(),
                d_tag: agent_pubkey.to_string(),
                content: archive.content.to_string(),
                created_at: archive.created_at.as_secs() as i64,
                raw_event: archive.as_json(),
                pending_sync: true,
            },
        )?;
        transaction
            .execute(
                &format!("DELETE FROM {DELETE_INTENT_TABLE} WHERE agent_pubkey = ?1"),
                [agent_pubkey.trim().to_ascii_lowercase()],
            )
            .map_err(|error| format!("failed to complete managed-agent delete intent: {error}"))?;
        Ok(())
    })();
    match result {
        Ok(()) => transaction
            .commit()
            .map_err(|e| format!("failed to commit managed-agent tombstone transaction: {e}")),
        Err(e) => Err(e),
    }
}

/// Finish an already committed local deletion. The journal row remains until
/// both key removal and the atomic relay enqueue succeed, so every error is
/// safe to retry at boot.
pub(crate) fn finalize_managed_agent_deletion_at(
    db_path: &std::path::Path,
    keys: &nostr::Keys,
    intent: &ManagedAgentDeleteIntent,
    delete_key: impl FnOnce(&str) -> Result<(), String>,
) -> Result<(), String> {
    delete_key(&intent.agent_pubkey).map_err(|error| {
        format!(
            "failed to delete agent {} key: {error}",
            intent.agent_pubkey
        )
    })?;
    tombstone_managed_agent_at(
        db_path,
        keys,
        &intent.agent_pubkey,
        intent.persona_id.as_deref(),
    )
}

/// Replay durable delete intents for the active workspace at boot.
///
/// A live local record means the command crashed or failed before its
/// authoritative JSON save, so the staged intent is discarded. An absent
/// record means deletion committed: retry key removal and atomically enqueue
/// the tombstone/archive before clearing the intent.
pub(crate) fn recover_managed_agent_delete_intents_at(
    db_path: &std::path::Path,
    keys: &nostr::Keys,
    live_pubkeys: &HashSet<String>,
    mut delete_key: impl FnMut(&str) -> Result<(), String>,
) -> Result<u32, String> {
    use crate::managed_agents::retention::open_retention_db;

    let conn = open_retention_db(db_path)?;
    let intents = load_managed_agent_delete_intents(&conn)?;
    drop(conn);

    let mut recovered = 0;
    let mut errors = Vec::new();
    for intent in intents {
        if live_pubkeys.contains(&intent.agent_pubkey) {
            if let Err(error) = clear_managed_agent_delete_intents_at(
                db_path,
                std::slice::from_ref(&intent.agent_pubkey),
            ) {
                errors.push(error);
            }
            continue;
        }
        match finalize_managed_agent_deletion_at(db_path, keys, &intent, |pubkey| {
            delete_key(pubkey)
        }) {
            Ok(()) => recovered += 1,
            Err(error) => errors.push(format!(
                "failed to recover deletion for {}: {error}",
                intent.agent_pubkey
            )),
        }
    }

    if errors.is_empty() {
        Ok(recovered)
    } else {
        Err(format!(
            "managed-agent deletion recovery incomplete; durable intents retained: {}",
            errors.join("; ")
        ))
    }
}

/// App-backed boot seam used by event sync after the workspace relay and owner
/// have been applied and while the workspace apply lock is still held.
pub(crate) fn recover_managed_agent_delete_intents(
    app: &AppHandle,
    keys: &nostr::Keys,
    db_path: &std::path::Path,
) -> Result<u32, String> {
    let state = app.state::<AppState>();
    let _store_guard = state
        .managed_agents_store_lock
        .lock()
        .map_err(|error| error.to_string())?;
    let live_pubkeys = crate::managed_agents::load_managed_agents(app)?
        .into_iter()
        .map(|record| record.pubkey.to_ascii_lowercase())
        .collect();
    recover_managed_agent_delete_intents_at(db_path, keys, &live_pubkeys, |pubkey| {
        crate::managed_agents::try_delete_agent_key(pubkey)
    })
}

/// Extract `persona_id` from a retained kind:30177 head's content projection.
/// Absent (definition-less agent) or unparseable content yields `None`, so the
/// archive request falls back to an empty payload — exactly what the record's
/// `None` persona_id produced before this was derived from the head.
fn persona_id_from_head(content: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(content)
        .ok()?
        .get("persona_id")?
        .as_str()
        .map(str::to_owned)
}

/// Build an owner-authenticated NIP-IA `kind:9035` archive request for a deleted agent.
/// Definition-linked agents carry the persona id in `content`, where it survives the
/// kind:30177 tombstone as owner-signed historical alias data. The request uses the
/// same builder as the GUI Archive action and the NIP-IA `retired` reason.
pub(crate) fn build_agent_archive_request(
    keys: &nostr::Keys,
    agent_pubkey: &str,
    persona_id: Option<&str>,
) -> Result<nostr::Event, String> {
    let auth_tag = if keys
        .public_key()
        .to_hex()
        .eq_ignore_ascii_case(agent_pubkey)
    {
        None
    } else {
        let agent = nostr::PublicKey::from_hex(agent_pubkey)
            .map_err(|e| format!("invalid agent pubkey: {e}"))?;
        let tag_json = buzz_sdk_pkg::nip_oa::compute_auth_tag(keys, &agent, "")
            .map_err(|e| format!("failed to build owner auth tag: {e}"))?;
        let parts: Vec<String> = serde_json::from_str(&tag_json)
            .map_err(|e| format!("failed to parse owner auth tag: {e}"))?;
        Some(
            <[String; 4]>::try_from(parts)
                .map_err(|_| "owner auth tag must have four elements".to_string())?,
        )
    };
    let content = persona_id
        .filter(|id| !id.trim().is_empty())
        .map(|id| serde_json::json!({ "persona_id": id }).to_string())
        .unwrap_or_default();
    crate::events::build_archive_identity_request(
        agent_pubkey,
        &content,
        Some("retired"),
        None,
        auth_tag.as_ref(),
    )?
    .sign_with_keys(keys)
    .map_err(|e| format!("failed to sign archive request: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::managed_agents::retention::{
        get_pending_sync, get_retained_event, open_retention_db, retain_event, RetainedEvent,
    };
    use buzz_core_pkg::kind::KIND_MANAGED_AGENT;

    // A valid 32-byte x-only pubkey hex — the folded archive request derives an
    // owner auth tag, which parses `agent_pubkey`, so it must be well-formed.
    const AGENT_PUBKEY: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    /// Seed a retained 30177 agent head dated `created_at` seconds since epoch.
    /// The tombstone helper reads only the head's `created_at`, so the content
    /// need not be a full agent projection.
    fn seed_agent_head(db_path: &std::path::Path, owner: &str, created_at: i64) {
        seed_agent_head_content(db_path, owner, created_at, r#"{"name":"Agent"}"#);
    }

    /// Like [`seed_agent_head`] but with explicit head `content`, so the
    /// archive-payload derivation from the head can be asserted.
    fn seed_agent_head_content(
        db_path: &std::path::Path,
        owner: &str,
        created_at: i64,
        content: &str,
    ) {
        let conn = open_retention_db(db_path).unwrap();
        retain_event(
            &conn,
            &RetainedEvent {
                kind: KIND_MANAGED_AGENT,
                pubkey: owner.to_string(),
                d_tag: AGENT_PUBKEY.to_string(),
                content: content.to_string(),
                created_at,
                raw_event: r#"{"id":"seed"}"#.to_string(),
                pending_sync: false,
            },
        )
        .unwrap();
    }

    #[test]
    fn agent_tombstone_created_at_strictly_dominates_a_future_dated_head() {
        // The retained 30177 head may be future-dated (retain_agent_record
        // bumps a same-second re-publish past the prior head). The relay only
        // soft-deletes coordinate versions with created_at <= the tombstone's,
        // and the flush loop never re-reads the (purged) head — so a kind:5
        // signed at wall-clock `now` would leave the agent live forever once
        // its local retry witness is gone.
        let dir = tempfile::tempdir().unwrap();
        let keys = nostr::Keys::generate();
        let owner = keys.public_key().to_hex();
        let db_path = dir.path().join("retention.sqlite3");

        let future = nostr::Timestamp::now().as_secs() as i64 + 86_400;
        seed_agent_head(&db_path, &owner, future);

        tombstone_managed_agent_at(&db_path, &keys, AGENT_PUBKEY, None).unwrap();

        let conn = open_retention_db(&db_path).unwrap();
        let tombstone = get_pending_sync(&conn)
            .unwrap()
            .into_iter()
            .find(|row| row.kind == 5)
            .expect("a kind:5 agent tombstone is enqueued");
        assert!(
            tombstone.created_at > future,
            "tombstone created_at ({}) must strictly dominate the future-dated head ({future})",
            tombstone.created_at
        );
        assert!(
            get_retained_event(&conn, KIND_MANAGED_AGENT, &owner, AGENT_PUBKEY)
                .unwrap()
                .is_none(),
            "the 30177 head is purged so no stale edit can republish it"
        );
    }

    #[test]
    fn agent_tombstone_rolls_back_head_purge_when_enqueue_fails() {
        // The head purge and kind:5 enqueue run in one `BEGIN IMMEDIATE`
        // transaction. A `BEFORE INSERT` trigger blocks the enqueue (which
        // follows the head DELETE); the whole transaction must roll back so the
        // 30177 head survives with its local retry witness intact.
        let dir = tempfile::tempdir().unwrap();
        let keys = nostr::Keys::generate();
        let owner = keys.public_key().to_hex();
        let db_path = dir.path().join("retention.sqlite3");

        let future = nostr::Timestamp::now().as_secs() as i64 + 86_400;
        seed_agent_head(&db_path, &owner, future);

        let conn = open_retention_db(&db_path).unwrap();
        conn.execute_batch(
            "CREATE TRIGGER block_all_inserts BEFORE INSERT ON persona_events
             BEGIN
                 SELECT RAISE(ABORT, 'insert blocked by test trigger');
             END;",
        )
        .unwrap();
        drop(conn);

        let err = tombstone_managed_agent_at(&db_path, &keys, AGENT_PUBKEY, None)
            .expect_err("tombstone with INSERT trigger must fail");
        assert!(
            err.contains("insert blocked by test trigger") || err.contains("blocked"),
            "error must name the trigger cause; got: {err}"
        );

        let conn = open_retention_db(&db_path).unwrap();
        assert!(
            get_retained_event(&conn, KIND_MANAGED_AGENT, &owner, AGENT_PUBKEY)
                .unwrap()
                .is_some(),
            "the 30177 head must survive when the tombstone enqueue fails"
        );
    }

    #[test]
    fn agent_tombstone_enqueues_archive_with_persona_id_from_head_atomically() {
        // FOLD-4: the kind:5 tombstone and the NIP-IA kind:9035 archive request
        // are enqueued in ONE transaction, and the archive's `persona_id`
        // payload is derived from the retained 30177 head's content (not the
        // already-deleted record). Both rows must be present and pending after
        // a successful tombstone.
        use buzz_core_pkg::kind::KIND_IA_ARCHIVE_REQUEST;

        let dir = tempfile::tempdir().unwrap();
        let keys = nostr::Keys::generate();
        let owner = keys.public_key().to_hex();
        let db_path = dir.path().join("retention.sqlite3");

        let now = nostr::Timestamp::now().as_secs() as i64;
        seed_agent_head_content(
            &db_path,
            &owner,
            now,
            r#"{"name":"Agent","persona_id":"persona-abc"}"#,
        );

        tombstone_managed_agent_at(&db_path, &keys, AGENT_PUBKEY, None).unwrap();

        let conn = open_retention_db(&db_path).unwrap();
        let pending = get_pending_sync(&conn).unwrap();
        assert!(
            pending.iter().any(|row| row.kind == 5),
            "a kind:5 tombstone is enqueued"
        );
        let archive = pending
            .iter()
            .find(|row| row.kind == KIND_IA_ARCHIVE_REQUEST)
            .expect("a kind:9035 archive request is enqueued in the same transaction");
        assert!(
            archive.content.contains("persona-abc"),
            "archive payload derives persona_id from the retained head; got: {}",
            archive.content
        );
    }

    #[test]
    fn agent_tombstone_rolls_back_kind5_when_archive_enqueue_fails() {
        // FOLD-4 atomicity: the kind:5 tombstone and kind:9035 archive share one
        // `BEGIN IMMEDIATE`. A trigger blocks ONLY the 9035 insert (which
        // follows the kind:5 insert); the whole transaction must roll back so
        // NEITHER the tombstone nor a purged head is left behind. Splitting the
        // two enqueues into separate transactions turns this RED — the kind:5
        // would commit and the head would be gone while the archive is lost.
        use buzz_core_pkg::kind::KIND_MANAGED_AGENT;

        let dir = tempfile::tempdir().unwrap();
        let keys = nostr::Keys::generate();
        let owner = keys.public_key().to_hex();
        let db_path = dir.path().join("retention.sqlite3");

        let now = nostr::Timestamp::now().as_secs() as i64;
        seed_agent_head(&db_path, &owner, now);

        let conn = open_retention_db(&db_path).unwrap();
        conn.execute_batch(
            "CREATE TRIGGER block_archive_insert BEFORE INSERT ON persona_events
             WHEN NEW.kind = 9035
             BEGIN
                 SELECT RAISE(ABORT, 'archive insert blocked by test trigger');
             END;",
        )
        .unwrap();
        drop(conn);

        let err = tombstone_managed_agent_at(&db_path, &keys, AGENT_PUBKEY, None)
            .expect_err("tombstone must fail when the archive enqueue is blocked");
        assert!(
            err.contains("archive insert blocked") || err.contains("blocked"),
            "error must name the trigger cause; got: {err}"
        );

        let conn = open_retention_db(&db_path).unwrap();
        assert!(
            get_retained_event(&conn, KIND_MANAGED_AGENT, &owner, AGENT_PUBKEY)
                .unwrap()
                .is_some(),
            "the 30177 head must survive — the whole transaction rolls back"
        );
        assert!(
            get_pending_sync(&conn)
                .unwrap()
                .iter()
                .all(|row| row.kind != 5),
            "no kind:5 tombstone may be committed when the archive enqueue fails"
        );
    }

    #[test]
    fn failed_archive_enqueue_keeps_intent_for_boot_recovery() {
        use buzz_core_pkg::kind::KIND_IA_ARCHIVE_REQUEST;

        let dir = tempfile::tempdir().unwrap();
        let keys = nostr::Keys::generate();
        let owner = keys.public_key().to_hex();
        let db_path = dir.path().join("retention.sqlite3");
        seed_agent_head(&db_path, &owner, nostr::Timestamp::now().as_secs() as i64);
        stage_managed_agent_delete_intents_at(
            &db_path,
            &[ManagedAgentDeleteIntent::new(
                AGENT_PUBKEY,
                Some("persona-from-intent"),
            )],
        )
        .unwrap();

        let conn = open_retention_db(&db_path).unwrap();
        conn.execute_batch(
            "CREATE TRIGGER block_archive_insert BEFORE INSERT ON persona_events
             WHEN NEW.kind = 9035
             BEGIN
                 SELECT RAISE(ABORT, 'archive insert blocked by recovery test');
             END;",
        )
        .unwrap();
        drop(conn);

        tombstone_managed_agent_at(&db_path, &keys, AGENT_PUBKEY, None)
            .expect_err("the first enqueue is intentionally blocked");
        let conn = open_retention_db(&db_path).unwrap();
        assert_eq!(
            load_managed_agent_delete_intents(&conn).unwrap(),
            vec![ManagedAgentDeleteIntent::new(
                AGENT_PUBKEY,
                Some("persona-from-intent")
            )],
            "the failed transaction must retain its durable retry witness"
        );
        conn.execute_batch("DROP TRIGGER block_archive_insert;")
            .unwrap();
        drop(conn);

        let mut deleted_keys = Vec::new();
        let recovered =
            recover_managed_agent_delete_intents_at(&db_path, &keys, &HashSet::new(), |pubkey| {
                deleted_keys.push(pubkey.to_string());
                Ok(())
            })
            .unwrap();
        assert_eq!(recovered, 1);
        assert_eq!(deleted_keys, vec![AGENT_PUBKEY.to_string()]);

        let conn = open_retention_db(&db_path).unwrap();
        assert!(load_managed_agent_delete_intents(&conn).unwrap().is_empty());
        let archive = get_pending_sync(&conn)
            .unwrap()
            .into_iter()
            .find(|row| row.kind == KIND_IA_ARCHIVE_REQUEST)
            .expect("boot recovery enqueues the archive request");
        assert!(archive.content.contains("persona-from-intent"));
    }

    #[test]
    fn boot_recovery_discards_staged_intent_when_record_is_still_live() {
        let dir = tempfile::tempdir().unwrap();
        let keys = nostr::Keys::generate();
        let db_path = dir.path().join("retention.sqlite3");
        stage_managed_agent_delete_intents_at(
            &db_path,
            &[ManagedAgentDeleteIntent::new(AGENT_PUBKEY, None)],
        )
        .unwrap();
        let live_pubkeys = HashSet::from([AGENT_PUBKEY.to_string()]);

        let recovered =
            recover_managed_agent_delete_intents_at(&db_path, &keys, &live_pubkeys, |_| {
                panic!("a live record must never lose its key during recovery")
            })
            .unwrap();

        assert_eq!(recovered, 0);
        let conn = open_retention_db(&db_path).unwrap();
        assert!(load_managed_agent_delete_intents(&conn).unwrap().is_empty());
        assert!(get_pending_sync(&conn).unwrap().is_empty());
    }

    #[test]
    fn key_deletion_failure_keeps_intent_and_skips_relay_enqueue() {
        let dir = tempfile::tempdir().unwrap();
        let keys = nostr::Keys::generate();
        let db_path = dir.path().join("retention.sqlite3");
        let intent = ManagedAgentDeleteIntent::new(AGENT_PUBKEY, Some("persona-key-failure"));
        stage_managed_agent_delete_intents_at(&db_path, std::slice::from_ref(&intent)).unwrap();

        let error = finalize_managed_agent_deletion_at(&db_path, &keys, &intent, |_| {
            Err("keyring unavailable".to_string())
        })
        .expect_err("keyring failure must fail the deletion finalizer");
        assert!(error.contains("keyring unavailable"));

        let conn = open_retention_db(&db_path).unwrap();
        assert_eq!(
            load_managed_agent_delete_intents(&conn).unwrap(),
            vec![intent],
            "the durable intent must survive a keyring failure"
        );
        assert!(
            get_pending_sync(&conn).unwrap().is_empty(),
            "relay deletion must not enqueue before key removal succeeds"
        );
    }
}
