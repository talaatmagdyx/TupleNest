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

mod wire;

use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use tokio::sync::Mutex as AsyncMutex;
use tokio_postgres::error::SqlState;
use tokio_postgres::types::{FromSql, Kind, Type};
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

/// The `BEGIN` for these options.
///
/// Separate and pure so the mapping can be tested without a server — this is
/// the kind of code where a wrong word is a wrong isolation level, silently.
///
/// `DEFERRABLE` only means anything for a SERIALIZABLE READ ONLY transaction;
/// PostgreSQL ignores it otherwise, and emitting it anyway would suggest it did
/// something.
fn begin_statement(o: &TransactionOptions) -> String {
    let mut sql = String::from("BEGIN");
    if let Some(level) = o.isolation {
        sql.push_str(" ISOLATION LEVEL ");
        sql.push_str(match level {
            // PostgreSQL accepts READ UNCOMMITTED and treats it as READ
            // COMMITTED — it has no dirty reads. Passing it through is honest:
            // the server's behaviour is the server's to explain.
            IsolationLevel::ReadUncommitted => "READ UNCOMMITTED",
            IsolationLevel::ReadCommitted => "READ COMMITTED",
            IsolationLevel::RepeatableRead => "REPEATABLE READ",
            IsolationLevel::Serializable => "SERIALIZABLE",
        });
    }
    if o.read_only {
        sql.push_str(" READ ONLY");
    }
    if o.deferrable && o.read_only && o.isolation == Some(IsolationLevel::Serializable) {
        sql.push_str(" DEFERRABLE");
    }
    sql
}

/// One array element, quoted the way PostgreSQL's own `array_out` does.
///
/// The elements used to be joined with a bare comma, so a text array whose
/// element contained a comma rendered as `{a,b}` — which reads as two elements
/// and does not round-trip. Same for braces, quotes, backslashes, whitespace,
/// the empty string, and the literal text `NULL`, which was indistinguishable
/// from an actual NULL.
///
/// For numbers, bools and uuids none of this can trigger, so it costs nothing
/// where it is not needed.
#[cfg(test)]
fn quote_array_element(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    push_array_element(&mut out, s);
    out
}

/// [`quote_array_element`], appended to `out`.
fn push_array_element(out: &mut String, s: &str) {
    let needs = s.is_empty()
        || s.eq_ignore_ascii_case("NULL")
        || s.chars()
            .any(|c| matches!(c, '{' | '}' | ',' | '"' | '\\') || c.is_whitespace());
    if !needs {
        out.push_str(s);
        return;
    }
    out.reserve(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        if c == '"' || c == '\\' {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('"');
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

/// A batch is also cut at this many bytes of wire data. Rows alone are not a
/// size: 1,000 rows of 1 MB bytea is a gigabyte decoded before the sink can
/// apply its budget (measured: 600 such rows peaked at 882 MB under a 256 MB
/// store budget). 4 MB, not 8: a batch is several times its wire size once
/// decoded, and it is the largest thing alive while a query streams.
pub const BATCH_BYTES: usize = 4 * 1024 * 1024;

/// Oldest PostgreSQL this build serves.
///
/// The binding constraint is `pg_partition_tree` / `pg_partition_root`, which
/// arrived in PostgreSQL 12 and the explorer leans on. 13 rather than 12
/// because 13 is what CI actually tests against — claiming a version nobody
/// runs the suite on is how the last version claim became untrue.
pub const MIN_SERVER_MAJOR: i32 = 13;
const MIN_SERVER_VERSION_NUM: i32 = MIN_SERVER_MAJOR * 10_000;

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

        // Decide whether TLS is *required*, separately from how the certificate
        // is *verified*. This is the load-bearing line the security review
        // flagged CRITICAL: without it, tokio-postgres defaults to
        // `SslMode::Prefer`, and a server (or on-path attacker) that answers the
        // SSLRequest with "no" drops the whole session to plaintext — even under
        // verify-full. The rustls verifier in `tls.rs` never runs, because no
        // handshake happens. `Require` closes that door: the verify modes now
        // refuse to speak plaintext at all.
        //
        // `tls::build` still controls the verifier (chain, hostname); this only
        // controls whether an unencrypted channel is acceptable.
        let ssl_mode = match config.tls_mode {
            TlsMode::Disabled => tokio_postgres::config::SslMode::Disable,
            // Prefer keeps the tokio-postgres default: try TLS, silently fall
            // back to plaintext. Documented and UI-warned as no-guarantee.
            TlsMode::Prefer => tokio_postgres::config::SslMode::Prefer,
            // Both verify modes REQUIRE TLS. verify-ca vs verify-full differ only
            // in whether the hostname is checked, which is the verifier's job.
            TlsMode::VerifyCa | TlsMode::VerifyFull => tokio_postgres::config::SslMode::Require,
        };
        c.ssl_mode(ssl_mode);
        // A half-open socket (laptop sleep, a dropped VPN, a dead NAT entry)
        // used to block until the OS gave up on TCP — many minutes — and with
        // it Disconnect, which waits for the running query. Keepalives notice
        // in about a minute; a server that never answers the dial fails fast.
        c.connect_timeout(std::time::Duration::from_secs(15));
        c.keepalives(true);
        c.keepalives_idle(std::time::Duration::from_secs(30));
        c
    }

    /// [`DatabaseDriver::test`] with an explicit resolved password.
    pub async fn test_with_password(
        &self,
        config: &ConnectionConfig,
        password: Option<&str>,
    ) -> Result<ConnectionTestReport, Box<DriverError>> {
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

    async fn test(
        &self,
        config: ConnectionConfig,
    ) -> Result<ConnectionTestReport, Box<DriverError>> {
        self.test_with_password(&config, None).await
    }

    async fn connect(
        &self,
        config: ConnectionConfig,
    ) -> Result<Box<dyn DatabaseSession>, Box<DriverError>> {
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
    /// The profile is read-only: every statement is checked against the
    /// server's own transaction state first (see `ensure_read_only`).
    read_only: bool,
}

/// A cloneable handle that can cancel the session's running query without
/// borrowing the session. Backed by the PostgreSQL wire-protocol cancel key.
#[derive(Clone)]
pub struct PgCancelHandle {
    token: Arc<AsyncMutex<CancelToken>>,
    tls: TlsSetup,
}

impl PgCancelHandle {
    pub async fn cancel(&self) -> Result<(), Box<DriverError>> {
        let token = self.token.lock().await.clone();
        cancel_with(token, &self.tls).await.map_err(normalize_error)
    }
}

impl PostgresSession {
    /*
     * Keeps a read-only profile read-only.
     *
     * The connect-time `SET SESSION CHARACTERISTICS … READ ONLY` is only a
     * default, and any statement can change it: `SET SESSION CHARACTERISTICS
     * AS TRANSACTION READ WRITE`, `SET default_transaction_read_only = off`,
     * `RESET ALL`, `set_config(…)`, or `BEGIN READ WRITE`. Recognising those
     * in the SQL text would be a filter, and filters get talked around.
     *
     * So before every statement the server is asked, in one round trip, to
     * restore the read-only default and to say whether the transaction this
     * statement will run in is read-only. Outside a transaction that is always
     * yes. Inside one opened `READ WRITE`, it is no, and the statement is
     * refused — whatever it is. An ordinary statement cannot both flip the
     * mode and write: PostgreSQL fixes a transaction's mode before its first
     * query. `DO` and `CALL` can, by committing partway through, so `execute`
     * refuses those on a read-only profile before this check ever runs.
     */
    /*
     * Is a transaction open on the server right now?
     *
     * The driver's own `in_transaction` only knows about `begin()`. A `BEGIN`
     * typed in the editor goes through `execute`, so the import and row edits
     * used to issue a second BEGIN and then COMMIT or ROLLBACK the user's own
     * work. The server is the only thing that knows.
     *
     * Outside a transaction every statement is its own, so `now()` (start of
     * transaction) equals `statement_timestamp()`. Inside one, this statement
     * started after `BEGIN` did. An aborted transaction refuses the query
     * with 25P02 — which also means one is open.
     */
    pub async fn server_in_transaction(&self) -> Result<bool, Box<DriverError>> {
        match self
            .client
            .simple_query("SELECT now() <> statement_timestamp()")
            .await
        {
            Ok(msgs) => Ok(msgs.iter().any(|m| match m {
                tokio_postgres::SimpleQueryMessage::Row(r) => r.get(0) == Some("t"),
                _ => false,
            })),
            Err(e)
                if e.code()
                    == Some(&tokio_postgres::error::SqlState::IN_FAILED_SQL_TRANSACTION) =>
            {
                Ok(true)
            }
            Err(e) => Err(normalize_error(e)),
        }
    }

    /*
     * Has a statement already failed in the open transaction?
     *
     * PostgreSQL answers `COMMIT` on such a transaction with success. The
     * command tag says `ROLLBACK` instead of `COMMIT`, there is no error, and
     * everything the transaction did is gone. tokio-postgres does not expose
     * the tag, so the state is asked for beforehand: a failed transaction
     * refuses every query with 25P02 until it is ended.
     */
    async fn transaction_failed(&self) -> bool {
        matches!(
            self.client.simple_query("SELECT 1").await,
            Err(e) if e.code() == Some(&tokio_postgres::error::SqlState::IN_FAILED_SQL_TRANSACTION)
        )
    }

    /*
     * COMMIT or ROLLBACK, keeping `in_transaction` true to the server.
     *
     * The flag used to be cleared before the statement was sent, so a COMMIT
     * that failed (a deferred constraint, a serialization failure) left the
     * driver sure there was no transaction while the UI still showed one —
     * and from then on Commit and Rollback both answered "No open
     * transaction". A failed COMMIT usually does end the transaction (the
     * server rolls it back), but not always (a lost connection), so after a
     * failure the server is asked rather than either side guessing.
     */
    async fn end_transaction(&mut self, sql: &str) -> Result<(), Box<DriverError>> {
        // The flag knows only about `begin()`. A transaction the user opened by
        // typing BEGIN is just as real, and Commit/Rollback (and the prompt on
        // closing the window) must be able to end it — so ask the server.
        let id = match self.in_transaction.take() {
            Some(id) => id,
            None if self.server_in_transaction().await.unwrap_or(false) => TransactionId::new(),
            None => {
                return Err(
                    DriverError::new(ErrorCategory::Internal, "No open transaction").into(),
                );
            }
        };
        // A commit of a failed transaction is a rollback that reports
        // success. Send the rollback under its own name and say what happened:
        // "COMMIT" on screen with the rows gone is the worst thing a database
        // client can tell someone.
        let failed = sql == "COMMIT" && self.transaction_failed().await;
        let result = self
            .client
            .batch_execute(if failed { "ROLLBACK" } else { sql })
            .await
            .map_err(normalize_error);
        if result.is_err() && self.server_in_transaction().await.unwrap_or(false) {
            self.in_transaction = Some(id);
        }
        result?;
        if failed {
            return Err(commit_rolled_back().into());
        }
        Ok(())
    }

    async fn ensure_read_only(&self) -> Result<(), Box<DriverError>> {
        // Two round trips, not one: sent together they run in one implicit
        // transaction, which began under the old default, so the statement
        // right after a mode flip was refused even with no transaction open.
        self.client
            .batch_execute("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY")
            .await
            .map_err(normalize_error)?;
        let msgs = self
            .client
            .simple_query("SELECT current_setting('transaction_read_only')")
            .await
            .map_err(normalize_error)?;
        let read_only = msgs.iter().any(|m| match m {
            tokio_postgres::SimpleQueryMessage::Row(r) => r.get(0) == Some("on"),
            _ => false,
        });
        if read_only {
            return Ok(());
        }
        Err(DriverError::new(
            ErrorCategory::Authorization,
            "This connection is read-only, but the open transaction is read-write. \
             Roll it back (or commit) to continue; nothing was run.",
        )
        .into())
    }

    /// Cancel (soft) or terminate (hard) another backend by pid — powers the
    /// monitoring panel's actions. Returns whether the admin call succeeded.
    pub async fn admin_backend(&self, pid: i32, terminate: bool) -> Result<bool, Box<DriverError>> {
        // Cancelling or ending someone else's session is an effect on the
        // server, and the read-only mode does not stop the functions that do
        // it. A read-only profile does not send them.
        if self.read_only {
            return Err(DriverError::new(
                ErrorCategory::Authorization,
                "This connection is read-only: it does not cancel or terminate other                  sessions. Nothing was sent.",
            )
            .into());
        }
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
    ) -> Result<PostgresSession, Box<DriverError>> {
        self.connect_concrete_with_password(config, None).await
    }

    /// Like [`PostgresDriver::connect_concrete`] with an explicit resolved password.
    pub async fn connect_concrete_with_password(
        &self,
        config: ConnectionConfig,
        password: Option<&str>,
    ) -> Result<PostgresSession, Box<DriverError>> {
        let setup = tls::build(&config)?;
        let (client, conn_task) = connect_client(&Self::pg_config(&config, password), &setup)
            .await
            .map_err(normalize_error)?;

        /*
         * Refuse a server too old to serve, rather than half-working.
         *
         * `supported_server_versions` advertised 13+ and was read by nothing:
         * connecting to PG 11 succeeded, the tree and queries worked, and only
         * the partition panels failed — at some later moment, with a raw
         * "function pg_partition_tree does not exist". A version check on
         * connect turns that into one sentence at the only point where it is
         * still actionable.
         *
         * `server_version_num` rather than parsing `server_version`: it is an
         * integer the server computes, and it does not have to be parsed out of
         * strings like "16.2 (Ubuntu 16.2-1.pgdg22.04+1)".
         */
        let ver: i32 = client
            .query_one("SHOW server_version_num", &[])
            .await
            .map_err(normalize_error)?
            .get::<_, String>(0)
            .parse()
            .unwrap_or(0);
        if ver > 0 && ver < MIN_SERVER_VERSION_NUM {
            return Err(DriverError::new(
                ErrorCategory::Configuration,
                format!(
                    "PostgreSQL {}.{} is older than the minimum this build supports ({}). \
                     Parts of the schema explorer rely on catalog functions added in {}.",
                    ver / 10_000,
                    (ver % 10_000) / 100,
                    MIN_SERVER_MAJOR,
                    MIN_SERVER_MAJOR,
                ),
            )
            .into());
        }

        /*
         * Read-only is the server's job, not ours.
         *
         * We could refuse writes in the client, but that is a promise we cannot
         * keep: any statement we failed to classify would sail through. Asking
         * PostgreSQL to set the session read-only moves enforcement to the only
         * place that sees every statement and cannot be talked around. A write
         * then fails with `25006: cannot execute … in a read-only transaction`,
         * from the database, whatever the app thought it was sending.
         *
         * This fails the connection rather than warning: a profile marked
         * read-only that quietly allows writes is worse than no profile at all.
         */
        if config.read_only {
            client
                .batch_execute("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY")
                .await
                .map_err(normalize_error)?;
        }

        /*
         * A ceiling on how long one statement may run.
         *
         * `default_statement_timeout_ms` existed on the config and was read by
         * nothing, so a runaway query had no limit but the user noticing. This
         * is the server's own timer: it fires even if the app is wedged, the
         * webview is busy, or the user has walked away — which a client-side
         * timeout does not.
         *
         * 0 means no timeout, matching PostgreSQL's own meaning, and is the
         * default: a query that is *supposed* to take an hour is a normal thing
         * to run from an IDE.
         */
        if config.default_statement_timeout_ms > 0 {
            client
                .batch_execute(&format!(
                    "SET statement_timeout = {}",
                    config.default_statement_timeout_ms
                ))
                .await
                .map_err(normalize_error)?;
        }

        let cancel_token = client.cancel_token();
        Ok(PostgresSession {
            client,
            cancel_token: Arc::new(AsyncMutex::new(cancel_token)),
            tls: setup,
            _conn_task: conn_task,
            in_transaction: None,
            read_only: config.read_only,
        })
    }
}

#[async_trait]
impl DatabaseSession for PostgresSession {
    async fn execute(
        &mut self,
        request: QueryRequest,
        sink: &dyn BatchSink,
    ) -> Result<ExecutionSummary, Box<DriverError>> {
        use futures_util::StreamExt;
        let started = Instant::now();

        // The same trap for a COMMIT typed in the editor (see
        // `transaction_failed`). The user's own statement is still what runs,
        // so `COMMIT AND CHAIN` keeps its meaning; only the answer changes.
        if commits(&request.sql) && self.transaction_failed().await {
            self.client
                .batch_execute(&request.sql)
                .await
                .map_err(normalize_error)?;
            return Err(commit_rolled_back().into());
        }

        if self.read_only {
            let words = leading_words(&request.sql, 2);
            let first = words.first().map(String::as_str).unwrap_or("");
            // DO and CALL may COMMIT partway through, and the transaction after
            // that takes whatever default the block just set: one statement can
            // both flip the mode and write. Nothing can be checked between the
            // two, so they are refused outright on a read-only profile.
            if first == "do" || first == "call" {
                return Err(DriverError::new(
                    ErrorCategory::Authorization,
                    "DO blocks and CALL are refused on a read-only connection: they can \
                     commit and change the transaction mode from inside. Nothing was run.",
                )
                .into());
            }
            // PostgreSQL's read-only mode stops writes to tables and to the
            // catalog. It does not stop maintenance or server-side effects:
            // VACUUM, ANALYZE, REINDEX, CLUSTER and CHECKPOINT all run in a
            // read-only session, and `COPY … TO PROGRAM` runs a shell command
            // on the server. So a read-only profile sends only what reads.
            if !reads_only(first) {
                return Err(DriverError::new(
                    ErrorCategory::Authorization,
                    format!(
                        "{} is refused on a read-only connection: only statements that read                          are sent, and PostgreSQL's own read-only mode would not stop this                          one. Nothing was run.",
                        if first.is_empty() {
                            "This statement".to_owned()
                        } else {
                            first.to_ascii_uppercase()
                        }
                    ),
                )
                .into());
            }
            // Ending a transaction must always work, and SET TRANSACTION has to
            // be the first statement of one, so the check's own query would
            // break it. Both are safe unchecked: the statement after is checked.
            let set_transaction =
                first == "set" && words.get(1).is_some_and(|w| w == "transaction");
            if !ends_transaction(&request.sql) && !set_transaction {
                self.ensure_read_only().await?;
            }
        }

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
        let mut batch_bytes = 0usize;
        let mut counting_only = false;

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
            rows_returned += 1;
            // The sink is full: count the rest, decode none of it.
            if counting_only {
                continue;
            }
            batch_bytes += row_wire_bytes(&row);
            buffer.push(convert_row(&row));
            if buffer.len() >= BATCH_SIZE || batch_bytes >= BATCH_BYTES {
                batch_bytes = 0;
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
                counting_only = !sink.wants_rows();
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

        /*
         * How many rows the statement actually changed.
         *
         * This was hard-coded `None`, and the whole chain above it believed
         * that meant "the server said nothing" rather than "we never asked":
         * the row-edit path treats a null count as "no opinion" and skips its
         * check, so the concurrency and zero-row guards were inert, and the
         * editor's "N rows affected" was never shown for a write.
         *
         * `rows_affected` is only meaningful once the stream is exhausted —
         * the count arrives in the CommandComplete message at the end — so it
         * has to be read here and not before the loop.
         */
        let rows_affected = stream.rows_affected();

        Ok(ExecutionSummary {
            execution_id: request.execution_id,
            status: ExecutionStatus::Success,
            rows_affected,
            rows_returned,
            duration_ms: started.elapsed().as_millis() as u64,
            messages: Vec::new(),
        })
    }

    async fn cancel(&self, _execution_id: ExecutionId) -> Result<(), Box<DriverError>> {
        let token = self.cancel_token.lock().await.clone();
        cancel_with(token, &self.tls).await.map_err(normalize_error)
    }

    async fn metadata(
        &self,
        request: MetadataRequest,
    ) -> Result<MetadataResponse, Box<DriverError>> {
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
            MetadataRequest::ObjectDetails {
                schema,
                name,
                object_kind,
            } => {
                object_details(
                    &self.client,
                    schema.as_str(),
                    name.as_str(),
                    object_kind.as_str(),
                )
                .await?
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
            MetadataRequest::IndexHealth { schema } => {
                index_health(&self.client, schema.as_deref()).await?
            }
            MetadataRequest::TableHealth { schema } => {
                table_health(&self.client, schema.as_deref()).await?
            }
            MetadataRequest::TopQueries { limit } => top_queries(&self.client, limit).await?,
            MetadataRequest::SearchObjects { term, limit } => {
                search_objects(&self.client, term.as_str(), limit).await?
            }
            MetadataRequest::PartitionOverview { schema, table } => {
                partition_overview(&self.client, schema.as_str(), table.as_str()).await?
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
                                col_description(a.attrelid, a.attnum) AS comment,
                                -- The server computes these; a client that
                                -- offers them for editing is offering a write
                                -- PostgreSQL will refuse. attgenerated is 's'
                                -- for STORED, attidentity 'a'/'d' for GENERATED
                                -- ... AS IDENTITY.
                                (a.attgenerated <> '' OR a.attidentity <> '') AS generated
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
                    )
                    .into());
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
                                "generated": r.get::<_, bool>(5),
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

    async fn begin(
        &mut self,
        options: TransactionOptions,
    ) -> Result<TransactionId, Box<DriverError>> {
        // The flag goes stale when the user ends the transaction by typing
        // COMMIT or ROLLBACK; the server is the authority on whether one is
        // still open.
        if self.in_transaction.is_some() {
            if self.server_in_transaction().await.unwrap_or(true) {
                return Err(
                    DriverError::new(ErrorCategory::Internal, "Transaction already open").into(),
                );
            }
            self.in_transaction = None;
        }
        /*
         * The options were discarded — the parameter was literally `_options` —
         * so `IsolationLevel`, `read_only` and `deferrable` were a complete,
         * documented API that did nothing, and every transaction ran at the
         * server default. Anyone reaching for SERIALIZABLE got READ COMMITTED
         * and no indication of it.
         *
         * Built from an enum rather than a string, so nothing here is
         * interpolated: the only values that can reach the SQL are the four
         * PostgreSQL defines.
         */
        self.client
            .batch_execute(&begin_statement(&options))
            .await
            .map_err(normalize_error)?;
        let id = TransactionId::new();
        self.in_transaction = Some(id);
        Ok(id)
    }

    async fn commit(&mut self) -> Result<(), Box<DriverError>> {
        self.end_transaction("COMMIT").await
    }

    async fn rollback(&mut self) -> Result<(), Box<DriverError>> {
        self.end_transaction("ROLLBACK").await
    }

    fn is_broken(&self) -> bool {
        self.client.is_closed()
    }
}

/// A labelled group of key/value rows, ready to render without the UI knowing
/// anything about Postgres catalogs.
fn section(label: &str, rows: Vec<(&str, String)>) -> serde_json::Value {
    serde_json::json!({
        "label": label,
        "rows": rows
            .into_iter()
            .filter(|(_, v)| !v.is_empty())
            .map(|(k, v)| serde_json::json!({ "k": k, "v": v }))
            .collect::<Vec<_>>(),
    })
}

fn opt(v: Option<String>) -> String {
    v.unwrap_or_default()
}

/// Why an index is or isn't a candidate for dropping.
///
/// `idx_scan = 0` is the seductive, wrong answer. On this developer's database
/// it flags 6.1 GB — of which 4 GB are primary keys and unique constraints that
/// enforce correctness and are scanned by the *constraint machinery*, not by
/// planner index scans. Reporting those as waste would be actively dangerous.
/// So the verdict, not the scan count, is what the UI leads with.
fn index_verdict(
    scans: i64,
    pk: bool,
    backs_constraint: bool,
    unique: bool,
) -> (&'static str, &'static str) {
    if scans > 0 {
        ("used", "Scanned since the last stats reset.")
    } else if pk || backs_constraint {
        (
            "keep",
            "Never scanned, but it enforces a primary key or constraint. Dropping it would drop the guarantee.",
        )
    } else if unique {
        (
            "review",
            "Never scanned, but it enforces uniqueness. Safe to drop only if nothing relies on that.",
        )
    } else {
        (
            "candidate",
            "Never scanned since the last stats reset, and enforces nothing.",
        )
    }
}

/// Index usage, folded by (partition root, column signature) so that one
/// logical index across 290 partitions reads as one row.
///
/// Folding by parent *index* would be the obvious approach and fails here:
/// this database attaches indexes to the leaves directly, so pg_inherits has
/// no parent to group by. The column signature is what actually identifies
/// "the same index" across a partition tree.
async fn index_health(
    client: &Client,
    schema: Option<&str>,
) -> Result<serde_json::Value, Box<DriverError>> {
    let rows = client
        .query(
            // `base` exists so the column signature can be computed per index
            // and then grouped on. Computing it inline in the GROUP BY forces
            // s.relid into the grouping key, which silently un-folds every
            // partition back into its own row — the failure looks like working
            // code that reports "1 partition" 8,887 times.
            "WITH base AS (
               SELECT s.indexrelid, s.idx_scan, s.schemaname,
                      i.relname, am.amname AS method,
                      x.indisunique AS uniq, x.indisprimary AS pk,
                      (c.conindid IS NOT NULL) AS backs_con,
                      rt.relname AS root_table, rn.nspname AS root_schema,
                      (SELECT string_agg(a.attname, ', ' ORDER BY k.ord)
                         FROM unnest(x.indkey) WITH ORDINALITY k(attnum, ord)
                         JOIN pg_attribute a ON a.attrelid = s.relid AND a.attnum = k.attnum) AS cols
               FROM pg_stat_user_indexes s
               JOIN pg_index x ON x.indexrelid = s.indexrelid
               JOIN pg_class i ON i.oid = s.indexrelid
               JOIN pg_am am ON am.oid = i.relam
               LEFT JOIN pg_constraint c ON c.conindid = s.indexrelid
               JOIN pg_class rt ON rt.oid = COALESCE(pg_partition_root(s.relid), s.relid)
               JOIN pg_namespace rn ON rn.oid = rt.relnamespace
               WHERE ($1::text IS NULL OR s.schemaname = $1::text)
             ), g AS (
               SELECT root_schema, root_table, cols, method, uniq,
                      bool_or(pk) AS pk,
                      bool_or(backs_con) AS backs_con,
                      sum(idx_scan)::bigint AS scans,
                      sum(pg_relation_size(indexrelid))::bigint AS bytes,
                      count(*)::bigint AS members,
                      min(relname) AS sample_index,
                      -- Fully qualified and quoted by Postgres itself. A
                      -- partitioned index can have children in other schemas,
                      -- so a bare name would drop the wrong thing or nothing;
                      -- and quote_ident is the only correct escaper here.
                      array_agg(quote_ident(schemaname) || '.' || quote_ident(relname)
                                ORDER BY relname) AS index_idents
               FROM base
               GROUP BY root_schema, root_table, cols, method, uniq
             )
             SELECT root_schema, root_table, cols, method, uniq, pk, backs_con,
                    scans, bytes, pg_size_pretty(bytes), members, sample_index,
                    index_idents,
                    -- Totals over every group, not just the rows that survive
                    -- the LIMIT. A headline number that quietly means \"of the
                    -- 500 biggest\" is worse than no headline number.
                    sum(bytes) FILTER (WHERE scans = 0 AND NOT pk AND NOT backs_con AND NOT uniq)
                      OVER ()::bigint AS total_drop_bytes,
                    sum(members) FILTER (WHERE scans = 0 AND NOT pk AND NOT backs_con AND NOT uniq)
                      OVER ()::bigint AS total_drop_n
             FROM g ORDER BY bytes DESC LIMIT 500",
            &[&schema],
        )
        .await
        .map_err(normalize_error)?;

    let mut items = Vec::new();
    // Identical across every row (window over the whole set); read once.
    let cand_bytes: i64 = rows.first().and_then(|r| r.get(13)).unwrap_or(0);
    let cand_n: i64 = rows.first().and_then(|r| r.get(14)).unwrap_or(0);
    for r in &rows {
        let scans: i64 = r.get(7);
        let (verdict, why) = index_verdict(scans, r.get(5), r.get(6), r.get(4));
        let bytes: i64 = r.get(8);
        let members: i64 = r.get(10);
        // The physical names are only needed to build a DROP script, and a
        // script is only ever offered for what might be dropped. Shipping all
        // 8,887 names to render a table nobody will act on is pure weight.
        let idents: Vec<String> = if verdict == "candidate" || verdict == "review" {
            r.get::<_, Vec<String>>(12)
        } else {
            Vec::new()
        };
        items.push(serde_json::json!({
            "schema": r.get::<_, String>(0),
            "table": r.get::<_, String>(1),
            "columns": opt(r.get::<_, Option<String>>(2)),
            "method": r.get::<_, String>(3),
            "scans": scans,
            "bytes": bytes,
            "size": opt(r.get::<_, Option<String>>(9)),
            "members": members,
            "sampleIndex": r.get::<_, String>(11),
            "indexIdents": idents,
            "verdict": verdict,
            "why": why,
        }));
    }
    Ok(serde_json::json!({
        "items": items,
        "droppableBytes": cand_bytes,
        "droppableIndexes": cand_n,
    }))
}

/// Dead tuples and vacuum/analyze recency.
///
/// Ordering by dead tuples alone would bury the real problem here: 2,603 tables
/// have never been vacuumed at all, and a table nobody has analyzed reports
/// zero dead tuples because nobody has counted them. Never-analyzed sorts first.
async fn table_health(
    client: &Client,
    schema: Option<&str>,
) -> Result<serde_json::Value, Box<DriverError>> {
    let rows = client
        .query(
            "SELECT schemaname, relname, n_live_tup, n_dead_tup,
                    CASE WHEN n_live_tup + n_dead_tup > 0
                         THEN round(100.0 * n_dead_tup / (n_live_tup + n_dead_tup), 1)::float8
                         ELSE 0::float8 END AS dead_pct,
                    GREATEST(last_vacuum, last_autovacuum)   AS vacuumed,
                    GREATEST(last_analyze, last_autoanalyze)  AS analyzed,
                    pg_size_pretty(pg_relation_size(relid)),
                    -- Counted over every table, then truncated by the LIMIT.
                    -- Counting the returned page instead would report \"500
                    -- never analyzed\" forever, which is just the page size
                    -- wearing a fact's clothing.
                    count(*) FILTER (WHERE last_analyze IS NULL AND last_autoanalyze IS NULL)
                      OVER ()::bigint AS total_never_analyzed,
                    count(*) FILTER (WHERE last_vacuum IS NULL AND last_autovacuum IS NULL)
                      OVER ()::bigint AS total_never_vacuumed,
                    count(*) OVER ()::bigint AS total_tables
             FROM pg_stat_user_tables
             WHERE ($1::text IS NULL OR schemaname = $1::text)
             ORDER BY (GREATEST(last_analyze, last_autoanalyze) IS NULL) DESC,
                      n_dead_tup DESC
             LIMIT 500",
            &[&schema],
        )
        .await
        .map_err(normalize_error)?;

    let fmt = |t: Option<chrono::DateTime<chrono::Utc>>| match t {
        Some(t) => t.format("%Y-%m-%d %H:%M").to_string(),
        None => "never".to_string(),
    };
    let items: Vec<_> = rows
        .iter()
        .map(|r| {
            let analyzed: Option<chrono::DateTime<chrono::Utc>> = r.get(6);
            serde_json::json!({
                "schema": r.get::<_, String>(0),
                "table": r.get::<_, String>(1),
                "liveTuples": r.get::<_, i64>(2),
                "deadTuples": r.get::<_, i64>(3),
                "deadPct": r.get::<_, f64>(4),
                "vacuumed": fmt(r.get(5)),
                "analyzed": fmt(analyzed),
                // The flag that matters: every row estimate this app shows for
                // such a table — including the details modal — is a guess.
                "neverAnalyzed": analyzed.is_none(),
                "size": opt(r.get::<_, Option<String>>(7)),
            })
        })
        .collect();
    Ok(serde_json::json!({
        "items": items,
        "neverAnalyzed": rows.first().and_then(|r| r.get::<_, Option<i64>>(8)).unwrap_or(0),
        "neverVacuumed": rows.first().and_then(|r| r.get::<_, Option<i64>>(9)).unwrap_or(0),
        "totalTables": rows.first().and_then(|r| r.get::<_, Option<i64>>(10)).unwrap_or(0),
        "truncated": rows.len() >= 500,
    }))
}

/// Top statements, or an honest explanation of why there are none.
async fn top_queries(client: &Client, limit: i64) -> Result<serde_json::Value, Box<DriverError>> {
    let installed: bool = client
        .query_one(
            "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements')",
            &[],
        )
        .await
        .map_err(normalize_error)?
        .get(0);
    if !installed {
        return Ok(serde_json::json!({
            "available": false,
            "reason": "The pg_stat_statements extension is not installed on this server.",
            "remedy": "It must be added to shared_preload_libraries in postgresql.conf, which needs a server restart, then: CREATE EXTENSION pg_stat_statements;",
            "items": [],
        }));
    }
    // total_exec_time is the PG13+ name; PG12 called it total_time. Ask the
    // catalog rather than the version string — forks renumber themselves.
    let modern: bool = client
        .query_one(
            "SELECT EXISTS (SELECT 1 FROM information_schema.columns
                             WHERE table_name = 'pg_stat_statements'
                               AND column_name = 'total_exec_time')",
            &[],
        )
        .await
        .map_err(normalize_error)?
        .get(0);
    let (total, mean) = if modern {
        ("total_exec_time", "mean_exec_time")
    } else {
        ("total_time", "mean_time")
    };
    let sql = format!(
        "SELECT queryid::text, query, calls, {total} AS total_ms, {mean} AS mean_ms, rows
         FROM pg_stat_statements ORDER BY {total} DESC LIMIT $1"
    );
    let rows = client
        .query(&sql, &[&limit])
        .await
        .map_err(normalize_error)?;
    let items: Vec<_> = rows
        .iter()
        .map(|r| {
            serde_json::json!({
                "queryId": opt(r.get::<_, Option<String>>(0)),
                "query": opt(r.get::<_, Option<String>>(1)),
                "calls": r.get::<_, i64>(2),
                "totalMs": r.get::<_, f64>(3),
                "meanMs": r.get::<_, f64>(4),
                "rows": r.get::<_, i64>(5),
            })
        })
        .collect();
    Ok(serde_json::json!({ "available": true, "items": items }))
}

/// Find an object by name anywhere in the database.
///
/// Partitions are excluded: matching "messages" would otherwise return
/// 300 near-identical children and hide the parent the user actually wants.
async fn search_objects(
    client: &Client,
    term: &str,
    limit: i64,
) -> Result<serde_json::Value, Box<DriverError>> {
    let pat = format!(
        "%{}%",
        term.replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    );
    let rows = client
        .query(
            "SELECT n.nspname, c.relname,
                    CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'table'
                                   WHEN 'v' THEN 'view'  WHEN 'm' THEN 'matview'
                                   WHEN 'S' THEN 'sequence' WHEN 'i' THEN 'index'
                                   WHEN 'I' THEN 'index' WHEN 'f' THEN 'foreign' END AS kind,
                    NULL::text AS column_name
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE c.relname ILIKE $1 ESCAPE '\\'
               AND NOT c.relispartition
               AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
               AND c.relkind IN ('r','p','v','m','S','i','I','f')
             UNION ALL
             SELECT n.nspname, c.relname, 'column', a.attname
             FROM pg_attribute a
             JOIN pg_class c ON c.oid = a.attrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE a.attname ILIKE $1 ESCAPE '\\'
               AND a.attnum > 0 AND NOT a.attisdropped
               AND NOT c.relispartition
               AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
               AND c.relkind IN ('r','p','v','m','f')
             ORDER BY 3, 1, 2
             LIMIT $2",
            &[&pat, &limit],
        )
        .await
        .map_err(normalize_error)?;
    let items: Vec<_> = rows
        .iter()
        .map(|r| {
            serde_json::json!({
                "schema": r.get::<_, String>(0),
                "name": r.get::<_, String>(1),
                "kind": opt(r.get::<_, Option<String>>(2)),
                "column": opt(r.get::<_, Option<String>>(3)),
            })
        })
        .collect();
    Ok(serde_json::json!({ "items": items, "truncated": items.len() as i64 >= limit }))
}

/// Direct partitions with bounds, size and rows.
async fn partition_overview(
    client: &Client,
    schema: &str,
    table: &str,
) -> Result<serde_json::Value, Box<DriverError>> {
    let head = client
        .query_opt(
            "SELECT pg_get_partkeydef(c.oid), c.relkind::text
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = $1 AND c.relname = $2",
            &[&schema, &table],
        )
        .await
        .map_err(normalize_error)?;
    let (partkey, is_part) = match head {
        Some(r) => (
            opt(r.get::<_, Option<String>>(0)),
            r.get::<_, String>(1) == "p",
        ),
        None => (String::new(), false),
    };
    if !is_part {
        return Ok(serde_json::json!({
            "partitioned": false,
            "strategy": "",
            "partitionKey": "",
            "items": [],
        }));
    }
    let rows = client
        .query(
            // Same trap as the parent: a sub-partitioned child stores nothing
            // itself, so its own size is 0 next to 300,000 rows. Sum its tree.
            "SELECT ch.relname,
                    pg_get_expr(ch.relpartbound, ch.oid) AS bounds,
                    pg_size_pretty(COALESCE(
                      (SELECT sum(pg_total_relation_size(pt.relid)) FROM pg_partition_tree(ch.oid) pt),
                      pg_total_relation_size(ch.oid))),
                    ch.reltuples::bigint,
                    ch.relkind = 'p' AS sub_partitioned,
                    (SELECT count(*) FROM pg_inherits gi WHERE gi.inhparent = ch.oid)::bigint
             FROM pg_inherits i
             JOIN pg_class ch ON ch.oid = i.inhrelid
             JOIN pg_class p  ON p.oid  = i.inhparent
             JOIN pg_namespace n ON n.oid = p.relnamespace
             WHERE n.nspname = $1 AND p.relname = $2
             ORDER BY ch.relname",
            &[&schema, &table],
        )
        .await
        .map_err(normalize_error)?;
    let strategy = partkey
        .split_once(' ')
        .map(|(s, _)| s.to_string())
        .unwrap_or_else(|| partkey.clone());
    let items: Vec<_> = rows
        .iter()
        .map(|r| {
            let est: i64 = r.get(3);
            serde_json::json!({
                "name": r.get::<_, String>(0),
                "bounds": opt(r.get::<_, Option<String>>(1)),
                "size": opt(r.get::<_, Option<String>>(2)),
                "rows": if est < 0 { 0 } else { est },
                "rowsKnown": est >= 0,
                "isPartitioned": r.get::<_, bool>(4),
                "partitionCount": r.get::<_, i64>(5),
            })
        })
        .collect();
    Ok(serde_json::json!({
        "partitioned": true,
        "strategy": strategy,
        "partitionKey": partkey,
        "items": items,
    }))
}

/// Facts about one object. Each kind is asked what it can actually answer:
/// a sequence knows its last value, an index knows how often it was scanned,
/// a table knows its size — and none of them share a catalog view.
async fn object_details(
    client: &Client,
    schema: &str,
    name: &str,
    kind: &str,
) -> Result<serde_json::Value, Box<DriverError>> {
    let mut sections: Vec<serde_json::Value> = Vec::new();

    if kind == "sequence" {
        // pg_sequences holds the definition; last_value needs the sequence
        // itself and is only visible with privileges, so it may be absent.
        let r = client
            .query_opt(
                "SELECT start_value, min_value, max_value, increment_by, cycle, cache_size, last_value
                 FROM pg_sequences WHERE schemaname = $1 AND sequencename = $2",
                &[&schema, &name],
            )
            .await
            .map_err(normalize_error)?;
        if let Some(r) = r {
            sections.push(section(
                "Sequence",
                vec![
                    (
                        "Last value",
                        r.get::<_, Option<i64>>(6)
                            .map(|v| v.to_string())
                            .unwrap_or_else(|| "not yet called".into()),
                    ),
                    ("Start", r.get::<_, i64>(0).to_string()),
                    ("Increment", r.get::<_, i64>(3).to_string()),
                    ("Minimum", r.get::<_, i64>(1).to_string()),
                    ("Maximum", r.get::<_, i64>(2).to_string()),
                    ("Cache", r.get::<_, i64>(5).to_string()),
                    (
                        "Cycles",
                        if r.get::<_, bool>(4) {
                            "yes".into()
                        } else {
                            "no".into()
                        },
                    ),
                ],
            ));
        }
        // Which column owns it, if any — the answer to "where does this get used".
        let owned = client
            .query_opt(
                "SELECT tc.relname || '.' || a.attname
                 FROM pg_depend d
                 JOIN pg_class sc ON sc.oid = d.objid
                 JOIN pg_namespace n ON n.oid = sc.relnamespace
                 JOIN pg_class tc ON tc.oid = d.refobjid
                 JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
                 WHERE sc.relkind = 'S' AND n.nspname = $1 AND sc.relname = $2
                   AND d.deptype IN ('a','i')",
                &[&schema, &name],
            )
            .await
            .map_err(normalize_error)?;
        if let Some(o) = owned {
            sections.push(section("Owned by", vec![("Column", o.get::<_, String>(0))]));
        }
    } else if kind == "index" {
        let r = client
            .query_opt(
                "SELECT pg_get_indexdef(i.indexrelid),
                        pg_size_pretty(pg_relation_size(i.indexrelid)),
                        COALESCE(s.idx_scan, 0),
                        COALESCE(s.idx_tup_read, 0),
                        COALESCE(s.idx_tup_fetch, 0),
                        i.indisunique, i.indisprimary, i.indisvalid,
                        tc.relname,
                        am.amname
                 FROM pg_index i
                 JOIN pg_class ic ON ic.oid = i.indexrelid
                 JOIN pg_class tc ON tc.oid = i.indrelid
                 JOIN pg_am am ON am.oid = ic.relam
                 JOIN pg_namespace n ON n.oid = ic.relnamespace
                 LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = i.indexrelid
                 WHERE n.nspname = $1 AND ic.relname = $2",
                &[&schema, &name],
            )
            .await
            .map_err(normalize_error)?;
        if let Some(r) = r {
            let scans: i64 = r.get(2);
            sections.push(section(
                "Index",
                vec![
                    ("On table", r.get::<_, String>(8)),
                    ("Method", r.get::<_, String>(9)),
                    ("Size", opt(r.get::<_, Option<String>>(1))),
                    (
                        "Unique",
                        if r.get::<_, bool>(5) {
                            "yes".into()
                        } else {
                            "no".into()
                        },
                    ),
                    (
                        "Primary key",
                        if r.get::<_, bool>(6) {
                            "yes".into()
                        } else {
                            "no".into()
                        },
                    ),
                    (
                        "Valid",
                        if r.get::<_, bool>(7) {
                            "yes".into()
                        } else {
                            "NO — rebuild it".into()
                        },
                    ),
                ],
            ));
            sections.push(section(
                "Usage since stats reset",
                vec![
                    (
                        "Scans",
                        if scans == 0 {
                            "0 — never used".into()
                        } else {
                            scans.to_string()
                        },
                    ),
                    ("Tuples read", r.get::<_, i64>(3).to_string()),
                    ("Tuples fetched", r.get::<_, i64>(4).to_string()),
                ],
            ));
            sections.push(section("Definition", vec![("SQL", r.get::<_, String>(0))]));
        }
    } else {
        // Tables, views, matviews, foreign tables.
        let r = client
            .query_opt(
                // A partitioned parent stores nothing itself, so
                // pg_total_relation_size(parent) is 0 — a true number that
                // reads as a lie next to three million rows. Sum the partition
                // tree instead. pg_partition_tree returns no rows for an
                // ordinary table, hence the COALESCE back to its own size.
                "SELECT pg_size_pretty(COALESCE(
                          (SELECT sum(pg_total_relation_size(pt.relid)) FROM pg_partition_tree(c.oid) pt),
                          pg_total_relation_size(c.oid))),
                        pg_size_pretty(COALESCE(
                          (SELECT sum(pg_relation_size(pt.relid)) FROM pg_partition_tree(c.oid) pt),
                          pg_relation_size(c.oid))),
                        pg_size_pretty(COALESCE(
                          (SELECT sum(pg_indexes_size(pt.relid)) FROM pg_partition_tree(c.oid) pt),
                          pg_indexes_size(c.oid))),
                        c.reltuples::bigint,
                        pg_get_userbyid(c.relowner),
                        obj_description(c.oid, 'pg_class'),
                        c.relkind::text,
                        c.relispartition,
                        pg_get_expr(c.relpartbound, c.oid),
                        (SELECT p.relname FROM pg_inherits i JOIN pg_class p ON p.oid = i.inhparent
                          WHERE i.inhrelid = c.oid),
                        (SELECT count(*) FROM pg_inherits i WHERE i.inhparent = c.oid),
                        pg_get_partkeydef(c.oid),
                        COALESCE(t.spcname, 'default'),
                        (SELECT count(*) FROM pg_attribute a
                          WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped),
                        -- Whole tree minus self. The direct-partition count
                        -- understates this whenever partitions are themselves
                        -- partitioned, which is exactly when it matters.
                        GREATEST((SELECT count(*) FROM pg_partition_tree(c.oid)) - 1, 0)
                 FROM pg_class c
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                 LEFT JOIN pg_tablespace t ON t.oid = c.reltablespace
                 WHERE n.nspname = $1 AND c.relname = $2",
                &[&schema, &name],
            )
            .await
            .map_err(normalize_error)?;
        if let Some(r) = r {
            let rows_est: i64 = r.get(3);
            let is_partitioned = r.get::<_, String>(6) == "p";
            let leaves: i64 = r.get(14);
            // Say what the number covers. On a parent these are tree totals,
            // and a reader who assumes otherwise draws the wrong conclusion.
            let note = |v: String| {
                if is_partitioned && !v.is_empty() {
                    format!("{v} — all {leaves} partitions")
                } else {
                    v
                }
            };
            sections.push(section(
                "Storage",
                vec![
                    ("Total size", note(opt(r.get::<_, Option<String>>(0)))),
                    ("Table", note(opt(r.get::<_, Option<String>>(1)))),
                    ("Indexes", note(opt(r.get::<_, Option<String>>(2)))),
                    // Planner estimate, not a count — saying so avoids a
                    // number being trusted as exact.
                    (
                        "Rows (estimate)",
                        if rows_est < 0 {
                            "unknown — never analyzed".into()
                        } else {
                            rows_est.to_string()
                        },
                    ),
                    ("Columns", r.get::<_, i64>(13).to_string()),
                    ("Tablespace", r.get::<_, String>(12)),
                ],
            ));
            let partkey = opt(r.get::<_, Option<String>>(11));
            let parent = opt(r.get::<_, Option<String>>(9));
            let children: i64 = r.get(10);
            if !partkey.is_empty() || !parent.is_empty() {
                sections.push(section(
                    "Partitioning",
                    vec![
                        ("Partitioned by", partkey),
                        (
                            "Direct partitions",
                            if children > 0 {
                                children.to_string()
                            } else {
                                String::new()
                            },
                        ),
                        // Only worth saying when the two differ — i.e. when the
                        // partitions are themselves partitioned.
                        (
                            "All levels",
                            if leaves > children {
                                leaves.to_string()
                            } else {
                                String::new()
                            },
                        ),
                        ("Parent", parent),
                        ("Bounds", opt(r.get::<_, Option<String>>(8))),
                    ],
                ));
            }
            sections.push(section(
                "About",
                vec![
                    ("Owner", r.get::<_, String>(4)),
                    ("Comment", opt(r.get::<_, Option<String>>(5))),
                ],
            ));
        }
    }

    Ok(serde_json::json!({ "title": name, "kind": kind, "sections": sections }))
}

/// The length of a value's wire bytes, without copying them.
struct RawLen(usize);

impl<'a> FromSql<'a> for RawLen {
    fn from_sql(_: &Type, raw: &'a [u8]) -> Result<Self, Box<dyn std::error::Error + Sync + Send>> {
        Ok(RawLen(raw.len()))
    }
    fn accepts(_: &Type) -> bool {
        true
    }
}

fn raw_len(row: &Row, i: usize) -> usize {
    row.try_get::<_, Option<RawLen>>(i)
        .ok()
        .flatten()
        .map_or(0, |r| r.0)
}

/// Wire size of a row: what decoding it will cost, roughly.
fn row_wire_bytes(row: &Row) -> usize {
    (0..row.len()).map(|i| raw_len(row, i)).sum()
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

/// PostgreSQL's own ceilings on a `numeric`: at most 0x3FFF (16383) display
/// digits after the point, and 1000 base-10000 wire digits. A real server never
/// exceeds these; a *malicious* one is not bound by them, so we enforce them
/// ourselves before any allocation is sized from the values.
const NUMERIC_DSCALE_MAX: usize = 0x3FFF;
const MAX_NUMERIC_DIGITS: usize = 1000;
/// Hard cap on the rendered decimal string. Well above any legitimate value
/// (16383 fractional + ~4000 integer chars ≈ 20 KB); this is the backstop that
/// turns a crafted length into a bounded error instead of an OOM.
const MAX_NUMERIC_RENDER_BYTES: usize = 64 * 1024;

impl<'a> FromSql<'a> for PgNumeric {
    fn from_sql(_: &Type, raw: &'a [u8]) -> Result<Self, Box<dyn std::error::Error + Sync + Send>> {
        if raw.len() < 8 {
            return Err("numeric: header too short".into());
        }
        // Read scale-like fields UNSIGNED. `dscale`/`ndigits`/`weight` are
        // unsigned on the wire; a prior `i16 as usize` sign-extended a crafted
        // high-bit value to a near-usize::MAX loop bound (security review
        // RUST-01) — a single `1::numeric`-shaped reply with dscale=0xFFFF hung
        // the app. Read as u16 and validate before use.
        let ndigits_raw = u16::from_be_bytes([raw[0], raw[1]]);
        let weight = i16::from_be_bytes([raw[2], raw[3]]) as i32;
        let sign = u16::from_be_bytes([raw[4], raw[5]]);
        let dscale = u16::from_be_bytes([raw[6], raw[7]]) as usize;

        match sign {
            0xC000 => return Ok(PgNumeric("NaN".into())),
            0xD000 => return Ok(PgNumeric("Infinity".into())),
            0xF000 => return Ok(PgNumeric("-Infinity".into())),
            _ => {}
        }

        if dscale > NUMERIC_DSCALE_MAX {
            return Err(
                format!("numeric: display scale {dscale} exceeds PostgreSQL maximum").into(),
            );
        }
        let ndigits = ndigits_raw as usize;
        if ndigits > MAX_NUMERIC_DIGITS {
            return Err(format!("numeric: digit count {ndigits} implausibly large").into());
        }
        if raw.len() < 8 + ndigits * 2 {
            return Err("numeric: digit count does not match payload".into());
        }
        // Bound the rendered size from the header before building the string.
        // Integer part ≈ (weight+1) groups of 4 chars; fraction ≈ dscale chars.
        let int_chars = (weight.max(-1) + 1) as usize * 4;
        let estimated = int_chars.saturating_add(dscale).saturating_add(4);
        if estimated > MAX_NUMERIC_RENDER_BYTES {
            return Err("numeric: value too large to render safely".into());
        }
        // Digit `k`, read from the wire in place (no `Vec` of them per cell);
        // groups past either end are zero.
        let at = |k: i32| -> i16 {
            usize::try_from(k)
                .ok()
                .filter(|&k| k < ndigits)
                .map_or(0, |k| i16::from_be_bytes([raw[8 + k * 2], raw[9 + k * 2]]))
        };

        // Written straight into the one string the cell keeps: this was a
        // `to_string`/`format!` allocation per digit group, plus a second
        // string for the fraction.
        use std::fmt::Write as _;
        let mut s = String::with_capacity(estimated);
        if sign == 0x4000 {
            s.push('-');
        }

        // Integer part: the digit groups with a non-negative exponent.
        if weight < 0 {
            s.push('0');
        } else {
            for k in 0..=weight {
                if k == 0 {
                    let _ = write!(s, "{}", at(k));
                } else {
                    let _ = write!(s, "{:04}", at(k));
                }
            }
        }

        // Fraction: groups after the point, padded then cut to the display scale
        // so a stored 125000.50 keeps its trailing zero.
        if dscale > 0 {
            s.push('.');
            let end = s.len() + dscale;
            let mut k = weight + 1;
            while s.len() < end {
                let _ = write!(s, "{:04}", at(k));
                k += 1;
            }
            // Only ASCII (digits, or a sign from a crafted group) past the
            // point, so any length is a char boundary.
            s.truncate(end);
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
#[cfg(test)]
struct RawValue(Vec<u8>);

#[cfg(test)]
impl<'a> FromSql<'a> for RawValue {
    fn from_sql(_: &Type, raw: &'a [u8]) -> Result<Self, Box<dyn std::error::Error + Sync + Send>> {
        Ok(RawValue(raw.to_vec()))
    }
    fn accepts(_: &Type) -> bool {
        true
    }
}

/// Does this type's **binary** wire encoding happen to be its text?
///
/// True for very few things, and that is the point. An enum is sent as its
/// label; `xml` as the document; a domain is sent exactly as its base type.
/// Everything else — `money`, `interval`, `point`, ranges, `macaddr`, `bit` —
/// has a packed binary layout that is not text and must not be read as text.
fn binary_is_text(ty: &Type) -> bool {
    match ty.kind() {
        // The wire value of an enum is the variant label itself.
        Kind::Enum(_) => true,
        // A domain transmits exactly as whatever it wraps, so ask that.
        Kind::Domain(inner) => binary_is_text(inner),
        _ => {
            *ty == Type::XML
                || *ty == Type::TEXT
                || *ty == Type::VARCHAR
                || *ty == Type::BPCHAR
                || *ty == Type::NAME
                || *ty == Type::UNKNOWN
        }
    }
}

/// Render a value of a type we have no dedicated mapping for.
///
/// This used to guess: if the bytes parsed as UTF-8 and looked printable, it
/// called them text. That is not a decode, it is a coincidence detector, and
/// it was wrong in a way that could not be seen. `money` is an int64 of cents
/// in binary; the eight bytes `12345678` are perfectly printable ASCII, so
/// `$35,449,521,560,180,631.60` rendered as the string `"12345678"` — no
/// error, no hex, just a plausible wrong answer in a cell. The same trap is
/// open for `interval`, `point`, and anything else whose packed layout can
/// land in printable range.
///
/// So: ask the type whether its binary form is text (`binary_is_text`), and
/// otherwise show hex. Hex is ugly, but it is *visibly* raw — nobody mistakes
/// `\x0000000000000064` for a value, whereas everyone would trust `12345678`.
/// A wrong answer that looks right is worse than an unfriendly one that looks
/// unfriendly.
#[cfg(test)]
fn render_raw(v: RawValue, ty: &Type) -> CellValue {
    render_raw_bytes(&v.0, ty)
}

/// A value's wire bytes, borrowed from the row: the fallback path renders
/// straight from the row buffer instead of copying the value out first.
struct RawRef<'a>(&'a [u8]);

impl<'a> FromSql<'a> for RawRef<'a> {
    fn from_sql(_: &Type, raw: &'a [u8]) -> Result<Self, Box<dyn std::error::Error + Sync + Send>> {
        Ok(RawRef(raw))
    }
    fn accepts(_: &Type) -> bool {
        true
    }
}

fn render_raw_bytes(v: &[u8], ty: &Type) -> CellValue {
    if binary_is_text(ty) {
        if let Ok(s) = std::str::from_utf8(v) {
            return CellValue::Text(s.to_owned());
        }
    }
    // Types with a fixed layout are decoded from it (see `wire`): an
    // `interval`, a range, an `infinity` date. That is a decode by layout,
    // not the guess from printable bytes described above; what `wire` does
    // not know, or cannot make sense of, still falls through to hex.
    if let Some(text) = wire::render(ty, v) {
        return CellValue::Text(text);
    }
    // Hex doubles the size, so cap the *input* bytes before encoding rather than
    // building a 2 GB string and truncating it. Keep MAX/2 bytes → MAX hex
    // chars, then note the rest. cap_cell would catch the length anyway; this
    // avoids the transient allocation on the way there. (RUST-02.)
    let cap = MAX_RENDERED_CELL_BYTES / 2;
    if v.len() > cap {
        let dropped = v.len() - cap;
        return CellValue::other(
            format!(
                "\\x{}… <truncated {dropped} more bytes>",
                hex::encode(&v[..cap])
            ),
            ty.name().to_string(),
        );
    }
    CellValue::other(format!("\\x{}", hex::encode(v)), ty.name().to_string())
}

/// The largest rendered cell string TupleNest keeps. A PostgreSQL field can be
/// ~1 GB on the wire, and an unknown/`bytea` value is hex-encoded to *twice*
/// its bytes — one pathological row could spike memory and freeze the grid
/// before the result-set byte budget (which counts *after* conversion) engages.
/// 1 MiB is far beyond any value worth showing whole in a cell; past it we keep
/// a head and label the truncation. (Security review RUST-02.)
const MAX_RENDERED_CELL_BYTES: usize = 1024 * 1024;

/// Truncate an over-long rendered cell on a char boundary, with a visible note
/// of how much was dropped. The value stays inspectable; it just cannot bury
/// the UI or the process.
fn cap_rendered(s: String) -> String {
    if s.len() <= MAX_RENDERED_CELL_BYTES {
        return s;
    }
    cap_str(&s)
}

/// `cap_rendered` for a borrowed value: one allocation of at most the cap,
/// rather than an owned copy of the whole value that is then cut down.
fn cap_str(s: &str) -> String {
    if s.len() <= MAX_RENDERED_CELL_BYTES {
        return s.to_owned();
    }
    let mut end = MAX_RENDERED_CELL_BYTES;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    let dropped = s.len() - end;
    format!("{}… <truncated {dropped} more bytes>", &s[..end])
}

/// Apply the per-cell cap to whichever variants carry a rendered string.
fn cap_cell(c: CellValue) -> CellValue {
    match c {
        CellValue::Text(s) => CellValue::Text(cap_rendered(s)),
        CellValue::Other(mut o) => {
            o.rendered = cap_rendered(std::mem::take(&mut o.rendered));
            CellValue::Other(o)
        }
        other => other,
    }
}

fn convert_cell(row: &Row, i: usize) -> CellValue {
    // Text is the common case and the one that can be huge: borrow it from the
    // row and cap while copying, so an over-long value is never held whole as
    // an owned String (and then copied again to truncate it).
    if matches!(
        *row.columns()[i].type_(),
        Type::TEXT | Type::VARCHAR | Type::BPCHAR | Type::NAME | Type::UNKNOWN
    ) {
        if let Ok(v) = row.try_get::<_, Option<&str>>(i) {
            return v.map_or(CellValue::Null, |s| CellValue::Text(cap_str(s)));
        }
    }
    cap_cell(convert_cell_inner(row, i))
}

fn convert_cell_inner(row: &Row, i: usize) -> CellValue {
    // Borrowed, not cloned: this runs once per cell.
    let ty = row.columns()[i].type_();
    // Text is capped after rendering; bytea and json used to be decoded whole
    // first (a full copy, and a full serde tree), with no cap at all. Decide
    // from the wire length before paying for either.
    if matches!(*ty, Type::BYTEA | Type::JSON | Type::JSONB) {
        let len = raw_len(row, i);
        if len > MAX_RENDERED_CELL_BYTES {
            return CellValue::other(
                format!(
                    "<{} of {len} bytes — too large to show in a cell>",
                    ty.name()
                ),
                ty.name().to_string(),
            );
        }
    }
    macro_rules! take {
        ($t:ty, $wrap:expr) => {
            match row.try_get::<_, Option<$t>>(i) {
                Ok(Some(v)) => $wrap(v),
                Ok(None) => CellValue::Null,
                Err(_) => fallback(row, i, ty),
            }
        };
    }
    match *ty {
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

        // Dates and times are decoded from their wire integers (see `wire`),
        // not through chrono's calendar types. Those have no `infinity`, no
        // 24:00:00 (it came out as 00:00:00) and no BC era (44 BC came out as
        // `-0043`), and print fractions padded to three or six digits where
        // the server prints `.25`. `timestamp` has no zone and is written as
        // the wall clock the server stored; `timestamptz` in UTC with a `Z`.
        Type::TIMESTAMP | Type::TIMESTAMPTZ | Type::DATE => fallback(row, i, ty),
        // Not through `NaiveTime`: it has no 24:00:00, which is a valid
        // `time`, and read it as 00:00:00.
        Type::TIME => fallback(row, i, ty),

        Type::JSON | Type::JSONB => match row.try_get::<_, Option<RawRef<'_>>>(i) {
            Ok(Some(raw)) => json_cell(raw.0, ty),
            Ok(None) => CellValue::Null,
            Err(_) => fallback(row, i, ty),
        },
        Type::BYTEA => take!(Vec<u8>, |v: Vec<u8>| CellValue::Bytes(v.into_boxed_slice())),
        Type::UUID => take!(uuid::Uuid, |v: uuid::Uuid| CellValue::Text(v.to_string())),
        Type::INET | Type::CIDR => take!(std::net::IpAddr, |v: std::net::IpAddr| {
            CellValue::Text(v.to_string())
        }),

        // Arrays of every element type and shape, ranges, intervals, enums,
        // domains: decoded from the wire in `wire`. Arrays used to have a
        // native path for one-dimensional ones of a few types, which dropped
        // non-default bounds (`[0:1]={7,8}` read `{7,8}`) and wrote booleans
        // as `true` where the server writes `t`.
        // Geometry, money, xml, and anything
        // else the server may have: decoded from the wire rather than refused.
        _ => fallback(row, i, ty),
    }
}

/// A `json` or `jsonb` value as the text the server sent.
///
/// json's wire form is the document as it was stored; jsonb's is a version
/// byte and the server's own rendering. Both are what `::text` and psql show.
///
/// The value used to be parsed into a `serde_json::Value` and written back
/// out, which is a different document: object keys re-sorted, the earlier of
/// a duplicated key dropped (`json` keeps both), and every number that is not
/// an i64, a u64 or an exact f64 rounded — `12345678901234567890123` came
/// back as `1.2345678901234568e22`. Checked for validity, never rewritten.
fn json_cell(raw: &[u8], ty: &Type) -> CellValue {
    let text = if *ty == Type::JSONB {
        match raw.split_first() {
            Some((1, rest)) => rest,
            // A version this code has never seen: show it raw, not guessed at.
            _ => return render_raw_bytes(raw, ty),
        }
    } else {
        raw
    };
    match std::str::from_utf8(text)
        .ok()
        .and_then(|s| serde_json::value::RawValue::from_string(s.to_owned()).ok())
    {
        Some(doc) => CellValue::Json(doc),
        None => render_raw_bytes(raw, ty),
    }
}

/// Last resort for a type with no dedicated mapping. Never returns
/// "unsupported" — a database client that cannot show you your own data is
/// not doing its job.
fn fallback(row: &Row, i: usize, ty: &Type) -> CellValue {
    match row.try_get::<_, Option<RawRef<'_>>>(i) {
        Ok(Some(v)) => render_raw_bytes(v.0, ty),
        Ok(None) => CellValue::Null,
        Err(e) => CellValue::other(format!("<decode error: {e}>"), ty.name().to_string()),
    }
}

/// An integer bind value that adapts to whatever integer width Postgres
/// infers for the placeholder (int2/int4/int8), so `where id = $1` works
/// whether the column is int4 or int8.
/// A parameter given as text, for a placeholder of any type.
///
/// Sent in the protocol's *text* format, so the server parses it with the
/// placeholder's own input function — exactly as it would a quoted literal
/// in the statement. That is what a value typed into a parameter box is.
///
/// It used to be sent in binary and accepted only where the placeholder was
/// a string type (or an integer, parsed here). A value for a `numeric`,
/// `date`, `uuid`, `timestamptz` or `jsonb` placeholder could not be bound at
/// all, and the page worked around its half of that by guessing a type from
/// the characters: `007` for a text column was sent as the number 7, and a
/// decimal went through a double and lost its digits.
#[derive(Debug)]
struct AnyText(String);

impl tokio_postgres::types::ToSql for AnyText {
    fn to_sql(
        &self,
        _: &Type,
        out: &mut tokio_postgres::types::private::BytesMut,
    ) -> Result<tokio_postgres::types::IsNull, Box<dyn std::error::Error + Sync + Send>> {
        out.extend_from_slice(self.0.as_bytes());
        Ok(tokio_postgres::types::IsNull::No)
    }
    fn accepts(_: &Type) -> bool {
        true
    }
    fn encode_format(&self, _: &Type) -> tokio_postgres::types::Format {
        tokio_postgres::types::Format::Text
    }
    tokio_postgres::types::to_sql_checked!();
}

#[derive(Debug)]
struct AnyInt(i64);

impl tokio_postgres::types::ToSql for AnyInt {
    fn to_sql(
        &self,
        ty: &Type,
        out: &mut tokio_postgres::types::private::BytesMut,
    ) -> Result<tokio_postgres::types::IsNull, Box<dyn std::error::Error + Sync + Send>> {
        // Checked, never `as`: `65537 as i16` is 1, so a parameter one past
        // the column's range silently became a different, valid key.
        match *ty {
            Type::INT2 => i16::try_from(self.0)
                .map_err(|_| format!("{} is out of range for smallint", self.0))?
                .to_sql(ty, out),
            Type::INT4 => i32::try_from(self.0)
                .map_err(|_| format!("{} is out of range for integer", self.0))?
                .to_sql(ty, out),
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
        ParamValue::Text(s) => Box::new(AnyText(s.clone())),
        ParamValue::Bytes(b) => Box::new(b.clone()),
        ParamValue::Json(v) => Box::new(v.clone()),
    }
}

/// `COMMIT` or `END`, in any of their spellings. Not `COMMIT PREPARED`, which
/// finishes a different, already-prepared transaction.
fn commits(sql: &str) -> bool {
    let words = leading_words(sql, 2);
    matches!(words.first().map(String::as_str), Some("commit" | "end"))
        && words.get(1).map(String::as_str) != Some("prepared")
}

/// What a commit of a failed transaction really was.
fn commit_rolled_back() -> DriverError {
    DriverError::new(
        ErrorCategory::DriverFailure,
        "Nothing was committed: the transaction had failed and was rolled back",
    )
    .with_native_code("25P02")
    .with_explanation(
        "An earlier statement in this transaction failed, was cancelled or timed out. \
         PostgreSQL discards such a transaction when it is committed, and reports no error.",
    )
}

/// Does this statement only end the current transaction (`COMMIT`,
/// `ROLLBACK`, `END`, `ABORT`)? Those must always get through on a read-only
/// profile, or a read-write transaction it refused could never be closed —
/// and they cannot write anything themselves.
fn ends_transaction(sql: &str) -> bool {
    matches!(
        leading_words(sql, 1).first().map(String::as_str),
        Some("commit" | "rollback" | "end" | "abort")
    )
}

/// May a read-only profile send a statement that starts with this word?
///
/// An allowlist, so a command added to PostgreSQL later is refused until
/// someone decides otherwise. Everything here either reads or manages the
/// session and its transaction; the server's read-only mode still judges what
/// the statement does (`WITH … DELETE`, `SELECT … INTO`, `EXPLAIN ANALYZE` of
/// a write, a prepared write on `EXECUTE`). `DO` and `CALL` are refused
/// before this is asked.
///
/// What this cannot see is a function with a side effect called from a
/// `SELECT` — `pg_terminate_backend`, `pg_reload_conf`, `lo_unlink`. Those are
/// the role's privileges, and only the database can withhold them.
fn reads_only(first_word: &str) -> bool {
    matches!(
        first_word,
        // A statement that is only a comment, or empty: nothing to run.
        ""
            | "select"
            | "with"
            | "table"
            | "values"
            | "show"
            | "explain"
            // Session and transaction control.
            | "set"
            | "reset"
            | "begin"
            | "start"
            | "commit"
            | "end"
            | "rollback"
            | "abort"
            | "savepoint"
            | "release"
            // Cursors and prepared statements.
            | "declare"
            | "fetch"
            | "move"
            | "close"
            | "prepare"
            | "execute"
            | "deallocate"
            | "listen"
            | "unlisten"
            | "discard"
    )
}

/// The first `n` words of a statement, lowercased, skipping leading comments
/// the way the server would.
fn leading_words(sql: &str, n: usize) -> Vec<String> {
    let mut s = sql.trim_start();
    loop {
        if let Some(rest) = s.strip_prefix("--") {
            s = rest.split_once('\n').map_or("", |(_, r)| r).trim_start();
        } else if let Some(rest) = s.strip_prefix("/*") {
            // PostgreSQL nests block comments. Stopping at the first `*/`
            // left the tail of `/* a /* b */ c */ DO …` to be read as the
            // statement, so its first word was `c`, not `do`.
            let bytes = rest.as_bytes();
            let (mut depth, mut i) = (1, 0);
            while i < bytes.len() && depth > 0 {
                if bytes[i..].starts_with(b"/*") {
                    depth += 1;
                    i += 2;
                } else if bytes[i..].starts_with(b"*/") {
                    depth -= 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
            // `i` is the end of the text or just past an ASCII `*/`.
            s = rest.get(i..).unwrap_or("").trim_start();
        } else {
            break;
        }
    }
    s.split(|c: char| !c.is_ascii_alphabetic())
        .filter(|w| !w.is_empty())
        .take(n)
        .map(str::to_ascii_lowercase)
        .collect()
}

/// Map a tokio-postgres error into the normalized taxonomy (spec §54).
pub fn normalize_error(e: tokio_postgres::Error) -> Box<DriverError> {
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
            // 25P02. Everything after a failed statement inside a transaction
            // returns this, and it used to fall through to a bare "Database
            // error" — leaving the user in a state the app could not name,
            // where every subsequent query failed for no visible reason. The
            // cure is one ROLLBACK, so the message says so.
            SqlState::IN_FAILED_SQL_TRANSACTION => (
                ErrorCategory::DriverFailure,
                "Transaction aborted — roll back to continue",
            ),
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
        // The server sends far more than the one-line message — DETAIL, HINT,
        // CONTEXT, and the names of the objects involved. psql shows all of
        // it; swallowing it here reduced every unmapped failure to the words
        // "Database error", which is exactly the report a beta user filed.
        // Reassembled in psql's order so the text reads like what the person
        // would have seen in the terminal.
        let mut report = db.message().to_string();
        if let Some(d) = db.detail() {
            report.push_str("\nDetail: ");
            report.push_str(d);
        }
        if let Some(h) = db.hint() {
            report.push_str("\nHint: ");
            report.push_str(h);
        }
        if let Some(w) = db.where_() {
            report.push_str("\nContext: ");
            report.push_str(w);
        }
        // Name the object when the server names it. Only constraint/table-ish
        // fields — never values; values live in `detail`, which the server
        // already chose to disclose.
        let mut on = Vec::new();
        if let Some(s) = db.schema() {
            on.push(format!("schema \"{s}\""));
        }
        if let Some(t) = db.table() {
            on.push(format!("table \"{t}\""));
        }
        if let Some(c) = db.column() {
            on.push(format!("column \"{c}\""));
        }
        if let Some(c) = db.constraint() {
            on.push(format!("constraint \"{c}\""));
        }
        if let Some(d) = db.datatype() {
            on.push(format!("type \"{d}\""));
        }
        if !on.is_empty() {
            report.push_str("\nOn: ");
            report.push_str(&on.join(", "));
        }
        let mut err = DriverError::new(category, title)
            .with_native_code(db.code().code())
            .with_original_message(report);
        if let Some(tokio_postgres::error::ErrorPosition::Original(p)) = db.position() {
            let p = *p as usize;
            err = err.with_query_range(p.saturating_sub(1), p);
        }
        err.into()
    } else if e.is_closed() {
        DriverError::new(ErrorCategory::Network, "Connection closed")
            .with_original_message(e.to_string())
            .with_suggested_action("Reconnect and retry if the statement is safe to re-run")
            .into()
    } else {
        DriverError::new(ErrorCategory::DriverFailure, "Driver error")
            .with_original_message(e.to_string())
            .into()
    }
}

#[cfg(test)]
mod begin_statement_tests {
    use super::*;

    fn opts(
        isolation: Option<IsolationLevel>,
        read_only: bool,
        deferrable: bool,
    ) -> TransactionOptions {
        TransactionOptions {
            isolation,
            read_only,
            deferrable,
        }
    }

    #[test]
    fn a_plain_begin_when_nothing_is_asked_for() {
        assert_eq!(begin_statement(&opts(None, false, false)), "BEGIN");
    }

    #[test]
    fn maps_every_isolation_level_to_its_postgres_spelling() {
        // A wrong word here is a wrong isolation level, silently — the server
        // would reject a typo, but a mapping to the *wrong valid* level would
        // run and be undetectable.
        let cases = [
            (
                IsolationLevel::ReadUncommitted,
                "BEGIN ISOLATION LEVEL READ UNCOMMITTED",
            ),
            (
                IsolationLevel::ReadCommitted,
                "BEGIN ISOLATION LEVEL READ COMMITTED",
            ),
            (
                IsolationLevel::RepeatableRead,
                "BEGIN ISOLATION LEVEL REPEATABLE READ",
            ),
            (
                IsolationLevel::Serializable,
                "BEGIN ISOLATION LEVEL SERIALIZABLE",
            ),
        ];
        for (level, want) in cases {
            assert_eq!(begin_statement(&opts(Some(level), false, false)), want);
        }
    }

    #[test]
    fn integer_parameters_are_range_checked_not_wrapped() {
        use tokio_postgres::types::ToSql;
        let mut buf = tokio_postgres::types::private::BytesMut::new();
        // `65537 as i16` is 1: this used to bind as a different, valid key.
        assert!(AnyInt(65_537).to_sql(&Type::INT2, &mut buf).is_err());
        assert!(AnyInt(4_294_967_297).to_sql(&Type::INT4, &mut buf).is_err());
        assert!(AnyInt(-32_769).to_sql(&Type::INT2, &mut buf).is_err());
        buf.clear();
        AnyInt(32_767).to_sql(&Type::INT2, &mut buf).unwrap();
        assert_eq!(&buf[..], &32_767_i16.to_be_bytes());
    }

    #[test]
    fn a_text_parameter_is_sent_as_text_for_any_placeholder_type() {
        use tokio_postgres::types::{Format, ToSql};
        // Audit TN-018. The bytes are the characters, whatever the type: the
        // server does the parsing. (The live tests check that it does.)
        for ty in [
            Type::INT8,
            Type::NUMERIC,
            Type::TEXT,
            Type::DATE,
            Type::UUID,
            Type::JSONB,
            Type::INT4_ARRAY,
        ] {
            assert!(<AnyText as ToSql>::accepts(&ty), "{ty}");
            let p = AnyText("007".into());
            assert!(matches!(p.encode_format(&ty), Format::Text), "{ty}");
            let mut buf = tokio_postgres::types::private::BytesMut::new();
            p.to_sql_checked(&ty, &mut buf).unwrap();
            assert_eq!(&buf[..], b"007", "{ty}");
        }
    }

    #[test]
    fn a_read_only_profile_sends_only_what_reads() {
        // Audit TN-009. By first word, as `execute` asks.
        let first = |sql: &str| leading_words(sql, 1).first().cloned().unwrap_or_default();
        for sql in [
            "select 1",
            "  SELECT now()",
            "(select 1) union all (select 2)",
            "with t as (select 1) select * from t",
            "table pg_class",
            "values (1), (2)",
            "show server_version",
            "explain select 1",
            "/* why */ select 1",
            "-- only a comment",
            "",
            "begin",
            "start transaction read only",
            "commit",
            "rollback to savepoint a",
            "savepoint a",
            "set statement_timeout = 0",
            "declare c cursor for select 1",
            "fetch all from c",
            "close c",
            "prepare p as select 1",
            "execute p",
            "deallocate p",
        ] {
            assert!(reads_only(&first(sql)), "{sql:?} should be sent");
        }
        for sql in [
            "vacuum",
            "VACUUM FULL pg_class",
            "analyze",
            "reindex table t",
            "cluster",
            "checkpoint",
            "copy (select 1) to program 'id'",
            "COPY t TO '/tmp/out.csv'",
            "copy t from stdin",
            "/* x */ vacuum",
            "lock table t",
            "notify ch",
            "load 'auto_explain'",
            "insert into t values (1)",
            "update t set x = 1",
            "delete from t",
            "merge into t using s on true when matched then delete",
            "truncate t",
            "create table t (x int)",
            "drop table t",
            "alter system set work_mem = '1GB'",
            "grant all on t to public",
            "refresh materialized view m",
            "comment on table t is 'x'",
            "security label on table t is 'x'",
            "import foreign schema s from server x into public",
            "some_command_from_a_future_release",
        ] {
            assert!(!reads_only(&first(sql)), "{sql:?} should be refused");
        }
    }

    #[test]
    fn leading_words_skip_nested_and_unterminated_comments() {
        assert_eq!(
            leading_words("/* a /* b */ c */ DO $$ begin end $$", 1),
            ["do"]
        );
        assert_eq!(
            leading_words("/* /* /* deep */ */ */\n-- and a line\ncall p()", 1),
            ["call"]
        );
        assert_eq!(leading_words("/* é /* ü */ ñ */ commit", 1), ["commit"]);
        // Unterminated: there is no statement, so there are no words.
        assert!(leading_words("/* never closed DO", 1).is_empty());
        assert!(leading_words("/* a /* b */ still open DO", 1).is_empty());
    }

    #[test]
    fn only_transaction_enders_skip_the_read_only_check() {
        for sql in [
            "COMMIT",
            "rollback",
            "  END",
            "ABORT;",
            "-- why\nROLLBACK",
            "/* x */ commit",
            "ROLLBACK TO SAVEPOINT a",
        ] {
            assert!(ends_transaction(sql), "{sql:?} should be let through");
        }
        for sql in [
            "SELECT 1",
            "BEGIN READ WRITE",
            "SET default_transaction_read_only = off",
            "committed",
            "-- commit\nDELETE FROM t",
            "/* rollback */ DELETE FROM t",
            "",
        ] {
            assert!(!ends_transaction(sql), "{sql:?} must be checked");
        }
    }

    // TN-001: which statements get the failed-transaction check before they
    // are allowed to answer "committed".
    #[test]
    fn a_commit_is_recognised_in_every_spelling_and_nothing_else_is() {
        for sql in [
            "COMMIT",
            "commit;",
            "  End",
            "END TRANSACTION",
            "COMMIT WORK",
            "commit and chain",
            "-- done\nCOMMIT",
            "/* a /* nested */ note */ commit",
        ] {
            assert!(commits(sql), "{sql:?} commits");
        }
        for sql in [
            "ROLLBACK",
            "ABORT",
            "COMMIT PREPARED 'gid'",
            "commit   prepared 'gid'",
            "committed",
            "SELECT 'commit'",
            "-- commit\nSELECT 1",
            "BEGIN; COMMIT",
            "",
        ] {
            assert!(!commits(sql), "{sql:?} does not commit");
        }
    }

    #[test]
    fn read_only_without_an_isolation_level() {
        assert_eq!(begin_statement(&opts(None, true, false)), "BEGIN READ ONLY");
    }

    #[test]
    fn deferrable_only_where_postgres_honours_it() {
        // DEFERRABLE means something only for SERIALIZABLE READ ONLY. Emitting
        // it elsewhere would imply it did something.
        assert_eq!(
            begin_statement(&opts(Some(IsolationLevel::Serializable), true, true)),
            "BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY DEFERRABLE"
        );
        assert_eq!(
            begin_statement(&opts(Some(IsolationLevel::RepeatableRead), true, true)),
            "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
        );
        assert_eq!(
            begin_statement(&opts(Some(IsolationLevel::Serializable), false, true)),
            "BEGIN ISOLATION LEVEL SERIALIZABLE"
        );
    }

    #[test]
    fn the_default_options_are_a_plain_begin() {
        // What `pg_begin` passes today. It must stay the server default.
        assert_eq!(begin_statement(&TransactionOptions::default()), "BEGIN");
    }
}

#[cfg(test)]
mod array_element_tests {
    use super::*;

    #[test]
    fn leaves_a_plain_element_alone() {
        assert_eq!(quote_array_element("ada"), "ada");
        assert_eq!(quote_array_element("42"), "42");
    }

    #[test]
    fn quotes_an_element_containing_a_comma() {
        // `{a,b}` from one element reads as two. This is the case that made
        // the rendering ambiguous rather than merely ugly.
        assert_eq!(quote_array_element("a,b"), r#""a,b""#);
    }

    #[test]
    fn quotes_braces_and_whitespace() {
        assert_eq!(quote_array_element("{x}"), r#""{x}""#);
        assert_eq!(quote_array_element("two words"), r#""two words""#);
    }

    #[test]
    fn escapes_quotes_and_backslashes() {
        assert_eq!(quote_array_element(r#"say "hi""#), r#""say \"hi\"""#);
        assert_eq!(quote_array_element(r"back\slash"), r#""back\\slash""#);
    }

    #[test]
    fn quotes_the_empty_string_so_it_is_not_nothing() {
        assert_eq!(quote_array_element(""), r#""""#);
    }

    #[test]
    fn quotes_the_literal_text_null() {
        // Otherwise a text element holding "NULL" is indistinguishable from an
        // actual NULL, which is a different fact about the data.
        assert_eq!(quote_array_element("NULL"), r#""NULL""#);
        assert_eq!(quote_array_element("null"), r#""null""#);
    }
}

/// Deterministic fuzz over the value decoders against a MALICIOUS server.
///
/// A hostile server controls the exact bytes behind every cell, so
/// `PgNumeric::from_sql` and `render_raw` must never panic and must never
/// produce an unbounded allocation, whatever it sends. Seeded xorshift rather
/// than a proptest dependency — keeping the supply chain small is itself part
/// of this project's security posture, and a fixed seed makes any failure
/// reproducible. (Security review RUST-01/RUST-02, "fuzz the decoder".)
#[cfg(test)]
mod decoder_fuzz_tests {
    use super::*;

    struct XorShift(u64);
    impl XorShift {
        fn next(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            self.0 = x;
            x
        }
        fn bytes(&mut self, max_len: usize) -> Vec<u8> {
            let len = (self.next() as usize) % (max_len + 1);
            (0..len).map(|_| (self.next() & 0xFF) as u8).collect()
        }
    }

    /// The decoder as it was before it wrote into one string: what the
    /// current one must match, character for character.
    fn numeric_reference(digits: &[i16], weight: i32, negative: bool, dscale: usize) -> String {
        let at = |k: i32| -> i16 {
            if k < 0 {
                0
            } else {
                digits.get(k as usize).copied().unwrap_or(0)
            }
        };
        let mut s = String::new();
        if negative {
            s.push('-');
        }
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
        s
    }

    #[test]
    fn numeric_decoder_matches_the_reference_on_valid_headers() {
        let mut rng = XorShift(0xDEAD_BEEF_0BAD_F00D);
        for _ in 0..100_000 {
            let ndigits = (rng.next() % 7) as usize;
            let weight = (rng.next() % 12) as i16 - 5;
            let negative = rng.next() % 2 == 0;
            let dscale = (rng.next() % 24) as u16;
            // Mostly real base-10000 groups, sometimes what no server sends.
            let digits: Vec<i16> = (0..ndigits)
                .map(|_| match rng.next() % 10 {
                    0 => rng.next() as i16,
                    _ => (rng.next() % 10_000) as i16,
                })
                .collect();
            let mut raw = Vec::new();
            raw.extend_from_slice(&(ndigits as u16).to_be_bytes());
            raw.extend_from_slice(&weight.to_be_bytes());
            raw.extend_from_slice(&(if negative { 0x4000u16 } else { 0 }).to_be_bytes());
            raw.extend_from_slice(&dscale.to_be_bytes());
            for d in &digits {
                raw.extend_from_slice(&d.to_be_bytes());
            }
            let got = PgNumeric::from_sql(&Type::NUMERIC, &raw).unwrap().0;
            let want = numeric_reference(&digits, weight as i32, negative, dscale as usize);
            assert_eq!(got, want, "{digits:?} weight={weight} dscale={dscale}");
        }
    }

    #[test]
    fn numeric_decoder_never_panics_or_over_allocates_on_random_bytes() {
        let mut rng = XorShift(0x9E37_79B9_7F4A_7C15);
        for _ in 0..200_000 {
            let raw = rng.bytes(40);
            // Must not panic on any input; a successful decode must be bounded.
            if let Ok(n) = PgNumeric::from_sql(&Type::NUMERIC, &raw) {
                assert!(
                    n.0.len() <= MAX_NUMERIC_RENDER_BYTES,
                    "numeric render exceeded its cap: {} bytes",
                    n.0.len()
                );
            }
        }
    }

    #[test]
    fn render_raw_never_panics_or_over_allocates_on_random_bytes() {
        let mut rng = XorShift(0x1234_5678_9ABC_DEF0);
        let types = [
            Type::BYTEA,
            Type::MONEY,
            Type::TEXT,
            Type::INTERVAL,
            Type::XML,
        ];
        for _ in 0..100_000 {
            let raw = rng.bytes(2048);
            let ty = &types[(rng.next() as usize) % types.len()];
            let cell = render_raw(RawValue(raw), ty);
            let len = match &cell {
                CellValue::Text(s) => s.len(),
                CellValue::Other(o) => o.rendered.len(),
                _ => 0,
            };
            // render_raw caps its own output; cap_cell would enforce it again.
            assert!(
                len <= MAX_RENDERED_CELL_BYTES + 64,
                "render exceeded cap: {len}"
            );
        }
    }

    #[test]
    fn numeric_with_crafted_oversized_headers_is_always_bounded() {
        // Sweep the whole dscale/ndigits/weight header space at the extremes —
        // the shapes a fuzzer is least likely to hit by chance but an attacker
        // would reach for.
        for &dscale in &[0u16, 1, 0x3FFF, 0x4000, 0x8000, 0xFFFF] {
            for &ndigits in &[0u16, 1, 1000, 1001, 0x7FFF, 0xFFFF] {
                for &weight in &[i16::MIN, -1, 0, 1, i16::MAX] {
                    let mut b = Vec::new();
                    b.extend_from_slice(&ndigits.to_be_bytes());
                    b.extend_from_slice(&weight.to_be_bytes());
                    b.extend_from_slice(&0u16.to_be_bytes()); // sign = positive
                    b.extend_from_slice(&dscale.to_be_bytes());
                    b.resize(b.len() + 8, 0); // a couple of digit words
                    if let Ok(n) = PgNumeric::from_sql(&Type::NUMERIC, &b) {
                        assert!(n.0.len() <= MAX_NUMERIC_RENDER_BYTES);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod cell_cap_tests {
    use super::*;

    #[test]
    fn capping_a_borrowed_value_matches_capping_an_owned_one() {
        for s in ["", "abc", &"é".repeat(MAX_RENDERED_CELL_BYTES)] {
            assert_eq!(cap_str(s), cap_rendered(s.to_string()));
        }
        let big = "é".repeat(MAX_RENDERED_CELL_BYTES / 2 + 10);
        let capped = cap_str(&big);
        assert!(capped.ends_with("… <truncated 20 more bytes>"));
    }

    #[test]
    fn short_values_are_untouched() {
        assert_eq!(cap_rendered("hello".into()), "hello");
        let big = "x".repeat(MAX_RENDERED_CELL_BYTES);
        assert_eq!(cap_rendered(big.clone()), big); // exactly at the cap is kept
    }

    #[test]
    fn over_long_values_are_truncated_with_a_note() {
        let s = "a".repeat(MAX_RENDERED_CELL_BYTES + 5000);
        let out = cap_rendered(s);
        assert!(out.len() < MAX_RENDERED_CELL_BYTES + 200, "must be bounded");
        assert!(
            out.contains("<truncated 5000 more bytes>"),
            "{}",
            &out[out.len() - 60..]
        );
    }

    #[test]
    fn truncation_lands_on_a_char_boundary_for_multibyte_text() {
        // A run of 4-byte emoji: naive slicing at MAX would split one.
        let s = "😀".repeat(MAX_RENDERED_CELL_BYTES); // 4 bytes each, well over cap
        let out = cap_rendered(s); // must not panic on a non-boundary slice
        assert!(out.contains("<truncated"), "expected a truncation note");
    }

    #[test]
    fn cap_cell_only_touches_string_bearing_variants() {
        assert!(matches!(cap_cell(CellValue::Int(7)), CellValue::Int(7)));
        assert!(matches!(cap_cell(CellValue::Null), CellValue::Null));
    }
}

#[cfg(test)]
mod numeric_decode_tests {
    use super::*;

    /// Build a raw `numeric` wire datum. digits are base-10000 groups.
    fn wire(ndigits: u16, weight: i16, sign: u16, dscale: u16, digits: &[i16]) -> Vec<u8> {
        let mut b = Vec::new();
        b.extend_from_slice(&ndigits.to_be_bytes());
        b.extend_from_slice(&weight.to_be_bytes());
        b.extend_from_slice(&sign.to_be_bytes());
        b.extend_from_slice(&dscale.to_be_bytes());
        for d in digits {
            b.extend_from_slice(&d.to_be_bytes());
        }
        b
    }

    fn decode(raw: &[u8]) -> Result<String, String> {
        PgNumeric::from_sql(&Type::NUMERIC, raw)
            .map(|n| n.0)
            .map_err(|e| e.to_string())
    }

    #[test]
    fn decodes_a_normal_value_with_trailing_zero() {
        // 125000.50  → ndigits=3 [12,5000,5000], weight=1, dscale=2
        let raw = wire(3, 1, 0x0000, 2, &[12, 5000, 5000]);
        assert_eq!(decode(&raw).unwrap(), "125000.50");
    }

    #[test]
    fn decodes_negative_and_specials() {
        assert_eq!(decode(&wire(1, 0, 0x4000, 0, &[42])).unwrap(), "-42");
        assert_eq!(decode(&wire(0, 0, 0xC000, 0, &[])).unwrap(), "NaN");
        assert_eq!(decode(&wire(0, 0, 0xD000, 0, &[])).unwrap(), "Infinity");
        assert_eq!(decode(&wire(0, 0, 0xF000, 0, &[])).unwrap(), "-Infinity");
    }

    #[test]
    fn rejects_dscale_high_bit_the_review_payload() {
        // RUST-01: dscale=0xFFFF. Before the fix this sign-extended to a
        // near-usize::MAX loop bound and hung the app; now it is a bounded error.
        let raw = wire(0, 0, 0x0000, 0xFFFF, &[]);
        let err = decode(&raw).unwrap_err();
        assert!(err.contains("display scale"), "got: {err}");
    }

    #[test]
    fn rejects_dscale_just_over_the_max() {
        assert!(
            decode(&wire(0, 0, 0x0000, (NUMERIC_DSCALE_MAX + 1) as u16, &[]))
                .unwrap_err()
                .contains("display scale")
        );
        // exactly at the max is allowed (0 digits → "0")
        assert!(decode(&wire(0, 0, 0x0000, NUMERIC_DSCALE_MAX as u16, &[])).is_ok());
    }

    #[test]
    fn rejects_implausible_digit_count() {
        // ndigits claims 2000 groups but the payload is short → must not panic.
        let raw = wire(2000, 0, 0x0000, 0, &[1, 2, 3]);
        assert!(decode(&raw).unwrap_err().contains("digit count"));
    }

    #[test]
    fn rejects_a_short_header_without_panic() {
        assert!(decode(&[0u8; 4]).unwrap_err().contains("header too short"));
    }

    #[test]
    fn rejects_a_value_too_large_to_render() {
        // weight=20000 → integer part ≈ 80004 chars, over the 64 KB backstop;
        // must be a bounded error, not a large allocation.
        let raw = wire(1, 20000, 0x0000, 0, &[1]);
        assert!(decode(&raw).unwrap_err().contains("too large"));
    }
}

#[cfg(test)]
mod render_raw_tests {
    use super::*;

    fn enum_type() -> Type {
        Type::new(
            "mood".to_string(),
            100_000,
            Kind::Enum(vec!["happy".to_string(), "sad".to_string()]),
            "public".to_string(),
        )
    }

    fn domain_over(inner: Type) -> Type {
        Type::new(
            "a_domain".to_string(),
            100_001,
            Kind::Domain(inner),
            "public".to_string(),
        )
    }

    #[test]
    fn an_enum_renders_as_its_label() {
        // Not a guess: an enum's binary wire value *is* the label.
        assert_eq!(
            render_raw(RawValue(b"happy".to_vec()), &enum_type()),
            CellValue::Text("happy".to_string())
        );
    }

    #[test]
    fn printable_binary_of_a_non_text_type_is_not_read_as_text() {
        // The regression this whole function was rewritten for. `money` is an
        // int64 of cents in binary. These eight bytes are printable ASCII, so
        // the old "does it look like text?" check returned Text("12345678")
        // for a value that is actually $35,449,521,560,180,631.60. This test
        // fails against that implementation, which is the point of it.
        let v = render_raw(RawValue(b"12345678".to_vec()), &Type::MONEY);
        assert!(
            matches!(v, CellValue::Other(_)),
            "money must never be rendered as text, got {v:?}"
        );
        match v {
            CellValue::Other(o) => {
                assert_eq!(o.rendered, "\\x3132333435363738");
                assert_eq!(o.db_type, "money");
            }
            _ => unreachable!(),
        }
    }

    #[test]
    fn interval_with_printable_bytes_is_decoded_by_layout_not_read_as_text() {
        // Same trap, different type — 16 bytes that happen to be readable.
        // An interval has a fixed layout, so it is decoded from that: eight
        // bytes of microseconds, four of days, four of months. What it must
        // never be is the sixteen characters.
        let cell = render_raw(RawValue(b"0123456789abcdef".to_vec()), &Type::INTERVAL);
        let CellValue::Text(text) = cell else {
            panic!("expected a decoded interval, got {cell:?}");
        };
        assert!(!text.contains("0123456789abcdef"), "{text}");
        assert!(
            text.contains(" years ") && text.contains(" days "),
            "{text}"
        );
    }

    #[test]
    fn a_wrong_sized_interval_is_still_hex() {
        assert!(matches!(
            render_raw(RawValue(b"0123456789abcde".to_vec()), &Type::INTERVAL),
            CellValue::Other(_)
        ));
    }

    #[test]
    fn xml_is_text_because_its_binary_form_is_the_document() {
        assert_eq!(
            render_raw(RawValue(b"<a>1</a>".to_vec()), &Type::XML),
            CellValue::Text("<a>1</a>".to_string())
        );
    }

    #[test]
    fn a_domain_follows_the_type_it_wraps() {
        // Domain over text transmits as text...
        assert_eq!(
            render_raw(RawValue(b"hello".to_vec()), &domain_over(Type::TEXT)),
            CellValue::Text("hello".to_string())
        );
        // ...and a domain over money is still money, printable bytes or not.
        assert!(matches!(
            render_raw(RawValue(b"12345678".to_vec()), &domain_over(Type::MONEY)),
            CellValue::Other(_)
        ));
    }

    #[test]
    fn a_domain_over_an_enum_is_text() {
        assert_eq!(
            render_raw(RawValue(b"sad".to_vec()), &domain_over(enum_type())),
            CellValue::Text("sad".to_string())
        );
    }

    #[test]
    fn invalid_utf8_in_a_text_type_falls_back_to_hex_rather_than_panicking() {
        assert!(matches!(
            render_raw(RawValue(vec![0xff, 0xfe]), &Type::TEXT),
            CellValue::Other(_)
        ));
    }

    #[test]
    fn an_empty_enum_value_is_empty_text_not_hex() {
        // The old guard rejected empty strings (`!s.is_empty()`) and hexed
        // them. An empty label is a legal value and '' is the right answer.
        assert_eq!(
            render_raw(RawValue(Vec::new()), &enum_type()),
            CellValue::Text(String::new())
        );
    }
}
