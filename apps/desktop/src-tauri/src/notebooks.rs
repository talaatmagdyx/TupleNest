//! SQL notebooks: the store side. A SQL cell runs through `pg_query`
//! (detached, `max_rows` 200) like any statement from the editor.

use tuplenest_workspace_store::{NotebookRecord, NotebookSummary};

fn lock(
    state: &crate::AppState,
) -> Result<std::sync::MutexGuard<'_, tuplenest_workspace_store::Store>, String> {
    state
        .store
        .lock()
        .map_err(|_| "store lock poisoned".to_string())
}

#[tauri::command]
pub fn notebook_list(
    state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<NotebookSummary>, String> {
    lock(&state)?.notebook_list().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn notebook_get(
    state: tauri::State<'_, crate::AppState>,
    id: String,
) -> Result<Option<NotebookRecord>, String> {
    lock(&state)?.notebook_get(&id).map_err(|e| e.to_string())
}

/// Saves the notebook and returns it as stored: each SQL cell's result cut to
/// 200 rows.
#[tauri::command]
pub fn notebook_save(
    state: tauri::State<'_, crate::AppState>,
    id: Option<String>,
    name: String,
    connection_id: Option<String>,
    cells: serde_json::Value,
) -> Result<NotebookRecord, String> {
    let record = NotebookRecord {
        id: id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        name,
        connection_id,
        cells,
    };
    lock(&state)?
        .notebook_save(&record)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn notebook_delete(state: tauri::State<'_, crate::AppState>, id: String) -> Result<(), String> {
    lock(&state)?
        .notebook_delete(&id)
        .map_err(|e| e.to_string())
}
