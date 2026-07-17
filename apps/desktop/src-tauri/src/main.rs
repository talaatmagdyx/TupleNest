//! TupleNest desktop shell (master spec §52).
//!
//! Only narrow commands are exposed to the WebView. Secrets and database
//! state stay in the Rust core.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;

use tauri::Manager;
use tuplenest_workspace_store::Store;

mod connections;
mod pg;

struct AppState {
    store: Mutex<Store>,
    /// Keeps the background log writer alive for the app's lifetime.
    _log_guard: Option<tuplenest_telemetry::LogGuard>,
}

#[derive(serde::Serialize)]
struct AppInfo {
    name: String,
    version: String,
    os: String,
}

#[tauri::command]
fn app_get_info(app: tauri::AppHandle) -> AppInfo {
    let pkg = app.package_info();
    AppInfo {
        name: pkg.name.clone(),
        version: pkg.version.to_string(),
        os: std::env::consts::OS.to_string(),
    }
}

#[tauri::command]
fn settings_get(
    state: tauri::State<'_, AppState>,
    key: String,
) -> Result<Option<serde_json::Value>, String> {
    state
        .store
        .lock()
        .map_err(|_| "store lock poisoned".to_string())?
        .setting_get(&key)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn settings_set(
    state: tauri::State<'_, AppState>,
    key: String,
    value: serde_json::Value,
) -> Result<(), String> {
    state
        .store
        .lock()
        .map_err(|_| "store lock poisoned".to_string())?
        .setting_set(&key, &value)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn layout_save(
    state: tauri::State<'_, AppState>,
    workspace_id: String,
    layout_json: String,
) -> Result<(), String> {
    let store = state
        .store
        .lock()
        .map_err(|_| "store lock poisoned".to_string())?;
    store
        .workspace_upsert(&workspace_id, &workspace_id)
        .map_err(|e| e.to_string())?;
    store
        .layout_save(&workspace_id, &layout_json)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn layout_load(
    state: tauri::State<'_, AppState>,
    workspace_id: String,
) -> Result<Option<String>, String> {
    state
        .store
        .lock()
        .map_err(|_| "store lock poisoned".to_string())?
        .layout_load(&workspace_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn history_list(
    state: tauri::State<'_, AppState>,
    search: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<tuplenest_workspace_store::HistoryEntry>, String> {
    state
        .store
        .lock()
        .map_err(|_| "store lock poisoned".to_string())?
        .history_list(
            search.as_deref().filter(|s| !s.is_empty()),
            limit.unwrap_or(50),
        )
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn history_favorite(
    state: tauri::State<'_, AppState>,
    id: String,
    favorite: bool,
) -> Result<(), String> {
    state
        .store
        .lock()
        .map_err(|_| "store lock poisoned".to_string())?
        .history_set_favorite(&id, favorite)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn history_clear(
    state: tauri::State<'_, AppState>,
    include_favorites: Option<bool>,
) -> Result<(), String> {
    state
        .store
        .lock()
        .map_err(|_| "store lock poisoned".to_string())?
        .history_clear(include_favorites.unwrap_or(false))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn snippet_list(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<tuplenest_workspace_store::SnippetRecord>, String> {
    state
        .store
        .lock()
        .map_err(|_| "store lock poisoned".to_string())?
        .snippet_list()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn snippet_save(
    state: tauri::State<'_, AppState>,
    id: Option<String>,
    name: String,
    body: String,
    tags: Option<String>,
) -> Result<tuplenest_workspace_store::SnippetRecord, String> {
    let rec = tuplenest_workspace_store::SnippetRecord {
        id: id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        name,
        body,
        tags,
    };
    let store = state
        .store
        .lock()
        .map_err(|_| "store lock poisoned".to_string())?;
    store.snippet_upsert(&rec).map_err(|e| e.to_string())?;
    Ok(rec)
}

#[tauri::command]
fn snippet_delete(state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    state
        .store
        .lock()
        .map_err(|_| "store lock poisoned".to_string())?
        .snippet_delete(&id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn audit_list(
    state: tauri::State<'_, AppState>,
    limit: Option<usize>,
) -> Result<Vec<tuplenest_workspace_store::AuditEntry>, String> {
    state
        .store
        .lock()
        .map_err(|_| "store lock poisoned".to_string())?
        .audit_list(limit.unwrap_or(200))
        .map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        // Auto-update. Payloads are verified against the minisign public key in
        // tauri.conf.json — an update that isn't signed with our private key is
        // rejected, so a compromised release host still cannot ship code.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Save dialog + write access, scoped by the capability file to paths
        // the user picks in the dialog — no ambient filesystem access.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // Hands the About box's links to the real browser. A plain <a href>
        // would navigate *this* webview and the app would vanish behind a web
        // page with no way back. The capability file allows two exact URLs and
        // nothing else — notably not `opener:default`, which would permit any
        // https:// URL the frontend cared to pass.
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;

            // E0.7: structured file logging (rotated daily) + crash capture.
            // JSON logs in release; human-readable in dev.
            let log_guard =
                tuplenest_telemetry::init_app(&dir.join("logs"), !cfg!(debug_assertions)).ok();
            tuplenest_telemetry::install_panic_hook(dir.join("crashes"));
            tracing::info!(
                component = "app",
                version = env!("CARGO_PKG_VERSION"),
                "TupleNest starting"
            );

            let store = Store::open(&dir.join("tuplenest.db"))
                .map_err(|e| -> Box<dyn std::error::Error> { format!("{e}").into() })?;
            app.manage(AppState {
                store: Mutex::new(store),
                _log_guard: log_guard,
            });
            let cache =
                tuplenest_metadata_cache::MetadataCache::open(&dir.join("metadata-cache.db"))
                    .map_err(|e| -> Box<dyn std::error::Error> { format!("{e}").into() })?;
            app.manage(pg::PgState::new(cache));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_get_info,
            settings_get,
            settings_set,
            layout_save,
            layout_load,
            history_list,
            history_favorite,
            history_clear,
            snippet_list,
            snippet_save,
            snippet_delete,
            audit_list,
            connections::connection_save,
            connections::connection_list,
            connections::connection_delete,
            pg::pg_secret_save,
            pg::pg_test,
            pg::pg_connect,
            pg::pg_disconnect,
            pg::pg_query,
            pg::pg_rows,
            pg::pg_metadata,
            pg::pg_metadata_cached,
            pg::pg_activity,
            pg::pg_relationships,
            pg::pg_admin_backend,
            pg::pg_begin,
            pg::pg_commit,
            pg::pg_rollback,
            pg::pg_cancel
        ])
        .run(tauri::generate_context!())
        .expect("error while running TupleNest");
}
