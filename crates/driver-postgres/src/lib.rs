//! PostgreSQL driver — Phase 0 proof of concept (master spec E0.9).
//!
//! Proves the driver contract end to end against a real server: staged
//! connection test, batched result streaming with bounded memory, and
//! server-side query cancellation.
//!
//! Phase 0 limitations (addressed in Phase 1 / E1.1–E1.2):
//! - No TLS or SSH tunnel yet (`TlsMode::Disabled` only; local development).
//! - Passwords are not resolved from the keychain yet; local trust/peer auth.
//! - Type conversion covers common types; the rest render as `Other`.

use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use tokio::sync::Mutex as AsyncMutex;
use tokio_postgres::error::SqlState;
use tokio_postgres::types::Type;
use tokio_postgres::{CancelToken, Client, NoTls, Row};

mod tls;
pub use tls::TlsSetup;

/// Connects with the right TLS posture; returns the client plus the spawned
/// connection task handle.
async fn connect_client(
    pgcfg: &tokio_postgres::Config,
    setup: &TlsSetup,
) -> Result<(Client, tokio::task::JoinHandle<()>), tokio_postgres::Error> {
    match setup.make() {
        None => {
            let (client, connection) = pgcfg.connect(NoTls).await?;
            let handle = tokio::spawn(async move {
                let _ = connection.await;
            });
            Ok((client, handle))
        }
        Some(mk) => {
            let (client, connection) = pgcfg.connect(mk).await?;
            let handle = tokio::spawn(async move {
                let _ = connection.await;
            });
            Ok((client, handle))
        }
    }
}

/// Cancels via the wire-protocol cancel key, matching the session's TLS posture.
async fn cancel_with(token: CancelToken, setup: &TlsSetup) -> Result<(), tokio_postgres::Error> {
    match setup.make() {
        None => token.cancel_query(NoTls).await,
        Some(mk) => token.cancel_query(mk).await,
    }
}
use tuplenest_driver_api::*;

/// Rows per streamed batch. Bounds memory: only one batch is materialized
/// between `deliver` calls.
pub const BATCH_SIZE: usize = 1_000;

pub struct PostgresDriver;

impl PostgresDriver {
    /// `password` is resolved by the caller (connection-core / app shell)
    /// from the credential store; this crate never touches the keychain.
    fn pg_config(config: &ConnectionConfig, password: Option<&str>) -> tokio_postgres::Config {
        let mut c = tokio_postgres::Config::new();
        c.host(&config.host)
            .port(config.port)
            .dbname(&config.database)
            .user(&config.username)
            .application_name("TupleNest");
        if let Some(pw) = password {
            c.password(pw);
        }
        c
    }

    /// [`DatabaseDriver::test`] with an explicit resolved password.
    pub async fn test_with_password(
        &self,
        config: &ConnectionConfig,
        password: Option<&str>,
    ) -> Result<ConnectionTestReport, DriverError> {
        let mut stages = Vec::new();

        // TLS configuration errors fail closed before any network activity.
        let setup = match tls::build(config) {
            Ok(s) => s,
            Err(e) => {
                stages.push(TestStage {
                    name: "tls".into(),
                    status: TestStageStatus::Failed,
                    duration_ms: 0,
                    detail: Some(e.to_string()),
                });
                return Ok(ConnectionTestReport {
                    stages,
                    server_version: None,
                });
            }
        };
        let tls_detail = match config.tls_mode {
            TlsMode::Disabled => "plaintext".to_string(),
            mode => format!("tls: {mode:?}"),
        };

        let started = Instant::now();
        let result = connect_client(&Self::pg_config(config, password), &setup).await;
        let elapsed = started.elapsed().as_millis() as u64;
        match result {
            Ok((client, handle)) => {
                stages.push(TestStage {
                    name: "connect".into(),
                    status: TestStageStatus::Passed,
                    duration_ms: elapsed,
                    detail: Some(tls_detail),
                });
                let vstart = Instant::now();
                let version: Option<String> = client
                    .query_one("SHOW server_version", &[])
                    .await
                    .ok()
                    .map(|r| r.get(0));
                stages.push(TestStage {
                    name: "server version".into(),
                    status: if version.is_some() {
                        TestStageStatus::Passed
                    } else {
                        TestStageStatus::Failed
                    },
                    duration_ms: vstart.elapsed().as_millis() as u64,
                    detail: version.clone(),
                });
                drop(client);
                let _ = handle.await;
                Ok(ConnectionTestReport {
                    stages,
                    server_version: version,
                })
            }
            Err(e) => {
                stages.push(TestStage {
                    name: "connect".into(),
                    status: TestStageStatus::Failed,
                    duration_ms: elapsed,
                    detail: Some(e.to_string()),
                });
                Ok(ConnectionTestReport {
                    stages,
                    server_version: None,
                })
            }
        }
    }
}

#[async_trait]
impl DatabaseDriver for PostgresDriver {
    fn descriptor(&self) -> DriverDescriptor {
        DriverDescriptor {
            id: "postgres".into(),
            display_name: "PostgreSQL".into(),
            version: env!("CARGO_PKG_VERSION").into(),
            maturity: DriverMaturity::Experimental,
            supported_server_versions: vec![
                "13".into(),
                "14".into(),
                "15".into(),
                "16".into(),
                "17".into(),
                "18".into(),
            ],
        }
    }

    fn capabilities(&self) -> DriverCapabilities {
        DriverCapabilities {
            sql: true,
            transactions: true,
            savepoints: true,
            query_cancellation: true,
            editable_results: true,
            explain: true,
            explain_analyze: true,
            schemas: true,
            catalogs: true,
            functions: true,
            procedures: true,
            triggers: true,
            roles: true,
            ..Default::default()
        }
    }

    async fn test(&self, config: ConnectionConfig) -> Result<ConnectionTestReport, DriverError> {
        self.test_with_password(&config, None).await
    }

    async fn connect(
        &self,
        config: ConnectionConfig,
    ) -> Result<Box<dyn DatabaseSession>, DriverError> {
        Ok(Box::new(
            self.connect_concrete_with_password(config, None).await?,
        ))
    }
}

pub struct PostgresSession {
    client: Client,
    cancel_token: Arc<AsyncMutex<CancelToken>>,
    tls: TlsSetup,
    _conn_task: tokio::task::JoinHandle<()>,
    in_transaction: Option<TransactionId>,
}

/// A cloneable handle that can cancel the session's running query without
/// borrowing the session. Backed by the PostgreSQL wire-protocol cancel key.
#[derive(Clone)]
pub struct PgCancelHandle {
    token: Arc<AsyncMutex<CancelToken>>,
    tls: TlsSetup,
}

impl PgCancelHandle {
    pub async fn cancel(&self) -> Result<(), DriverError> {
        let token = self.token.lock().await.clone();
        cancel_with(token, &self.tls).await.map_err(normalize_error)
    }
}

impl PostgresSession {
    /// Cancel (soft) or terminate (hard) another backend by pid — powers the
    /// monitoring panel's actions. Returns whether the admin call succeeded.
    pub async fn admin_backend(&self, pid: i32, terminate: bool) -> Result<bool, DriverError> {
        let sql = if terminate {
            "SELECT pg_terminate_backend($1)"
        } else {
            "SELECT pg_cancel_backend($1)"
        };
        let row = self
            .client
            .query_one(sql, &[&pid])
            .await
            .map_err(normalize_error)?;
        Ok(row.get::<_, bool>(0))
    }

    pub fn cancel_handle(&self) -> PgCancelHandle {
        PgCancelHandle {
            token: self.cancel_token.clone(),
            tls: self.tls.clone(),
        }
    }
}

impl PostgresDriver {
    /// Like [`DatabaseDriver::connect`] but returns the concrete session type,
    /// giving access to [`PostgresSession::cancel_handle`].
    pub async fn connect_concrete(
        &self,
        config: ConnectionConfig,
    ) -> Result<PostgresSession, DriverError> {
        self.connect_concrete_with_password(config, None).await
    }

    /// Like [`PostgresDriver::connect_concrete`] with an explicit resolved password.
    pub async fn connect_concrete_with_password(
        &self,
        config: ConnectionConfig,
        password: Option<&str>,
    ) -> Result<PostgresSession, DriverError> {
        let setup = tls::build(&config)?;
        let (client, conn_task) = connect_client(&Self::pg_config(&config, password), &setup)
            .await
            .map_err(normalize_error)?;
        let cancel_token = client.cancel_token();
        Ok(PostgresSession {
            client,
            cancel_token: Arc::new(AsyncMutex::new(cancel_token)),
            tls: setup,
            _conn_task: conn_task,
            in_transaction: None,
        })
    }
}

#[async_trait]
impl DatabaseSession for PostgresSession {
    async fn execute(
        &mut self,
        request: QueryRequest,
        sink: &dyn BatchSink,
    ) -> Result<ExecutionSummary, DriverError> {
        use futures_util::StreamExt;
        let started = Instant::now();

        let params: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = Vec::new();
        if !request.params.is_empty() {
            return Err(DriverError::new(
                ErrorCategory::Unsupported,
                "Parameters not supported in the Phase 0 proof of concept",
            ));
        }

        let stream = self
            .client
            .query_raw(request.sql.as_str(), params)
            .await
            .map_err(normalize_error)?;
        tokio::pin!(stream);

        let mut columns: Vec<ColumnMeta> = Vec::new();
        let mut buffer: Vec<Vec<CellValue>> = Vec::with_capacity(BATCH_SIZE);
        let mut sequence = 0u64;
        let mut rows_returned = 0u64;

        while let Some(item) = stream.next().await {
            let row = item.map_err(normalize_error)?;
            if columns.is_empty() {
                columns = row
                    .columns()
                    .iter()
                    .map(|c| ColumnMeta {
                        name: c.name().to_string(),
                        db_type: c.type_().name().to_string(),
                        nullable: None,
                    })
                    .collect();
            }
            buffer.push(convert_row(&row));
            rows_returned += 1;
            if buffer.len() >= BATCH_SIZE {
                sink.deliver(RowBatch {
                    execution_id: request.execution_id,
                    sequence,
                    columns: columns.clone(),
                    rows: std::mem::take(&mut buffer),
                    is_last: false,
                })
                .await?;
                sequence += 1;
                buffer.reserve(BATCH_SIZE);
            }
        }

        sink.deliver(RowBatch {
            execution_id: request.execution_id,
            sequence,
            columns,
            rows: std::mem::take(&mut buffer),
            is_last: true,
        })
        .await?;

        Ok(ExecutionSummary {
            execution_id: request.execution_id,
            status: ExecutionStatus::Success,
            rows_affected: None,
            rows_returned,
            duration_ms: started.elapsed().as_millis() as u64,
            messages: Vec::new(),
        })
    }

    async fn cancel(&self, _execution_id: ExecutionId) -> Result<(), DriverError> {
        let token = self.cancel_token.lock().await.clone();
        cancel_with(token, &self.tls).await.map_err(normalize_error)
    }

    async fn metadata(&self, request: MetadataRequest) -> Result<MetadataResponse, DriverError> {
        let payload = match request {
            MetadataRequest::ServerInfo => {
                let row = self
                    .client
                    .query_one("SELECT version(), current_database()", &[])
                    .await
                    .map_err(normalize_error)?;
                serde_json::json!({
                    "version": row.get::<_, String>(0),
                    "database": row.get::<_, String>(1),
                })
            }
            MetadataRequest::ListSchemas => {
                let rows = self
                    .client
                    .query(
                        "SELECT nspname FROM pg_namespace
                         WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema'
                         ORDER BY nspname",
                        &[],
                    )
                    .await
                    .map_err(normalize_error)?;
                serde_json::json!(rows
                    .iter()
                    .map(|r| r.get::<_, String>(0))
                    .collect::<Vec<_>>())
            }
            MetadataRequest::ListObjects { schema } => {
                let rows = self
                    .client
                    .query(
                        "SELECT c.relname,
                                CASE c.relkind
                                  WHEN 'r' THEN 'table'
                                  WHEN 'p' THEN 'table'
                                  WHEN 'v' THEN 'view'
                                  WHEN 'm' THEN 'matview'
                                  WHEN 'f' THEN 'foreign'
                                END AS kind,
                                obj_description(c.oid, 'pg_class') AS comment
                         FROM pg_class c
                         JOIN pg_namespace n ON n.oid = c.relnamespace
                         WHERE n.nspname = $1
                           AND c.relkind IN ('r','p','v','m','f')
                         ORDER BY c.relname",
                        &[&schema],
                    )
                    .await
                    .map_err(normalize_error)?;
                serde_json::json!(rows
                    .iter()
                    .map(|r| {
                        serde_json::json!({
                            "name": r.get::<_, String>(0),
                            "kind": r.get::<_, String>(1),
                            "comment": r.get::<_, Option<String>>(2),
                        })
                    })
                    .collect::<Vec<_>>())
            }
            MetadataRequest::DescribeObject { schema, name } => {
                let rows = self
                    .client
                    .query(
                        "SELECT a.attname,
                                format_type(a.atttypid, a.atttypmod) AS db_type,
                                NOT a.attnotnull AS nullable,
                                COALESCE((
                                  SELECT TRUE FROM pg_index i
                                  WHERE i.indrelid = a.attrelid AND i.indisprimary
                                    AND a.attnum = ANY (i.indkey)
                                ), FALSE) AS primary_key,
                                col_description(a.attrelid, a.attnum) AS comment
                         FROM pg_attribute a
                         JOIN pg_class c ON c.oid = a.attrelid
                         JOIN pg_namespace n ON n.oid = c.relnamespace
                         WHERE n.nspname = $1 AND c.relname = $2
                           AND a.attnum > 0 AND NOT a.attisdropped
                         ORDER BY a.attnum",
                        &[&schema, &name],
                    )
                    .await
                    .map_err(normalize_error)?;
                if rows.is_empty() {
                    return Err(DriverError::new(
                        ErrorCategory::Configuration,
                        format!("Relation {schema}.{name} not found"),
                    ));
                }
                // Indexes + size/row estimates for the object-detail view.
                let idx_rows = self
                    .client
                    .query(
                        "SELECT indexname, indexdef FROM pg_indexes
                         WHERE schemaname = $1 AND tablename = $2
                         ORDER BY indexname",
                        &[&schema, &name],
                    )
                    .await
                    .unwrap_or_default();
                let stats_row = self
                    .client
                    .query_opt(
                        "SELECT c.reltuples::bigint,
                                pg_size_pretty(pg_total_relation_size(c.oid)),
                                obj_description(c.oid, 'pg_class')
                         FROM pg_class c
                         JOIN pg_namespace n ON n.oid = c.relnamespace
                         WHERE n.nspname = $1 AND c.relname = $2",
                        &[&schema, &name],
                    )
                    .await
                    .ok()
                    .flatten();
                serde_json::json!({
                    "columns": rows
                        .iter()
                        .map(|r| {
                            serde_json::json!({
                                "name": r.get::<_, String>(0),
                                "dbType": r.get::<_, String>(1),
                                "nullable": r.get::<_, bool>(2),
                                "primaryKey": r.get::<_, bool>(3),
                                "comment": r.get::<_, Option<String>>(4),
                            })
                        })
                        .collect::<Vec<_>>(),
                    "indexes": idx_rows
                        .iter()
                        .map(|r| {
                            serde_json::json!({
                                "name": r.get::<_, String>(0),
                                "def": r.get::<_, String>(1),
                            })
                        })
                        .collect::<Vec<_>>(),
                    "rowsEstimate": stats_row.as_ref().map(|r| r.get::<_, i64>(0)),
                    "totalSize": stats_row.as_ref().map(|r| r.get::<_, String>(1)),
                    "comment": stats_row.as_ref().and_then(|r| r.get::<_, Option<String>>(2)),
                })
            }
            MetadataRequest::ServerActivity => {
                // Sessions from pg_stat_activity (excluding this session).
                let sessions = self
                    .client
                    .query(
                        "SELECT pid, usename, datname, application_name, client_addr::text,
                                state, wait_event_type, wait_event,
                                EXTRACT(EPOCH FROM (now() - query_start))::bigint AS secs,
                                left(query, 240) AS query
                         FROM pg_stat_activity
                         WHERE pid <> pg_backend_pid() AND backend_type = 'client backend'
                         ORDER BY query_start NULLS LAST
                         LIMIT 200",
                        &[],
                    )
                    .await
                    .map_err(normalize_error)?;
                // Locks that are currently NOT granted (blocking situations).
                let locks = self
                    .client
                    .query(
                        "SELECT bl.pid AS blocked_pid, ka.usename AS blocked_user,
                                bl.locktype, bl.mode,
                                COALESCE(cl.relname, bl.locktype) AS object
                         FROM pg_locks bl
                         JOIN pg_stat_activity ka ON ka.pid = bl.pid
                         LEFT JOIN pg_class cl ON cl.oid = bl.relation
                         WHERE NOT bl.granted
                         LIMIT 100",
                        &[],
                    )
                    .await
                    .map_err(normalize_error)?;
                // Database-wide stats.
                let db = self
                    .client
                    .query_one(
                        "SELECT numbackends, xact_commit, xact_rollback,
                                blks_hit, blks_read, tup_returned, tup_fetched,
                                pg_size_pretty(pg_database_size(current_database()))
                         FROM pg_stat_database WHERE datname = current_database()",
                        &[],
                    )
                    .await
                    .map_err(normalize_error)?;
                serde_json::json!({
                    "sessions": sessions.iter().map(|r| serde_json::json!({
                        "pid": r.get::<_, i32>(0),
                        "user": r.get::<_, Option<String>>(1),
                        "database": r.get::<_, Option<String>>(2),
                        "application": r.get::<_, Option<String>>(3),
                        "clientAddr": r.get::<_, Option<String>>(4),
                        "state": r.get::<_, Option<String>>(5),
                        "waitType": r.get::<_, Option<String>>(6),
                        "waitEvent": r.get::<_, Option<String>>(7),
                        "seconds": r.get::<_, Option<i64>>(8),
                        "query": r.get::<_, Option<String>>(9),
                    })).collect::<Vec<_>>(),
                    "locks": locks.iter().map(|r| serde_json::json!({
                        "blockedPid": r.get::<_, i32>(0),
                        "blockedUser": r.get::<_, Option<String>>(1),
                        "lockType": r.get::<_, String>(2),
                        "mode": r.get::<_, Option<String>>(3),
                        "object": r.get::<_, String>(4),
                    })).collect::<Vec<_>>(),
                    "db": {
                        "backends": db.get::<_, i32>(0),
                        "commits": db.get::<_, i64>(1),
                        "rollbacks": db.get::<_, i64>(2),
                        "blocksHit": db.get::<_, i64>(3),
                        "blocksRead": db.get::<_, i64>(4),
                        "tuplesReturned": db.get::<_, i64>(5),
                        "tuplesFetched": db.get::<_, i64>(6),
                        "size": db.get::<_, String>(7),
                    },
                })
            }
            MetadataRequest::Relationships { schema } => {
                let rows = self
                    .client
                    .query(
                        "SELECT c.conname,
                                sr.relname AS src_table,
                                tr.relname AS tgt_table
                         FROM pg_constraint c
                         JOIN pg_class sr ON sr.oid = c.conrelid
                         JOIN pg_class tr ON tr.oid = c.confrelid
                         JOIN pg_namespace n ON n.oid = sr.relnamespace
                         WHERE c.contype = 'f' AND n.nspname = $1
                         ORDER BY sr.relname, c.conname",
                        &[&schema],
                    )
                    .await
                    .map_err(normalize_error)?;
                serde_json::json!(rows.iter().map(|r| serde_json::json!({
                    "name": r.get::<_, String>(0),
                    "from": r.get::<_, String>(1),
                    "to": r.get::<_, String>(2),
                })).collect::<Vec<_>>())
            }
        };
        Ok(MetadataResponse {
            payload,
            annotations: Default::default(),
        })
    }

    async fn begin(&mut self, _options: TransactionOptions) -> Result<TransactionId, DriverError> {
        if self.in_transaction.is_some() {
            return Err(DriverError::new(
                ErrorCategory::Internal,
                "Transaction already open",
            ));
        }
        self.client
            .batch_execute("BEGIN")
            .await
            .map_err(normalize_error)?;
        let id = TransactionId::new();
        self.in_transaction = Some(id);
        Ok(id)
    }

    async fn commit(&mut self) -> Result<(), DriverError> {
        if self.in_transaction.take().is_none() {
            return Err(DriverError::new(
                ErrorCategory::Internal,
                "No open transaction",
            ));
        }
        self.client
            .batch_execute("COMMIT")
            .await
            .map_err(normalize_error)
    }

    async fn rollback(&mut self) -> Result<(), DriverError> {
        if self.in_transaction.take().is_none() {
            return Err(DriverError::new(
                ErrorCategory::Internal,
                "No open transaction",
            ));
        }
        self.client
            .batch_execute("ROLLBACK")
            .await
            .map_err(normalize_error)
    }

    fn is_broken(&self) -> bool {
        self.client.is_closed()
    }
}

fn convert_row(row: &Row) -> Vec<CellValue> {
    (0..row.len()).map(|i| convert_cell(row, i)).collect()
}

fn convert_cell(row: &Row, i: usize) -> CellValue {
    let ty = row.columns()[i].type_().clone();
    macro_rules! take {
        ($t:ty, $wrap:expr) => {
            match row.try_get::<_, Option<$t>>(i) {
                Ok(Some(v)) => $wrap(v),
                Ok(None) => CellValue::Null,
                Err(_) => other(&ty),
            }
        };
    }
    match ty {
        Type::BOOL => take!(bool, CellValue::Bool),
        Type::INT2 => take!(i16, |v: i16| CellValue::Int(v as i64)),
        Type::INT4 => take!(i32, |v: i32| CellValue::Int(v as i64)),
        Type::INT8 => take!(i64, CellValue::Int),
        Type::FLOAT4 => take!(f32, |v: f32| CellValue::Float(v as f64)),
        Type::FLOAT8 => take!(f64, CellValue::Float),
        Type::TEXT | Type::VARCHAR | Type::BPCHAR | Type::NAME => {
            take!(String, CellValue::Text)
        }
        Type::JSON | Type::JSONB => take!(serde_json::Value, CellValue::Json),
        Type::BYTEA => take!(Vec<u8>, CellValue::Bytes),
        Type::UUID => take!(uuid::Uuid, |v: uuid::Uuid| CellValue::Text(v.to_string())),
        _ => other(&ty),
    }
}

fn other(ty: &Type) -> CellValue {
    CellValue::Other {
        rendered: "<unsupported in PoC>".into(),
        db_type: ty.name().to_string(),
    }
}

/// Map a tokio-postgres error into the normalized taxonomy (spec §54).
pub fn normalize_error(e: tokio_postgres::Error) -> DriverError {
    if let Some(db) = e.as_db_error() {
        let (category, title) = match *db.code() {
            SqlState::QUERY_CANCELED => (ErrorCategory::Cancelled, "Query cancelled"),
            SqlState::SYNTAX_ERROR => (ErrorCategory::Syntax, "Syntax error"),
            SqlState::UNDEFINED_TABLE => (ErrorCategory::SchemaMissing, "Relation not found"),
            SqlState::UNDEFINED_COLUMN => (ErrorCategory::Syntax, "Column not found"),
            SqlState::INVALID_PASSWORD => (ErrorCategory::Authentication, "Authentication failed"),
            SqlState::INSUFFICIENT_PRIVILEGE => (ErrorCategory::Authorization, "Permission denied"),
            SqlState::UNIQUE_VIOLATION
            | SqlState::FOREIGN_KEY_VIOLATION
            | SqlState::NOT_NULL_VIOLATION
            | SqlState::CHECK_VIOLATION => {
                (ErrorCategory::ConstraintViolation, "Constraint violation")
            }
            SqlState::T_R_DEADLOCK_DETECTED => (ErrorCategory::Deadlock, "Deadlock detected"),
            SqlState::LOCK_NOT_AVAILABLE => (ErrorCategory::LockTimeout, "Lock timeout"),
            SqlState::T_R_SERIALIZATION_FAILURE => (
                ErrorCategory::SerializationConflict,
                "Serialization conflict",
            ),
            SqlState::READ_ONLY_SQL_TRANSACTION => {
                (ErrorCategory::ReadOnlyViolation, "Read-only transaction")
            }
            SqlState::DISK_FULL => (ErrorCategory::DiskFull, "Disk full"),
            _ => (ErrorCategory::DriverFailure, "Database error"),
        };
        let mut err = DriverError::new(category, title)
            .with_native_code(db.code().code())
            .with_original_message(db.message());
        if let Some(tokio_postgres::error::ErrorPosition::Original(p)) = db.position() {
            let p = *p as usize;
            err = err.with_query_range(p.saturating_sub(1), p);
        }
        err
    } else if e.is_closed() {
        DriverError::new(ErrorCategory::Network, "Connection closed")
            .with_original_message(e.to_string())
            .with_suggested_action("Reconnect and retry if the statement is safe to re-run")
    } else {
        DriverError::new(ErrorCategory::DriverFailure, "Driver error")
            .with_original_message(e.to_string())
    }
}
