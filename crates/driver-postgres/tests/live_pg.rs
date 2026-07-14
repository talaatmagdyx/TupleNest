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

// --- TLS live tests (E1.2) --------------------------------------------------
// Require a local server with ssl=on and a self-signed cert whose SAN covers
// `localhost` (see docs). CA path from TUPLENEST_TEST_PG_SSL_CA, defaulting
// to the brew PG 18 data dir.

fn ca_path() -> String {
    std::env::var("TUPLENEST_TEST_PG_SSL_CA")
        .unwrap_or_else(|_| "/opt/homebrew/var/postgresql@18/tuplenest_ca.crt".into())
}

fn tls_config(mode: TlsMode, ca: Option<String>) -> ConnectionConfig {
    let mut c = test_config();
    c.tls_mode = mode;
    c.tls_ca_path = ca;
    c
}

/// Grabs the first cell of the first row as rendered text.
struct FirstCellSink(Mutex<Option<String>>);

#[async_trait]
impl BatchSink for FirstCellSink {
    async fn deliver(&self, batch: RowBatch) -> Result<(), DriverError> {
        let mut slot = self.0.lock().unwrap();
        if slot.is_none() {
            if let Some(row) = batch.rows.first() {
                let rendered = match &row[0] {
                    CellValue::Bool(b) => b.to_string(),
                    CellValue::Text(t) => t.clone(),
                    other => format!("{other:?}"),
                };
                *slot = Some(rendered);
            }
        }
        Ok(())
    }
}

#[tokio::test]
#[ignore]
async fn live_tls_verify_full_with_ca_passes_and_encrypts() {
    let config = tls_config(TlsMode::VerifyFull, Some(ca_path()));
    let report = PostgresDriver
        .test_with_password(&config, None)
        .await
        .unwrap();
    assert!(
        report.passed(),
        "verify-full with CA should pass: {:?}",
        report.stages
    );

    // Prove the session channel is actually encrypted.
    let mut session = PostgresDriver.connect_concrete(config).await.unwrap();
    let sink = FirstCellSink(Mutex::new(None));
    session
        .execute(
            req("select ssl::text from pg_stat_ssl where pid = pg_backend_pid()"),
            &sink,
        )
        .await
        .unwrap();
    assert_eq!(sink.0.lock().unwrap().as_deref(), Some("true"));
}

#[tokio::test]
#[ignore]
async fn live_tls_verify_full_without_ca_fails_closed() {
    // Self-signed server cert is not in the system trust store: the
    // handshake must fail — never silently downgrade to plaintext.
    let config = tls_config(TlsMode::VerifyFull, None);
    let report = PostgresDriver
        .test_with_password(&config, None)
        .await
        .unwrap();
    assert!(!report.passed(), "must fail closed on untrusted cert");

    let err = PostgresDriver.connect_concrete(config).await.err();
    assert!(err.is_some(), "connect must also fail closed");
}

#[tokio::test]
#[ignore]
async fn live_tls_prefer_encrypts_without_verification() {
    let mut session = PostgresDriver
        .connect_concrete(tls_config(TlsMode::Prefer, None))
        .await
        .expect("prefer mode should connect to self-signed server");
    let sink = FirstCellSink(Mutex::new(None));
    session
        .execute(
            req("select ssl::text from pg_stat_ssl where pid = pg_backend_pid()"),
            &sink,
        )
        .await
        .unwrap();
    assert_eq!(sink.0.lock().unwrap().as_deref(), Some("true"));
}

#[tokio::test]
#[ignore]
async fn live_tls_cancel_works_over_tls() {
    let mut session = PostgresDriver
        .connect_concrete(tls_config(TlsMode::VerifyFull, Some(ca_path())))
        .await
        .unwrap();
    let handle = session.cancel_handle();
    let canceller = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(400)).await;
        handle.cancel().await.unwrap();
    });
    let started = Instant::now();
    let result = session.execute(req("select pg_sleep(30)"), &NullSink).await;
    canceller.await.unwrap();
    assert!(result.is_err(), "sleep must be cancelled");
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "cancel must interrupt promptly over TLS"
    );
}

// --- Metadata live tests (E1.3) ----------------------------------------------

#[tokio::test]
#[ignore]
async fn live_metadata_schema_objects_columns_roundtrip() {
    let mut session = PostgresDriver
        .connect_concrete(test_config())
        .await
        .unwrap();

    // Fixture: table with PK, nullable column, comment; and a view.
    session
        .execute(
            req("CREATE TABLE tuplenest_meta (id bigint PRIMARY KEY, note text, qty int NOT NULL)"),
            &NullSink,
        )
        .await
        .unwrap();
    session
        .execute(
            req("COMMENT ON COLUMN tuplenest_meta.note IS 'free text'"),
            &NullSink,
        )
        .await
        .unwrap();
    session
        .execute(
            req("CREATE VIEW tuplenest_meta_v AS SELECT id FROM tuplenest_meta"),
            &NullSink,
        )
        .await
        .unwrap();

    // Schemas include public.
    let schemas = session
        .metadata(MetadataRequest::ListSchemas)
        .await
        .unwrap();
    let list: Vec<String> = serde_json::from_value(schemas.payload).unwrap();
    assert!(list.contains(&"public".to_string()));

    // Objects include our table and view with correct kinds.
    let objects = session
        .metadata(MetadataRequest::ListObjects {
            schema: "public".into(),
        })
        .await
        .unwrap();
    let objs = objects.payload.as_array().unwrap().clone();
    let find = |n: &str| {
        objs.iter()
            .find(|o| o["name"] == n)
            .unwrap_or_else(|| panic!("{n} missing"))
            .clone()
    };
    assert_eq!(find("tuplenest_meta")["kind"], "table");
    assert_eq!(find("tuplenest_meta_v")["kind"], "view");

    // Columns: types, nullability, PK, comment.
    let desc = session
        .metadata(MetadataRequest::DescribeObject {
            schema: "public".into(),
            name: "tuplenest_meta".into(),
        })
        .await
        .unwrap();
    let cols = desc.payload["columns"].as_array().unwrap().clone();
    assert_eq!(cols.len(), 3);
    assert_eq!(cols[0]["name"], "id");
    assert_eq!(cols[0]["dbType"], "bigint");
    assert_eq!(cols[0]["primaryKey"], true);
    assert_eq!(cols[0]["nullable"], false);
    assert_eq!(cols[1]["name"], "note");
    assert_eq!(cols[1]["nullable"], true);
    assert_eq!(cols[1]["comment"], "free text");
    assert_eq!(cols[2]["name"], "qty");
    assert_eq!(cols[2]["nullable"], false);

    // Unknown relation is a clean error, not a panic.
    assert!(session
        .metadata(MetadataRequest::DescribeObject {
            schema: "public".into(),
            name: "no_such_relation".into(),
        })
        .await
        .is_err());

    session
        .execute(req("DROP VIEW tuplenest_meta_v"), &NullSink)
        .await
        .unwrap();
    session
        .execute(req("DROP TABLE tuplenest_meta"), &NullSink)
        .await
        .unwrap();
}
