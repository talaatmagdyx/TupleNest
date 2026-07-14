//! TupleNest desktop shell (master spec §52).
//!
//! Only narrow commands are exposed to the WebView. Secrets and database
//! state stay in the Rust core.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;

use tauri::Manager;
use tuplenest_workspace_store::Store;

struct AppState {
    store: Mutex<Store>,
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

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let store = Store::open(&dir.join("tuplenest.db"))
                .map_err(|e| -> Box<dyn std::error::Error> { format!("{e}").into() })?;
            app.manage(AppState {
                store: Mutex::new(store),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_get_info,
            settings_get,
            settings_set,
            layout_save,
            layout_load
        ])
        .run(tauri::generate_context!())
        .expect("error while running TupleNest");
}
