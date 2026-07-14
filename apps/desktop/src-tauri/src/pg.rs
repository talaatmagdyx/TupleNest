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
}

impl Default for PgState {
    fn default() -> Self {
        Self {
            session: AsyncMutex::new(None),
            cancel: StdMutex::new(None),
        }
    }
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
    tracing::info!(component = "pg", host = %params.host, db = %params.database, "session opened");
    Ok(())
}

#[tauri::command]
pub async fn pg_disconnect(state: tauri::State<'_, PgState>) -> Result<(), String> {
    *state.session.lock().await = None;
    *state.cancel.lock().map_err(|_| "cancel lock poisoned")? = None;
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

/// Collects up to `max_rows` rows in memory for display; counts the rest.
struct CollectSink {
    max_rows: usize,
    inner: StdMutex<CollectInner>,
}

#[derive(Default)]
struct CollectInner {
    columns: Vec<(String, String)>,
    rows: Vec<Vec<serde_json::Value>>,
    total: u64,
}

#[async_trait]
impl BatchSink for CollectSink {
    async fn deliver(&self, batch: RowBatch) -> Result<(), DriverError> {
        let mut inner = self.inner.lock().expect("sink lock");
        if inner.columns.is_empty() {
            inner.columns = batch
                .columns
                .iter()
                .map(|c| (c.name.clone(), c.db_type.clone()))
                .collect();
        }
        inner.total += batch.rows.len() as u64;
        let room = self.max_rows.saturating_sub(inner.rows.len());
        for row in batch.rows.into_iter().take(room) {
            let json_row = row.into_iter().map(cell_to_json).collect();
            inner.rows.push(json_row);
        }
        Ok(())
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResultOut {
    columns: Vec<ColumnOut>,
    rows: Vec<Vec<serde_json::Value>>,
    total_rows: u64,
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

/// Runs SQL on the active session, returning up to `maxRows` rows for
/// display (the full stream is still drained and counted).
#[tauri::command]
pub async fn pg_query(
    state: tauri::State<'_, PgState>,
    sql: String,
    max_rows: Option<usize>,
) -> Result<QueryResultOut, String> {
    let mut guard = state.session.lock().await;
    let session = guard.as_mut().ok_or("not connected")?;

    let sink = CollectSink {
        max_rows: max_rows.unwrap_or(500).min(10_000),
        inner: StdMutex::new(CollectInner::default()),
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
    let inner = sink.inner.into_inner().map_err(|_| "sink lock poisoned")?;
    tracing::info!(
        component = "pg",
        rows = inner.total,
        duration_ms = summary.duration_ms,
        "query finished" // NOTE: query text is deliberately not logged
    );
    Ok(QueryResultOut {
        truncated: (inner.rows.len() as u64) < inner.total,
        columns: inner
            .columns
            .into_iter()
            .map(|(name, db_type)| ColumnOut { name, db_type })
            .collect(),
        rows: inner.rows,
        total_rows: inner.total,
        rows_affected: summary.rows_affected,
        elapsed_ms: summary.duration_ms,
    })
}

/// Metadata for the explorer tree (E1.3). `request` mirrors driver-api's
/// MetadataRequest: {"kind":"list_schemas"} | {"kind":"list_objects","schema":..}
/// | {"kind":"describe_object","schema":..,"name":..}.
#[tauri::command]
pub async fn pg_metadata(
    state: tauri::State<'_, PgState>,
    request: MetadataRequest,
) -> Result<serde_json::Value, String> {
    let guard = state.session.lock().await;
    let session = guard.as_ref().ok_or("not connected")?;
    let response = session.metadata(request).await.map_err(err_to_string)?;
    Ok(response.payload)
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
