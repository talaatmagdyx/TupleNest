//! Contract test skeleton (master spec §8.2) exercised against a mock driver.
//!
//! Real drivers (starting with `tuplenest-driver-postgres`) must pass the same
//! shape of tests against live servers in CI.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use tuplenest_driver_api::*;

// --- Mock driver -----------------------------------------------------------

struct MockDriver;

struct MockSession {
    cancelled: Arc<AtomicBool>,
    in_transaction: Option<TransactionId>,
    broken: bool,
}

fn config() -> ConnectionConfig {
    ConnectionConfig {
        driver_id: "mock".into(),
        name: "test".into(),
        environment: Environment::Dev,
        read_only: false,
        host: "localhost".into(),
        port: 5432,
        database: "db".into(),
        username: "user".into(),
        secret_ref: Some(SecretRef::new("keychain://mock")),
        tls_mode: TlsMode::VerifyFull,
        tls_ca_path: None,
        options: BTreeMap::new(),
        default_statement_timeout_ms: 0,
    }
}

#[async_trait]
impl DatabaseDriver for MockDriver {
    fn descriptor(&self) -> DriverDescriptor {
        DriverDescriptor {
            id: "mock".into(),
            display_name: "Mock".into(),
            version: "0.0.1".into(),
            maturity: DriverMaturity::Experimental,
            supported_server_versions: vec!["1.0".into()],
        }
    }

    fn capabilities(&self) -> DriverCapabilities {
        DriverCapabilities {
            sql: true,
            transactions: true,
            query_cancellation: true,
            ..Default::default()
        }
    }

    async fn test(&self, _config: ConnectionConfig) -> Result<ConnectionTestReport, DriverError> {
        Ok(ConnectionTestReport {
            stages: vec![TestStage {
                name: "tcp".into(),
                status: TestStageStatus::Passed,
                duration_ms: 1,
                detail: None,
            }],
            server_version: Some("1.0".into()),
        })
    }

    async fn connect(
        &self,
        config: ConnectionConfig,
    ) -> Result<Box<dyn DatabaseSession>, DriverError> {
        if config.secret_ref.is_none() {
            return Err(
                DriverError::new(ErrorCategory::Authentication, "Missing credentials")
                    .with_suggested_action("Add a password to this connection profile"),
            );
        }
        Ok(Box::new(MockSession {
            cancelled: Arc::new(AtomicBool::new(false)),
            in_transaction: None,
            broken: false,
        }))
    }
}

#[async_trait]
impl DatabaseSession for MockSession {
    async fn execute(
        &mut self,
        request: QueryRequest,
        sink: &dyn BatchSink,
    ) -> Result<ExecutionSummary, DriverError> {
        if request.sql.contains("syntax error") {
            return Err(DriverError::new(ErrorCategory::Syntax, "Syntax error")
                .with_native_code("42601")
                .with_query_range(0, 12));
        }
        let mut rows_returned = 0u64;
        for sequence in 0..3u64 {
            if self.cancelled.load(Ordering::SeqCst) {
                return Err(DriverError::cancelled());
            }
            let rows: Vec<Vec<CellValue>> = (0..10)
                .map(|i| {
                    vec![
                        CellValue::Int((sequence * 10 + i) as i64),
                        CellValue::Text(format!("row-{sequence}-{i}")),
                    ]
                })
                .collect();
            rows_returned += rows.len() as u64;
            sink.deliver(RowBatch {
                execution_id: request.execution_id,
                sequence,
                columns: vec![
                    ColumnMeta {
                        name: "id".into(),
                        db_type: "int8".into(),
                        nullable: Some(false),
                    },
                    ColumnMeta {
                        name: "label".into(),
                        db_type: "text".into(),
                        nullable: Some(true),
                    },
                ],
                rows,
                is_last: sequence == 2,
            })
            .await?;
        }
        Ok(ExecutionSummary {
            execution_id: request.execution_id,
            status: ExecutionStatus::Success,
            rows_affected: None,
            rows_returned,
            duration_ms: 1,
            messages: vec![],
        })
    }

    async fn cancel(&self, _execution_id: ExecutionId) -> Result<(), DriverError> {
        self.cancelled.store(true, Ordering::SeqCst);
        Ok(())
    }

    async fn metadata(&self, request: MetadataRequest) -> Result<MetadataResponse, DriverError> {
        let payload = match request {
            MetadataRequest::ServerInfo => serde_json::json!({"version": "1.0"}),
            MetadataRequest::ListSchemas => serde_json::json!(["public"]),
            _ => serde_json::json!(null),
        };
        Ok(MetadataResponse {
            payload,
            annotations: BTreeMap::new(),
        })
    }

    async fn begin(&mut self, _options: TransactionOptions) -> Result<TransactionId, DriverError> {
        let id = TransactionId::new();
        self.in_transaction = Some(id);
        Ok(id)
    }

    async fn commit(&mut self) -> Result<(), DriverError> {
        self.in_transaction
            .take()
            .map(|_| ())
            .ok_or_else(|| DriverError::new(ErrorCategory::Internal, "No open transaction"))
    }

    async fn rollback(&mut self) -> Result<(), DriverError> {
        self.in_transaction
            .take()
            .map(|_| ())
            .ok_or_else(|| DriverError::new(ErrorCategory::Internal, "No open transaction"))
    }

    fn is_broken(&self) -> bool {
        self.broken
    }
}

// --- Test sink ---------------------------------------------------------------

#[derive(Default)]
struct CollectSink {
    batches: Mutex<Vec<RowBatch>>,
}

#[async_trait]
impl BatchSink for CollectSink {
    async fn deliver(&self, batch: RowBatch) -> Result<(), DriverError> {
        self.batches.lock().unwrap().push(batch);
        Ok(())
    }
}

// --- Contract tests ----------------------------------------------------------

#[tokio::test]
async fn connection_contract_connect_and_execute() {
    let driver = MockDriver;
    assert!(driver.capabilities().sql);

    let mut session = driver.connect(config()).await.unwrap();
    let sink = CollectSink::default();
    let summary = session
        .execute(
            QueryRequest {
                execution_id: ExecutionId::new(),
                sql: "SELECT 1".into(),
                params: vec![],
                row_limit: 0,
                timeout_ms: 0,
            },
            &sink,
        )
        .await
        .unwrap();

    assert_eq!(summary.status, ExecutionStatus::Success);
    assert_eq!(summary.rows_returned, 30);
    let batches = sink.batches.lock().unwrap();
    assert_eq!(batches.len(), 3);
    assert!(batches.last().unwrap().is_last);
    // Sequence numbers are contiguous — required for corruption detection.
    for (i, b) in batches.iter().enumerate() {
        assert_eq!(b.sequence, i as u64);
    }
}

#[tokio::test]
async fn error_contract_normalized_syntax_error() {
    let driver = MockDriver;
    let mut session = driver.connect(config()).await.unwrap();
    let sink = CollectSink::default();
    let err = session
        .execute(
            QueryRequest {
                execution_id: ExecutionId::new(),
                sql: "syntax error here".into(),
                params: vec![],
                row_limit: 0,
                timeout_ms: 0,
            },
            &sink,
        )
        .await
        .unwrap_err();

    assert_eq!(err.category, ErrorCategory::Syntax);
    assert_eq!(err.native_code.as_deref(), Some("42601"));
    assert_eq!(err.retryability, Retryability::NotRetryable);
}

#[tokio::test]
async fn cancellation_contract() {
    let driver = MockDriver;
    let mut session = driver.connect(config()).await.unwrap();
    let exec_id = ExecutionId::new();
    session.cancel(exec_id).await.unwrap();

    let sink = CollectSink::default();
    let err = session
        .execute(
            QueryRequest {
                execution_id: exec_id,
                sql: "SELECT slow".into(),
                params: vec![],
                row_limit: 0,
                timeout_ms: 0,
            },
            &sink,
        )
        .await
        .unwrap_err();
    assert_eq!(err.category, ErrorCategory::Cancelled);
}

#[tokio::test]
async fn transaction_contract_begin_commit_rollback() {
    let driver = MockDriver;
    let mut session = driver.connect(config()).await.unwrap();

    session.begin(TransactionOptions::default()).await.unwrap();
    session.commit().await.unwrap();
    // Commit without an open transaction is an internal error, not silence.
    assert_eq!(
        session.commit().await.unwrap_err().category,
        ErrorCategory::Internal
    );

    session.begin(TransactionOptions::default()).await.unwrap();
    session.rollback().await.unwrap();
}

#[tokio::test]
async fn auth_contract_missing_secret_is_normalized() {
    let driver = MockDriver;
    let mut cfg = config();
    cfg.secret_ref = None;
    let err = driver.connect(cfg).await.err().unwrap();
    assert_eq!(err.category, ErrorCategory::Authentication);
    assert!(!err.suggested_actions.is_empty());
}

#[test]
fn secret_ref_debug_is_redacted() {
    let secret = SecretRef::new("keychain://item-with-sensitive-name");
    assert_eq!(format!("{secret:?}"), "SecretRef(<redacted>)");
}
