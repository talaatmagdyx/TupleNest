//! Connection configuration and staged connection testing.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::ids::SecretRef;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TlsMode {
    /// No TLS. Only acceptable for local development.
    Disabled,
    /// TLS if the server supports it, without verification. Discouraged.
    Prefer,
    /// TLS required, certificate chain verified.
    VerifyCa,
    /// TLS required, chain and hostname verified. Default.
    #[default]
    VerifyFull,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Environment {
    Dev,
    Test,
    Staging,
    Prod,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionConfig {
    pub driver_id: String,
    pub name: String,
    pub environment: Environment,
    /// Hard read-only flag: drivers must reject write statements when set.
    pub read_only: bool,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    /// Keychain reference to the password/token. Never the secret itself.
    pub secret_ref: Option<SecretRef>,
    pub tls_mode: TlsMode,
    /// Path to a custom CA bundle, if any.
    pub tls_ca_path: Option<String>,
    /// Driver-specific options (never secrets).
    pub options: BTreeMap<String, String>,
    /// Statement timeout applied by default, in milliseconds. 0 = none.
    pub default_statement_timeout_ms: u64,
}

/// One stage of a staged connection test (DNS → TCP → TLS → auth → version).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestStage {
    pub name: String,
    pub status: TestStageStatus,
    pub duration_ms: u64,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TestStageStatus {
    Passed,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionTestReport {
    pub stages: Vec<TestStage>,
    /// Reported server version, when the test reached the server.
    pub server_version: Option<String>,
}

impl ConnectionTestReport {
    pub fn passed(&self) -> bool {
        self.stages
            .iter()
            .all(|s| s.status != TestStageStatus::Failed)
    }
}
