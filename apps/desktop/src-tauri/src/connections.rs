//! Saved connection profiles (Phase 1, E1.2).
//!
//! Profiles live in SQLite (workspace-store); passwords and SSH key
//! passphrases live in the OS keychain. `connection_save` is the only path
//! that accepts either, and it immediately converts each into a keychain
//! reference. Deleting a profile also deletes its keychain entries.

use tuplenest_credential_store::{CredentialStore, KeychainStore, Secret};
use tuplenest_driver_api::SecretRef;
use tuplenest_workspace_store::ConnectionRecord;
use uuid::Uuid;

use crate::pg::SshParams;
use crate::AppState;

/// Payload from the WebView. `password` and `ssh_passphrase`, when present,
/// are consumed here and never stored or echoed back.
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
    /// SSH tunnel config as JSON (secret-free: key path, fingerprint and, for
    /// an encrypted key, the keychain ref of its passphrase — the same rules
    /// as `secret_ref` decide whether that ref is kept).
    pub ssh_json: Option<String>,
    /// One-time SSH key passphrase; replaced by a keychain ref before
    /// persisting. Defaulted so an older frontend keeps working.
    #[serde(default)]
    pub ssh_passphrase: Option<String>,
    /// Ceiling on one statement, in milliseconds; 0 means no limit. Defaulted
    /// so a profile saved by an older frontend keeps working.
    #[serde(default)]
    pub statement_timeout_ms: u64,
}

/// Which keychain entry holds a profile's secret once it is saved.
///
/// A typed value is written over the profile's own entry, or into a new one.
/// With nothing typed, a ref written this session (`adoptable`: a Test that
/// consumed the typed value) is adopted and the entry it replaces deleted, or
/// else the profile keeps the entry it had. The same rule for the password
/// and the SSH key passphrase.
fn settle_secret(
    keychain: &dyn CredentialStore,
    typed: Option<String>,
    adoptable: Option<String>,
    existing: Option<String>,
) -> Result<Option<String>, String> {
    match typed {
        Some(value) if !value.is_empty() => Ok(Some(match &existing {
            Some(key) => {
                let r = SecretRef::new(key.clone());
                keychain
                    .replace(&r, Secret::new(value))
                    .map_err(|e| e.to_string())?;
                key.clone()
            }
            None => keychain
                .set(Secret::new(value))
                .map_err(|e| e.to_string())?
                .key()
                .to_string(),
        })),
        _ => {
            // A fresh ref replacing an older one: remove the old entry rather
            // than leave an unreferenced secret in the keychain.
            if let (Some(new), Some(old)) = (&adoptable, &existing) {
                if new != old {
                    let _ = keychain.delete(&SecretRef::new(old.clone()));
                }
            }
            Ok(adoptable.or(existing))
        }
    }
}

fn parse_ssh(json: Option<&str>) -> Option<SshParams> {
    json.filter(|j| !j.trim().is_empty())
        .and_then(|j| serde_json::from_str::<SshParams>(j).ok())
}

#[tauri::command]
pub fn connection_save(
    state: tauri::State<'_, AppState>,
    pg: tauri::State<'_, crate::pg::PgState>,
    input: ConnectionInput,
) -> Result<ConnectionRecord, String> {
    let id = input.id.unwrap_or_else(|| Uuid::new_v4().to_string());
    // The store lock is held only to read and to write, never across the
    // keychain calls below: a keychain permission prompt held it for as long
    // as the prompt was open, and every history write (inside a running
    // query) and settings read waited behind it.
    let existing = state
        .store
        .lock()
        .map_err(|_| "store lock poisoned")?
        .connection_get(&id)
        .map_err(|e| e.to_string())?;
    let typed_password = input.password.as_deref().is_some_and(|p| !p.is_empty());
    let typed_passphrase = input
        .ssh_passphrase
        .as_deref()
        .is_some_and(|p| !p.is_empty());
    let existing_ssh = existing.as_ref().and_then(crate::pg::saved_ssh);
    let new_ssh = parse_ssh(input.ssh_json.as_deref());
    // Only a ref written this session may be adopted, as for the password.
    let adoptable_passphrase = new_ssh
        .as_ref()
        .and_then(SshParams::passphrase_key)
        .filter(|k| pg.is_fresh_secret(k))
        .map(str::to_owned);

    // A stored password is bound to the connection it was saved for (see
    // `pg::authorize_secret`): address *and* TLS mode, CA file and SSH hop.
    // Changing any of them without re-entering it would carry the password to
    // a different place — or to the same place over a weaker channel.
    if let Some(old) = &existing {
        let tls = |m: Option<&str>| {
            m.filter(|m| !m.is_empty())
                .unwrap_or("verify-full")
                .to_string()
        };
        let ca = |c: Option<&str>| c.filter(|c| !c.trim().is_empty()).map(str::to_string);
        let same_hop = SshParams::same_hop(existing_ssh.as_ref(), new_ssh.as_ref());
        let moved = old.host != input.host
            || old.port != input.port
            || old.database != input.database
            || old.username != input.username
            || tls(Some(&old.tls_mode)) != tls(input.tls_mode.as_deref())
            || ca(old.tls_ca_path.as_deref()) != ca(input.tls_ca_path.as_deref())
            || !same_hop;
        let carried = old.secret_ref.is_some()
            && !typed_password
            && !input
                .secret_ref
                .as_deref()
                .is_some_and(|k| pg.is_fresh_secret(k));
        if moved && carried {
            return Err(
                "Enter the password again: this profile now connects differently (server, user, TLS or SSH)."
                    .into(),
            );
        }
        // The passphrase is bound to the tunnel it opens: a different bastion,
        // SSH user or key file asks for it again.
        let passphrase_carried = existing_ssh
            .as_ref()
            .and_then(SshParams::passphrase_key)
            .is_some()
            && !typed_passphrase
            && adoptable_passphrase.is_none();
        if new_ssh.is_some() && !same_hop && passphrase_carried {
            return Err(
                "Enter the SSH key passphrase again: this profile's SSH tunnel changed (host, user, key or host key)."
                    .into(),
            );
        }
    }
    let existing_ref = existing.and_then(|c| c.secret_ref);
    let existing_passphrase = existing_ssh
        .as_ref()
        .and_then(SshParams::passphrase_key)
        .map(str::to_owned);
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
    let secret_ref = settle_secret(&keychain, input.password, adoptable, existing_ref)?;

    // The passphrase, by the same rule. The ref the WebView sent is never
    // stored as given: it is replaced by what was settled here.
    let ssh_json = match new_ssh {
        Some(mut ssh) => {
            ssh.passphrase_ref = settle_secret(
                &keychain,
                input.ssh_passphrase,
                adoptable_passphrase,
                existing_passphrase,
            )?;
            Some(serde_json::to_string(&ssh).map_err(|e| e.to_string())?)
        }
        None => {
            // No tunnel any more: its passphrase has nothing left to open.
            if let Some(old) = existing_passphrase {
                let _ = keychain.delete(&SecretRef::new(old));
            }
            input.ssh_json.filter(|s| !s.trim().is_empty())
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
        ssh_json,
        options_json: None,
        statement_timeout_ms: input.statement_timeout_ms,
    };
    state
        .store
        .lock()
        .map_err(|_| "store lock poisoned")?
        .connection_upsert(&record)
        .map_err(|e| e.to_string())?;
    // Saved: the refs are now bound to this profile's connection.
    if let Some(k) = &record.secret_ref {
        pg.bind_secret(k);
    }
    if let Some(k) = crate::pg::saved_ssh(&record)
        .as_ref()
        .and_then(SshParams::passphrase_key)
    {
        pg.bind_secret(k);
    }
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
    let (secret_ref, passphrase_ref, orphaned_cache) = {
        let store = state.store.lock().map_err(|_| "store lock poisoned")?;
        let key_of = |r: &tuplenest_workspace_store::ConnectionRecord| {
            crate::pg::cache_key(&r.username, &r.host, r.port, &r.database)
        };
        let doomed = store.connection_get(&id).map_err(|e| e.to_string())?;
        let passphrase_ref = doomed
            .as_ref()
            .and_then(crate::pg::saved_ssh)
            .and_then(|s| s.passphrase_key().map(str::to_owned));
        let doomed = doomed.map(|r| key_of(&r));
        let secret_ref = store.connection_delete(&id).map_err(|e| e.to_string())?;
        // Another profile may point at the same database; its cache stays.
        let still_used = |k: &String| {
            store
                .connection_list()
                .map(|all| all.iter().any(|r| &key_of(r) == k))
                .unwrap_or(true)
        };
        (
            secret_ref,
            passphrase_ref,
            doomed.filter(|k| !still_used(k)),
        )
    };
    if let Some(key) = orphaned_cache {
        pg.forget_cached_metadata(&key);
    }
    // Keychain cleanup: profile row is gone; remove its orphaned secrets.
    delete_secrets(&KeychainStore::new(), secret_ref, passphrase_ref)?;
    tracing::info!(component = "connections", id = %id, "profile deleted");
    Ok(())
}

/// Removes a deleted profile's password and SSH key passphrase entries.
fn delete_secrets(
    keychain: &dyn CredentialStore,
    secret_ref: Option<String>,
    passphrase_ref: Option<String>,
) -> Result<(), String> {
    // The same ref twice is one entry: delete it once.
    let passphrase_ref = passphrase_ref.filter(|p| secret_ref.as_ref() != Some(p));
    for key in secret_ref.into_iter().chain(passphrase_ref) {
        keychain
            .delete(&SecretRef::new(key))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;
    use tuplenest_credential_store::CredentialError;

    /// An in-memory keychain. Never the OS one.
    #[derive(Default)]
    struct FakeKeychain {
        entries: Mutex<HashMap<String, String>>,
        next: Mutex<u32>,
    }
    impl FakeKeychain {
        fn with(entries: &[(&str, &str)]) -> Self {
            let k = Self::default();
            for (key, value) in entries {
                k.entries
                    .lock()
                    .unwrap()
                    .insert(key.to_string(), value.to_string());
            }
            k
        }
        fn value(&self, key: &str) -> Option<String> {
            self.entries.lock().unwrap().get(key).cloned()
        }
        fn len(&self) -> usize {
            self.entries.lock().unwrap().len()
        }
    }
    impl CredentialStore for FakeKeychain {
        fn set(&self, secret: Secret) -> Result<SecretRef, CredentialError> {
            let mut n = self.next.lock().unwrap();
            *n += 1;
            let key = format!("tn-new-{n}");
            self.entries
                .lock()
                .unwrap()
                .insert(key.clone(), secret.expose().to_string());
            Ok(SecretRef::new(key))
        }
        fn replace(&self, r: &SecretRef, secret: Secret) -> Result<(), CredentialError> {
            self.entries
                .lock()
                .unwrap()
                .insert(r.key().to_string(), secret.expose().to_string());
            Ok(())
        }
        fn get(&self, r: &SecretRef) -> Result<Secret, CredentialError> {
            self.value(r.key())
                .map(Secret::new)
                .ok_or_else(|| CredentialError::NotFound(r.key().to_string()))
        }
        fn delete(&self, r: &SecretRef) -> Result<(), CredentialError> {
            self.entries.lock().unwrap().remove(r.key());
            Ok(())
        }
    }

    #[test]
    fn a_typed_secret_goes_into_a_new_entry_for_a_new_profile() {
        let k = FakeKeychain::default();
        let r = settle_secret(&k, Some("pp".into()), None, None).unwrap();
        assert_eq!(k.value(r.as_deref().unwrap()).as_deref(), Some("pp"));
    }

    #[test]
    fn a_typed_secret_overwrites_the_profiles_own_entry() {
        let k = FakeKeychain::with(&[("tn-old", "old")]);
        let r = settle_secret(&k, Some("new".into()), None, Some("tn-old".into())).unwrap();
        assert_eq!(r.as_deref(), Some("tn-old"));
        assert_eq!(k.value("tn-old").as_deref(), Some("new"));
        assert_eq!(k.len(), 1);
    }

    #[test]
    fn a_tested_entry_is_adopted_and_the_old_one_removed() {
        let k = FakeKeychain::with(&[("tn-old", "old"), ("tn-tested", "new")]);
        let r = settle_secret(&k, None, Some("tn-tested".into()), Some("tn-old".into())).unwrap();
        assert_eq!(r.as_deref(), Some("tn-tested"));
        assert_eq!(k.value("tn-old"), None);
    }

    #[test]
    fn nothing_typed_keeps_the_entry_the_profile_had() {
        let k = FakeKeychain::with(&[("tn-old", "old")]);
        let r = settle_secret(&k, Some(String::new()), None, Some("tn-old".into())).unwrap();
        assert_eq!(r.as_deref(), Some("tn-old"));
        assert_eq!(k.value("tn-old").as_deref(), Some("old"));
    }

    #[test]
    fn deleting_a_profile_removes_its_password_and_passphrase() {
        let k = FakeKeychain::with(&[("tn-pw", "a"), ("tn-pp", "b"), ("tn-other", "c")]);
        delete_secrets(&k, Some("tn-pw".into()), Some("tn-pp".into())).unwrap();
        assert_eq!(k.value("tn-pw"), None);
        assert_eq!(k.value("tn-pp"), None);
        assert_eq!(k.value("tn-other").as_deref(), Some("c"));
        // A profile with only a passphrase.
        let k = FakeKeychain::with(&[("tn-pp", "b")]);
        delete_secrets(&k, None, Some("tn-pp".into())).unwrap();
        assert_eq!(k.len(), 0);
    }
}
