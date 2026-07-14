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
}

#[tauri::command]
pub fn connection_save(
    state: tauri::State<'_, AppState>,
    input: ConnectionInput,
) -> Result<ConnectionRecord, String> {
    let store = state.store.lock().map_err(|_| "store lock poisoned")?;

    let id = input.id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let existing_ref = store
        .connection_get(&id)
        .map_err(|e| e.to_string())?
        .and_then(|c| c.secret_ref);

    // Password handling: new password → create or replace keychain entry;
    // no password → keep whatever reference the profile already had.
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
        _ => existing_ref,
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
        tls_mode: "disabled".into(), // Phase 0 PoC driver is NoTls; E1.2 adds TLS
        tls_ca_path: None,
        ssh_json: None,
        options_json: None,
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
pub fn connection_delete(state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    let secret_ref = state
        .store
        .lock()
        .map_err(|_| "store lock poisoned")?
        .connection_delete(&id)
        .map_err(|e| e.to_string())?;
    // Keychain cleanup: profile row is gone; remove the orphaned secret.
    if let Some(key) = secret_ref {
        KeychainStore::new()
            .delete(&SecretRef::new(key))
            .map_err(|e| e.to_string())?;
    }
    tracing::info!(component = "connections", id = %id, "profile deleted");
    Ok(())
}
