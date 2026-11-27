//! The MCP tools and the rules they run under.
//!
//! Every tool call re-reads the profile and its access from the store, so a
//! connection switched to `off` in Settings stops answering on the next call,
//! with no restart. What an MCP client may do:
//!
//! - `off` (the default for every profile): the connection does not exist.
//!   It is not listed, and naming it gets the same answer as a name that was
//!   never saved.
//! - `read_only`: the session is opened read-only — the server-enforced
//!   `SET SESSION CHARACTERISTICS … READ ONLY` with its per-statement
//!   re-check, and the driver's allowlist of statements that only read. The
//!   same session a read-only profile gets in the app.
//! - `read_write`: writes are allowed, but anything the app's destructive
//!   statement guard would stop and ask about is refused, with the reason:
//!   there is no one to ask. Not available on prod or staging.
//!
//! On a prod or staging profile, `run_query` and `explain` write the audit
//! row before the statement is sent, and a failed audit write refuses the
//! statement. Both also go to query history, attributed to the MCP client.

use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};

use async_trait::async_trait;
use serde_json::{json, Value};
use tuplenest_credential_store::{CredentialStore, Secret};
use tuplenest_driver_api::{
    BatchSink, ConnectionConfig, DriverError, Environment, ErrorCategory, ExecutionId, ParamValue,
    QueryRequest, RowBatch, SecretRef,
};
use tuplenest_workspace_store::{ConnectionRecord, HistoryEntry, McpAccess, Store};

use super::backend::{Connector, OpenTarget, Session};
use crate::guard;

/// Rows `run_query` returns at most.
pub const ROW_CAP: usize = 500;
/// Bytes of row JSON returned at most, whichever cap comes first: 500 rows
/// of a 10 MB `jsonb` column is not something to hand a language model.
pub const BYTE_CAP: usize = 1024 * 1024;
/// The longest SQL text accepted.
const SQL_MAX: usize = 256 * 1024;
const PARAMS_MAX: usize = 100;
const NAME_MAX: usize = 256;

/// A tool's answer: text for the model, and whether it is an error.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolOutput {
    pub text: String,
    pub is_error: bool,
}

impl ToolOutput {
    fn ok(value: Value) -> Self {
        Self {
            text: serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string()),
            is_error: false,
        }
    }
    fn err(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            is_error: true,
        }
    }
}

/// A tool call that could not be dispatched at all (JSON-RPC error).
#[derive(Debug, PartialEq)]
pub struct UnknownTool(pub String);

struct OpenSession {
    /// The profile and access it was opened for: if either changes, it is
    /// closed and opened again under the new terms.
    opened_for: (ConnectionRecord, McpAccess),
    session: Box<dyn Session>,
}

pub struct McpServer {
    store: Arc<StdMutex<Store>>,
    credentials: Arc<dyn CredentialStore>,
    connector: Arc<dyn Connector>,
    /// `clientInfo.name` from `initialize`, cleaned.
    client: String,
    sessions: HashMap<String, OpenSession>,
}

/// The tools, as `tools/list` describes them.
pub fn tool_definitions() -> Value {
    let connection = json!({
        "type": "string",
        "description": "Connection name or id, as list_connections returns it."
    });
    let params = json!({
        "type": "array",
        "description": "Values for $1, $2, … placeholders.",
        "maxItems": PARAMS_MAX
    });
    json!([
        {
            "name": "list_connections",
            "title": "List connections",
            "description": "Saved TupleNest connections the user has made available to AI tools, with their environment tag and access (read_only or read_write). Connections not listed here cannot be used.",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": false},
            "annotations": {"readOnlyHint": true}
        },
        {
            "name": "list_schemas",
            "title": "List schemas",
            "description": "Schemas in the connection's database (system schemas left out).",
            "inputSchema": {"type": "object", "properties": {"connection": connection},
                "required": ["connection"], "additionalProperties": false},
            "annotations": {"readOnlyHint": true}
        },
        {
            "name": "list_tables",
            "title": "List tables",
            "description": "Tables, views, materialized views and foreign tables in one schema.",
            "inputSchema": {"type": "object", "properties": {
                    "connection": connection,
                    "schema": {"type": "string", "description": "Schema name, e.g. public."}},
                "required": ["connection", "schema"], "additionalProperties": false},
            "annotations": {"readOnlyHint": true}
        },
        {
            "name": "describe_table",
            "title": "Describe table",
            "description": "Columns (type, nullability, default), constraints (primary, foreign, unique, check) and indexes of one table or view.",
            "inputSchema": {"type": "object", "properties": {
                    "connection": connection,
                    "schema": {"type": "string"},
                    "table": {"type": "string"}},
                "required": ["connection", "schema", "table"], "additionalProperties": false},
            "annotations": {"readOnlyHint": true}
        },
        {
            "name": "run_query",
            "title": "Run SQL",
            "description": format!("Run one SQL statement and return at most {ROW_CAP} rows (`truncated` says whether there were more). On a read_only connection only statements that read are accepted. On a read_write connection, statements the TupleNest guard would stop (UPDATE/DELETE without a real WHERE, DROP, TRUNCATE, ALTER, GRANT/REVOKE, DO, CALL, MERGE, COPY FROM …) are refused. Each call is its own transaction."),
            "inputSchema": {"type": "object", "properties": {
                    "connection": connection,
                    "sql": {"type": "string", "description": "One SQL statement."},
                    "params": params},
                "required": ["connection", "sql"], "additionalProperties": false},
            "annotations": {"readOnlyHint": false, "destructiveHint": false, "openWorldHint": false}
        },
        {
            "name": "explain",
            "title": "Explain query plan",
            "description": "The planner's plan for one statement (EXPLAIN, never ANALYZE: the statement is not run).",
            "inputSchema": {"type": "object", "properties": {
                    "connection": connection,
                    "sql": {"type": "string", "description": "The statement to explain, without EXPLAIN."},
                    "params": params},
                "required": ["connection", "sql"], "additionalProperties": false},
            "annotations": {"readOnlyHint": true}
        }
    ])
}

/// The client's name, made safe to store and show: no control characters,
/// at most 64 characters, never empty.
pub fn clean_client_name(raw: Option<&str>) -> String {
    let name: String = raw
        .unwrap_or("")
        .chars()
        .filter(|c| !c.is_control())
        .take(64)
        .collect();
    let name = name.trim();
    if name.is_empty() {
        "unknown client".into()
    } else {
        name.to_string()
    }
}

// ---- argument validation ---------------------------------------------------

fn args_object<'a>(
    args: &'a Value,
    allowed: &[&str],
) -> Result<&'a serde_json::Map<String, Value>, String> {
    let obj = args.as_object().ok_or("arguments must be a JSON object")?;
    if let Some(extra) = obj.keys().find(|k| !allowed.contains(&k.as_str())) {
        return Err(format!("unknown argument `{extra}`"));
    }
    Ok(obj)
}

fn string_arg(
    obj: &serde_json::Map<String, Value>,
    key: &str,
    max: usize,
) -> Result<String, String> {
    let s = obj
        .get(key)
        .ok_or_else(|| format!("`{key}` is required"))?
        .as_str()
        .ok_or_else(|| format!("`{key}` must be a string"))?;
    if s.trim().is_empty() {
        return Err(format!("`{key}` must not be empty"));
    }
    if s.len() > max {
        return Err(format!("`{key}` is longer than {max} bytes"));
    }
    if s.contains('\0') {
        return Err(format!("`{key}` must not contain NUL characters"));
    }
    Ok(s.to_string())
}

fn params_arg(obj: &serde_json::Map<String, Value>) -> Result<Vec<ParamValue>, String> {
    match obj.get("params") {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(items)) if items.len() <= PARAMS_MAX => Ok(items
            .iter()
            .cloned()
            .map(|v| match v {
                Value::Null => ParamValue::Null,
                Value::Bool(b) => ParamValue::Bool(b),
                Value::Number(n) => n
                    .as_i64()
                    .map(ParamValue::Int)
                    .unwrap_or_else(|| ParamValue::Float(n.as_f64().unwrap_or(0.0))),
                Value::String(s) => ParamValue::Text(s),
                other => ParamValue::Json(other),
            })
            .collect()),
        Some(Value::Array(_)) => Err(format!("`params` has more than {PARAMS_MAX} values")),
        Some(_) => Err("`params` must be an array".into()),
    }
}

// ---- statement policy ------------------------------------------------------

/// Words that open, close or nest a transaction. Each call is one
/// transaction of its own; a BEGIN left open by a model would hold locks
/// across calls with no one watching.
const TRANSACTION_CONTROL: [&str; 7] = [
    "begin",
    "start",
    "commit",
    "end",
    "rollback",
    "abort",
    "savepoint",
];

fn first_word(masked: &str) -> String {
    masked
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .find(|w| !w.is_empty())
        .unwrap_or("")
        .to_ascii_lowercase()
}

/// Is there more than one statement? A `;` at the top level with anything
/// but whitespace after it.
fn several_statements(masked: &str) -> bool {
    masked.find(';').is_some_and(|i| {
        !masked[i..]
            .trim_start_matches([';', ' ', '\t', '\r', '\n'])
            .is_empty()
    })
}

/// May an MCP client send this statement with this access? Ok, or why not.
/// The read-only rules themselves are the driver's (they apply to the
/// session); this adds what is particular to a client with no human at it.
pub fn check_statement(access: McpAccess, sql: &str) -> Result<(), String> {
    let masked = guard::mask_literals(sql);
    if several_statements(&masked) {
        return Err("Refused: send one statement per call. Nothing was run.".into());
    }
    let word = first_word(&masked);
    if word.is_empty() {
        return Err("Refused: the SQL has no statement in it. Nothing was run.".into());
    }
    if TRANSACTION_CONTROL.contains(&word.as_str()) || word == "release" {
        return Err(format!(
            "Refused: {} is not accepted here. Each call runs as its own transaction. Nothing was run.",
            word.to_ascii_uppercase()
        ));
    }
    match access {
        McpAccess::Off => Err(not_available()),
        McpAccess::ReadOnly => Ok(()),
        McpAccess::ReadWrite => match guard::guard_reason(sql) {
            None => Ok(()),
            Some(r) => Err(format!(
                "Refused: {verb}. {why} In the TupleNest window this would ask for \
                 confirmation; an MCP client has no one to confirm it, so it is not run. \
                 Run it from TupleNest if it is intended. Nothing was run.",
                verb = r.verb,
                why = r.why
            )),
        },
    }
}

/// The one answer for a connection that is off and one that does not exist,
/// so a client cannot tell them apart.
fn not_available() -> String {
    "No connection by that name is available to AI tools. Call list_connections for the ones \
     that are; others are turned on in TupleNest → Settings → MCP server."
        .into()
}

/// Statements `explain` will put EXPLAIN in front of. Only statements, never
/// options: anything else (`ANALYZE …`, `(ANALYZE) …`) would turn the plan
/// into a run.
const EXPLAINABLE: [&str; 8] = [
    "select", "with", "insert", "update", "delete", "merge", "values", "table",
];

fn is_audited(environment: Option<&str>) -> bool {
    matches!(environment, Some("prod" | "staging"))
}

// ---- the row sink ----------------------------------------------------------

#[derive(Default)]
struct Collected {
    columns: Vec<(String, String)>,
    rows: Vec<String>,
    bytes: usize,
    full: bool,
    /// A row was left out for the byte cap, not the row cap.
    byte_capped: bool,
}

/// Keeps the first rows of a result, up to [`ROW_CAP`] and [`BYTE_CAP`].
#[derive(Default)]
struct CollectSink(StdMutex<Collected>);

#[async_trait]
impl BatchSink for CollectSink {
    fn wants_rows(&self) -> bool {
        self.0.lock().map(|c| !c.full).unwrap_or(false)
    }

    async fn deliver(&self, batch: RowBatch) -> Result<(), Box<DriverError>> {
        let mut c = self.0.lock().expect("sink lock");
        if c.columns.is_empty() && !batch.columns.is_empty() {
            c.columns = batch
                .columns
                .iter()
                .map(|col| (col.name.clone(), col.db_type.clone()))
                .collect();
        }
        let mut buf = Vec::new();
        for row in batch.rows {
            if c.full {
                break;
            }
            buf.clear();
            crate::pg::write_row(&mut buf, &row);
            if c.bytes + buf.len() > BYTE_CAP {
                c.full = true;
                c.byte_capped = true;
                break;
            }
            c.bytes += buf.len();
            c.rows
                .push(String::from_utf8(buf.clone()).expect("serde_json writes UTF-8"));
            if c.rows.len() >= ROW_CAP {
                c.full = true;
            }
        }
        Ok(())
    }
}

struct Ran {
    columns: Vec<(String, String)>,
    rows: Vec<String>,
    truncated: bool,
    rows_affected: Option<u64>,
    rows_returned: u64,
    duration_ms: u64,
}

impl Ran {
    fn rows_json(&self) -> Value {
        // Each row is already its JSON array, as the app's grid gets it
        // (big integers as exact text, NaN as "NaN").
        serde_json::from_str(&format!("[{}]", self.rows.join(","))).unwrap_or(Value::Null)
    }
}

impl McpServer {
    pub fn new(
        store: Arc<StdMutex<Store>>,
        credentials: Arc<dyn CredentialStore>,
        connector: Arc<dyn Connector>,
    ) -> Self {
        Self {
            store,
            credentials,
            connector,
            client: "unknown client".into(),
            sessions: HashMap::new(),
        }
    }

    pub fn set_client(&mut self, name: Option<&str>) {
        self.client = clean_client_name(name);
    }

    /// The actor recorded in audit and history rows.
    pub fn actor(&self) -> String {
        format!("MCP · {}", self.client)
    }

    fn store(&self) -> Result<std::sync::MutexGuard<'_, Store>, String> {
        self.store
            .lock()
            .map_err(|_| "the local store is unavailable".to_string())
    }

    pub async fn call_tool(&mut self, name: &str, args: &Value) -> Result<ToolOutput, UnknownTool> {
        let result = match name {
            "list_connections" => self.list_connections(args),
            "list_schemas" => self.list_schemas(args).await,
            "list_tables" => self.list_tables(args).await,
            "describe_table" => self.describe_table(args).await,
            "run_query" => self.run_query(args).await,
            "explain" => self.explain(args).await,
            other => return Err(UnknownTool(other.to_string())),
        };
        Ok(result.unwrap_or_else(ToolOutput::err))
    }

    /// Profiles an MCP client may see, with their access. `Off` ones are not
    /// in this list at all.
    fn visible(&self) -> Result<Vec<(ConnectionRecord, McpAccess)>, String> {
        Ok(self
            .store()?
            .mcp_access_list()
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter(|(_, a)| *a != McpAccess::Off)
            .collect())
    }

    fn list_connections(&self, args: &Value) -> Result<ToolOutput, String> {
        args_object(args, &[])?;
        let list: Vec<Value> = self
            .visible()?
            .into_iter()
            .map(|(p, access)| {
                json!({
                    "id": p.id,
                    "name": p.name,
                    "engine": "postgresql",
                    "environment": p.environment,
                    "access": access.as_str(),
                    "host": p.host,
                    "port": p.port,
                    "database": p.database,
                })
            })
            .collect();
        Ok(ToolOutput::ok(json!({ "connections": list })))
    }

    /// The profile a call names, by id or by name, if it is visible.
    fn resolve(&self, name: &str) -> Result<(ConnectionRecord, McpAccess), String> {
        let visible = self.visible()?;
        if let Some(hit) = visible.iter().find(|(p, _)| p.id == name) {
            return Ok(hit.clone());
        }
        let mut by_name = visible.iter().filter(|(p, _)| p.name == name);
        match (by_name.next(), by_name.next()) {
            (Some(hit), None) => Ok(hit.clone()),
            (Some(_), Some(_)) => Err(format!(
                "More than one connection is named `{name}`; use its id from list_connections."
            )),
            _ => Err(not_available()),
        }
    }

    fn config_for(
        profile: &ConnectionRecord,
        access: McpAccess,
    ) -> Result<ConnectionConfig, String> {
        Ok(ConnectionConfig {
            driver_id: "postgres".into(),
            name: format!("{} (MCP)", profile.name),
            environment: Environment::Dev,
            // `effective` has already held read_write to read_only for a
            // read-only, prod or staging profile; the profile's own flag is
            // checked again here so no path forgets it.
            read_only: access != McpAccess::ReadWrite || profile.read_only,
            host: profile.host.clone(),
            port: profile.port,
            database: profile.database.clone(),
            username: profile.username.clone(),
            secret_ref: profile.secret_ref.as_deref().map(SecretRef::new),
            tls_mode: crate::pg::parse_tls_mode(
                Some(profile.tls_mode.as_str()).filter(|m| !m.is_empty()),
            )?,
            tls_ca_path: profile.tls_ca_path.clone().filter(|c| !c.trim().is_empty()),
            options: Default::default(),
            default_statement_timeout_ms: profile.statement_timeout_ms,
        })
    }

    fn secret(&self, key: Option<&str>) -> Result<Option<Secret>, String> {
        match key.filter(|k| !k.is_empty()) {
            None => Ok(None),
            Some(key) => self
                .credentials
                .get(&SecretRef::new(key))
                .map(Some)
                .map_err(|e| format!("Could not read the saved password from the keychain: {e}")),
        }
    }

    /// The session for this profile under this access, opened if needed.
    async fn session(
        &mut self,
        profile: &ConnectionRecord,
        access: McpAccess,
    ) -> Result<&mut Box<dyn Session>, String> {
        let wanted = (profile.clone(), access);
        let stale = self
            .sessions
            .get(&profile.id)
            .is_some_and(|s| s.opened_for != wanted);
        if stale {
            self.sessions.remove(&profile.id);
        }
        if !self.sessions.contains_key(&profile.id) {
            let config = Self::config_for(profile, access)?;
            let password = self.secret(profile.secret_ref.as_deref())?;
            let ssh = match crate::pg::saved_ssh(profile) {
                Some(ssh) => {
                    let passphrase = self
                        .secret(ssh.passphrase_key())?
                        .map(|s| s.expose().to_owned());
                    Some((ssh, passphrase))
                }
                None => None,
            };
            let session = self
                .connector
                .open(OpenTarget {
                    config,
                    password,
                    ssh,
                })
                .await?;
            tracing::info!(
                component = "mcp",
                read_only = access != McpAccess::ReadWrite,
                "session opened"
            );
            self.sessions.insert(
                profile.id.clone(),
                OpenSession {
                    opened_for: wanted,
                    session,
                },
            );
        }
        Ok(&mut self
            .sessions
            .get_mut(&profile.id)
            .expect("inserted above")
            .session)
    }

    /// Runs SQL that TupleNest wrote itself (catalog reads): no policy check,
    /// no audit, no history.
    async fn internal(
        &mut self,
        profile: &ConnectionRecord,
        access: McpAccess,
        sql: &str,
        params: Vec<ParamValue>,
    ) -> Result<Ran, String> {
        self.execute(profile, access, sql, params)
            .await
            .map_err(|e| crate::pg::err_to_string(&e))
    }

    async fn execute(
        &mut self,
        profile: &ConnectionRecord,
        access: McpAccess,
        sql: &str,
        params: Vec<ParamValue>,
    ) -> Result<Ran, Box<DriverError>> {
        let session = self
            .session(profile, access)
            .await
            .map_err(|e| Box::new(DriverError::new(ErrorCategory::Network, e)))?;
        let sink = CollectSink::default();
        let request = QueryRequest {
            execution_id: ExecutionId::new(),
            sql: sql.to_string(),
            params,
            row_limit: ROW_CAP as u64,
        };
        match session.execute(request, &sink).await {
            Ok(summary) => {
                let c = sink.0.into_inner().unwrap_or_default();
                Ok(Ran {
                    truncated: summary.more_rows
                        || c.byte_capped
                        || summary.rows_returned > c.rows.len() as u64,
                    columns: c.columns,
                    rows: c.rows,
                    rows_affected: summary.rows_affected,
                    rows_returned: summary.rows_returned,
                    duration_ms: summary.duration_ms,
                })
            }
            Err(e) => {
                // A network failure means the session is gone; the next call
                // opens a new one rather than talking to a dead socket.
                if e.category == ErrorCategory::Network {
                    self.sessions.remove(&profile.id);
                }
                Err(e)
            }
        }
    }

    async fn list_schemas(&mut self, args: &Value) -> Result<ToolOutput, String> {
        let obj = args_object(args, &["connection"])?;
        let (profile, access) = self.resolve(&string_arg(obj, "connection", NAME_MAX)?)?;
        let ran = self
            .internal(
                &profile,
                access,
                "SELECT nspname::text AS schema FROM pg_catalog.pg_namespace \
                 WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' \
                 ORDER BY 1",
                vec![],
            )
            .await?;
        let schemas: Vec<Value> = ran
            .rows_json()
            .as_array()
            .map(|rows| rows.iter().filter_map(|r| r.get(0).cloned()).collect())
            .unwrap_or_default();
        Ok(ToolOutput::ok(
            json!({ "schemas": schemas, "truncated": ran.truncated }),
        ))
    }

    async fn list_tables(&mut self, args: &Value) -> Result<ToolOutput, String> {
        let obj = args_object(args, &["connection", "schema"])?;
        let (profile, access) = self.resolve(&string_arg(obj, "connection", NAME_MAX)?)?;
        let schema = string_arg(obj, "schema", NAME_MAX)?;
        let ran = self
            .internal(
                &profile,
                access,
                "SELECT c.relname::text AS name, \
                   CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned table' \
                     WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' \
                     WHEN 'f' THEN 'foreign table' END AS kind \
                 FROM pg_catalog.pg_class c \
                 JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = $1::text AND c.relkind IN ('r','p','v','m','f') \
                 ORDER BY 1",
                vec![ParamValue::Text(schema.clone())],
            )
            .await?;
        Ok(ToolOutput::ok(json!({
            "schema": schema,
            "tables": objects(&ran, &["name", "kind"]),
            "truncated": ran.truncated,
        })))
    }

    async fn describe_table(&mut self, args: &Value) -> Result<ToolOutput, String> {
        let obj = args_object(args, &["connection", "schema", "table"])?;
        let (profile, access) = self.resolve(&string_arg(obj, "connection", NAME_MAX)?)?;
        let schema = string_arg(obj, "schema", NAME_MAX)?;
        let table = string_arg(obj, "table", NAME_MAX)?;
        let target = || {
            vec![
                ParamValue::Text(schema.clone()),
                ParamValue::Text(table.clone()),
            ]
        };
        const REL: &str = "to_regclass(format('%I.%I', $1::text, $2::text))";
        let columns = self
            .internal(
                &profile,
                access,
                &format!(
                    "SELECT a.attname::text AS name, \
                       pg_catalog.format_type(a.atttypid, a.atttypmod) AS type, \
                       NOT a.attnotnull AS nullable, \
                       pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default \
                     FROM pg_catalog.pg_attribute a \
                     LEFT JOIN pg_catalog.pg_attrdef d \
                       ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
                     WHERE a.attrelid = {REL} AND a.attnum > 0 AND NOT a.attisdropped \
                     ORDER BY a.attnum"
                ),
                target(),
            )
            .await?;
        if columns.rows.is_empty() {
            return Err(format!("No table or view `{schema}`.`{table}` was found."));
        }
        let constraints = self
            .internal(
                &profile,
                access,
                &format!(
                    "SELECT conname::text AS name, \
                       CASE contype WHEN 'p' THEN 'primary key' WHEN 'f' THEN 'foreign key' \
                         WHEN 'u' THEN 'unique' WHEN 'c' THEN 'check' WHEN 'x' THEN 'exclusion' \
                         ELSE contype::text END AS kind, \
                       pg_catalog.pg_get_constraintdef(oid) AS definition \
                     FROM pg_catalog.pg_constraint WHERE conrelid = {REL} ORDER BY 1"
                ),
                target(),
            )
            .await?;
        let indexes = self
            .internal(
                &profile,
                access,
                &format!(
                    "SELECT c.relname::text AS name, pg_catalog.pg_get_indexdef(i.indexrelid) AS definition \
                     FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid \
                     WHERE i.indrelid = {REL} ORDER BY 1"
                ),
                target(),
            )
            .await?;
        Ok(ToolOutput::ok(json!({
            "schema": schema,
            "table": table,
            "columns": objects(&columns, &["name", "type", "nullable", "default"]),
            "constraints": objects(&constraints, &["name", "kind", "definition"]),
            "indexes": objects(&indexes, &["name", "definition"]),
        })))
    }

    /// Writes the audit row for a prod or staging statement, before it is
    /// sent. If it cannot be written, the statement is not sent.
    fn audit(&self, profile: &ConnectionRecord, key: &str, sql: &str) -> Result<(), String> {
        let env = profile.environment.as_deref();
        if !is_audited(env) {
            return Ok(());
        }
        let env = env.unwrap_or_default();
        let not_run = |why: String| {
            tracing::error!(
                component = "audit",
                "MCP audit write failed; statement refused"
            );
            format!(
                "Not run: this {env} statement could not be recorded in the audit log ({why}). \
                 Nothing was sent to the database."
            )
        };
        self.store()
            .map_err(&not_run)?
            .audit_add_by(
                key,
                Some(env),
                &crate::pg::redact_sql(sql),
                Some(&self.actor()),
            )
            .map_err(|e| not_run(e.to_string()))
    }

    /// The history row, as the app writes one: no SQL text on prod, nothing
    /// at all under `-- tuplenest:no-history`. A failure is logged, not
    /// returned — history is not what decides whether a statement ran.
    #[allow(clippy::too_many_arguments)]
    fn history(
        &self,
        profile: &ConnectionRecord,
        key: &str,
        sql: &str,
        status: &str,
        error_text: Option<String>,
        rows_returned: u64,
        rows_affected: Option<u64>,
        duration_ms: u64,
    ) {
        if crate::pg::opts_out_of_history(sql) {
            return;
        }
        let entry = HistoryEntry {
            id: uuid::Uuid::new_v4().to_string(),
            connection_key: key.to_string(),
            sql_text: (profile.environment.as_deref() != Some("prod"))
                .then(|| crate::pg::redact_sql(sql)),
            status: status.to_string(),
            error_text,
            rows_returned,
            rows_affected,
            started_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0),
            duration_ms,
            favorite: false,
            actor: Some(self.actor()),
        };
        let written = self
            .store()
            .and_then(|s| s.history_add(&entry, 1_000).map_err(|e| e.to_string()));
        if let Err(e) = written {
            tracing::warn!(component = "history", error = %e, "failed to record MCP history");
        }
    }

    /// Policy, audit, run, history — the path both SQL tools share.
    async fn run_checked(
        &mut self,
        profile: &ConnectionRecord,
        access: McpAccess,
        sql: &str,
        params: Vec<ParamValue>,
    ) -> Result<Ran, String> {
        let key = crate::pg::cache_key(
            &profile.username,
            &profile.host,
            profile.port,
            &profile.database,
        );
        // Connect first, so an unreachable server is not audited as sent.
        self.session(profile, access).await?;
        self.audit(profile, &key, sql)?;
        let started = std::time::Instant::now();
        match self.execute(profile, access, sql, params).await {
            Ok(ran) => {
                self.history(
                    profile,
                    &key,
                    sql,
                    "success",
                    None,
                    ran.rows_returned,
                    ran.rows_affected,
                    ran.duration_ms,
                );
                Ok(ran)
            }
            Err(e) => {
                self.history(
                    profile,
                    &key,
                    sql,
                    crate::pg::history_status(&e),
                    Some(crate::pg::persisted_error(&e)),
                    0,
                    None,
                    started.elapsed().as_millis() as u64,
                );
                Err(crate::pg::err_to_string(&e))
            }
        }
    }

    async fn run_query(&mut self, args: &Value) -> Result<ToolOutput, String> {
        let obj = args_object(args, &["connection", "sql", "params"])?;
        let name = string_arg(obj, "connection", NAME_MAX)?;
        let sql = string_arg(obj, "sql", SQL_MAX)?;
        let params = params_arg(obj)?;
        let (profile, access) = self.resolve(&name)?;
        check_statement(access, &sql)?;
        let ran = self.run_checked(&profile, access, &sql, params).await?;
        let columns: Vec<Value> = ran
            .columns
            .iter()
            .map(|(n, t)| json!({"name": n, "type": t}))
            .collect();
        Ok(ToolOutput::ok(json!({
            "columns": columns,
            "rows": ran.rows_json(),
            "rowCount": ran.rows.len(),
            "truncated": ran.truncated,
            "rowsAffected": ran.rows_affected,
            "elapsedMs": ran.duration_ms,
        })))
    }

    async fn explain(&mut self, args: &Value) -> Result<ToolOutput, String> {
        let obj = args_object(args, &["connection", "sql", "params"])?;
        let name = string_arg(obj, "connection", NAME_MAX)?;
        let sql = string_arg(obj, "sql", SQL_MAX)?;
        let params = params_arg(obj)?;
        let (profile, access) = self.resolve(&name)?;
        let word = first_word(&guard::mask_literals(&sql));
        if !EXPLAINABLE.contains(&word.as_str()) {
            return Err(format!(
                "Refused: explain takes a statement (SELECT, WITH, INSERT, UPDATE, DELETE, MERGE, \
                 VALUES or TABLE), without EXPLAIN or its options; got `{word}`. Nothing was run."
            ));
        }
        let statement = format!("EXPLAIN {sql}");
        check_statement(access, &statement)?;
        let ran = self
            .run_checked(&profile, access, &statement, params)
            .await?;
        let plan: Vec<String> = ran
            .rows_json()
            .as_array()
            .map(|rows| {
                rows.iter()
                    .filter_map(|r| r.get(0).and_then(Value::as_str).map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default();
        Ok(ToolOutput::ok(json!({ "plan": plan.join("\n") })))
    }
}

/// Rows as objects keyed by `names`, in column order.
fn objects(ran: &Ran, names: &[&str]) -> Vec<Value> {
    ran.rows_json()
        .as_array()
        .map(|rows| {
            rows.iter()
                .map(|r| {
                    let mut o = serde_json::Map::new();
                    for (i, n) in names.iter().enumerate() {
                        o.insert((*n).into(), r.get(i).cloned().unwrap_or(Value::Null));
                    }
                    Value::Object(o)
                })
                .collect()
        })
        .unwrap_or_default()
}
