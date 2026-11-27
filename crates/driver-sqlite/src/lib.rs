//! SQLite driver: a database that is a file on this machine.
//!
//! No server, no network, no password. `ConnectionConfig::database` is the
//! file's path; host, port, user, TLS and SSH do not apply and are ignored.
//!
//! The safety model is the PostgreSQL driver's, enforced by the engine:
//!
//! - **Read-only** opens the file `SQLITE_OPEN_READONLY` (which every
//!   `ATTACH`ed file inherits) and sets `PRAGMA query_only = ON`. Before every
//!   statement `query_only` is set again — a typed `PRAGMA query_only = OFF`
//!   lasts until the next statement at most — and a statement SQLite itself
//!   says is not read-only (`sqlite3_stmt_readonly`) is refused before it
//!   runs. That last check is what stops `VACUUM INTO 'copy.db'`, which
//!   writes a new file and is allowed on a read-only database.
//! - **Row cap**: a read stops stepping at `row_limit`; one extra step says
//!   whether there were more (`more_rows`). Anything that writes runs to the
//!   end, so a write is never cut short.
//! - **Cancel** is `sqlite3_interrupt`, from any thread, through
//!   [`SqliteCancelHandle`].
//!
//! rusqlite is synchronous: each request runs on the blocking pool and hands
//! its batches to the async side through a one-slot channel, so `deliver`'s
//! backpressure reaches the stepping loop.

mod error;
mod metadata;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};
use tuplenest_driver_api::*;

pub use error::code_name;

/// Rows per streamed batch, as the PostgreSQL driver.
pub const BATCH_SIZE: usize = 1_000;
/// A batch is also cut at this many bytes of cell data.
pub const BATCH_BYTES: usize = 4 * 1024 * 1024;
/// How long a statement waits for another process's lock before failing
/// with "database is locked".
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// `ConnectionConfig::options` key: create the file if it does not exist.
/// Ignored on a read-only profile. Without it a mistyped path is an error,
/// not a new empty database.
pub const OPTION_CREATE: &str = "create";

pub struct SqliteDriver;

impl SqliteDriver {
    fn open(config: &ConnectionConfig) -> Result<Connection, Box<DriverError>> {
        let path = config.database.trim();
        if path.is_empty() {
            return Err(
                DriverError::new(ErrorCategory::Configuration, "No database file")
                    .with_explanation("A SQLite connection needs the path of its database file.")
                    .into(),
            );
        }
        let create = !config.read_only
            && config
                .options
                .get(OPTION_CREATE)
                .is_some_and(|v| v == "true");
        // NO_MUTEX: the connection is only ever used under this crate's own
        // lock. URI is left off: a path is a path.
        let mut flags = OpenFlags::SQLITE_OPEN_NO_MUTEX;
        flags |= if config.read_only {
            OpenFlags::SQLITE_OPEN_READ_ONLY
        } else {
            OpenFlags::SQLITE_OPEN_READ_WRITE
        };
        if create {
            flags |= OpenFlags::SQLITE_OPEN_CREATE;
        }
        let conn = Connection::open_with_flags(path, flags).map_err(error::normalize)?;
        conn.busy_timeout(BUSY_TIMEOUT).map_err(error::normalize)?;
        if config.read_only {
            conn.pragma_update(None, "query_only", true)
                .map_err(error::normalize)?;
        } else {
            // Declared foreign keys are enforced, as every other engine does.
            // SQLite's own default (off) is a compatibility setting.
            conn.pragma_update(None, "foreign_keys", true)
                .map_err(error::normalize)?;
        }
        // Opening is lazy: read the schema now, so a file that is not a
        // database (or is damaged) fails here and not on the first query.
        conn.query_row("SELECT count(*) FROM sqlite_schema", [], |r| {
            r.get::<_, i64>(0)
        })
        .map_err(error::normalize)?;
        Ok(conn)
    }

    /// Like [`DatabaseDriver::connect`], returning the concrete session.
    pub async fn connect_concrete(
        &self,
        config: ConnectionConfig,
    ) -> Result<SqliteSession, Box<DriverError>> {
        let read_only = config.read_only;
        let timeout = config.default_statement_timeout_ms;
        let path = config.database.trim().to_string();
        let conn = tokio::task::spawn_blocking(move || Self::open(&config))
            .await
            .map_err(join_error)??;
        Ok(SqliteSession {
            interrupt: Arc::new(conn.get_interrupt_handle()),
            conn: Arc::new(Mutex::new(conn)),
            path,
            read_only,
            statement_timeout: (timeout > 0).then(|| Duration::from_millis(timeout)),
            pending_cancel: Mutex::new(None),
        })
    }
}

fn join_error(e: tokio::task::JoinError) -> Box<DriverError> {
    DriverError::new(ErrorCategory::Internal, "SQLite worker failed")
        .with_original_message(e.to_string())
        .into()
}

#[async_trait]
impl DatabaseDriver for SqliteDriver {
    fn descriptor(&self) -> DriverDescriptor {
        DriverDescriptor {
            id: "sqlite".into(),
            display_name: "SQLite".into(),
            version: env!("CARGO_PKG_VERSION").into(),
            maturity: DriverMaturity::Experimental,
            supported_server_versions: vec![rusqlite::version().into()],
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
            schemas: true,
            triggers: true,
            ..Default::default()
        }
    }

    /// Staged test: the file is there, it opens as a SQLite database, and
    /// which SQLite answers.
    async fn test(
        &self,
        config: ConnectionConfig,
    ) -> Result<ConnectionTestReport, Box<DriverError>> {
        let started = Instant::now();
        let path = std::path::PathBuf::from(config.database.trim());
        let create = config
            .options
            .get(OPTION_CREATE)
            .is_some_and(|v| v == "true");
        let mut stages = Vec::new();
        let exists = path.is_file();
        stages.push(TestStage {
            name: "file".into(),
            status: if exists || (create && !config.read_only) {
                TestStageStatus::Passed
            } else {
                TestStageStatus::Failed
            },
            duration_ms: started.elapsed().as_millis() as u64,
            detail: Some(if exists {
                path.display().to_string()
            } else if create && !config.read_only {
                format!("{} (will be created)", path.display())
            } else {
                format!("{}: no such file", path.display())
            }),
        });
        if !exists {
            // Testing must not create the file: that is Save & Connect's job.
            return Ok(ConnectionTestReport {
                stages,
                server_version: None,
            });
        }
        let opened = Instant::now();
        let session = self.connect_concrete(config).await;
        stages.push(TestStage {
            name: "open".into(),
            status: if session.is_ok() {
                TestStageStatus::Passed
            } else {
                TestStageStatus::Failed
            },
            duration_ms: opened.elapsed().as_millis() as u64,
            detail: session.as_ref().err().map(|e| e.title.clone()),
        });
        Ok(ConnectionTestReport {
            server_version: session.is_ok().then(|| rusqlite::version().to_string()),
            stages,
        })
    }

    async fn connect(
        &self,
        config: ConnectionConfig,
    ) -> Result<Box<dyn DatabaseSession>, Box<DriverError>> {
        Ok(Box::new(self.connect_concrete(config).await?))
    }
}

/// Cancels whatever statement the session is running, from any thread,
/// without the session's lock.
#[derive(Clone)]
pub struct SqliteCancelHandle(Arc<rusqlite::InterruptHandle>);

impl SqliteCancelHandle {
    pub async fn cancel(&self) -> Result<(), Box<DriverError>> {
        self.0.interrupt();
        Ok(())
    }
}

pub struct SqliteSession {
    conn: Arc<Mutex<Connection>>,
    interrupt: Arc<rusqlite::InterruptHandle>,
    path: String,
    read_only: bool,
    statement_timeout: Option<Duration>,
    /// A cancel for an execution that has not started yet. `sqlite3_interrupt`
    /// with nothing running is a no-op, so without this a cancel that arrives
    /// just before its statement would be lost.
    pending_cancel: Mutex<Option<ExecutionId>>,
}

impl SqliteSession {
    pub fn cancel_handle(&self) -> SqliteCancelHandle {
        SqliteCancelHandle(self.interrupt.clone())
    }

    /// Is a transaction open — including one begun by a typed `BEGIN`?
    /// SQLite knows exactly: the connection is out of autocommit mode.
    pub async fn in_transaction(&self) -> Result<bool, Box<DriverError>> {
        self.with_conn(|c| Ok(!c.is_autocommit())).await
    }

    pub fn is_read_only(&self) -> bool {
        self.read_only
    }

    async fn with_conn<T: Send + 'static>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, Box<DriverError>> + Send + 'static,
    ) -> Result<T, Box<DriverError>> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let guard = conn.lock().map_err(|_| poisoned())?;
            f(&guard)
        })
        .await
        .map_err(join_error)?
    }

    async fn end_transaction(&self, sql: &'static str) -> Result<(), Box<DriverError>> {
        self.with_conn(move |c| {
            if c.is_autocommit() {
                return Err(
                    DriverError::new(ErrorCategory::Internal, "No open transaction").into(),
                );
            }
            c.execute_batch(sql).map_err(error::normalize)
        })
        .await
    }
}

fn poisoned() -> Box<DriverError> {
    DriverError::new(ErrorCategory::Internal, "SQLite session lock poisoned").into()
}

/// What stepping a statement found.
struct Pumped {
    rows_returned: u64,
    more_rows: bool,
    rows_affected: Option<u64>,
}

/// Binds `params` to `stmt`. `$1`/`?1`/`:1` placeholders are numbered by
/// their digits — SQLite numbers named parameters by first appearance, so
/// `… $2 … $1` would otherwise bind them the wrong way round — and plain `?`
/// by position.
fn bind(stmt: &mut rusqlite::Statement<'_>, params: &[ParamValue]) -> Result<(), Box<DriverError>> {
    let count = stmt.parameter_count();
    for index in 1..=count {
        let which = match stmt.parameter_name(index) {
            Some(name) => name[1..].parse::<usize>().ok().unwrap_or(index),
            None => index,
        };
        let value = params.get(which.wrapping_sub(1)).ok_or_else(|| {
            Box::new(
                DriverError::new(ErrorCategory::Configuration, "Wrong number of parameters")
                    .with_original_message(format!(
                        "placeholder {which} has no value ({} given)",
                        params.len()
                    )),
            )
        })?;
        let bound = match value {
            ParamValue::Null => stmt.raw_bind_parameter(index, rusqlite::types::Null),
            ParamValue::Bool(b) => stmt.raw_bind_parameter(index, *b),
            ParamValue::Int(i) => stmt.raw_bind_parameter(index, *i),
            ParamValue::Float(f) => stmt.raw_bind_parameter(index, *f),
            ParamValue::Text(s) => stmt.raw_bind_parameter(index, s.as_str()),
            ParamValue::Bytes(b) => stmt.raw_bind_parameter(index, b.as_slice()),
            ParamValue::Json(v) => stmt.raw_bind_parameter(index, v.to_string()),
        };
        bound.map_err(error::normalize)?;
    }
    Ok(())
}

fn cell(v: ValueRef<'_>) -> (CellValue, usize) {
    match v {
        ValueRef::Null => (CellValue::Null, 0),
        ValueRef::Integer(i) => (CellValue::Int(i), 8),
        ValueRef::Real(f) => (CellValue::Float(f), 8),
        ValueRef::Text(t) => (
            CellValue::Text(String::from_utf8_lossy(t).into_owned()),
            t.len(),
        ),
        ValueRef::Blob(b) => (CellValue::Bytes(b.into()), b.len()),
    }
}

/// The storage class of a value, for a column with no declared type (an
/// expression): what the first row actually holds.
fn storage_class(v: ValueRef<'_>) -> &'static str {
    match v {
        ValueRef::Null => "",
        ValueRef::Integer(_) => "INTEGER",
        ValueRef::Real(_) => "REAL",
        ValueRef::Text(_) => "TEXT",
        ValueRef::Blob(_) => "BLOB",
    }
}

/// The blocking side's end of the batch hand-off: each batch is sent, and the
/// next row is not stepped until the sink has taken it and said whether it
/// wants more rows (`BatchSink::wants_rows`) — the lockstep the async drivers
/// get from awaiting `deliver`.
struct Handoff {
    batches: tokio::sync::mpsc::Sender<RowBatch>,
    acks: std::sync::mpsc::Receiver<bool>,
}

impl Handoff {
    /// Hands over one batch; returns whether the sink wants more rows.
    fn send(&self, batch: RowBatch) -> Result<bool, Box<DriverError>> {
        // Either end is gone only when the async side has already failed and
        // is reporting that; nothing more to say here.
        let gone = || Box::new(DriverError::cancelled());
        self.batches.blocking_send(batch).map_err(|_| gone())?;
        self.acks.recv().map_err(|_| gone())
    }
}

/// Runs one statement on the blocking pool, handing batches to `out`.
fn run(
    conn: &Connection,
    request: &QueryRequest,
    read_only: bool,
    out: &Handoff,
) -> Result<Pumped, Box<DriverError>> {
    if read_only {
        conn.pragma_update(None, "query_only", true)
            .map_err(error::normalize)?;
    }
    let mut stmt = conn.prepare(&request.sql).map_err(error::normalize)?;
    // An EXPLAIN reports `readonly` for the statement it explains, but runs
    // none of it: explaining a write is a read.
    let reads = stmt.readonly() || stmt.is_explain() > 0;
    if read_only && !reads {
        return Err(error::read_only_refusal());
    }
    bind(&mut stmt, &request.params)?;
    let names: Vec<String> = stmt.column_names().map(|s| s.to_string()).collect();
    let declared: Vec<Option<String>> = stmt
        .columns()
        .map(|c| c.decl_type().map(str::to_string))
        .collect();
    let before = conn.total_changes();
    let cap = if reads { request.row_limit } else { 0 };

    let mut columns: Vec<ColumnMeta> = Vec::new();
    let mut buffer: Vec<Vec<CellValue>> = Vec::with_capacity(BATCH_SIZE);
    let mut batch_bytes = 0usize;
    let mut sequence = 0u64;
    let mut rows_returned = 0u64;
    let mut more_rows = false;
    // The sink is full: count the rest, decode none of it.
    let mut counting_only = false;

    let mut rows = stmt.raw_query();
    loop {
        let row = match rows.next() {
            Ok(Some(row)) => row,
            Ok(None) => break,
            Err(e) => return Err(error::normalize(e)),
        };
        if cap > 0 && rows_returned >= cap {
            // One step past the cap: there is more. Stop stepping.
            more_rows = true;
            break;
        }
        if columns.is_empty() {
            columns = names
                .iter()
                .enumerate()
                .map(|(i, name)| ColumnMeta {
                    name: name.clone(),
                    db_type: declared[i].clone().unwrap_or_else(|| {
                        row.get_ref(i)
                            .map(storage_class)
                            .unwrap_or_default()
                            .to_string()
                    }),
                    nullable: None,
                })
                .collect();
        }
        rows_returned += 1;
        if counting_only {
            continue;
        }
        let mut cells = Vec::with_capacity(names.len());
        for i in 0..names.len() {
            let (c, bytes) = cell(row.get_ref(i).map_err(error::normalize)?);
            batch_bytes += bytes;
            cells.push(c);
        }
        buffer.push(cells);
        if buffer.len() >= BATCH_SIZE || batch_bytes >= BATCH_BYTES {
            batch_bytes = 0;
            counting_only = !out.send(RowBatch {
                execution_id: request.execution_id,
                sequence,
                columns: columns.clone(),
                rows: std::mem::take(&mut buffer),
                is_last: false,
            })?;
            sequence += 1;
            buffer.reserve(BATCH_SIZE);
        }
    }
    drop(rows);
    out.send(RowBatch {
        execution_id: request.execution_id,
        sequence,
        columns,
        rows: buffer,
        is_last: true,
    })?;
    /*
     * `changes()` is the row count of the last INSERT/UPDATE/DELETE to
     * finish, which is this statement's only if this statement was one: after
     * DDL it is a stale count from before. `total_changes()` moving says it
     * was. A read reports the rows it returned, as PostgreSQL's SELECT tag.
     */
    let rows_affected = if reads {
        (!names.is_empty()).then_some(rows_returned)
    } else if conn.total_changes() == before {
        Some(0)
    } else {
        Some(conn.changes())
    };
    Ok(Pumped {
        rows_returned,
        more_rows,
        rows_affected,
    })
}

#[async_trait]
impl DatabaseSession for SqliteSession {
    async fn execute(
        &mut self,
        request: QueryRequest,
        sink: &dyn BatchSink,
    ) -> Result<ExecutionSummary, Box<DriverError>> {
        let started = Instant::now();
        {
            let mut pending = self.pending_cancel.lock().map_err(|_| poisoned())?;
            if *pending == Some(request.execution_id) {
                *pending = None;
                return Err(DriverError::cancelled().into());
            }
        }
        let execution_id = request.execution_id;
        let (batches, mut rx) = tokio::sync::mpsc::channel::<RowBatch>(1);
        let (ack, acks) = std::sync::mpsc::sync_channel::<bool>(1);
        let timed_out = Arc::new(AtomicBool::new(false));
        // A statement timeout is an interrupt on a timer, told apart from a
        // user's cancel by the flag it sets.
        let timer = self.statement_timeout.map(|limit| {
            let (interrupt, timed_out) = (self.interrupt.clone(), timed_out.clone());
            tokio::spawn(async move {
                tokio::time::sleep(limit).await;
                timed_out.store(true, Ordering::SeqCst);
                interrupt.interrupt();
            })
        });
        let job = {
            let conn = self.conn.clone();
            let read_only = self.read_only;
            tokio::task::spawn_blocking(move || {
                let guard = conn.lock().map_err(|_| poisoned())?;
                run(&guard, &request, read_only, &Handoff { batches, acks })
            })
        };
        let mut delivered = Ok(());
        while let Some(batch) = rx.recv().await {
            if let Err(e) = sink.deliver(batch).await {
                delivered = Err(e);
                // Stop the statement rather than let it run to the end
                // into a sink that has failed.
                self.interrupt.interrupt();
                break;
            }
            // Never blocks: the stepping side takes each ack before it sends
            // the next batch.
            let _ = ack.send(sink.wants_rows());
        }
        drop(rx);
        drop(ack);
        let outcome = job.await.map_err(join_error);
        if let Some(t) = timer {
            t.abort();
        }
        delivered?;
        let pumped = match outcome? {
            Ok(p) => p,
            Err(e)
                if e.category == ErrorCategory::Cancelled && timed_out.load(Ordering::SeqCst) =>
            {
                return Err(DriverError::new(
                    ErrorCategory::StatementTimeout,
                    "Statement timed out",
                )
                .with_native_code(code_name(rusqlite::ffi::SQLITE_INTERRUPT))
                .into());
            }
            Err(e) => return Err(e),
        };
        Ok(ExecutionSummary {
            execution_id,
            status: ExecutionStatus::Success,
            rows_affected: pumped.rows_affected,
            rows_returned: pumped.rows_returned,
            more_rows: pumped.more_rows,
            duration_ms: started.elapsed().as_millis() as u64,
            messages: Vec::new(),
        })
    }

    async fn cancel(&self, execution_id: ExecutionId) -> Result<(), Box<DriverError>> {
        *self.pending_cancel.lock().map_err(|_| poisoned())? = Some(execution_id);
        self.interrupt.interrupt();
        Ok(())
    }

    async fn metadata(
        &self,
        request: MetadataRequest,
    ) -> Result<MetadataResponse, Box<DriverError>> {
        let path = self.path.clone();
        let payload = self
            .with_conn(move |c| metadata::answer(c, &path, request))
            .await?;
        Ok(MetadataResponse {
            payload,
            annotations: Default::default(),
        })
    }

    async fn begin(
        &mut self,
        _options: TransactionOptions,
    ) -> Result<TransactionId, Box<DriverError>> {
        // SQLite has one isolation level (serializable) and no deferrable
        // mode; a read-only profile is read-only whatever the transaction.
        self.with_conn(|c| {
            if !c.is_autocommit() {
                return Err(
                    DriverError::new(ErrorCategory::Internal, "Transaction already open").into(),
                );
            }
            c.execute_batch("BEGIN").map_err(error::normalize)
        })
        .await?;
        Ok(TransactionId::new())
    }

    async fn commit(&mut self) -> Result<(), Box<DriverError>> {
        self.end_transaction("COMMIT").await
    }

    async fn rollback(&mut self) -> Result<(), Box<DriverError>> {
        self.end_transaction("ROLLBACK").await
    }

    fn is_broken(&self) -> bool {
        false
    }
}

#[cfg(test)]
mod tests;
