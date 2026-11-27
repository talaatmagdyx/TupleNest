//! Settings → MCP server: the commands the window uses to show how to
//! connect an AI tool and to choose, per connection, what it may do.

use serde_json::json;
use tuplenest_workspace_store::{McpAccess, Store};

/// How an AI tool starts this server.
#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpInfo {
    /// Absolute path of this binary.
    pub command: String,
    pub args: Vec<String>,
    /// The `mcpServers` JSON to paste into Claude Desktop or Cursor.
    pub config: String,
}

/// One profile's row in the settings list.
#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpAccessRow {
    pub id: String,
    pub name: String,
    pub environment: Option<String>,
    pub access: McpAccess,
    /// False for prod, staging and read-only profiles.
    pub read_write_allowed: bool,
}

pub fn info_for(command: &str) -> McpInfo {
    let args = vec![super::SUBCOMMAND.to_string()];
    let config = json!({"mcpServers": {"tuplenest": {"command": command, "args": args}}});
    McpInfo {
        command: command.to_string(),
        args,
        config: serde_json::to_string_pretty(&config).expect("JSON values serialize"),
    }
}

pub fn access_rows(store: &Store) -> Result<Vec<McpAccessRow>, String> {
    Ok(store
        .mcp_access_list()
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|(p, access)| McpAccessRow {
            read_write_allowed: !McpAccess::read_write_refused(&p),
            id: p.id,
            name: p.name,
            environment: p.environment,
            access,
        })
        .collect())
}

pub fn set_access(store: &Store, id: &str, access: &str) -> Result<(), String> {
    let access = McpAccess::parse(access).ok_or_else(|| format!("unknown access `{access}`"))?;
    store
        .mcp_access_set(id, access)
        .map_err(|e| e.to_string())?;
    tracing::info!(
        component = "mcp",
        access = access.as_str(),
        "MCP access changed"
    );
    Ok(())
}

#[tauri::command]
pub fn mcp_info() -> Result<McpInfo, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    Ok(info_for(&exe.to_string_lossy()))
}

#[tauri::command]
pub fn mcp_access_list(
    state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<McpAccessRow>, String> {
    access_rows(&*state.store.lock().map_err(|_| "store lock poisoned")?)
}

#[tauri::command]
pub fn mcp_access_set(
    state: tauri::State<'_, crate::AppState>,
    id: String,
    access: String,
) -> Result<(), String> {
    set_access(
        &*state.store.lock().map_err(|_| "store lock poisoned")?,
        &id,
        &access,
    )
}
