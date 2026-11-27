//! The in-app assistant: Anthropic (the user's own key) or a local Ollama.
//!
//! Every request leaves from here, never from the WebView. The WebView sends
//! what the user typed and the editor text; this module adds the schema
//! digest of the live session's database, builds the prompt through
//! [`context`] — the one place the privacy rule is enforced — and streams the
//! answer back as `assistant:chunk` events. Nothing the assistant writes is
//! ever executed here: the WebView shows it, and only the user's Run sends a
//! statement to the database, through the same guard and audit paths as any
//! other.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tauri::{Emitter, Manager};
use tokio::sync::Notify;

pub mod anthropic;
pub mod config;
pub mod context;
pub mod http;
pub mod ollama;
pub mod stream;

use config::{AssistantSettingsIn, AssistantSettingsOut, Provider};
use context::AskInput;

/// The event each piece of an answer arrives on.
pub const CHUNK_EVENT: &str = "assistant:chunk";

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Chunk<'a> {
    id: &'a str,
    text: &'a str,
}

/// Requests in flight, by the id the WebView gave them, for Cancel.
#[derive(Default)]
pub struct AssistantState {
    running: Mutex<HashMap<String, Arc<Notify>>>,
}

impl AssistantState {
    fn start(&self, id: &str) -> Result<Arc<Notify>, String> {
        let mut map = self.running.lock().map_err(|_| "assistant lock poisoned")?;
        if map.contains_key(id) {
            return Err("That request is already running.".into());
        }
        let n = Arc::new(Notify::new());
        map.insert(id.to_string(), n.clone());
        Ok(n)
    }

    fn finish(&self, id: &str) {
        if let Ok(mut map) = self.running.lock() {
            map.remove(id);
        }
    }

    fn cancel(&self, id: &str) -> bool {
        match self.running.lock() {
            Ok(map) => map.get(id).map(|n| n.notify_one()).is_some(),
            Err(_) => false,
        }
    }
}

fn valid_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 64
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("bad request id".into());
    }
    Ok(())
}

async fn blocking<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())?
}

fn keychain() -> tuplenest_credential_store::KeychainStore {
    tuplenest_credential_store::KeychainStore::new()
}

#[tauri::command]
pub fn assistant_settings_get(
    app: tauri::State<'_, crate::AppState>,
) -> Result<AssistantSettingsOut, String> {
    Ok((&config::load(&app.store)?).into())
}

#[tauri::command]
pub fn assistant_settings_set(
    app: tauri::State<'_, crate::AppState>,
    settings: AssistantSettingsIn,
) -> Result<AssistantSettingsOut, String> {
    Ok((&config::update(&app.store, settings)?).into())
}

/// Store the Anthropic key in the OS keychain. Besides `pg_secret_save` and
/// `connection_save`, the only command that ever receives a secret; it is not
/// logged and not returned.
#[tauri::command]
pub async fn assistant_key_save(
    app: tauri::AppHandle,
    key: String,
) -> Result<AssistantSettingsOut, String> {
    blocking(move || {
        let state = app.state::<crate::AppState>();
        Ok((&config::save_key(&state.store, &keychain(), &key)?).into())
    })
    .await
}

/// Remove the Anthropic provider: the keychain entry goes with it.
#[tauri::command]
pub async fn assistant_key_remove(app: tauri::AppHandle) -> Result<AssistantSettingsOut, String> {
    blocking(move || {
        let state = app.state::<crate::AppState>();
        Ok((&config::remove_key(&state.store, &keychain())?).into())
    })
    .await
}

/// Make a one-token request with the key typed in Settings, or the stored
/// one when nothing is typed.
#[tauri::command]
pub async fn assistant_anthropic_test(
    app: tauri::AppHandle,
    key: Option<String>,
) -> Result<String, String> {
    let secret = match key.filter(|k| !k.trim().is_empty()) {
        Some(k) => tuplenest_credential_store::Secret::new(config::check_key(&k)?),
        None => {
            blocking(move || {
                let state = app.state::<crate::AppState>();
                config::load_key(&state.store, &keychain())
            })
            .await?
        }
    };
    http::anthropic_test(&http::client()?, anthropic::BASE_URL, &secret).await?;
    Ok("The key works.".into())
}

/// List the models at an Ollama URL, checking the URL policy first.
#[tauri::command]
pub async fn assistant_ollama_test(
    url: String,
    allow_remote: bool,
) -> Result<Vec<ollama::OllamaModel>, String> {
    let base = ollama::validate_url(&url, allow_remote)?;
    http::ollama_tags(&http::client()?, &base).await
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    pub provider: Provider,
    pub model: String,
    pub label: String,
    /// Runs off this computer (an Ollama cloud model, on ollama.com).
    pub cloud: bool,
    /// False for a cloud model the user has not opted in to: shown, marked,
    /// and refused by `assistant_ask`.
    pub available: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelsOut {
    pub options: Vec<ModelOption>,
    pub default_provider: Option<Provider>,
    pub default_model: Option<String>,
    /// Set when Ollama is turned on but could not be listed.
    pub ollama_error: Option<String>,
    pub ollama_allow_cloud: bool,
}

fn anthropic_options() -> Vec<ModelOption> {
    anthropic::MODELS
        .iter()
        .map(|(id, label)| ModelOption {
            provider: Provider::Anthropic,
            model: id.to_string(),
            label: format!("{label} · your key"),
            cloud: false,
            available: true,
        })
        .collect()
}

fn ollama_options(models: Vec<ollama::OllamaModel>, allow_cloud: bool) -> Vec<ModelOption> {
    models
        .into_iter()
        .map(|m| ModelOption {
            provider: Provider::Ollama,
            label: m.label(),
            available: allow_cloud || !m.cloud,
            cloud: m.cloud,
            model: m.name,
        })
        .collect()
}

/// The stored default, unless it names a cloud model: those are only ever
/// used when picked by hand.
fn safe_default(
    options: &[ModelOption],
    provider: Option<Provider>,
    model: Option<String>,
) -> (Option<Provider>, Option<String>) {
    let cloud = model.as_deref().is_some_and(|m| {
        provider == Some(Provider::Ollama)
            && (ollama::is_cloud_name(m)
                || options
                    .iter()
                    .any(|o| o.provider == Provider::Ollama && o.model == m && o.cloud))
    });
    if cloud {
        (provider, None)
    } else {
        (provider, model)
    }
}

/// What the panel's model picker offers: the configured providers only.
#[tauri::command]
pub async fn assistant_models(app: tauri::State<'_, crate::AppState>) -> Result<ModelsOut, String> {
    let c = config::load(&app.store)?;
    let mut options = Vec::new();
    if c.anthropic_key_ref.is_some() {
        options.extend(anthropic_options());
    }
    let mut ollama_error = None;
    if c.ollama_enabled {
        let listed = match ollama::validate_url(&c.ollama_url, c.ollama_allow_remote) {
            Ok(base) => http::ollama_tags(&http::client()?, &base).await,
            Err(e) => Err(e),
        };
        match listed {
            Ok(models) => options.extend(ollama_options(models, c.ollama_allow_cloud)),
            Err(e) => ollama_error = Some(e),
        }
    }
    let (default_provider, default_model) =
        safe_default(&options, c.default_provider, c.default_model);
    Ok(ModelsOut {
        options,
        default_provider,
        default_model,
        ollama_error,
        ollama_allow_cloud: c.ollama_allow_cloud,
    })
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AskOutcome {
    pub cancelled: bool,
}

/// Ask the assistant. Pieces of the answer arrive as `assistant:chunk`
/// events carrying `id`; the call returns when the answer is complete, was
/// cancelled, or failed.
#[tauri::command]
pub async fn assistant_ask(
    app: tauri::AppHandle,
    state: tauri::State<'_, AssistantState>,
    id: String,
    provider: Provider,
    model: String,
    input: AskInput,
) -> Result<AskOutcome, String> {
    valid_id(&id)?;
    let c = {
        let app_state = app.state::<crate::AppState>();
        config::load(&app_state.store)?
    };
    // Checked before anything is read or sent.
    match provider {
        Provider::Anthropic if !anthropic::is_known_model(&model) => {
            return Err(format!("{model} is not one of the offered Claude models."))
        }
        Provider::Ollama if !c.ollama_enabled => {
            return Err("Ollama is turned off. Turn it on in Settings › Assistant.".into())
        }
        Provider::Ollama if !ollama::is_valid_model(&model) => {
            return Err("That is not an Ollama model name.".into())
        }
        Provider::Ollama => {
            // A cloud model sends the prompt to ollama.com: refused, before
            // the schema is even read, unless the user opted in.
            let base = ollama::validate_url(&c.ollama_url, c.ollama_allow_remote)?;
            http::ollama_cloud_gate(&http::client()?, &base, &model, c.ollama_allow_cloud).await?;
        }
        _ => {}
    }

    let hint = input.sql.clone().unwrap_or_default();
    let schema = {
        let pg = app.state::<crate::pg::PgState>();
        crate::pg::assistant_schema(
            &pg,
            &format!("{hint}\n{}", input.message),
            context::SCHEMA_CAP,
        )
    };
    let prompt = context::build_prompt(&input, &schema);

    let cancel = state.start(&id)?;
    let emit = |text: &str| {
        let _ = app.emit(CHUNK_EVENT, Chunk { id: &id, text });
    };
    let result = async {
        let client = http::client()?;
        match provider {
            Provider::Anthropic => {
                let handle = app.clone();
                let key = blocking(move || {
                    let s = handle.state::<crate::AppState>();
                    config::load_key(&s.store, &keychain())
                })
                .await?;
                http::anthropic_ask(
                    &client,
                    anthropic::BASE_URL,
                    &key,
                    &model,
                    &prompt,
                    &cancel,
                    emit,
                )
                .await
            }
            Provider::Ollama => {
                let base = ollama::validate_url(&c.ollama_url, c.ollama_allow_remote)?;
                http::ollama_ask(&client, &base, &model, &prompt, &cancel, emit).await
            }
        }
    }
    .await;
    state.finish(&id);
    let outcome = result?;
    tracing::info!(
        component = "assistant",
        provider = ?provider,
        action = ?input.action,
        cancelled = outcome == http::Outcome::Cancelled,
        "assistant request finished"
    );
    Ok(AskOutcome {
        cancelled: outcome == http::Outcome::Cancelled,
    })
}

#[tauri::command]
pub fn assistant_cancel(state: tauri::State<'_, AssistantState>, id: String) -> bool {
    state.cancel(&id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_short_and_plain() {
        assert!(valid_id("a1-b_2").is_ok());
        assert!(valid_id("").is_err());
        assert!(valid_id("has space").is_err());
        assert!(valid_id(&"x".repeat(65)).is_err());
    }

    #[test]
    fn a_request_can_be_cancelled_once_started_and_not_twice_started() {
        let s = AssistantState::default();
        assert!(!s.cancel("r1"), "nothing to cancel yet");
        let n = s.start("r1").unwrap();
        assert!(s.start("r1").is_err());
        assert!(s.cancel("r1"));
        // The permit is stored, so a waiter that arrives later still sees it.
        tauri::async_runtime::block_on(async { n.notified().await });
        s.finish("r1");
        assert!(!s.cancel("r1"));
        assert!(s.start("r1").is_ok());
    }

    #[test]
    fn the_picker_offers_three_claude_models_default_first() {
        let o = anthropic_options();
        assert_eq!(o.len(), 3);
        assert_eq!(o[0].model, anthropic::DEFAULT_MODEL);
        assert!(o.iter().all(|m| m.provider == Provider::Anthropic));
    }

    fn listed() -> Vec<ollama::OllamaModel> {
        ollama::parse_tags(
            r#"{"models":[{"name":"llama3.2:latest"},{"name":"glm-5.2:cloud","remote_host":"https://ollama.com:443"},{"name":"kimi:latest","remote_host":"https://ollama.com:443"}]}"#,
        )
        .unwrap()
    }

    #[test]
    fn cloud_models_are_labelled_and_unavailable_until_opted_in() {
        let o = ollama_options(listed(), false);
        assert_eq!(o[0].label, "llama3.2:latest · Ollama");
        assert!(o[0].available && !o[0].cloud);
        assert_eq!(o[1].label, "glm-5.2:cloud · cloud via ollama.com");
        assert!(o[1].cloud && !o[1].available);
        assert!(o[2].cloud && !o[2].available);
        assert!(ollama_options(listed(), true).iter().all(|m| m.available));
    }

    #[test]
    fn a_cloud_model_is_never_the_default() {
        let o = ollama_options(listed(), true);
        for m in ["glm-5.2:cloud", "kimi:latest"] {
            let (_, model) = safe_default(&o, Some(Provider::Ollama), Some(m.into()));
            assert_eq!(model, None, "{m}");
        }
        let (_, model) = safe_default(&o, Some(Provider::Ollama), Some("llama3.2:latest".into()));
        assert_eq!(model.as_deref(), Some("llama3.2:latest"));
    }
}
