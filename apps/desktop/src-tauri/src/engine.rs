//! The engine seam: which database a session talks to.
//!
//! Every command in `pg.rs` works on a [`Session`], whatever the engine. The
//! common operations — run a statement, read metadata, begin/commit/rollback
//! — are the driver-api [`DatabaseSession`] trait, which `Session` forwards
//! to the driver. What is not common is said here, in one `match` per
//! operation, so adding an engine (MySQL, SQL Server, …) is: a driver crate,
//! a variant below, and the compiler pointing at every match that needs an
//! answer. Which app features an engine lacks is the WebView's to show (see
//! `src/lib/engine.ts`); a request that reaches a driver for one anyway is
//! answered `Unsupported`, never with an empty panel.

use async_trait::async_trait;
use tuplenest_driver_api::{
    BatchSink, DatabaseSession, DriverError, ErrorCategory, ExecutionId, ExecutionSummary,
    MetadataRequest, MetadataResponse, QueryRequest, TransactionId, TransactionOptions,
};
use tuplenest_driver_postgres::{PgCancelHandle, PostgresSession};
use tuplenest_driver_sqlite::{SqliteCancelHandle, SqliteSession};

/// The engines TupleNest drives. The string forms are what profiles store
/// (`connections.engine`) and what the WebView sends.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    #[default]
    Postgres,
    Sqlite,
}

impl Engine {
    /// A stored or sent engine name. Absent or empty is PostgreSQL — every
    /// profile and every WebView build before engines existed.
    pub fn parse(s: Option<&str>) -> Result<Self, String> {
        match s.map(str::trim).filter(|s| !s.is_empty()) {
            None | Some("postgres") => Ok(Self::Postgres),
            Some("sqlite") => Ok(Self::Sqlite),
            Some(other) => Err(format!("unknown database engine `{other}`")),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Postgres => "postgres",
            Self::Sqlite => "sqlite",
        }
    }

    /// The name people know it by.
    pub fn display_name(self) -> &'static str {
        match self {
            Self::Postgres => "PostgreSQL",
            Self::Sqlite => "SQLite",
        }
    }
}

/// One open session, on whichever engine.
pub enum Session {
    Postgres(PostgresSession),
    Sqlite(SqliteSession),
}

/// Cancels a session's running statement without its lock.
#[derive(Clone)]
pub enum CancelHandle {
    Postgres(PgCancelHandle),
    Sqlite(SqliteCancelHandle),
}

impl CancelHandle {
    pub async fn cancel(&self) -> Result<(), Box<DriverError>> {
        match self {
            Self::Postgres(h) => h.cancel().await,
            Self::Sqlite(h) => h.cancel().await,
        }
    }
}

impl From<PostgresSession> for Session {
    fn from(s: PostgresSession) -> Self {
        Self::Postgres(s)
    }
}

impl From<SqliteSession> for Session {
    fn from(s: SqliteSession) -> Self {
        Self::Sqlite(s)
    }
}

fn unsupported(engine: Engine, what: &str) -> Box<DriverError> {
    DriverError::new(
        ErrorCategory::Unsupported,
        format!("{what} is not available for {}", engine.display_name()),
    )
    .into()
}

impl Session {
    pub fn engine(&self) -> Engine {
        match self {
            Self::Postgres(_) => Engine::Postgres,
            Self::Sqlite(_) => Engine::Sqlite,
        }
    }

    fn inner(&self) -> &dyn DatabaseSession {
        match self {
            Self::Postgres(s) => s,
            Self::Sqlite(s) => s,
        }
    }

    fn inner_mut(&mut self) -> &mut dyn DatabaseSession {
        match self {
            Self::Postgres(s) => s,
            Self::Sqlite(s) => s,
        }
    }

    pub fn cancel_handle(&self) -> CancelHandle {
        match self {
            Self::Postgres(s) => CancelHandle::Postgres(s.cancel_handle()),
            Self::Sqlite(s) => CancelHandle::Sqlite(s.cancel_handle()),
        }
    }

    /// Is a transaction open — including one the user typed `BEGIN` for?
    /// Each engine is asked in its own way; neither trusts a flag.
    pub async fn server_in_transaction(&self) -> Result<bool, Box<DriverError>> {
        match self {
            Self::Postgres(s) => s.server_in_transaction().await,
            Self::Sqlite(s) => s.in_transaction().await,
        }
    }

    /// Cancel or terminate another server session (the monitor's actions).
    /// SQLite has no server and no other sessions.
    pub async fn admin_backend(&self, pid: i32, terminate: bool) -> Result<bool, Box<DriverError>> {
        match self {
            Self::Postgres(s) => s.admin_backend(pid, terminate).await,
            Self::Sqlite(_) => Err(unsupported(Engine::Sqlite, "The server monitor")),
        }
    }
}

#[async_trait]
impl DatabaseSession for Session {
    async fn execute(
        &mut self,
        request: QueryRequest,
        sink: &dyn BatchSink,
    ) -> Result<ExecutionSummary, Box<DriverError>> {
        self.inner_mut().execute(request, sink).await
    }

    async fn cancel(&self, execution_id: ExecutionId) -> Result<(), Box<DriverError>> {
        self.inner().cancel(execution_id).await
    }

    async fn metadata(
        &self,
        request: MetadataRequest,
    ) -> Result<MetadataResponse, Box<DriverError>> {
        self.inner().metadata(request).await
    }

    async fn begin(
        &mut self,
        options: TransactionOptions,
    ) -> Result<TransactionId, Box<DriverError>> {
        self.inner_mut().begin(options).await
    }

    async fn commit(&mut self) -> Result<(), Box<DriverError>> {
        self.inner_mut().commit().await
    }

    async fn rollback(&mut self) -> Result<(), Box<DriverError>> {
        self.inner_mut().rollback().await
    }

    fn is_broken(&self) -> bool {
        self.inner().is_broken()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_engine_is_postgres_and_unknown_is_refused() {
        assert_eq!(Engine::parse(None), Ok(Engine::Postgres));
        assert_eq!(Engine::parse(Some("")), Ok(Engine::Postgres));
        assert_eq!(Engine::parse(Some("sqlite")), Ok(Engine::Sqlite));
        assert!(Engine::parse(Some("oracle")).is_err());
        // Every engine the store accepts has a driver here, and back.
        for name in tuplenest_workspace_store::ENGINES {
            assert_eq!(Engine::parse(Some(name)).unwrap().as_str(), name);
        }
    }
}
