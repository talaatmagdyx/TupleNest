//! TupleNest as an MCP (Model Context Protocol) server.
//!
//! `tuplenest-desktop mcp` runs this on stdin/stdout instead of opening a
//! window, so an AI tool (Claude Desktop, Claude Code, Cursor) can list and
//! query the user's saved connections — only the ones the user turned on in
//! Settings, and only under the rules in `server.rs`.
//!
//! The protocol is JSON-RPC 2.0, one message per line (MCP's stdio
//! transport). Only the subset a tools-only server needs is implemented:
//! `initialize`, `ping`, `tools/list`, `tools/call` and the notifications a
//! client sends. That is small enough to own outright rather than take a
//! dependency for, and every byte of it is tested below.
//!
//! stdout carries protocol messages and nothing else. Logs go to the app's log
//! file; a startup failure goes to stderr.

mod backend;
pub mod commands;
mod server;

#[cfg(test)]
mod tests;

use std::sync::{Arc, Mutex as StdMutex};

use serde_json::{json, Value};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};

use backend::DriverConnector;
use server::McpServer;

/// Protocol revisions this server speaks, newest first. A client asking for
/// one of these gets it back; anything else gets the newest.
const PROTOCOL_VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

/// The longest line read. A message bigger than this is not one a client
/// legitimately sends to this server, and reading it whole would let one
/// line take all the memory there is.
const LINE_MAX: usize = 8 * 1024 * 1024;

const PARSE_ERROR: i64 = -32700;
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;

/// The command-line word that starts the server.
pub const SUBCOMMAND: &str = "mcp";

const INSTRUCTIONS: &str =
    "TupleNest gives access to the user's saved database connections (PostgreSQL or \
SQLite: see each one's `engine`) that they turned on for AI tools. Call list_connections first. \
Write SQL for that engine: a SQLite connection's schemas are `main` and any attached databases. read_only connections accept only \
statements that read. On read_write connections, destructive statements (no WHERE, DROP, \
TRUNCATE, ALTER, …) are refused because no one can confirm them here. Statements on prod and \
staging connections are recorded in TupleNest's audit log before they run.";

fn response(id: &Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

fn error(id: &Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

/// One connection's worth of protocol state around the tool server.
pub struct Protocol {
    server: McpServer,
    initialized: bool,
}

impl Protocol {
    pub fn new(server: McpServer) -> Self {
        Self {
            server,
            initialized: false,
        }
    }

    /// Handles one line; returns the reply line, or None for a notification.
    pub async fn handle_line(&mut self, line: &str) -> Option<Value> {
        let msg: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => return Some(error(&Value::Null, PARSE_ERROR, "Parse error")),
        };
        let Some(obj) = msg.as_object() else {
            // Batches were removed from MCP in 2025-06-18; nothing sends them.
            return Some(error(&Value::Null, INVALID_REQUEST, "Invalid Request"));
        };
        let method = obj.get("method").and_then(Value::as_str);
        let Some(id) = obj.get("id").cloned() else {
            // A notification (`notifications/initialized`, `…/cancelled`):
            // nothing to answer.
            return None;
        };
        let Some(method) = method else {
            // A response to a request this server never makes is ignored; an
            // id with neither a method nor a result is malformed.
            if obj.contains_key("result") || obj.contains_key("error") {
                return None;
            }
            return Some(error(&id, INVALID_REQUEST, "Invalid Request"));
        };
        if obj.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
            || !(id.is_string() || id.is_number())
        {
            return Some(error(&id, INVALID_REQUEST, "Invalid Request"));
        }
        let params = obj.get("params").cloned().unwrap_or(Value::Null);
        Some(self.request(&id, method, &params).await)
    }

    async fn request(&mut self, id: &Value, method: &str, params: &Value) -> Value {
        match method {
            "initialize" => {
                let client = params.pointer("/clientInfo/name").and_then(Value::as_str);
                self.server.set_client(client);
                self.initialized = true;
                let asked = params.get("protocolVersion").and_then(Value::as_str);
                let version = asked
                    .filter(|v| PROTOCOL_VERSIONS.contains(v))
                    .unwrap_or(PROTOCOL_VERSIONS[0]);
                tracing::info!(component = "mcp", client = %self.server.actor(), "client connected");
                response(
                    id,
                    json!({
                        "protocolVersion": version,
                        "capabilities": {"tools": {"listChanged": false}},
                        "serverInfo": {
                            "name": "tuplenest",
                            "title": "TupleNest",
                            "version": env!("CARGO_PKG_VERSION"),
                        },
                        "instructions": INSTRUCTIONS,
                    }),
                )
            }
            "ping" => response(id, json!({})),
            _ if !self.initialized => error(id, INVALID_REQUEST, "Send initialize first"),
            "tools/list" => response(id, json!({"tools": server::tool_definitions()})),
            "tools/call" => {
                let Some(name) = params.get("name").and_then(Value::as_str) else {
                    return error(id, INVALID_PARAMS, "tools/call needs a tool name");
                };
                let args = match params.get("arguments") {
                    None | Some(Value::Null) => json!({}),
                    Some(a) => a.clone(),
                };
                match self.server.call_tool(name, &args).await {
                    Ok(out) => response(
                        id,
                        json!({
                            "content": [{"type": "text", "text": out.text}],
                            "isError": out.is_error,
                        }),
                    ),
                    Err(server::UnknownTool(name)) => {
                        error(id, INVALID_PARAMS, &format!("Unknown tool: {name}"))
                    }
                }
            }
            _ => error(id, METHOD_NOT_FOUND, "Method not found"),
        }
    }
}

/// Reads one line of at most [`LINE_MAX`] bytes. Ok(None) at end of input;
/// Ok(Some(Err(()))) for a line that was too long (and has been skipped).
async fn read_line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
) -> std::io::Result<Option<Result<String, ()>>> {
    let mut buf = Vec::new();
    let mut too_long = false;
    loop {
        let chunk = reader.fill_buf().await?;
        if chunk.is_empty() {
            if buf.is_empty() && !too_long {
                return Ok(None);
            }
            break;
        }
        let (take, done) = match chunk.iter().position(|b| *b == b'\n') {
            Some(i) => (i + 1, true),
            None => (chunk.len(), false),
        };
        if !too_long {
            if buf.len() + take > LINE_MAX {
                too_long = true;
                buf.clear();
            } else {
                buf.extend_from_slice(&chunk[..take]);
            }
        }
        reader.consume(take);
        if done {
            break;
        }
    }
    if too_long {
        return Ok(Some(Err(())));
    }
    Ok(Some(Ok(String::from_utf8_lossy(&buf).into_owned())))
}

/// Serves MCP over a line-delimited stream until it closes.
pub async fn serve<R, W>(
    mut reader: R,
    mut writer: W,
    mut protocol: Protocol,
) -> std::io::Result<()>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
{
    while let Some(line) = read_line(&mut reader).await? {
        let reply = match line {
            Err(()) => Some(error(&Value::Null, INVALID_REQUEST, "Message too large")),
            Ok(line) if line.trim().is_empty() => None,
            Ok(line) => protocol.handle_line(line.trim_end()).await,
        };
        if let Some(reply) = reply {
            let mut out = serde_json::to_vec(&reply).expect("JSON values serialize");
            out.push(b'\n');
            writer.write_all(&out).await?;
            writer.flush().await?;
        }
    }
    Ok(())
}

/// The app's bundle identifier, from the same config Tauri builds with: the
/// data directory and the keychain service both follow it.
fn identifier() -> String {
    let conf: Value = serde_json::from_str(include_str!("../../tauri.conf.json"))
        .expect("tauri.conf.json is JSON");
    conf["identifier"]
        .as_str()
        .expect("tauri.conf.json has an identifier")
        .to_string()
}

/// Where the app keeps its data: Tauri's `app_data_dir`, which is the
/// platform data directory joined with the bundle identifier. Worked out
/// here because the MCP server starts no Tauri app to ask.
pub fn app_data_dir() -> Option<std::path::PathBuf> {
    dirs::data_dir().map(|d| d.join(identifier()))
}

/// Entry point for `tuplenest-desktop mcp`. Returns the process exit code.
pub fn run_stdio() -> i32 {
    let Some(dir) = app_data_dir() else {
        eprintln!("tuplenest mcp: no data directory on this system");
        return 1;
    };
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("tuplenest mcp: cannot create {}: {e}", dir.display());
        return 1;
    }
    tuplenest_telemetry::secure_dir(&dir);
    let _log = tuplenest_telemetry::init_app(&dir.join("logs"), !cfg!(debug_assertions)).ok();
    tuplenest_telemetry::install_panic_hook(dir.join("crashes"));
    let store = match tuplenest_workspace_store::Store::open(&dir.join("tuplenest.db")) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("tuplenest mcp: cannot open the TupleNest store: {e}");
            return 1;
        }
    };
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
    {
        Ok(r) => r,
        Err(e) => {
            eprintln!("tuplenest mcp: {e}");
            return 1;
        }
    };
    let server = McpServer::new(
        Arc::new(StdMutex::new(store)),
        Arc::new(tuplenest_credential_store::KeychainStore::new()),
        Arc::new(DriverConnector),
    );
    tracing::info!(
        component = "mcp",
        version = env!("CARGO_PKG_VERSION"),
        "MCP server starting"
    );
    let served = runtime.block_on(serve(
        tokio::io::BufReader::new(tokio::io::stdin()),
        tokio::io::stdout(),
        Protocol::new(server),
    ));
    match served {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("tuplenest mcp: {e}");
            1
        }
    }
}
