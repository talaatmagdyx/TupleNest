//! Saved connection profiles (Phase 1, E1.2).
//!
//! Profiles live in SQLite (workspace-store); passwords live in the OS
//! keychain. `connection_save` is the only path that accepts a password,
//! and it immediately converts it into a keychain reference. Deleting a
//! profile also deletes its keychain entry.

use tuplenest_credential_store::{CredentialStore, KeychainStore, Secret};
use tuplenest_driver_api::SecretRef;
use tuplenest_workspace_store::ConnectionRecord;
use uuid::Uuid;

use crate::AppState;

/// Payload from the WebView. `password`, when present, is consumed here
/// and never stored or echoed back.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInput {
    pub id: Option<String>,
    pub name: String,
    pub environment: Option<String>,
    pub color: Option<String>,
    #[serde(default)]
    pub read_only: bool,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    /// One-time password; replaced by a keychain ref before persisting.
    pub password: Option<String>,
    /// A keychain ref already created this session (e.g. by a prior Test that
    /// consumed the typed password). Adopted when no fresh password is sent, so
    /// the tested credential is kept rather than orphaned. (CRED-01.)
    pub secret_ref: Option<String>,
    /// "disabled" | "prefer" | "verify-ca" | "verify-full" (default).
    pub tls_mode: Option<String>,
    pub tls_ca_path: Option<String>,
    /// SSH tunnel config as JSON (secret-free: key path + fingerprint only).
    pub ssh_json: Option<String>,
    /// Ceiling on one statement, in milliseconds; 0 means no limit. Defaulted
    /// so a profile saved by an older frontend keeps working.
    #[serde(default)]
    pub statement_timeout_ms: u64,
}

#[tauri::command]
pub fn connection_save(
    state: tauri::State<'_, AppState>,
    pg: tauri::State<'_, crate::pg::PgState>,
    input: ConnectionInput,
) -> Result<ConnectionRecord, String> {
    let store = state.store.lock().map_err(|_| "store lock poisoned")?;

    let id = input.id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let existing = store.connection_get(&id).map_err(|e| e.to_string())?;
    let typed_password = input.password.as_deref().is_some_and(|p| !p.is_empty());

    // A stored password is bound to the server and user it was saved for (see
    // `pg::authorize_secret`). Moving a profile to another server or user
    // without re-entering it would carry the old password to the new place.
    if let Some(old) = &existing {
        let moved = old.host != input.host
            || old.port != input.port
            || old.database != input.database
            || old.username != input.username;
        let carried = old.secret_ref.is_some()
            && !typed_password
            && !input
                .secret_ref
                .as_deref()
                .is_some_and(|k| pg.is_fresh_secret(k));
        if moved && carried {
            return Err(
                "Enter the password again: this profile now points at a different server or user."
                    .into(),
            );
        }
    }
    let existing_ref = existing.and_then(|c| c.secret_ref);
    // Only a ref written this session (a Test with the typed password) may be
    // adopted; any other would let a profile claim another profile's secret.
    let adoptable = input
        .secret_ref
        .clone()
        .filter(|k| !k.is_empty() && pg.is_fresh_secret(k));

    // Password handling: new password → create or replace keychain entry;
    // no password → keep the profile's existing ref, or adopt one already
    // created this session (a prior Test), so it isn't orphaned.
    let keychain = KeychainStore::new();
    let secret_ref = match input.password {
        Some(pw) if !pw.is_empty() => Some(match &existing_ref {
            Some(key) => {
                let r = SecretRef::new(key.clone());
                keychain
                    .replace(&r, Secret::new(pw))
                    .map_err(|e| e.to_string())?;
                key.clone()
            }
            None => keychain
                .set(Secret::new(pw))
                .map_err(|e| e.to_string())?
                .key()
                .to_string(),
        }),
        _ => {
            // A fresh ref replacing an older one: remove the old entry rather
            // than leave an unreferenced password in the keychain.
            if let (Some(new), Some(old)) = (&adoptable, &existing_ref) {
                if new != old {
                    let _ = keychain.delete(&SecretRef::new(old.clone()));
                }
            }
            adoptable.or(existing_ref)
        }
    };

    let record = ConnectionRecord {
        id,
        name: input.name,
        driver: "postgres".into(),
        environment: input.environment,
        color: input.color,
        read_only: input.read_only,
        host: input.host,
        port: input.port,
        database: input.database,
        username: input.username,
        secret_ref,
        tls_mode: input.tls_mode.unwrap_or_else(|| "verify-full".into()),
        tls_ca_path: input.tls_ca_path,
        ssh_json: input.ssh_json.filter(|s| !s.trim().is_empty()),
        options_json: None,
        statement_timeout_ms: input.statement_timeout_ms,
    };
    store
        .connection_upsert(&record)
        .map_err(|e| e.to_string())?;
    tracing::info!(component = "connections", id = %record.id, "profile saved");
    Ok(record)
}

#[tauri::command]
pub fn connection_list(state: tauri::State<'_, AppState>) -> Result<Vec<ConnectionRecord>, String> {
    state
        .store
        .lock()
        .map_err(|_| "store lock poisoned")?
        .connection_list()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn connection_delete(
    state: tauri::State<'_, AppState>,
    pg: tauri::State<'_, crate::pg::PgState>,
    id: String,
) -> Result<(), String> {
    let (secret_ref, orphaned_cache) = {
        let store = state.store.lock().map_err(|_| "store lock poisoned")?;
        let key_of = |r: &tuplenest_workspace_store::ConnectionRecord| {
            crate::pg::cache_key(&r.username, &r.host, r.port, &r.database)
        };
        let doomed = store
            .connection_get(&id)
            .map_err(|e| e.to_string())?
            .map(|r| key_of(&r));
        let secret_ref = store.connection_delete(&id).map_err(|e| e.to_string())?;
        // Another profile may point at the same database; its cache stays.
        let still_used = |k: &String| {
            store
                .connection_list()
                .map(|all| all.iter().any(|r| &key_of(r) == k))
                .unwrap_or(true)
        };
        (secret_ref, doomed.filter(|k| !still_used(k)))
    };
    if let Some(key) = orphaned_cache {
        pg.forget_cached_metadata(&key);
    }
    // Keychain cleanup: profile row is gone; remove the orphaned secret.
    if let Some(key) = secret_ref {
        KeychainStore::new()
            .delete(&SecretRef::new(key))
            .map_err(|e| e.to_string())?;
    }
    tracing::info!(component = "connections", id = %id, "profile deleted");
    Ok(())
}
