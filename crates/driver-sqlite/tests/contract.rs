//! The driver-api contract suite (`crates/driver-api/tests/contract_mock.rs`),
//! with the same expectations, against SQLite on a temporary file. No server
//! and no network: this runs in every `cargo test`.

use std::collections::BTreeMap;
use std::sync::Mutex;

use async_trait::async_trait;
use tuplenest_driver_api::*;
use tuplenest_driver_sqlite::{SqliteDriver, OPTION_CREATE};

fn config(dir: &tempfile::TempDir) -> ConnectionConfig {
    ConnectionConfig {
        driver_id: "sqlite".into(),
        name: "test".into(),
        environment: Environment::Dev,
        read_only: false,
        host: String::new(),
        port: 0,
        database: dir.path().join("contract.db").display().to_string(),
        username: String::new(),
        secret_ref: None,
        tls_mode: TlsMode::Disabled,
        tls_ca_path: None,
        options: BTreeMap::from([(OPTION_CREATE.to_string(), "true".to_string())]),
        default_statement_timeout_ms: 0,
    }
}

#[derive(Default)]
struct CollectSink {
    batches: Mutex<Vec<RowBatch>>,
}

#[async_trait]
impl BatchSink for CollectSink {
    async fn deliver(&self, batch: RowBatch) -> Result<(), Box<DriverError>> {
        self.batches.lock().unwrap().push(batch);
        Ok(())
    }
}

fn request(sql: &str) -> QueryRequest {
    QueryRequest {
        execution_id: ExecutionId::new(),
        sql: sql.into(),
        params: vec![],
        row_limit: 0,
    }
}

#[tokio::test]
async fn connection_contract_connect_and_execute() {
    let dir = tempfile::tempdir().unwrap();
    let driver = SqliteDriver;
    assert!(driver.capabilities().sql);
    assert_eq!(driver.descriptor().id, "sqlite");

    let mut session = driver.connect(config(&dir)).await.unwrap();
    // 30 rows, as the mock: 2,500 here so they span three batches.
    let sink = CollectSink::default();
    let summary = session
        .execute(
            request(
                "WITH RECURSIVE n(id) AS (SELECT 0 UNION ALL SELECT id + 1 FROM n WHERE id < 2499) \
                 SELECT id, 'row-' || id AS label FROM n",
            ),
            &sink,
        )
        .await
        .unwrap();

    assert_eq!(summary.status, ExecutionStatus::Success);
    assert_eq!(summary.rows_returned, 2_500);
    let batches = sink.batches.lock().unwrap();
    assert_eq!(batches.len(), 3);
    assert!(batches.last().unwrap().is_last);
    // Sequence numbers are contiguous — required for corruption detection.
    for (i, b) in batches.iter().enumerate() {
        assert_eq!(b.sequence, i as u64);
    }
    assert_eq!(batches[0].columns[0].name, "id");
    assert_eq!(batches[0].rows[1][1], CellValue::Text("row-1".into()));
}

#[tokio::test]
async fn error_contract_normalized_syntax_error() {
    let dir = tempfile::tempdir().unwrap();
    let mut session = SqliteDriver.connect(config(&dir)).await.unwrap();
    let err = session
        .execute(request("syntax error here"), &CollectSink::default())
        .await
        .unwrap_err();

    assert_eq!(err.category, ErrorCategory::Syntax);
    // SQLite's extended result code, where PostgreSQL puts its SQLSTATE.
    assert_eq!(err.native_code.as_deref(), Some("SQLITE_ERROR"));
    assert_eq!(err.retryability, Retryability::NotRetryable);
    assert!(err.query_range.is_some());
}

#[tokio::test]
async fn cancellation_contract() {
    let dir = tempfile::tempdir().unwrap();
    let mut session = SqliteDriver.connect(config(&dir)).await.unwrap();
    let exec_id = ExecutionId::new();
    session.cancel(exec_id).await.unwrap();

    let err = session
        .execute(
            QueryRequest {
                execution_id: exec_id,
                sql: "SELECT 1".into(),
                params: vec![],
                row_limit: 0,
            },
            &CollectSink::default(),
        )
        .await
        .unwrap_err();
    assert_eq!(err.category, ErrorCategory::Cancelled);
    // Only that execution: the next one runs.
    session
        .execute(request("SELECT 1"), &CollectSink::default())
        .await
        .unwrap();
}

#[tokio::test]
async fn transaction_contract_begin_commit_rollback() {
    let dir = tempfile::tempdir().unwrap();
    let mut session = SqliteDriver.connect(config(&dir)).await.unwrap();

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

/// The mock's auth contract, for an engine with no credentials: a missing
/// target is a normalized error with something to do about it.
#[tokio::test]
async fn open_contract_missing_file_is_normalized() {
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = config(&dir);
    cfg.options.clear();
    let err = SqliteDriver.connect(cfg).await.err().unwrap();
    assert_eq!(err.category, ErrorCategory::DatabaseMissing);
    assert_eq!(err.native_code.as_deref(), Some("SQLITE_CANTOPEN"));

    let mut cfg = config(&dir);
    cfg.database = "  ".into();
    let err = SqliteDriver.connect(cfg).await.err().unwrap();
    assert_eq!(err.category, ErrorCategory::Configuration);
}

#[tokio::test]
async fn metadata_contract_server_info_and_schemas() {
    let dir = tempfile::tempdir().unwrap();
    let session = SqliteDriver.connect(config(&dir)).await.unwrap();
    let info = session.metadata(MetadataRequest::ServerInfo).await.unwrap();
    assert!(info.payload["version"]
        .as_str()
        .unwrap()
        .starts_with("SQLite 3."));
    let schemas = session
        .metadata(MetadataRequest::ListSchemas)
        .await
        .unwrap();
    assert_eq!(schemas.payload, serde_json::json!(["main"]));
    assert!(!session.is_broken());
}
