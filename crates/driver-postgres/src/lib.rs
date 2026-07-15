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
use tokio_postgres::types::{FromSql, Type};
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

        // Bind typed parameters ($1..$n). Passed as owned boxed ToSql so the
        // borrow lives for the whole query_raw call (Phase 3).
        let bound: Vec<Box<dyn tokio_postgres::types::ToSql + Sync + Send>> =
            request.params.iter().map(param_to_sql).collect();
        let refs: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> =
            bound.iter().map(|b| b.as_ref() as _).collect();

        let stream = self
            .client
            .query_raw(request.sql.as_str(), refs)
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
                // `NOT c.relispartition` is the important clause: partitions are
                // reached through their parent, never listed beside it. Without
                // it this schema returns 4,196 rows of which 4,170 are noise.
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
                                  WHEN 'S' THEN 'sequence'
                                END AS kind,
                                obj_description(c.oid, 'pg_class') AS comment,
                                c.relkind = 'p' AS is_partitioned,
                                (SELECT count(*) FROM pg_inherits i WHERE i.inhparent = c.oid)
                                  AS partition_count
                         FROM pg_class c
                         JOIN pg_namespace n ON n.oid = c.relnamespace
                         WHERE n.nspname = $1
                           AND c.relkind IN ('r','p','v','m','f','S')
                           AND NOT c.relispartition
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
                            "isPartitioned": r.get::<_, bool>(3),
                            "partitionCount": r.get::<_, i64>(4),
                        })
                    })
                    .collect::<Vec<_>>())
            }
            MetadataRequest::ListPartitions { schema, table } => {
                let rows = self
                    .client
                    .query(
                        // A partition is very often partitioned again (here:
                        // channel, then quarter), so each child reports its own
                        // sub-partition count. Without it the tree cannot know
                        // to offer a Partitions node before loading one.
                        "SELECT c.relname,
                                pg_get_expr(c.relpartbound, c.oid) AS bounds,
                                pg_total_relation_size(c.oid) AS bytes,
                                c.reltuples::bigint AS rows_estimate,
                                c.relkind = 'p' AS is_partitioned,
                                (SELECT count(*) FROM pg_inherits ii WHERE ii.inhparent = c.oid)
                                  AS partition_count
                         FROM pg_inherits i
                         JOIN pg_class c ON c.oid = i.inhrelid
                         JOIN pg_class p ON p.oid = i.inhparent
                         JOIN pg_namespace n ON n.oid = p.relnamespace
                         WHERE n.nspname = $1 AND p.relname = $2
                         ORDER BY c.relname",
                        &[&schema, &table],
                    )
                    .await
                    .map_err(normalize_error)?;
                serde_json::json!(rows
                    .iter()
                    .map(|r| {
                        serde_json::json!({
                            "name": r.get::<_, String>(0),
                            "bounds": r.get::<_, Option<String>>(1),
                            "bytes": r.get::<_, i64>(2),
                            "rowsEstimate": r.get::<_, i64>(3),
                            "isPartitioned": r.get::<_, bool>(4),
                            "partitionCount": r.get::<_, i64>(5),
                        })
                    })
                    .collect::<Vec<_>>())
            }
            MetadataRequest::ListConstraints { schema, table } => {
                let rows = self
                    .client
                    .query(
                        "SELECT con.conname,
                                CASE con.contype
                                  WHEN 'p' THEN 'primary key'
                                  WHEN 'f' THEN 'foreign key'
                                  WHEN 'u' THEN 'unique'
                                  WHEN 'c' THEN 'check'
                                  WHEN 'x' THEN 'exclusion'
                                  WHEN 'n' THEN 'not null'
                                  WHEN 't' THEN 'trigger'
                                  ELSE con.contype::text
                                END AS kind,
                                pg_get_constraintdef(con.oid) AS definition,
                                con.convalidated
                         FROM pg_constraint con
                         JOIN pg_class c ON c.oid = con.conrelid
                         JOIN pg_namespace n ON n.oid = c.relnamespace
                         WHERE n.nspname = $1 AND c.relname = $2
                         ORDER BY con.contype, con.conname",
                        &[&schema, &table],
                    )
                    .await
                    .map_err(normalize_error)?;
                serde_json::json!(rows
                    .iter()
                    .map(|r| {
                        serde_json::json!({
                            "name": r.get::<_, String>(0),
                            "kind": r.get::<_, String>(1),
                            "definition": r.get::<_, Option<String>>(2),
                            "isValid": r.get::<_, bool>(3),
                        })
                    })
                    .collect::<Vec<_>>())
            }
            MetadataRequest::ListIndexes { schema, table } => {
                // `idx_scan` is what makes this worth showing: with 8,885
                // indexes in one schema, "which have never been used" is the
                // only question that matters.
                let rows = self
                    .client
                    .query(
                        "SELECT ic.relname,
                                pg_get_indexdef(i.indexrelid) AS definition,
                                i.indisunique,
                                i.indisprimary,
                                pg_relation_size(i.indexrelid) AS bytes,
                                COALESCE(s.idx_scan, 0) AS scans,
                                i.indisvalid
                         FROM pg_index i
                         JOIN pg_class ic ON ic.oid = i.indexrelid
                         JOIN pg_class tc ON tc.oid = i.indrelid
                         JOIN pg_namespace n ON n.oid = tc.relnamespace
                         LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = i.indexrelid
                         WHERE n.nspname = $1 AND tc.relname = $2
                         ORDER BY i.indisprimary DESC, ic.relname",
                        &[&schema, &table],
                    )
                    .await
                    .map_err(normalize_error)?;
                serde_json::json!(rows
                    .iter()
                    .map(|r| {
                        serde_json::json!({
                            "name": r.get::<_, String>(0),
                            "definition": r.get::<_, String>(1),
                            "isUnique": r.get::<_, bool>(2),
                            "isPrimary": r.get::<_, bool>(3),
                            "bytes": r.get::<_, i64>(4),
                            "scans": r.get::<_, i64>(5),
                            "isValid": r.get::<_, bool>(6),
                        })
                    })
                    .collect::<Vec<_>>())
            }
            MetadataRequest::ListTypes { schema } => {
                let rows = self
                    .client
                    .query(
                        "SELECT t.typname,
                                CASE t.typtype
                                  WHEN 'e' THEN 'enum'
                                  WHEN 'c' THEN 'composite'
                                  WHEN 'd' THEN 'domain'
                                  WHEN 'r' THEN 'range'
                                  ELSE 'type'
                                END AS kind,
                                obj_description(t.oid, 'pg_type') AS comment,
                                (SELECT string_agg(e.enumlabel, ', ' ORDER BY e.enumsortorder)
                                   FROM pg_enum e WHERE e.enumtypid = t.oid) AS labels
                         FROM pg_type t
                         JOIN pg_namespace n ON n.oid = t.typnamespace
                         WHERE n.nspname = $1
                           AND t.typtype IN ('e','c','d','r')
                           -- skip the implicit row type every table creates
                           AND NOT EXISTS (
                             SELECT 1 FROM pg_class c
                             WHERE c.oid = t.typrelid AND c.relkind <> 'c'
                           )
                         ORDER BY t.typname",
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
                            "labels": r.get::<_, Option<String>>(3),
                        })
                    })
                    .collect::<Vec<_>>())
            }
            MetadataRequest::ListRoutines { schema } => {
                let rows = self
                    .client
                    .query(
                        "SELECT p.proname,
                                CASE p.prokind
                                  WHEN 'p' THEN 'procedure'
                                  WHEN 'a' THEN 'aggregate'
                                  WHEN 'w' THEN 'window'
                                  ELSE 'function'
                                END AS kind,
                                pg_get_function_identity_arguments(p.oid) AS args,
                                pg_get_function_result(p.oid) AS returns,
                                obj_description(p.oid, 'pg_proc') AS comment,
                                l.lanname
                         FROM pg_proc p
                         JOIN pg_namespace n ON n.oid = p.pronamespace
                         JOIN pg_language l ON l.oid = p.prolang
                         WHERE n.nspname = $1
                         ORDER BY p.proname",
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
                            "args": r.get::<_, Option<String>>(2),
                            "returns": r.get::<_, Option<String>>(3),
                            "comment": r.get::<_, Option<String>>(4),
                            "language": r.get::<_, String>(5),
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
                serde_json::json!(rows
                    .iter()
                    .map(|r| serde_json::json!({
                        "name": r.get::<_, String>(0),
                        "from": r.get::<_, String>(1),
                        "to": r.get::<_, String>(2),
                    }))
                    .collect::<Vec<_>>())
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

/// An exact `numeric`, decoded straight from the binary wire format.
///
/// Postgres `numeric` is arbitrary precision. Every fixed-width Rust decimal
/// (`rust_decimal` is 96-bit, ~28 digits) silently fails on values a database
/// happily stores, and an f64 mangles them. Decoding the wire format is only a
/// few lines and is exact for any value the server can hold.
///
/// Wire format: i16 ndigits, i16 weight, u16 sign, u16 dscale, then `ndigits`
/// base-10000 digits. The value is sum(digits[k] * 10000^(weight-k)).
struct PgNumeric(String);

impl<'a> FromSql<'a> for PgNumeric {
    fn from_sql(_: &Type, raw: &'a [u8]) -> Result<Self, Box<dyn std::error::Error + Sync + Send>> {
        if raw.len() < 8 {
            return Err("numeric: header too short".into());
        }
        let rd = |o: usize| i16::from_be_bytes([raw[o], raw[o + 1]]);
        let ndigits = rd(0);
        let weight = rd(2) as i32;
        let sign = u16::from_be_bytes([raw[4], raw[5]]);
        let dscale = rd(6) as usize;

        match sign {
            0xC000 => return Ok(PgNumeric("NaN".into())),
            0xD000 => return Ok(PgNumeric("Infinity".into())),
            0xF000 => return Ok(PgNumeric("-Infinity".into())),
            _ => {}
        }
        if ndigits < 0 || raw.len() < 8 + ndigits as usize * 2 {
            return Err("numeric: digit count does not match payload".into());
        }
        let digits: Vec<i16> = (0..ndigits as usize).map(|k| rd(8 + k * 2)).collect();
        let at = |k: i32| -> i16 {
            if k < 0 {
                0
            } else {
                digits.get(k as usize).copied().unwrap_or(0)
            }
        };

        let mut s = String::new();
        if sign == 0x4000 {
            s.push('-');
        }

        // Integer part: the digit groups with a non-negative exponent.
        if weight < 0 {
            s.push('0');
        } else {
            for k in 0..=weight {
                if k == 0 {
                    s.push_str(&at(k).to_string());
                } else {
                    s.push_str(&format!("{:04}", at(k)));
                }
            }
        }

        // Fraction: groups after the point, padded then cut to the display scale
        // so a stored 125000.50 keeps its trailing zero.
        if dscale > 0 {
            let mut frac = String::new();
            let mut k = weight + 1;
            while frac.len() < dscale {
                frac.push_str(&format!("{:04}", at(k)));
                k += 1;
            }
            frac.truncate(dscale);
            s.push('.');
            s.push_str(&frac);
        }
        Ok(PgNumeric(s))
    }

    fn accepts(ty: &Type) -> bool {
        *ty == Type::NUMERIC
    }
}

/// Any value Postgres hands us that we have no dedicated Rust mapping for.
///
/// Postgres transmits enums, and a number of other types, as their plain text
/// label even in the binary protocol — so decoding the raw bytes as UTF-8
/// recovers the real value. This is what lets user-defined enums render
/// without the driver knowing anything about them. Types whose binary form is
/// genuinely not text fall back to a hex dump, which is at least honest and
/// copyable, rather than a shrug.
struct RawValue(Vec<u8>);

impl<'a> FromSql<'a> for RawValue {
    fn from_sql(_: &Type, raw: &'a [u8]) -> Result<Self, Box<dyn std::error::Error + Sync + Send>> {
        Ok(RawValue(raw.to_vec()))
    }
    fn accepts(_: &Type) -> bool {
        true
    }
}

fn render_raw(v: RawValue, ty: &Type) -> CellValue {
    match std::str::from_utf8(&v.0) {
        // Printable UTF-8 is the value itself (enums, and friends).
        Ok(s) if !s.is_empty() && !s.chars().any(|c| c.is_control() && c != '\t' && c != '\n') => {
            CellValue::Text(s.to_owned())
        }
        _ => CellValue::Other {
            rendered: format!("\\x{}", hex::encode(&v.0)),
            db_type: ty.name().to_string(),
        },
    }
}

fn convert_cell(row: &Row, i: usize) -> CellValue {
    let ty = row.columns()[i].type_().clone();
    macro_rules! take {
        ($t:ty, $wrap:expr) => {
            match row.try_get::<_, Option<$t>>(i) {
                Ok(Some(v)) => $wrap(v),
                Ok(None) => CellValue::Null,
                Err(_) => fallback(row, i, &ty),
            }
        };
    }
    /// Render `Vec<Option<T>>` as a Postgres array literal: {a,b,NULL}.
    macro_rules! take_array {
        ($t:ty) => {
            match row.try_get::<_, Option<Vec<Option<$t>>>>(i) {
                Ok(Some(v)) => CellValue::Text(format!(
                    "{{{}}}",
                    v.iter()
                        .map(|e| e.as_ref().map(|x| x.to_string()).unwrap_or_else(|| "NULL".into()))
                        .collect::<Vec<_>>()
                        .join(",")
                )),
                Ok(None) => CellValue::Null,
                Err(_) => fallback(row, i, &ty),
            }
        };
    }

    match ty {
        Type::BOOL => take!(bool, CellValue::Bool),
        Type::INT2 => take!(i16, |v: i16| CellValue::Int(v as i64)),
        Type::INT4 => take!(i32, |v: i32| CellValue::Int(v as i64)),
        Type::INT8 => take!(i64, CellValue::Int),
        Type::OID => take!(u32, |v: u32| CellValue::Int(v as i64)),
        Type::FLOAT4 => take!(f32, |v: f32| CellValue::Float(v as f64)),
        Type::FLOAT8 => take!(f64, CellValue::Float),

        // Arbitrary precision: decoded exactly, never via f64 or a fixed-width
        // decimal that would silently fail on large values.
        Type::NUMERIC => take!(PgNumeric, |v: PgNumeric| CellValue::Text(v.0)),

        Type::TEXT | Type::VARCHAR | Type::BPCHAR | Type::NAME | Type::UNKNOWN => {
            take!(String, CellValue::Text)
        }
        Type::CHAR => take!(i8, |v: i8| CellValue::Int(v as i64)),

        // Dates and times. `timestamp` has no zone, so it must not be rendered
        // as if it were UTC — NaiveDateTime keeps it as the wall clock the
        // server stored.
        Type::TIMESTAMP => take!(chrono::NaiveDateTime, |v: chrono::NaiveDateTime| {
            CellValue::Text(v.format("%Y-%m-%d %H:%M:%S%.f").to_string())
        }),
        Type::TIMESTAMPTZ => take!(chrono::DateTime<chrono::Utc>, |v: chrono::DateTime<chrono::Utc>| {
            CellValue::Text(v.to_rfc3339_opts(chrono::SecondsFormat::AutoSi, true))
        }),
        Type::DATE => take!(chrono::NaiveDate, |v: chrono::NaiveDate| CellValue::Text(v.to_string())),
        Type::TIME => take!(chrono::NaiveTime, |v: chrono::NaiveTime| CellValue::Text(v.to_string())),

        Type::JSON | Type::JSONB => take!(serde_json::Value, CellValue::Json),
        Type::BYTEA => take!(Vec<u8>, CellValue::Bytes),
        Type::UUID => take!(uuid::Uuid, |v: uuid::Uuid| CellValue::Text(v.to_string())),
        Type::INET | Type::CIDR => take!(std::net::IpAddr, |v: std::net::IpAddr| {
            CellValue::Text(v.to_string())
        }),

        // Common array types.
        Type::BOOL_ARRAY => take_array!(bool),
        Type::INT2_ARRAY => take_array!(i16),
        Type::INT4_ARRAY => take_array!(i32),
        Type::INT8_ARRAY => take_array!(i64),
        Type::FLOAT4_ARRAY => take_array!(f32),
        Type::FLOAT8_ARRAY => take_array!(f64),
        Type::TEXT_ARRAY | Type::VARCHAR_ARRAY | Type::NAME_ARRAY => take_array!(String),
        Type::UUID_ARRAY => take_array!(uuid::Uuid),

        // Enums, domains, ranges, geometry, intervals, money, xml, and anything
        // else the server may have: decoded from the wire rather than refused.
        _ => fallback(row, i, &ty),
    }
}

/// Last resort for a type with no dedicated mapping. Never returns
/// "unsupported" — a database client that cannot show you your own data is
/// not doing its job.
fn fallback(row: &Row, i: usize, ty: &Type) -> CellValue {
    match row.try_get::<_, Option<RawValue>>(i) {
        Ok(Some(v)) => render_raw(v, ty),
        Ok(None) => CellValue::Null,
        Err(e) => CellValue::Other {
            rendered: format!("<decode error: {e}>"),
            db_type: ty.name().to_string(),
        },
    }
}

/// An integer bind value that adapts to whatever integer width Postgres
/// infers for the placeholder (int2/int4/int8), so `where id = $1` works
/// whether the column is int4 or int8.
#[derive(Debug)]
struct AnyInt(i64);

impl tokio_postgres::types::ToSql for AnyInt {
    fn to_sql(
        &self,
        ty: &Type,
        out: &mut tokio_postgres::types::private::BytesMut,
    ) -> Result<tokio_postgres::types::IsNull, Box<dyn std::error::Error + Sync + Send>> {
        match *ty {
            Type::INT2 => (self.0 as i16).to_sql(ty, out),
            Type::INT4 => (self.0 as i32).to_sql(ty, out),
            _ => self.0.to_sql(ty, out),
        }
    }
    fn accepts(ty: &Type) -> bool {
        matches!(*ty, Type::INT2 | Type::INT4 | Type::INT8)
    }
    tokio_postgres::types::to_sql_checked!();
}

/// A float bind value adapting to float4/float8.
#[derive(Debug)]
struct AnyFloat(f64);

impl tokio_postgres::types::ToSql for AnyFloat {
    fn to_sql(
        &self,
        ty: &Type,
        out: &mut tokio_postgres::types::private::BytesMut,
    ) -> Result<tokio_postgres::types::IsNull, Box<dyn std::error::Error + Sync + Send>> {
        match *ty {
            Type::FLOAT4 => (self.0 as f32).to_sql(ty, out),
            _ => self.0.to_sql(ty, out),
        }
    }
    fn accepts(ty: &Type) -> bool {
        matches!(*ty, Type::FLOAT4 | Type::FLOAT8)
    }
    tokio_postgres::types::to_sql_checked!();
}

/// Convert a driver-api ParamValue into an owned tokio-postgres bind value.
fn param_to_sql(p: &ParamValue) -> Box<dyn tokio_postgres::types::ToSql + Sync + Send> {
    match p {
        ParamValue::Null => Box::new(Option::<String>::None),
        ParamValue::Bool(b) => Box::new(*b),
        ParamValue::Int(i) => Box::new(AnyInt(*i)),
        ParamValue::Float(f) => Box::new(AnyFloat(*f)),
        ParamValue::Text(s) => Box::new(s.clone()),
        ParamValue::Bytes(b) => Box::new(b.clone()),
        ParamValue::Json(v) => Box::new(v.clone()),
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
