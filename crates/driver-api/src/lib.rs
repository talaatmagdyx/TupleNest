//! TupleNest driver contract (master spec §50).
//!
//! Every database driver implements [`DatabaseDriver`] and [`DatabaseSession`]
//! and publishes honest [`DriverCapabilities`]. Nothing outside driver crates
//! may depend on database-specific behavior.

pub mod capabilities;
pub mod config;
pub mod error;
pub mod ids;
pub mod request;

pub use capabilities::{DriverCapabilities, DriverDescriptor, DriverMaturity};
pub use config::{
    ConnectionConfig, ConnectionTestReport, Environment, TestStage, TestStageStatus, TlsMode,
};
pub use error::{DriverError, ErrorCategory, Retryability};
pub use ids::{ConnectionId, ExecutionId, SecretRef, SessionId, TransactionId};
pub use request::{
    CellValue, ColumnMeta, ExecutionStatus, ExecutionSummary, IsolationLevel, MetadataRequest,
    MetadataResponse, ParamValue, QueryRequest, RowBatch, TransactionOptions,
};

use async_trait::async_trait;

/// Sink for streamed result batches.
///
/// Implementations provide backpressure: `deliver` returns only once the
/// batch has been accepted, and drivers must not buffer unbounded batches.
#[async_trait]
pub trait BatchSink: Send + Sync {
    async fn deliver(&self, batch: RowBatch) -> Result<(), Box<DriverError>>;
}

#[async_trait]
pub trait DatabaseDriver: Send + Sync {
    fn descriptor(&self) -> DriverDescriptor;
    fn capabilities(&self) -> DriverCapabilities;

    /// Staged connection test: DNS → TCP → TLS → auth → server version.
    async fn test(
        &self,
        config: ConnectionConfig,
    ) -> Result<ConnectionTestReport, Box<DriverError>>;

    async fn connect(
        &self,
        config: ConnectionConfig,
    ) -> Result<Box<dyn DatabaseSession>, Box<DriverError>>;
}

#[async_trait]
pub trait DatabaseSession: Send + Sync {
    /// Execute a request, streaming batches into `sink`, returning a summary.
    async fn execute(
        &mut self,
        request: QueryRequest,
        sink: &dyn BatchSink,
    ) -> Result<ExecutionSummary, Box<DriverError>>;

    /// Request cancellation of a running execution. Must be safe to call
    /// concurrently with `execute` and must reach the server where supported.
    async fn cancel(&self, execution_id: ExecutionId) -> Result<(), Box<DriverError>>;

    async fn metadata(
        &self,
        request: MetadataRequest,
    ) -> Result<MetadataResponse, Box<DriverError>>;

    async fn begin(
        &mut self,
        options: TransactionOptions,
    ) -> Result<TransactionId, Box<DriverError>>;
    async fn commit(&mut self) -> Result<(), Box<DriverError>>;
    async fn rollback(&mut self) -> Result<(), Box<DriverError>>;

    /// True if the underlying connection is known to be unusable.
    fn is_broken(&self) -> bool;
}
