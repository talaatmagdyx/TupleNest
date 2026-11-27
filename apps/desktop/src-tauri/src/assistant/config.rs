//! Assistant settings, and the Anthropic key's place in the keychain.
//!
//! The key is stored exactly as database passwords are: the value in the OS
//! keychain, an opaque `tn-secret-…` reference in `tuplenest.db`. The
//! reference never reaches the WebView — `AssistantSettingsOut` says only
//! whether a key is set — and `settings_get`/`settings_set` refuse the
//! settings key this lives under (see `main.rs`), so the WebView cannot point
//! the assistant at some other keychain entry, such as a database password,
//! and have it sent to api.anthropic.com as an API key.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tuplenest_credential_store::{CredentialStore, Secret};
use tuplenest_driver_api::SecretRef;
use tuplenest_workspace_store::Store;

use super::{anthropic, ollama};

/// The settings row. Reserved: only the assistant commands read or write it.
pub const SETTINGS_KEY: &str = "assistant";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Anthropic,
    Ollama,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AssistantConfig {
    /// Keychain reference for the Anthropic key. Never serialised to the WebView.
    pub anthropic_key_ref: Option<String>,
    pub ollama_enabled: bool,
    pub ollama_url: String,
    pub ollama_allow_remote: bool,
    pub default_provider: Option<Provider>,
    pub default_model: Option<String>,
}

impl Default for AssistantConfig {
    fn default() -> Self {
        Self {
            anthropic_key_ref: None,
            ollama_enabled: false,
            ollama_url: ollama::DEFAULT_URL.to_string(),
            ollama_allow_remote: false,
            default_provider: None,
            default_model: None,
        }
    }
}

/// What the WebView is told. No reference, no key.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantSettingsOut {
    pub anthropic_configured: bool,
    pub ollama_enabled: bool,
    pub ollama_url: String,
    pub ollama_allow_remote: bool,
    pub default_provider: Option<Provider>,
    pub default_model: Option<String>,
}

impl From<&AssistantConfig> for AssistantSettingsOut {
    fn from(c: &AssistantConfig) -> Self {
        Self {
            anthropic_configured: c.anthropic_key_ref.is_some(),
            ollama_enabled: c.ollama_enabled,
            ollama_url: c.ollama_url.clone(),
            ollama_allow_remote: c.ollama_allow_remote,
            default_provider: c.default_provider,
            default_model: c.default_model.clone(),
        }
    }
}

/// The fields the WebView may change.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantSettingsIn {
    pub ollama_enabled: bool,
    pub ollama_url: String,
    pub ollama_allow_remote: bool,
    pub default_provider: Option<Provider>,
    pub default_model: Option<String>,
}

fn lock(store: &Mutex<Store>) -> Result<std::sync::MutexGuard<'_, Store>, String> {
    store.lock().map_err(|_| "store lock poisoned".to_string())
}

pub fn load(store: &Mutex<Store>) -> Result<AssistantConfig, String> {
    Ok(lock(store)?
        .setting_get::<AssistantConfig>(SETTINGS_KEY)
        .map_err(|e| e.to_string())?
        .unwrap_or_default())
}

fn save(store: &Mutex<Store>, c: &AssistantConfig) -> Result<(), String> {
    lock(store)?
        .setting_set(SETTINGS_KEY, c)
        .map_err(|e| e.to_string())
}

/// Apply the WebView's changes, refusing a non-loopback Ollama URL unless the
/// same update turns remote servers on.
pub fn update(store: &Mutex<Store>, input: AssistantSettingsIn) -> Result<AssistantConfig, String> {
    let url = ollama::validate_url(&input.ollama_url, input.ollama_allow_remote)?;
    if let (Some(p), Some(m)) = (input.default_provider, input.default_model.as_deref()) {
        let ok = match p {
            Provider::Anthropic => anthropic::is_known_model(m),
            Provider::Ollama => ollama::is_valid_model(m),
        };
        if !ok {
            return Err(format!("{m} is not a model this provider offers."));
        }
    }
    let mut c = load(store)?;
    c.ollama_enabled = input.ollama_enabled;
    c.ollama_url = url;
    c.ollama_allow_remote = input.ollama_allow_remote;
    c.default_provider = input.default_provider;
    c.default_model = input.default_model.filter(|m| !m.is_empty());
    save(store, &c)?;
    Ok(c)
}

/// Check the shape of a pasted key without sending it anywhere.
pub fn check_key(key: &str) -> Result<&str, String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("Paste an API key first.".into());
    }
    if key.len() > 512 || key.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("That does not look like an API key.".into());
    }
    Ok(key)
}

/// Store the key in the keychain and point the settings at it. A key that was
/// there before is deleted once the new one is in place.
///
/// The store is not locked while the keychain is called: a keychain call can
/// wait on a system prompt (see `pg::sweep_pending_secrets`).
pub fn save_key(
    store: &Mutex<Store>,
    keychain: &dyn CredentialStore,
    key: &str,
) -> Result<AssistantConfig, String> {
    let key = check_key(key)?;
    let new_ref = keychain.set(Secret::new(key)).map_err(|e| e.to_string())?;
    let mut c = match load(store) {
        Ok(c) => c,
        Err(e) => {
            let _ = keychain.delete(&new_ref);
            return Err(e);
        }
    };
    let old = c.anthropic_key_ref.replace(new_ref.key().to_string());
    if c.default_provider.is_none() {
        c.default_provider = Some(Provider::Anthropic);
        c.default_model = Some(anthropic::DEFAULT_MODEL.to_string());
    }
    if let Err(e) = save(store, &c) {
        // Nothing points at the new entry: do not leave it behind.
        let _ = keychain.delete(&new_ref);
        return Err(e);
    }
    if let Some(old) = old {
        let _ = keychain.delete(&SecretRef::new(old));
    }
    Ok(c)
}

/// Delete the key from the keychain and forget its reference.
pub fn remove_key(
    store: &Mutex<Store>,
    keychain: &dyn CredentialStore,
) -> Result<AssistantConfig, String> {
    let mut c = load(store)?;
    let Some(old) = c.anthropic_key_ref.take() else {
        return Ok(c);
    };
    keychain
        .delete(&SecretRef::new(old))
        .map_err(|e| e.to_string())?;
    if c.default_provider == Some(Provider::Anthropic) {
        c.default_provider = c.ollama_enabled.then_some(Provider::Ollama);
        c.default_model = None;
    }
    save(store, &c)?;
    Ok(c)
}

/// The stored key, for a request. Backend-only.
pub fn load_key(store: &Mutex<Store>, keychain: &dyn CredentialStore) -> Result<Secret, String> {
    let c = load(store)?;
    let r = c
        .anthropic_key_ref
        .ok_or("No Anthropic key is set. Add one in Settings › Assistant.")?;
    keychain.get(&SecretRef::new(r)).map_err(|_| {
        "The Anthropic key is missing from the keychain. Add it again in Settings › Assistant."
            .to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tuplenest_credential_store::MemoryStore;

    fn store() -> Mutex<Store> {
        Mutex::new(Store::open_in_memory().unwrap())
    }

    #[test]
    fn a_saved_key_lives_in_the_keychain_and_only_a_ref_in_settings() {
        let s = store();
        let kc = MemoryStore::new();
        let c = save_key(&s, &kc, "  sk-ant-test-123  ").unwrap();
        let r = c.anthropic_key_ref.clone().unwrap();
        assert!(r.starts_with("tn-secret-"));
        assert_eq!(
            kc.get(&SecretRef::new(r)).unwrap().expose(),
            "sk-ant-test-123"
        );
        // The row on disk holds the reference, not the value.
        let raw: serde_json::Value = s
            .lock()
            .unwrap()
            .setting_get(SETTINGS_KEY)
            .unwrap()
            .unwrap();
        assert!(!raw.to_string().contains("sk-ant-test-123"));
        // And the WebView's view holds neither.
        let out = serde_json::to_string(&AssistantSettingsOut::from(&c)).unwrap();
        assert!(!out.contains("tn-secret-"));
        assert!(!out.contains("sk-ant"));
        assert!(out.contains("\"anthropicConfigured\":true"));
        assert_eq!(c.default_provider, Some(Provider::Anthropic));
        assert_eq!(load_key(&s, &kc).unwrap().expose(), "sk-ant-test-123");
    }

    #[test]
    fn replacing_a_key_deletes_the_old_entry() {
        let s = store();
        let kc = MemoryStore::new();
        let first = save_key(&s, &kc, "sk-one")
            .unwrap()
            .anthropic_key_ref
            .unwrap();
        let second = save_key(&s, &kc, "sk-two")
            .unwrap()
            .anthropic_key_ref
            .unwrap();
        assert_ne!(first, second);
        assert!(kc.get(&SecretRef::new(first)).is_err());
        assert_eq!(load_key(&s, &kc).unwrap().expose(), "sk-two");
    }

    #[test]
    fn removing_the_provider_deletes_the_key() {
        let s = store();
        let kc = MemoryStore::new();
        let r = save_key(&s, &kc, "sk-gone")
            .unwrap()
            .anthropic_key_ref
            .unwrap();
        let c = remove_key(&s, &kc).unwrap();
        assert!(c.anthropic_key_ref.is_none());
        assert!(c.default_provider.is_none());
        assert!(kc.get(&SecretRef::new(r)).is_err());
        assert!(load_key(&s, &kc).unwrap_err().contains("No Anthropic key"));
        // Twice is fine.
        assert!(remove_key(&s, &kc).is_ok());
    }

    #[test]
    fn removing_the_key_falls_back_to_ollama_when_it_is_on() {
        let s = store();
        let kc = MemoryStore::new();
        save_key(&s, &kc, "sk-x").unwrap();
        update(
            &s,
            AssistantSettingsIn {
                ollama_enabled: true,
                ollama_url: "http://localhost:11434".into(),
                ollama_allow_remote: false,
                default_provider: Some(Provider::Anthropic),
                default_model: Some("claude-haiku-5-5".into()),
            },
        )
        .unwrap();
        let c = remove_key(&s, &kc).unwrap();
        assert_eq!(c.default_provider, Some(Provider::Ollama));
    }

    #[test]
    fn a_key_missing_from_the_keychain_says_so() {
        let s = store();
        let kc = MemoryStore::new();
        let r = save_key(&s, &kc, "sk-x")
            .unwrap()
            .anthropic_key_ref
            .unwrap();
        kc.delete(&SecretRef::new(r)).unwrap();
        assert!(load_key(&s, &kc)
            .unwrap_err()
            .contains("missing from the keychain"));
    }

    #[test]
    fn bad_keys_are_refused_before_the_keychain() {
        let s = store();
        let kc = MemoryStore::new();
        assert!(save_key(&s, &kc, "   ").is_err());
        assert!(save_key(&s, &kc, "sk ant").is_err());
        assert!(load(&s).unwrap().anthropic_key_ref.is_none());
    }

    #[test]
    fn a_remote_ollama_url_needs_the_switch() {
        let s = store();
        let input = |allow| AssistantSettingsIn {
            ollama_enabled: true,
            ollama_url: "http://gpu-box.lan:11434/".into(),
            ollama_allow_remote: allow,
            default_provider: Some(Provider::Ollama),
            default_model: Some("llama3.2".into()),
        };
        assert!(update(&s, input(false))
            .unwrap_err()
            .contains("not this computer"));
        assert_eq!(load(&s).unwrap().ollama_url, ollama::DEFAULT_URL);
        let c = update(&s, input(true)).unwrap();
        assert_eq!(c.ollama_url, "http://gpu-box.lan:11434");
    }

    #[test]
    fn an_unknown_default_model_is_refused() {
        let s = store();
        let err = update(
            &s,
            AssistantSettingsIn {
                ollama_enabled: false,
                ollama_url: ollama::DEFAULT_URL.into(),
                ollama_allow_remote: false,
                default_provider: Some(Provider::Anthropic),
                default_model: Some("gpt-9".into()),
            },
        )
        .unwrap_err();
        assert!(err.contains("gpt-9"));
    }

    #[test]
    fn defaults_point_at_local_ollama_and_nothing_configured() {
        let c = load(&store()).unwrap();
        assert_eq!(c, AssistantConfig::default());
        assert_eq!(c.ollama_url, "http://localhost:11434");
        assert!(!c.ollama_allow_remote);
    }
}
