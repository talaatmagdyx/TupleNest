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
        let started = Instant::now();
        let result = Self::pg_config(config, password).connect(NoTls).await;
        let elapsed = started.elapsed().as_millis() as u64;
        match result {
            Ok((client, connection)) => {
                let handle = tokio::spawn(connection);
                stages.push(TestStage {
                    name: "connect".into(),
                    status: TestStageStatus::Passed,
                    duration_ms: elapsed,
                    detail: None,
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
    _conn_task: tokio::task::JoinHandle<()>,
    in_transaction: Option<TransactionId>,
}

/// A cloneable handle that can cancel the session's running query without
/// borrowing the session. Backed by the PostgreSQL wire-protocol cancel key.
#[derive(Clone)]
pub struct PgCancelHandle(Arc<AsyncMutex<CancelToken>>);

impl PgCancelHandle {
    pub async fn cancel(&self) -> Result<(), DriverError> {
        let token = self.0.lock().await.clone();
        token.cancel_query(NoTls).await.map_err(normalize_error)
    }
}

impl PostgresSession {
    pub fn cancel_handle(&self) -> PgCancelHandle {
        PgCancelHandle(self.cancel_token.clone())
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
        let (client, connection) = Self::pg_config(&config, password)
            .connect(NoTls)
            .await
            .map_err(normalize_error)?;
        let conn_task = tokio::spawn(async move {
            let _ = connection.await;
        });
        let cancel_token = client.cancel_token();
        Ok(PostgresSession {
            client,
            cancel_token: Arc::new(AsyncMutex::new(cancel_token)),
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
        token.cancel_query(NoTls).await.map_err(normalize_error)
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
            _ => {
                return Err(DriverError::new(
                    ErrorCategory::Unsupported,
                    "Metadata request not supported in the Phase 0 proof of concept",
                ))
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
