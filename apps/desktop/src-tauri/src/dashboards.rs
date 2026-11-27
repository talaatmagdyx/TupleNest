//! Dashboards: the store side. Running a chart is `pg::pg_query_read`.

use tuplenest_workspace_store::{DashboardChart, DashboardRecord, Store};

fn store_err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn lock(state: &crate::AppState) -> Result<std::sync::MutexGuard<'_, Store>, String> {
    state
        .store
        .lock()
        .map_err(|_| "store lock poisoned".to_string())
}

/// Refuses a statement that is not a plain read, before it is stored.
/// `pg_query_read` checks again on every run; this makes the refusal happen
/// where the user is pinning, not later on a dashboard.
pub fn pin_check(sql: &str) -> Result<(), String> {
    match crate::guard::write_reason(sql) {
        None => Ok(()),
        Some(why) => Err(format!(
            "Not pinned: a dashboard chart runs its query every time the page opens, so only a query that reads can be pinned. {why}"
        )),
    }
}

#[tauri::command]
pub fn dashboard_list(
    state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<DashboardRecord>, String> {
    lock(&state)?.dashboard_list().map_err(store_err)
}

#[tauri::command]
pub fn dashboard_save(
    state: tauri::State<'_, crate::AppState>,
    id: Option<String>,
    name: String,
    connection_id: Option<String>,
    refresh_secs: u32,
) -> Result<String, String> {
    let id = id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    lock(&state)?
        .dashboard_save(&id, &name, connection_id.as_deref(), refresh_secs)
        .map_err(store_err)?;
    Ok(id)
}

#[tauri::command]
pub fn dashboard_delete(
    state: tauri::State<'_, crate::AppState>,
    id: String,
) -> Result<(), String> {
    lock(&state)?.dashboard_delete(&id).map_err(store_err)
}

#[tauri::command]
pub fn dashboard_chart_add(
    state: tauri::State<'_, crate::AppState>,
    dashboard_id: String,
    title: String,
    kind: String,
    sql: String,
) -> Result<DashboardChart, String> {
    pin_check(&sql)?;
    lock(&state)?
        .dashboard_chart_add(&DashboardChart {
            id: uuid::Uuid::new_v4().to_string(),
            dashboard_id,
            title,
            kind,
            sql_text: sql,
            position: 0,
        })
        .map_err(store_err)
}

#[tauri::command]
pub fn dashboard_chart_delete(
    state: tauri::State<'_, crate::AppState>,
    id: String,
) -> Result<(), String> {
    lock(&state)?.dashboard_chart_delete(&id).map_err(store_err)
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_write_is_never_pinned() {
        assert!(super::pin_check("select status, count(*) from orders group by 1").is_ok());
        let err = super::pin_check("delete from orders where id = 1").unwrap_err();
        assert!(err.starts_with("Not pinned:"), "{err}");
        assert!(err.contains("DELETE"), "{err}");
    }
}
