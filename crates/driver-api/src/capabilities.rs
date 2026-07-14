//! Driver capability model (master spec §8).
//!
//! Every driver publishes an honest capability report. The frontend uses it to
//! show supported features, hide unsupported actions, and explain limitations.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct DriverCapabilities {
    pub sql: bool,
    pub transactions: bool,
    pub savepoints: bool,
    pub query_cancellation: bool,
    pub server_side_cursors: bool,
    pub editable_results: bool,
    pub explain: bool,
    pub explain_analyze: bool,
    pub schemas: bool,
    pub catalogs: bool,
    pub functions: bool,
    pub procedures: bool,
    pub triggers: bool,
    pub roles: bool,
    pub session_monitoring: bool,
    pub lock_monitoring: bool,
    pub replication_monitoring: bool,
    pub schema_compare: bool,
    pub data_compare: bool,
    pub change_streams: bool,
    pub graph_results: bool,
}

/// Visible maturity level of a driver (master spec §8.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DriverMaturity {
    Experimental,
    Preview,
    Stable,
    Certified,
}

/// Static description of a driver implementation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DriverDescriptor {
    /// Stable machine identifier, e.g. `postgres`.
    pub id: String,
    /// Human-readable name, e.g. `PostgreSQL`.
    pub display_name: String,
    /// Driver implementation version.
    pub version: String,
    pub maturity: DriverMaturity,
    /// Database server versions this driver is tested against.
    pub supported_server_versions: Vec<String>,
}
