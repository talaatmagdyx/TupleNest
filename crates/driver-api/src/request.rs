//! Query requests, results, and streaming batch model.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::ids::ExecutionId;

/// A parameter value bound to a query. Deliberately explicit — no `Any`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum ParamValue {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Text(String),
    Bytes(Vec<u8>),
    Json(serde_json::Value),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryRequest {
    pub execution_id: ExecutionId,
    pub sql: String,
    pub params: Vec<ParamValue>,
    /// Maximum rows to fetch before the frontend must page. 0 = unlimited/stream.
    pub row_limit: u64,
    /// Statement timeout in milliseconds. 0 = connection default.
    pub timeout_ms: u64,
}

/// A cell value received from the database, normalized for transport.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum CellValue {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Text(String),
    Bytes(Vec<u8>),
    Json(serde_json::Value),
    /// Rendered form of a type without a lossless native mapping,
    /// plus the database type name (e.g. `interval`, `numrange`).
    Other {
        rendered: String,
        db_type: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ColumnMeta {
    pub name: String,
    /// Database-native type name, e.g. `int8`, `timestamptz`.
    pub db_type: String,
    pub nullable: Option<bool>,
}

/// One bounded batch of rows. Streams flow as `RowBatch` frames with
/// backpressure: the receiver acknowledges batches before more are sent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RowBatch {
    pub execution_id: ExecutionId,
    pub sequence: u64,
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<CellValue>>,
    pub is_last: bool,
}

/// Terminal summary of an execution.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionSummary {
    pub execution_id: ExecutionId,
    pub status: ExecutionStatus,
    pub rows_affected: Option<u64>,
    pub rows_returned: u64,
    pub duration_ms: u64,
    /// Server notices/warnings emitted during execution.
    pub messages: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExecutionStatus {
    Success,
    Error,
    Cancelled,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct TransactionOptions {
    pub isolation: Option<IsolationLevel>,
    pub read_only: bool,
    pub deferrable: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IsolationLevel {
    ReadUncommitted,
    ReadCommitted,
    RepeatableRead,
    Serializable,
}

/// Metadata requests are deliberately coarse in Phase 0; they grow in Phase 1.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MetadataRequest {
    ServerInfo,
    ListSchemas,
    ListObjects {
        schema: String,
    },
    DescribeObject {
        schema: String,
        name: String,
    },
    /// Live server activity (sessions), locks, and database stats (Phase 6).
    ServerActivity,
    /// Foreign-key relationships across a schema for the ER view (Phase 2).
    Relationships {
        schema: String,
    },
    /// Child partitions of one partitioned table. Partitions are deliberately
    /// excluded from `ListObjects` — a schema here has 153 partitioned parents
    /// and 4,170 partitions, so listing them flat buries everything else.
    ListPartitions {
        schema: String,
        table: String,
    },
    /// Indexes on one table, with size and usage counters so dead indexes are
    /// visible rather than merely present.
    ListIndexes {
        schema: String,
        table: String,
    },
    /// Primary keys, foreign keys, unique, check, not-null constraints.
    ListConstraints {
        schema: String,
        table: String,
    },
    /// Everything worth knowing about one object, as labelled sections of
    /// key/value rows. Generic on purpose: a table, sequence, index, view and
    /// enum all want different facts, and the UI should not need to know which.
    ObjectDetails {
        schema: String,
        name: String,
        /// table | view | matview | sequence | index | type | routine.
        /// Not `kind`: that name is taken by this enum's serde tag. The wire
        /// name stays camelCase to match every other payload the UI sees.
        #[serde(rename = "objectKind")]
        object_kind: String,
    },
    /// User-defined types: enums, composites, domains.
    ListTypes {
        schema: String,
    },
    /// Functions and procedures.
    ListRoutines {
        schema: String,
    },
    /// Index usage across the database, folded so that one logical index
    /// spanning N partitions is one row rather than N. `schema: None` means
    /// every schema the user can see.
    IndexHealth {
        schema: Option<String>,
    },
    /// Dead tuples, vacuum/analyze recency and estimated bloat per table.
    TableHealth {
        schema: Option<String>,
    },
    /// Top statements from pg_stat_statements. Returns an `available: false`
    /// payload rather than an error when the extension is absent — a missing
    /// extension is a state to explain, not a failure.
    TopQueries {
        limit: i64,
    },
    /// Name search across every schema, for databases too large to browse.
    SearchObjects {
        term: String,
        limit: i64,
    },
    /// Partitions of one table with bounds, size and row estimates, plus any
    /// gaps detected in a RANGE-partitioned series.
    PartitionOverview {
        schema: String,
        table: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetadataResponse {
    /// Structured payload; shape depends on the request kind.
    pub payload: serde_json::Value,
    /// Driver-specific annotations (e.g. server version quirks).
    pub annotations: BTreeMap<String, String>,
}
