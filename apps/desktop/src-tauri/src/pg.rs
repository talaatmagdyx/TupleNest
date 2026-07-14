//! Phase 0 PoC commands: PostgreSQL connect / test / query / cancel.
//!
//! Security invariants:
//! - The WebView sends a password exactly once (`pg_secret_save`); it is
//!   stored in the OS keychain and only the opaque ref returns to the UI.
//! - Query commands accept the ref; resolution happens here in the backend.
//! - Secrets and full query results never appear in logs.

use std::collections::BTreeMap;
use std::sync::Mutex as StdMutex;

use async_trait::async_trait;
use tokio::sync::Mutex as AsyncMutex;
use tuplenest_credential_store::{CredentialStore, KeychainStore, Secret};
use tuplenest_driver_api::{
    BatchSink, CellValue, ConnectionConfig, DatabaseSession, DriverError, Environment, ExecutionId,
    MetadataRequest, QueryRequest, RowBatch, SecretRef, TlsMode,
};
use tuplenest_driver_postgres::{PgCancelHandle, PostgresDriver, PostgresSession};

/// Connection parameters as sent from the WebView. Never contains a password.
#[derive(serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PgParams {
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    /// Opaque keychain reference from `pg_secret_save`, if auth is needed.
    pub secret_ref: Option<String>,
    /// "disabled" | "prefer" | "verify-ca" | "verify-full" (default).
    pub tls_mode: Option<String>,
    pub tls_ca_path: Option<String>,
}

fn parse_tls_mode(s: Option<&str>) -> Result<TlsMode, String> {
    match s.unwrap_or("verify-full") {
        "disabled" => Ok(TlsMode::Disabled),
        "prefer" => Ok(TlsMode::Prefer),
        "verify-ca" => Ok(TlsMode::VerifyCa),
        "verify-full" => Ok(TlsMode::VerifyFull),
        other => Err(format!("unknown tls mode `{other}`")),
    }
}

impl PgParams {
    fn to_config(&self) -> Result<ConnectionConfig, String> {
        Ok(ConnectionConfig {
            driver_id: "postgres".into(),
            name: format!("{}@{}/{}", self.username, self.host, self.database),
            environment: Environment::Dev,
            read_only: false,
            host: self.host.clone(),
            port: self.port,
            database: self.database.clone(),
            username: self.username.clone(),
            secret_ref: self.secret_ref.as_deref().map(SecretRef::new),
            tls_mode: parse_tls_mode(self.tls_mode.as_deref())?,
            tls_ca_path: self.tls_ca_path.clone(),
            options: BTreeMap::new(),
            default_statement_timeout_ms: 0,
        })
    }
}

pub struct PgState {
    session: AsyncMutex<Option<PostgresSession>>,
    cancel: StdMutex<Option<PgCancelHandle>>,
    /// Metadata cache (E1.3): instant explorer loads + offline browsing.
    cache: StdMutex<tuplenest_metadata_cache::MetadataCache>,
    /// Cache key of the currently connected session.
    cache_key: StdMutex<Option<String>>,
    /// Last query's rows, held backend-side for windowed paging.
    result: StdMutex<Option<StoredResult>>,
}

impl PgState {
    pub fn new(cache: tuplenest_metadata_cache::MetadataCache) -> Self {
        Self {
            session: AsyncMutex::new(None),
            cancel: StdMutex::new(None),
            cache: StdMutex::new(cache),
            cache_key: StdMutex::new(None),
            result: StdMutex::new(None),
        }
    }
}

/// Stable, secret-free cache identity for a connection target.
fn cache_key_of(p: &PgParams) -> String {
    format!("{}@{}:{}/{}", p.username, p.host, p.port, p.database)
}

fn resolve_password(secret_ref: &Option<String>) -> Result<Option<Secret>, String> {
    match secret_ref {
        None => Ok(None),
        Some(key) => KeychainStore::new()
            .get(&SecretRef::new(key.clone()))
            .map(Some)
            .map_err(|e| e.to_string()),
    }
}

fn err_to_string(e: DriverError) -> String {
    // DriverError's Display is already sanitized (no credentials by design).
    e.to_string()
}

/// Stores a password in the OS keychain; returns the opaque reference key.
/// This is the ONLY command that ever sees a secret, and it does not log it.
#[tauri::command]
pub fn pg_secret_save(password: String) -> Result<String, String> {
    KeychainStore::new()
        .set(Secret::new(password))
        .map(|r| r.key().to_string())
        .map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestStageOut {
    name: String,
    passed: bool,
    duration_ms: u64,
    detail: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestReportOut {
    server_version: Option<String>,
    stages: Vec<TestStageOut>,
}

fn stage_out(s: tuplenest_driver_api::TestStage) -> TestStageOut {
    TestStageOut {
        name: s.name,
        passed: matches!(s.status, tuplenest_driver_api::TestStageStatus::Passed),
        duration_ms: s.duration_ms,
        detail: s.detail,
    }
}

/// Staged connection test (E1.2): DNS → TCP via connection-core, then
/// auth + server version via the driver. Stops at the first failure.
#[tauri::command]
pub async fn pg_test(params: PgParams) -> Result<TestReportOut, String> {
    let probe = tuplenest_connection_core::probe(
        &params.host,
        params.port,
        std::time::Duration::from_secs(5),
    )
    .await;
    let mut stages: Vec<TestStageOut> = probe.stages.into_iter().map(stage_out).collect();

    if !probe.reachable {
        return Ok(TestReportOut {
            server_version: None,
            stages,
        });
    }

    let password = resolve_password(&params.secret_ref)?;
    let report = PostgresDriver
        .test_with_password(&params.to_config()?, password.as_ref().map(|s| s.expose()))
        .await
        .map_err(err_to_string)?;
    stages.extend(report.stages.into_iter().map(|mut s| {
        // In the combined report the driver's "connect" stage is the
        // authenticated session open, i.e. the auth stage.
        if s.name == "connect" {
            s.name = "auth".into();
        }
        stage_out(s)
    }));
    Ok(TestReportOut {
        server_version: report.server_version,
        stages,
    })
}

#[tauri::command]
pub async fn pg_connect(state: tauri::State<'_, PgState>, params: PgParams) -> Result<(), String> {
    let password = resolve_password(&params.secret_ref)?;
    let session = PostgresDriver
        .connect_concrete_with_password(params.to_config()?, password.as_ref().map(|s| s.expose()))
        .await
        .map_err(err_to_string)?;
    *state.cancel.lock().map_err(|_| "cancel lock poisoned")? = Some(session.cancel_handle());
    *state.session.lock().await = Some(session);
    *state.cache_key.lock().map_err(|_| "key lock poisoned")? = Some(cache_key_of(&params));
    tracing::info!(component = "pg", host = %params.host, db = %params.database, "session opened");
    Ok(())
}

#[tauri::command]
pub async fn pg_disconnect(state: tauri::State<'_, PgState>) -> Result<(), String> {
    *state.session.lock().await = None;
    *state.cancel.lock().map_err(|_| "cancel lock poisoned")? = None;
    *state.result.lock().map_err(|_| "result lock poisoned")? = None;
    tracing::info!(component = "pg", "session closed");
    Ok(())
}

fn cell_to_json(cell: CellValue) -> serde_json::Value {
    match cell {
        CellValue::Null => serde_json::Value::Null,
        CellValue::Bool(b) => b.into(),
        CellValue::Int(i) => i.into(),
        CellValue::Float(f) => serde_json::Number::from_f64(f)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        CellValue::Text(t) => t.into(),
        CellValue::Bytes(b) => format!("\\x{}", hex(&b)).into(),
        CellValue::Json(v) => v,
        CellValue::Other { rendered, .. } => rendered.into(),
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Backend-held result of the last query: the WebView pages windows out of
/// this store (`pg_rows`) instead of receiving the full row set over IPC.
pub struct StoredResult {
    columns: Vec<(String, String)>,
    store: tuplenest_result_stream::RowStore<Vec<serde_json::Value>>,
}

/// Hard cap on rows kept for scrolling. Beyond this the stream is still
/// drained and counted, but rows are dropped and the result marked truncated.
const RESULT_STORE_CAP: usize = 100_000;

/// Streams batches into a bounded RowStore.
struct StoreSink {
    inner: StdMutex<StoredResult>,
}

#[async_trait]
impl BatchSink for StoreSink {
    async fn deliver(&self, batch: RowBatch) -> Result<(), DriverError> {
        let mut inner = self.inner.lock().expect("sink lock");
        if inner.columns.is_empty() {
            inner.columns = batch
                .columns
                .iter()
                .map(|c| (c.name.clone(), c.db_type.clone()))
                .collect();
        }
        for row in batch.rows {
            inner
                .store
                .push(row.into_iter().map(cell_to_json).collect());
        }
        Ok(())
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResultOut {
    columns: Vec<ColumnOut>,
    /// Rows seen from the server (including any dropped past the cap).
    total_rows: u64,
    /// Rows available for paging via `pg_rows`.
    stored_rows: usize,
    truncated: bool,
    rows_affected: Option<u64>,
    elapsed_ms: u64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnOut {
    name: String,
    db_type: String,
}

/// Runs SQL on the active session. Rows stream into the backend store;
/// the WebView pages them with `pg_rows`.
#[tauri::command]
pub async fn pg_query(
    state: tauri::State<'_, PgState>,
    sql: String,
) -> Result<QueryResultOut, String> {
    // Drop the previous result before running (frees memory immediately).
    *state.result.lock().map_err(|_| "result lock poisoned")? = None;

    let mut guard = state.session.lock().await;
    let session = guard.as_mut().ok_or("not connected")?;

    let sink = StoreSink {
        inner: StdMutex::new(StoredResult {
            columns: Vec::new(),
            store: tuplenest_result_stream::RowStore::new(RESULT_STORE_CAP),
        }),
    };
    let request = QueryRequest {
        execution_id: ExecutionId::new(),
        sql,
        params: vec![],
        row_limit: 0,
        timeout_ms: 0,
    };
    let summary = session
        .execute(request, &sink)
        .await
        .map_err(err_to_string)?;
    let stored = sink.inner.into_inner().map_err(|_| "sink lock poisoned")?;
    tracing::info!(
        component = "pg",
        rows = stored.store.total_seen(),
        duration_ms = summary.duration_ms,
        "query finished" // NOTE: query text is deliberately not logged
    );
    let out = QueryResultOut {
        columns: stored
            .columns
            .iter()
            .map(|(name, db_type)| ColumnOut {
                name: name.clone(),
                db_type: db_type.clone(),
            })
            .collect(),
        total_rows: stored.store.total_seen(),
        stored_rows: stored.store.stored(),
        truncated: stored.store.truncated(),
        rows_affected: summary.rows_affected,
        elapsed_ms: summary.duration_ms,
    };
    *state.result.lock().map_err(|_| "result lock poisoned")? = Some(stored);
    Ok(out)
}

/// Pages a window of rows out of the last query's backend store.
#[tauri::command]
pub fn pg_rows(
    state: tauri::State<'_, PgState>,
    offset: usize,
    limit: usize,
) -> Result<Vec<Vec<serde_json::Value>>, String> {
    let guard = state.result.lock().map_err(|_| "result lock poisoned")?;
    let stored = guard.as_ref().ok_or("no result")?;
    Ok(stored.store.window(offset, limit.min(1_000)).to_vec())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataOut {
    pub payload: serde_json::Value,
    /// True when served from the local cache rather than the live server.
    pub cached: bool,
    /// Unix seconds of the cache write, when `cached`.
    pub fetched_at: Option<i64>,
}

/// (object_type, schema_scope, name_scope) addressing for a request.
fn cache_scope(request: &MetadataRequest) -> (&'static str, String, String) {
    match request {
        MetadataRequest::ServerInfo => ("server", String::new(), String::new()),
        MetadataRequest::ListSchemas => ("schema", String::new(), String::new()),
        MetadataRequest::ListObjects { schema } => ("object", schema.clone(), String::new()),
        MetadataRequest::DescribeObject { schema, name } => {
            ("columns", schema.clone(), name.clone())
        }
    }
}

fn read_cache(
    state: &PgState,
    key: &str,
    request: &MetadataRequest,
) -> Result<Option<MetadataOut>, String> {
    let cache = state.cache.lock().map_err(|_| "cache lock poisoned")?;
    let (object_type, schema, name) = cache_scope(request);
    let out = match request {
        MetadataRequest::ListSchemas | MetadataRequest::ListObjects { .. } => {
            let entries = cache
                .list(key, object_type, &schema)
                .map_err(|e| e.to_string())?;
            if entries.is_empty() {
                None
            } else {
                let fetched_at = entries.iter().map(|e| e.fetched_at).min();
                let items: Result<Vec<serde_json::Value>, _> = entries
                    .iter()
                    .map(|e| serde_json::from_str(&e.payload_json))
                    .collect();
                Some(MetadataOut {
                    payload: serde_json::Value::Array(items.map_err(|e| e.to_string())?),
                    cached: true,
                    fetched_at,
                })
            }
        }
        _ => cache
            .get(key, object_type, &schema, &name)
            .map_err(|e| e.to_string())?
            .map(|entry| {
                Ok::<_, String>(MetadataOut {
                    payload: serde_json::from_str(&entry.payload_json)
                        .map_err(|e| e.to_string())?,
                    cached: true,
                    fetched_at: Some(entry.fetched_at),
                })
            })
            .transpose()?,
    };
    Ok(out)
}

fn write_cache(
    state: &PgState,
    key: &str,
    request: &MetadataRequest,
    payload: &serde_json::Value,
) -> Result<(), String> {
    let mut cache = state.cache.lock().map_err(|_| "cache lock poisoned")?;
    let (object_type, schema, name) = cache_scope(request);
    match request {
        MetadataRequest::ListSchemas => {
            // Payload is an array of schema-name strings.
            let entries: Vec<(String, String)> = payload
                .as_array()
                .unwrap_or(&vec![])
                .iter()
                .filter_map(|v| {
                    v.as_str()
                        .map(|s| (s.to_string(), serde_json::json!(s).to_string()))
                })
                .collect();
            cache
                .replace_list(key, object_type, &schema, &entries)
                .map_err(|e| e.to_string())
        }
        MetadataRequest::ListObjects { .. } => {
            // Payload is an array of {name, kind, comment} objects.
            let entries: Vec<(String, String)> = payload
                .as_array()
                .unwrap_or(&vec![])
                .iter()
                .filter_map(|v| v["name"].as_str().map(|n| (n.to_string(), v.to_string())))
                .collect();
            cache
                .replace_list(key, object_type, &schema, &entries)
                .map_err(|e| e.to_string())
        }
        _ => cache
            .put(key, object_type, &schema, &name, &payload.to_string())
            .map_err(|e| e.to_string()),
    }
}

/// Metadata for the explorer tree (E1.3). Live when connected — with
/// write-through to the cache — falling back to cached data on live errors.
#[tauri::command]
pub async fn pg_metadata(
    state: tauri::State<'_, PgState>,
    request: MetadataRequest,
) -> Result<MetadataOut, String> {
    let key = state
        .cache_key
        .lock()
        .map_err(|_| "key lock poisoned")?
        .clone();
    let guard = state.session.lock().await;
    let session = guard.as_ref().ok_or("not connected")?;
    match session.metadata(request.clone()).await {
        Ok(response) => {
            if let Some(key) = &key {
                // Cache failures must never break live metadata.
                if let Err(e) = write_cache(&state, key, &request, &response.payload) {
                    tracing::warn!(component = "metadata-cache", error = %e, "write-through failed");
                }
            }
            Ok(MetadataOut {
                payload: response.payload,
                cached: false,
                fetched_at: None,
            })
        }
        Err(live_err) => {
            if let Some(key) = &key {
                if let Some(cached) = read_cache(&state, key, &request)? {
                    tracing::warn!(
                        component = "metadata-cache",
                        "serving stale cache after live failure"
                    );
                    return Ok(cached);
                }
            }
            Err(err_to_string(live_err))
        }
    }
}

/// Cache-only metadata: renders the explorer for a saved profile before —
/// or without — connecting. Never touches the network.
#[tauri::command]
pub fn pg_metadata_cached(
    state: tauri::State<'_, PgState>,
    params: PgParams,
    request: MetadataRequest,
) -> Result<Option<MetadataOut>, String> {
    read_cache(&state, &cache_key_of(&params), &request)
}

/// Cancels the in-flight query via the wire-protocol cancel key. Does not
/// require the session lock, so it works while `pg_query` is blocked.
#[tauri::command]
pub async fn pg_cancel(state: tauri::State<'_, PgState>) -> Result<(), String> {
    let handle = state
        .cancel
        .lock()
        .map_err(|_| "cancel lock poisoned")?
        .clone()
        .ok_or("not connected")?;
    handle.cancel().await.map_err(err_to_string)
}
