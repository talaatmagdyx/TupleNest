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
    ListObjects { schema: String },
    DescribeObject { schema: String, name: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetadataResponse {
    /// Structured payload; shape depends on the request kind.
    pub payload: serde_json::Value,
    /// Driver-specific annotations (e.g. server version quirks).
    pub annotations: BTreeMap<String, String>,
}
