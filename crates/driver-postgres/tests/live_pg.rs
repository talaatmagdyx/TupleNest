//! Live PostgreSQL contract tests (Phase 0 exit criteria E0.9).
//!
//! These run against a real server and are ignored by default:
//!     cargo test -p tuplenest-driver-postgres -- --ignored
//!
//! Connection comes from TUPLENEST_TEST_PG_* env vars, defaulting to the
//! local development server (current OS user, database `postgres`).

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use tuplenest_driver_api::*;
use tuplenest_driver_postgres::PostgresDriver;

fn test_config() -> ConnectionConfig {
    ConnectionConfig {
        driver_id: "postgres".into(),
        name: "local".into(),
        environment: Environment::Dev,
        read_only: false,
        host: std::env::var("TUPLENEST_TEST_PG_HOST").unwrap_or_else(|_| "localhost".into()),
        port: std::env::var("TUPLENEST_TEST_PG_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(5432),
        database: std::env::var("TUPLENEST_TEST_PG_DB").unwrap_or_else(|_| "postgres".into()),
        username: std::env::var("TUPLENEST_TEST_PG_USER")
            .or_else(|_| std::env::var("USER"))
            .unwrap_or_else(|_| "postgres".into()),
        secret_ref: None,
        tls_mode: TlsMode::Disabled,
        tls_ca_path: None,
        options: BTreeMap::new(),
        default_statement_timeout_ms: 0,
    }
}

fn req(sql: impl Into<String>) -> QueryRequest {
    QueryRequest {
        execution_id: ExecutionId::new(),
        sql: sql.into(),
        params: vec![],
        row_limit: 0,
        timeout_ms: 0,
    }
}

struct NullSink;

#[async_trait]
impl BatchSink for NullSink {
    async fn deliver(&self, _batch: RowBatch) -> Result<(), DriverError> {
        Ok(())
    }
}

#[derive(Default)]
struct CountingSink {
    batches: AtomicU64,
    rows: AtomicU64,
    max_batch_rows: AtomicU64,
    checksum: AtomicU64,
    sequences: Mutex<Vec<u64>>,
}

#[async_trait]
impl BatchSink for CountingSink {
    async fn deliver(&self, batch: RowBatch) -> Result<(), DriverError> {
        self.batches.fetch_add(1, Ordering::SeqCst);
        self.rows
            .fetch_add(batch.rows.len() as u64, Ordering::SeqCst);
        self.max_batch_rows
            .fetch_max(batch.rows.len() as u64, Ordering::SeqCst);
        for row in &batch.rows {
            if let CellValue::Int(v) = row[0] {
                self.checksum.fetch_add(v as u64, Ordering::SeqCst);
            }
        }
        self.sequences.lock().unwrap().push(batch.sequence);
        Ok(())
    }
}

#[tokio::test]
#[ignore = "requires live PostgreSQL"]
async fn staged_connection_test_reports_server_version() {
    let report = PostgresDriver.test(test_config()).await.unwrap();
    assert!(report.passed(), "stages: {:?}", report.stages);
    assert!(report.server_version.is_some());
}

#[tokio::test]
#[ignore = "requires live PostgreSQL"]
async fn streams_100k_rows_in_bounded_ordered_batches_without_corruption() {
    let mut session = PostgresDriver.connect(test_config()).await.unwrap();
    let sink = CountingSink::default();
    let n: u64 = 100_000;
    let summary = session
        .execute(
            req(format!(
                "SELECT g::int8 AS id FROM generate_series(1, {n}) g"
            )),
            &sink,
        )
        .await
        .unwrap();

    assert_eq!(summary.status, ExecutionStatus::Success);
    assert_eq!(summary.rows_returned, n);
    assert_eq!(sink.rows.load(Ordering::SeqCst), n);
    assert!(
        sink.max_batch_rows.load(Ordering::SeqCst) <= 1_000,
        "batches must be bounded"
    );
    let seqs = sink.sequences.lock().unwrap();
    for (i, s) in seqs.iter().enumerate() {
        assert_eq!(*s, i as u64, "sequence numbers must be contiguous");
    }
    assert_eq!(
        sink.checksum.load(Ordering::SeqCst),
        n * (n + 1) / 2,
        "checksum mismatch — rows lost or duplicated"
    );
}

#[tokio::test]
#[ignore = "requires live PostgreSQL"]
async fn cancellation_terminates_server_side_query_quickly() {
    let mut session = PostgresDriver
        .connect_concrete(test_config())
        .await
        .unwrap();
    let handle = session.cancel_handle();

    let canceller = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        handle.cancel().await
    });

    let started = Instant::now();
    let err = session
        .execute(req("SELECT pg_sleep(30)"), &NullSink)
        .await
        .expect_err("execution must fail with cancellation");

    canceller
        .await
        .unwrap()
        .expect("cancel request should succeed");
    assert_eq!(err.category, ErrorCategory::Cancelled, "got: {err:?}");
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "took {:?}",
        started.elapsed()
    );
}

#[tokio::test]
#[ignore = "requires live PostgreSQL"]
async fn syntax_error_is_normalized_with_sqlstate_and_position() {
    let mut session = PostgresDriver.connect(test_config()).await.unwrap();
    let err = session
        .execute(req("SELEC 1"), &NullSink)
        .await
        .unwrap_err();
    assert_eq!(err.category, ErrorCategory::Syntax);
    assert_eq!(err.native_code.as_deref(), Some("42601"));
    assert!(err.query_range.is_some());
}

#[tokio::test]
#[ignore = "requires live PostgreSQL"]
async fn transactions_visible_only_after_commit() {
    let mut a = PostgresDriver.connect(test_config()).await.unwrap();
    a.execute(req("DROP TABLE IF EXISTS tuplenest_poc"), &NullSink)
        .await
        .unwrap();
    a.execute(
        req("CREATE TABLE tuplenest_poc (id int8 PRIMARY KEY)"),
        &NullSink,
    )
    .await
    .unwrap();

    a.begin(TransactionOptions::default()).await.unwrap();
    a.execute(req("INSERT INTO tuplenest_poc VALUES (1)"), &NullSink)
        .await
        .unwrap();
    a.rollback().await.unwrap();

    a.begin(TransactionOptions::default()).await.unwrap();
    a.execute(req("INSERT INTO tuplenest_poc VALUES (2)"), &NullSink)
        .await
        .unwrap();
    a.commit().await.unwrap();

    let sink = CountingSink::default();
    let summary = a
        .execute(req("SELECT id FROM tuplenest_poc ORDER BY id"), &sink)
        .await
        .unwrap();
    assert_eq!(summary.rows_returned, 1, "rollback row must not be visible");
    assert_eq!(
        sink.checksum.load(Ordering::SeqCst),
        2,
        "only the committed row remains"
    );
    a.execute(req("DROP TABLE tuplenest_poc"), &NullSink)
        .await
        .unwrap();
}
