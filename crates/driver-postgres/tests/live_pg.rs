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

/// Collects every cell so type rendering can be asserted on.
#[derive(Default)]
struct CollectSink {
    rows: Mutex<Vec<Vec<CellValue>>>,
}

#[async_trait]
impl BatchSink for CollectSink {
    async fn deliver(&self, batch: RowBatch) -> Result<(), DriverError> {
        self.rows.lock().unwrap().extend(batch.rows);
        Ok(())
    }
}

/// Run `sql` and return the first row's cells.
async fn first_row(sql: &str) -> Vec<CellValue> {
    let mut session = PostgresDriver.connect(test_config()).await.unwrap();
    let sink = CollectSink::default();
    session.execute(req(sql), &sink).await.unwrap();
    let rows = sink.rows.lock().unwrap();
    rows.first().cloned().unwrap_or_default()
}

fn text_of(c: &CellValue) -> String {
    match c {
        CellValue::Text(s) => s.clone(),
        CellValue::Int(i) => i.to_string(),
        CellValue::Float(f) => f.to_string(),
        CellValue::Bool(b) => b.to_string(),
        CellValue::Json(j) => j.to_string(),
        CellValue::Null => "NULL".into(),
        CellValue::Bytes(b) => format!("\\x{}", hex::encode(b)),
        CellValue::Other { rendered, .. } => rendered.clone(),
    }
}

// Regression: these types all rendered as "<unsupported in PoC>", which made
// real tables unreadable — 7 of 22 columns on the reporter's table.
#[tokio::test]
#[ignore = "requires live PostgreSQL"]
async fn renders_timestamps_and_dates() {
    let cells = first_row(
        "select '2024-01-15 10:30:00'::timestamp,
                '2024-01-15 10:30:00+00'::timestamptz,
                '2024-01-15'::date,
                '10:30:00'::time",
    )
    .await;
    assert_eq!(text_of(&cells[0]), "2024-01-15 10:30:00");
    assert!(
        text_of(&cells[1]).starts_with("2024-01-15T10:30:00"),
        "{:?}",
        cells[1]
    );
    assert_eq!(text_of(&cells[2]), "2024-01-15");
    assert_eq!(text_of(&cells[3]), "10:30:00");
}

#[tokio::test]
#[ignore = "requires live PostgreSQL"]
async fn renders_user_defined_enums() {
    let mut session = PostgresDriver.connect(test_config()).await.unwrap();
    session
        .execute(req("drop type if exists tn_test_mood cascade"), &NullSink)
        .await
        .unwrap();
    session
        .execute(
            req("create type tn_test_mood as enum ('happy','sad')"),
            &NullSink,
        )
        .await
        .unwrap();

    let cells = first_row("select 'happy'::tn_test_mood").await;
    assert_eq!(text_of(&cells[0]), "happy");

    let mut s2 = PostgresDriver.connect(test_config()).await.unwrap();
    s2.execute(req("drop type if exists tn_test_mood cascade"), &NullSink)
        .await
        .unwrap();
}

// Regression: rust_decimal is 96-bit (~28 digits) and silently failed on
// values Postgres stores happily, falling back to a hex dump. numeric is
// decoded from the wire format instead, which is exact at any precision.
#[tokio::test]
#[ignore = "requires live PostgreSQL"]
async fn renders_numeric_without_losing_precision() {
    let cells = first_row(
        "select '123456789012345678901234567890.12345'::numeric,
                '125000.50'::numeric,
                '-42.001'::numeric,
                '0.00001234'::numeric,
                '0'::numeric,
                '12'::numeric,
                'NaN'::numeric",
    )
    .await;
    assert_eq!(text_of(&cells[0]), "123456789012345678901234567890.12345");
    assert_eq!(
        text_of(&cells[1]),
        "125000.50",
        "trailing zero must survive"
    );
    assert_eq!(text_of(&cells[2]), "-42.001");
    assert_eq!(
        text_of(&cells[3]),
        "0.00001234",
        "leading zeros after the point"
    );
    assert_eq!(text_of(&cells[4]), "0");
    assert_eq!(text_of(&cells[5]), "12");
    assert_eq!(text_of(&cells[6]), "NaN");
}

#[tokio::test]
#[ignore = "requires live PostgreSQL"]
async fn renders_arrays_and_network_types() {
    let cells = first_row(
        "select array[1,2,3]::int4[],
                array['a',null,'c']::text[],
                '192.168.1.1'::inet",
    )
    .await;
    assert_eq!(text_of(&cells[0]), "{1,2,3}");
    assert_eq!(text_of(&cells[1]), "{a,NULL,c}");
    assert_eq!(text_of(&cells[2]), "192.168.1.1");
}

#[tokio::test]
#[ignore = "requires live PostgreSQL"]
async fn renders_interval_money_and_xml_via_fallback() {
    let cells =
        first_row("select '1 day 2 hours'::interval, '<a>b</a>'::xml, '$1.50'::money").await;
    // Not "unsupported" — the fallback decodes the wire value.
    for c in &cells {
        let t = text_of(c);
        assert!(!t.contains("unsupported"), "got {t:?}");
    }
    assert_eq!(
        text_of(&cells[1]),
        "<a>b</a>",
        "xml is sent as text on the wire"
    );
}

#[tokio::test]
#[ignore = "requires live PostgreSQL"]
async fn nulls_of_exotic_types_are_null_not_rendered() {
    let cells = first_row("select null::timestamp, null::numeric, null::inet, null::int4[]").await;
    for c in &cells {
        assert!(matches!(c, CellValue::Null), "expected Null, got {c:?}");
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

/// The server's DETAIL and the constraint name must survive normalization.
///
/// Exists because they didn't: `normalize_error` kept only `message()`, so a
/// duplicate-key failure reached the UI as "Constraint violation" with no key,
/// no value, no constraint — and an unmapped SQLSTATE as the bare words
/// "Database error". A beta user reported exactly that. Only a live server
/// can prove this, because tokio-postgres's DbError cannot be constructed in
/// a unit test.
#[tokio::test]
#[ignore = "requires live PostgreSQL"]
async fn constraint_violation_keeps_detail_and_constraint_name() {
    let mut s = PostgresDriver.connect(test_config()).await.unwrap();
    s.execute(
        req("DROP TABLE IF EXISTS public.tuplenest_errdet"),
        &NullSink,
    )
    .await
    .unwrap();
    s.execute(
        req("CREATE TABLE public.tuplenest_errdet (id int8 PRIMARY KEY)"),
        &NullSink,
    )
    .await
    .unwrap();
    s.execute(
        req("INSERT INTO public.tuplenest_errdet VALUES (1)"),
        &NullSink,
    )
    .await
    .unwrap();
    let err = s
        .execute(
            req("INSERT INTO public.tuplenest_errdet VALUES (1)"),
            &NullSink,
        )
        .await
        .unwrap_err();

    assert_eq!(err.category, ErrorCategory::ConstraintViolation);
    assert_eq!(err.native_code.as_deref(), Some("23505"));
    let msg = err.original_message.as_deref().unwrap_or_default();
    assert!(
        msg.contains("Detail: Key (id)=(1) already exists."),
        "server DETAIL missing from: {msg}"
    );
    assert!(
        msg.contains("constraint \"tuplenest_errdet_pkey\""),
        "constraint name missing from: {msg}"
    );

    s.execute(req("DROP TABLE public.tuplenest_errdet"), &NullSink)
        .await
        .unwrap();
}

#[tokio::test]
#[ignore = "requires live PostgreSQL"]
async fn transactions_visible_only_after_commit() {
    let mut a = PostgresDriver.connect(test_config()).await.unwrap();
    a.execute(req("DROP TABLE IF EXISTS public.tuplenest_poc"), &NullSink)
        .await
        .unwrap();
    a.execute(
        req("CREATE TABLE public.tuplenest_poc (id int8 PRIMARY KEY)"),
        &NullSink,
    )
    .await
    .unwrap();

    a.begin(TransactionOptions::default()).await.unwrap();
    a.execute(
        req("INSERT INTO public.tuplenest_poc VALUES (1)"),
        &NullSink,
    )
    .await
    .unwrap();
    a.rollback().await.unwrap();

    a.begin(TransactionOptions::default()).await.unwrap();
    a.execute(
        req("INSERT INTO public.tuplenest_poc VALUES (2)"),
        &NullSink,
    )
    .await
    .unwrap();
    a.commit().await.unwrap();

    let sink = CountingSink::default();
    let summary = a
        .execute(
            req("SELECT id FROM public.tuplenest_poc ORDER BY id"),
            &sink,
        )
        .await
        .unwrap();
    assert_eq!(summary.rows_returned, 1, "rollback row must not be visible");
    assert_eq!(
        sink.checksum.load(Ordering::SeqCst),
        2,
        "only the committed row remains"
    );
    a.execute(req("DROP TABLE public.tuplenest_poc"), &NullSink)
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

// --- TLS downgrade / SSL-stripping tests (security review NET-01) -----------
// These need a PLAINTEXT server (ssl=off) — distinct from the ssl=on server the
// tests above use. Point them at one with TUPLENEST_TEST_PG_PLAINTEXT_PORT
// (default 5433). The whole reason these exist: before the ssl_mode fix, a
// verify-full connection to a no-TLS server SILENTLY SUCCEEDED in plaintext.
// After the fix, the verify modes must refuse it.

fn plaintext_config(mode: TlsMode) -> ConnectionConfig {
    let mut c = test_config();
    c.tls_mode = mode;
    c.tls_ca_path = None;
    c.port = std::env::var("TUPLENEST_TEST_PG_PLAINTEXT_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(5433);
    c
}

#[tokio::test]
#[ignore = "requires a plaintext (ssl=off) PostgreSQL server"]
async fn live_tls_verify_full_refuses_a_plaintext_server() {
    // The NET-01 regression. A server that does not offer TLS must NOT be
    // reached over plaintext when the user asked for verify-full.
    let config = plaintext_config(TlsMode::VerifyFull);
    let report = PostgresDriver
        .test_with_password(&config, None)
        .await
        .unwrap();
    assert!(
        !report.passed(),
        "verify-full must fail closed against a no-TLS server, not downgrade: {:?}",
        report.stages
    );
    assert!(
        PostgresDriver.connect_concrete(config).await.is_err(),
        "connect must also refuse plaintext under verify-full"
    );
}

#[tokio::test]
#[ignore = "requires a plaintext (ssl=off) PostgreSQL server"]
async fn live_tls_verify_ca_refuses_a_plaintext_server() {
    let config = plaintext_config(TlsMode::VerifyCa);
    let report = PostgresDriver
        .test_with_password(&config, None)
        .await
        .unwrap();
    assert!(
        !report.passed(),
        "verify-ca must fail closed against a no-TLS server: {:?}",
        report.stages
    );
    assert!(
        PostgresDriver.connect_concrete(config).await.is_err(),
        "connect must also refuse plaintext under verify-ca"
    );
}

#[tokio::test]
#[ignore = "requires a plaintext (ssl=off) PostgreSQL server"]
async fn live_tls_prefer_allows_a_plaintext_server() {
    // Prefer's documented behavior: try TLS, accept plaintext if unavailable.
    // This must still succeed after the fix — the fix only tightens verify-*.
    let report = PostgresDriver
        .test_with_password(&plaintext_config(TlsMode::Prefer), None)
        .await
        .unwrap();
    assert!(
        report.passed(),
        "prefer must still connect to a plaintext server: {:?}",
        report.stages
    );
}

#[tokio::test]
#[ignore = "requires a plaintext (ssl=off) PostgreSQL server"]
async fn live_tls_disabled_connects_to_a_plaintext_server() {
    let report = PostgresDriver
        .test_with_password(&plaintext_config(TlsMode::Disabled), None)
        .await
        .unwrap();
    assert!(
        report.passed(),
        "disabled must connect to a plaintext server: {:?}",
        report.stages
    );
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
    //
    // Dropped first, and schema-qualified throughout. Unqualified DDL lands in
    // whatever schema the role's search_path names first — on a developer's own
    // database that is their application schema, not `public`, which is the
    // schema every assertion below asks about. And a run that panics never
    // reaches its cleanup, so without this the next run fails on "already
    // exists" and looks like a driver bug.
    session
        .execute(
            req("DROP VIEW IF EXISTS public.tuplenest_meta_v"),
            &NullSink,
        )
        .await
        .unwrap();
    session
        .execute(req("DROP TABLE IF EXISTS public.tuplenest_meta"), &NullSink)
        .await
        .unwrap();
    session
        .execute(
            req("CREATE TABLE public.tuplenest_meta (id bigint PRIMARY KEY, note text, qty int NOT NULL)"),
            &NullSink,
        )
        .await
        .unwrap();
    session
        .execute(
            req("COMMENT ON COLUMN public.tuplenest_meta.note IS 'free text'"),
            &NullSink,
        )
        .await
        .unwrap();
    session
        .execute(
            req("CREATE VIEW public.tuplenest_meta_v AS SELECT id FROM public.tuplenest_meta"),
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
        .execute(req("DROP VIEW public.tuplenest_meta_v"), &NullSink)
        .await
        .unwrap();
    session
        .execute(req("DROP TABLE public.tuplenest_meta"), &NullSink)
        .await
        .unwrap();
}

// --- Fault injection (E1.1) ---------------------------------------------------

#[tokio::test]
#[ignore]
async fn killed_backend_yields_network_error_and_broken_session() {
    let mut victim = PostgresDriver
        .connect_concrete(test_config())
        .await
        .unwrap();
    let mut killer = PostgresDriver
        .connect_concrete(test_config())
        .await
        .unwrap();

    // Learn the victim's backend pid.
    let sink = FirstCellSink(Mutex::new(None));
    victim
        .execute(req("select pg_backend_pid()::text"), &sink)
        .await
        .unwrap();
    let pid = sink.0.lock().unwrap().clone().unwrap();

    // Kill it server-side from the second session.
    killer
        .execute(
            req(format!("select pg_terminate_backend({pid})")),
            &NullSink,
        )
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;

    // The victim's next statement must fail with a normalized network-class
    // error — never hang, never silently reconnect and re-run.
    let err = victim
        .execute(req("select 1"), &NullSink)
        .await
        .expect_err("statement on killed backend must fail");
    assert!(
        matches!(
            err.category,
            ErrorCategory::Network | ErrorCategory::DriverFailure
        ),
        "expected network-class category, got {:?}: {err}",
        err.category
    );

    // And the session stays broken on subsequent use.
    assert!(victim.execute(req("select 2"), &NullSink).await.is_err());
}

// --- Monitoring (Phase 6) ---------------------------------------------------

#[tokio::test]
#[ignore]
async fn live_server_activity_reports_sessions_and_db_stats() {
    let session = PostgresDriver
        .connect_concrete(test_config())
        .await
        .unwrap();
    // Open a second connection so there is at least one other session.
    let _other = PostgresDriver
        .connect_concrete(test_config())
        .await
        .unwrap();

    let resp = session
        .metadata(MetadataRequest::ServerActivity)
        .await
        .unwrap();
    let p = resp.payload;
    assert!(p["sessions"].is_array(), "sessions array present");
    assert!(p["locks"].is_array(), "locks array present");
    // db stats populated
    assert!(p["db"]["backends"].as_i64().unwrap() >= 1);
    assert!(!p["db"]["size"].as_str().unwrap().is_empty());
}

#[tokio::test]
#[ignore]
async fn live_terminate_backend_kills_target_session() {
    let admin = PostgresDriver
        .connect_concrete(test_config())
        .await
        .unwrap();
    let mut victim = PostgresDriver
        .connect_concrete(test_config())
        .await
        .unwrap();

    let sink = FirstCellSink(Mutex::new(None));
    victim
        .execute(req("select pg_backend_pid()::text"), &sink)
        .await
        .unwrap();
    let pid: i32 = sink.0.lock().unwrap().clone().unwrap().parse().unwrap();

    let ok = admin.admin_backend(pid, true).await.unwrap();
    assert!(ok, "pg_terminate_backend returned true");
    tokio::time::sleep(Duration::from_millis(300)).await;
    // Victim's next statement fails — its backend is gone.
    assert!(victim.execute(req("select 1"), &NullSink).await.is_err());
}

#[tokio::test]
#[ignore]
async fn live_relationships_lists_foreign_keys() {
    let mut session = PostgresDriver
        .connect_concrete(test_config())
        .await
        .unwrap();
    // Dropped first: a panicking run leaves these behind, and the child holds
    // the foreign key so it has to go first.
    session
        .execute(req("DROP TABLE IF EXISTS public.tn_child"), &NullSink)
        .await
        .unwrap();
    session
        .execute(req("DROP TABLE IF EXISTS public.tn_parent"), &NullSink)
        .await
        .unwrap();
    session
        .execute(
            req("CREATE TABLE public.tn_parent (id int primary key)"),
            &NullSink,
        )
        .await
        .unwrap();
    session
        .execute(
            req("CREATE TABLE public.tn_child (id int primary key, parent_id int references public.tn_parent(id))"),
            &NullSink,
        )
        .await
        .unwrap();

    let resp = session
        .metadata(MetadataRequest::Relationships {
            schema: "public".into(),
        })
        .await
        .unwrap();
    let fks = resp.payload.as_array().unwrap().clone();
    let hit = fks
        .iter()
        .find(|f| f["from"] == "tn_child" && f["to"] == "tn_parent");
    assert!(hit.is_some(), "child→parent FK present: {fks:?}");

    session
        .execute(req("DROP TABLE public.tn_child"), &NullSink)
        .await
        .unwrap();
    session
        .execute(req("DROP TABLE public.tn_parent"), &NullSink)
        .await
        .unwrap();
}

// --- Query parameters (Phase 3) ---------------------------------------------

fn req_params(sql: impl Into<String>, params: Vec<ParamValue>) -> QueryRequest {
    QueryRequest {
        execution_id: ExecutionId::new(),
        sql: sql.into(),
        params,
        row_limit: 0,
        timeout_ms: 0,
    }
}

#[tokio::test]
#[ignore]
async fn live_typed_parameters_bind_correctly() {
    let mut session = PostgresDriver
        .connect_concrete(test_config())
        .await
        .unwrap();

    // Real-world shape: params matched against typed columns (the common
    // `where col = $n` case). Postgres infers each param type from context.
    session
        .execute(req("DROP TABLE IF EXISTS public.tn_param"), &NullSink)
        .await
        .unwrap();
    session
        .execute(
            req(
                "CREATE TABLE public.tn_param (id int4 primary key, name text, active bool, score float4)",
            ),
            &NullSink,
        )
        .await
        .unwrap();
    session
        .execute(
            req_params(
                "INSERT INTO public.tn_param VALUES ($1, $2, $3, $4)",
                vec![
                    ParamValue::Int(7), // i64 → adapts to int4 column
                    ParamValue::Text("alice".into()),
                    ParamValue::Bool(true),
                    ParamValue::Float(9.5),
                ],
            ),
            &NullSink,
        )
        .await
        .unwrap();

    // Read it back filtering by an int4 column with an i64 param.
    let sink = FirstCellSink(Mutex::new(None));
    session
        .execute(
            req_params(
                "SELECT name FROM public.tn_param WHERE id = $1 AND active = $2",
                vec![ParamValue::Int(7), ParamValue::Bool(true)],
            ),
            &sink,
        )
        .await
        .unwrap();
    assert_eq!(sink.0.lock().unwrap().as_deref(), Some("alice"));

    // Null parameter: rows where name = $1 with $1 null returns nothing.
    #[derive(Default)]
    struct Counter(std::sync::atomic::AtomicU64);
    #[async_trait]
    impl BatchSink for Counter {
        async fn deliver(&self, b: RowBatch) -> Result<(), DriverError> {
            self.0.fetch_add(b.rows.len() as u64, Ordering::SeqCst);
            Ok(())
        }
    }
    let counter = Counter::default();
    session
        .execute(
            req_params(
                "SELECT * FROM public.tn_param WHERE name = $1",
                vec![ParamValue::Null],
            ),
            &counter,
        )
        .await
        .unwrap();
    assert_eq!(
        counter.0.load(Ordering::SeqCst),
        0,
        "= null matches nothing"
    );

    session
        .execute(req("DROP TABLE public.tn_param"), &NullSink)
        .await
        .unwrap();
}

// --- read-only sessions -----------------------------------------------------

/// A read-only profile must be enforced by the *server*, not by us guessing
/// which statements write. This is the test that the flag is not decorative:
/// before it, `read_only` was collected from the profile, carried all the way
/// into `ConnectionConfig`, and then hard-coded to `false` on the way to the
/// session — so the whole feature was a no-op.
#[tokio::test]
#[ignore = "requires live PostgreSQL"]
async fn read_only_session_refuses_writes_at_the_server() {
    let mut cfg = test_config();
    cfg.read_only = true;
    let mut s = PostgresDriver
        .connect_concrete_with_password(cfg, None)
        .await
        .expect("connect");

    // Reads still work — read-only must not mean useless.
    s.execute(req("SELECT 1"), &NullSink)
        .await
        .expect("a read-only session must still read");

    let err = s
        .execute(req("CREATE TEMP TABLE tn_ro_probe (id int)"), &NullSink)
        .await
        .expect_err("a write must be refused on a read-only session");

    // 25006 read_only_sql_transaction. The message comes from PostgreSQL,
    // which is the point: no statement can talk its way past it.
    let msg = format!("{err:?}").to_lowercase();
    assert!(
        msg.contains("read-only") || msg.contains("read only"),
        "expected a read-only refusal from the server, got: {msg}"
    );
}

/// The same connection without the flag must be unaffected — otherwise the
/// test above would pass for the wrong reason.
#[tokio::test]
#[ignore = "requires live PostgreSQL"]
async fn a_normal_session_still_writes() {
    let mut s = PostgresDriver
        .connect_concrete_with_password(test_config(), None)
        .await
        .expect("connect");
    s.execute(req("CREATE TEMP TABLE tn_rw_probe (id int)"), &NullSink)
        .await
        .expect("a normal session must still write");
}

/// A generated column must be reported as such, so the grid can refuse to
/// offer it for editing. Without the flag the app builds an UPDATE PostgreSQL
/// always rejects, and the user sees a raw database error for a cell the app
/// told them was writable.
#[tokio::test]
#[ignore = "requires live PostgreSQL"]
async fn describe_object_flags_generated_and_identity_columns() {
    let mut session = PostgresDriver
        .connect_concrete(test_config())
        .await
        .unwrap();

    session
        .execute(req("DROP TABLE IF EXISTS public.tn_gen"), &NullSink)
        .await
        .unwrap();
    session
        .execute(
            req("CREATE TABLE public.tn_gen (
                   id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                   qty  int,
                   unit int,
                   total int GENERATED ALWAYS AS (qty * unit) STORED
                 )"),
            &NullSink,
        )
        .await
        .unwrap();

    let out = session
        .metadata(MetadataRequest::DescribeObject {
            schema: "public".into(),
            name: "tn_gen".into(),
        })
        .await
        .expect("describe");

    let cols = out.payload["columns"].as_array().expect("columns");
    let flag = |name: &str| -> bool {
        cols.iter()
            .find(|c| c["name"] == name)
            .unwrap_or_else(|| panic!("column {name} missing"))["generated"]
            .as_bool()
            .expect("generated flag")
    };

    assert!(flag("total"), "STORED generated column must be flagged");
    assert!(flag("id"), "GENERATED AS IDENTITY column must be flagged");
    assert!(!flag("qty"), "an ordinary column must not be flagged");

    session
        .execute(req("DROP TABLE public.tn_gen"), &NullSink)
        .await
        .unwrap();
}

/// 25P02: after a failed statement inside a transaction, every subsequent
/// statement fails with this. It used to fall through to a bare "Database
/// error", leaving the user in a state the app could not name and could not
/// tell them how to leave.
#[tokio::test]
#[ignore = "requires live PostgreSQL"]
async fn aborted_transaction_is_named_and_says_how_to_recover() {
    let mut s = PostgresDriver
        .connect_concrete(test_config())
        .await
        .unwrap();

    s.begin(TransactionOptions::default()).await.unwrap();
    // Poison the transaction.
    let _ = s
        .execute(req("SELECT * FROM tn_does_not_exist"), &NullSink)
        .await;

    let err = s
        .execute(req("SELECT 1"), &NullSink)
        .await
        .expect_err("everything after a failure in a transaction must fail");
    let msg = format!("{err:?}");
    assert!(
        msg.contains("aborted") && msg.to_lowercase().contains("roll back"),
        "the error must name the state and the way out, got: {msg}"
    );

    // And the way out actually works.
    s.rollback().await.expect("rollback");
    s.execute(req("SELECT 1"), &NullSink)
        .await
        .expect("the session is usable again after a rollback");
}

/// A statement timeout is the server's timer, so it fires whatever the client
/// is doing. The field existed on the config and was wired to nothing.
#[tokio::test]
#[ignore = "requires live PostgreSQL"]
async fn statement_timeout_is_enforced_by_the_server() {
    let mut cfg = test_config();
    cfg.default_statement_timeout_ms = 250;
    let mut s = PostgresDriver
        .connect_concrete_with_password(cfg, None)
        .await
        .expect("connect");

    let err = s
        .execute(req("SELECT pg_sleep(5)"), &NullSink)
        .await
        .expect_err("a 5s sleep must not survive a 250ms timeout");
    // Postgres reports a timeout as query_canceled, same as a user cancel.
    assert!(
        matches!(err.category, ErrorCategory::Cancelled),
        "expected a cancellation, got {:?}",
        err.category
    );
}

/// Zero means no limit, which is PostgreSQL's own meaning and the default: a
/// query that is supposed to take a long time is a normal thing to run here.
#[tokio::test]
#[ignore = "requires live PostgreSQL"]
async fn no_timeout_is_configured_by_default() {
    // `first_row` opens its own session with the default config, which is
    // exactly the question being asked.
    let row = first_row("SHOW statement_timeout").await;
    assert_eq!(text_of(&row[0]), "0");
}

/// Optimistic concurrency, proved against a real server.
///
/// The frontend builds `UPDATE ... WHERE pk = $n AND col IS NOT DISTINCT FROM
/// $m`. This is the shape that matters: if another session changed the cell
/// after the grid drew it, the statement must match zero rows so the app can
/// refuse rather than overwrite. Before, the WHERE was the key alone and the
/// other session's change was silently clobbered.
#[tokio::test]
#[ignore = "requires live PostgreSQL"]
async fn optimistic_where_clause_catches_a_concurrent_change() {
    let mut s = PostgresDriver
        .connect_concrete(test_config())
        .await
        .unwrap();
    s.execute(req("DROP TABLE IF EXISTS public.tn_occ"), &NullSink)
        .await
        .unwrap();
    s.execute(
        req("CREATE TABLE public.tn_occ (id int primary key, email text)"),
        &NullSink,
    )
    .await
    .unwrap();
    s.execute(
        req("INSERT INTO public.tn_occ VALUES (1, 'ada@x.com')"),
        &NullSink,
    )
    .await
    .unwrap();

    // Another session gets there first.
    let mut other = PostgresDriver
        .connect_concrete(test_config())
        .await
        .unwrap();
    other
        .execute(
            req("UPDATE public.tn_occ SET email = 'someone-else@x.com' WHERE id = 1"),
            &NullSink,
        )
        .await
        .unwrap();

    // Our edit, staged when the cell still read 'ada@x.com'.
    let mut r =
        req("UPDATE public.tn_occ SET email = $1 WHERE id = $2 AND email IS NOT DISTINCT FROM $3");
    r.params = vec![
        ParamValue::Text("mine@x.com".into()),
        ParamValue::Int(1),
        ParamValue::Text("ada@x.com".into()),
    ];
    let summary = s.execute(r, &NullSink).await.expect("statement runs");
    assert_eq!(
        summary.rows_affected,
        Some(0),
        "a stale old value must match no rows — this is what makes the app able to refuse"
    );

    // The other session's write stands.
    let row = first_row("SELECT email FROM public.tn_occ WHERE id = 1").await;
    assert_eq!(text_of(&row[0]), "someone-else@x.com");

    // And the same statement with the current value does land.
    let mut ok =
        req("UPDATE public.tn_occ SET email = $1 WHERE id = $2 AND email IS NOT DISTINCT FROM $3");
    ok.params = vec![
        ParamValue::Text("mine@x.com".into()),
        ParamValue::Int(1),
        ParamValue::Text("someone-else@x.com".into()),
    ];
    assert_eq!(
        s.execute(ok, &NullSink).await.unwrap().rows_affected,
        Some(1)
    );

    s.execute(req("DROP TABLE public.tn_occ"), &NullSink)
        .await
        .unwrap();
}

/// `IS NOT DISTINCT FROM` and not `=`: a cell that was NULL must still be
/// editable. With `=` every such edit would match zero rows and be reported as
/// a conflict.
#[tokio::test]
#[ignore = "requires live PostgreSQL"]
async fn a_null_old_value_still_matches() {
    let mut s = PostgresDriver
        .connect_concrete(test_config())
        .await
        .unwrap();
    s.execute(req("DROP TABLE IF EXISTS public.tn_occ_null"), &NullSink)
        .await
        .unwrap();
    s.execute(
        req("CREATE TABLE public.tn_occ_null (id int primary key, note text)"),
        &NullSink,
    )
    .await
    .unwrap();
    s.execute(
        req("INSERT INTO public.tn_occ_null VALUES (1, NULL)"),
        &NullSink,
    )
    .await
    .unwrap();

    let mut r = req(
        "UPDATE public.tn_occ_null SET note = $1 WHERE id = $2 AND note IS NOT DISTINCT FROM $3",
    );
    r.params = vec![
        ParamValue::Text("filled".into()),
        ParamValue::Int(1),
        ParamValue::Null,
    ];
    assert_eq!(
        s.execute(r, &NullSink).await.unwrap().rows_affected,
        Some(1),
        "a NULL old value must match; `= NULL` never would"
    );

    s.execute(req("DROP TABLE public.tn_occ_null"), &NullSink)
        .await
        .unwrap();
}

/// `rows_affected` must be a real count, not None.
///
/// It was hard-coded `None` in the driver, and everything above it read that
/// as "the server did not say" rather than "we never asked". The row-edit
/// guard skips its check on a null count, so the zero-row and concurrency
/// refusals were both inert — they looked implemented, were tested with mocks
/// that returned numbers, and could never have fired against a real server.
///
/// The lesson this encodes: a mock that returns the shape you hoped for will
/// not tell you the shape you actually get.
#[tokio::test]
#[ignore = "requires live PostgreSQL"]
async fn rows_affected_is_reported_for_writes() {
    let mut s = PostgresDriver
        .connect_concrete(test_config())
        .await
        .unwrap();
    s.execute(req("DROP TABLE IF EXISTS public.tn_affected"), &NullSink)
        .await
        .unwrap();
    s.execute(
        req("CREATE TABLE public.tn_affected (id int primary key)"),
        &NullSink,
    )
    .await
    .unwrap();

    let ins = s
        .execute(
            req("INSERT INTO public.tn_affected VALUES (1), (2), (3)"),
            &NullSink,
        )
        .await
        .unwrap();
    assert_eq!(ins.rows_affected, Some(3), "INSERT must report its count");

    let upd = s
        .execute(
            req("UPDATE public.tn_affected SET id = id + 10 WHERE id > 1"),
            &NullSink,
        )
        .await
        .unwrap();
    assert_eq!(upd.rows_affected, Some(2), "UPDATE must report its count");

    let miss = s
        .execute(
            req("UPDATE public.tn_affected SET id = 99 WHERE id = 4242"),
            &NullSink,
        )
        .await
        .unwrap();
    assert_eq!(
        miss.rows_affected,
        Some(0),
        "a write that hit nothing must report 0 — this is the value the edit guard turns into a refusal"
    );

    let del = s
        .execute(req("DELETE FROM public.tn_affected"), &NullSink)
        .await
        .unwrap();
    assert_eq!(del.rows_affected, Some(3), "DELETE must report its count");

    s.execute(req("DROP TABLE public.tn_affected"), &NullSink)
        .await
        .unwrap();
}

/// The isolation level must reach the server.
///
/// `begin(_options)` discarded them: `IsolationLevel`, `read_only` and
/// `deferrable` were a complete API wired to nothing, and every transaction ran
/// at the server default. Someone asking for SERIALIZABLE got READ COMMITTED
/// and no sign of it. Unit tests cover the string; only the server can say it
/// was honoured.
#[tokio::test]
#[ignore = "requires live PostgreSQL"]
async fn isolation_level_reaches_the_server() {
    let mut s = PostgresDriver
        .connect_concrete(test_config())
        .await
        .unwrap();

    s.begin(TransactionOptions {
        isolation: Some(IsolationLevel::Serializable),
        read_only: false,
        deferrable: false,
    })
    .await
    .expect("begin serializable");

    let mut sink = CollectSink::default();
    s.execute(req("SHOW transaction_isolation"), &sink)
        .await
        .unwrap();
    let level = {
        let rows = sink.rows.lock().unwrap();
        text_of(&rows[0][0])
    };
    assert_eq!(
        level, "serializable",
        "the level the caller asked for must be the level in force"
    );
    s.rollback().await.unwrap();

    // And a transaction that asks for nothing still gets the server default,
    // rather than inheriting the last one.
    s.begin(TransactionOptions::default()).await.unwrap();
    sink = CollectSink::default();
    s.execute(req("SHOW transaction_isolation"), &sink)
        .await
        .unwrap();
    let dflt = {
        let rows = sink.rows.lock().unwrap();
        text_of(&rows[0][0])
    };
    assert_eq!(dflt, "read committed");
    s.rollback().await.unwrap();
}

/// A READ ONLY transaction refuses writes, without the whole session being
/// read-only.
#[tokio::test]
#[ignore = "requires live PostgreSQL"]
async fn a_read_only_transaction_refuses_writes() {
    let mut s = PostgresDriver
        .connect_concrete(test_config())
        .await
        .unwrap();
    s.begin(TransactionOptions {
        isolation: None,
        read_only: true,
        deferrable: false,
    })
    .await
    .expect("begin read only");

    let err = s
        .execute(req("CREATE TEMP TABLE tn_ro_tx (id int)"), &NullSink)
        .await
        .expect_err("a write must be refused in a READ ONLY transaction");
    assert!(
        format!("{err:?}").to_lowercase().contains("read-only")
            || format!("{err:?}").to_lowercase().contains("read only"),
        "expected a read-only refusal, got {err:?}"
    );
    s.rollback().await.unwrap();
}

/// An array element containing a comma must survive the round trip.
///
/// Elements were joined with a bare comma, so `{"a,b", "c"}` rendered as
/// `{a,b,c}` — three elements where there were two, and no way to tell.
#[tokio::test]
#[ignore = "requires live PostgreSQL"]
async fn array_elements_are_quoted_like_postgres_does() {
    // What PostgreSQL itself prints, as the reference.
    let want = text_of(&first_row("SELECT ARRAY['a,b', 'c']::text[]").await[0]);
    assert_eq!(want, r#"{"a,b",c}"#, "this is what array_out produces");

    let cases = [
        ("SELECT ARRAY['a,b','c']::text[]", r#"{"a,b",c}"#),
        (
            "SELECT ARRAY['plain','words here']::text[]",
            r#"{plain,"words here"}"#,
        ),
        ("SELECT ARRAY['NULL', NULL]::text[]", r#"{"NULL",NULL}"#),
        ("SELECT ARRAY['','x']::text[]", r#"{"",x}"#),
        // Numbers never need quoting; the rule costs nothing where it is not used.
        ("SELECT ARRAY[1,2,3]::int4[]", "{1,2,3}"),
    ];
    for (sql, want) in cases {
        assert_eq!(text_of(&first_row(sql).await[0]), want, "for {sql}");
    }
}

/// `render_raw` decides text-vs-hex from `Type::kind()`. The unit tests build
/// `Kind::Enum` by hand, which proves the branch but not that tokio-postgres
/// ever *reports* `Kind::Enum` for a real column — and if it reported
/// `Kind::Simple` instead, every enum in the product would silently become hex.
/// Only a real server can answer that, so it is asked here.
#[tokio::test]
#[ignore = "requires live PostgreSQL"]
async fn unknown_types_render_from_the_type_not_from_a_guess() {
    let mut s = PostgresDriver
        .connect_concrete(test_config())
        .await
        .unwrap();

    s.execute(req("DROP TYPE IF EXISTS tn_mood CASCADE"), &NullSink)
        .await
        .unwrap();
    s.execute(
        req("CREATE TYPE tn_mood AS ENUM ('happy', 'sad')"),
        &NullSink,
    )
    .await
    .unwrap();

    // An enum must survive as its label.
    let sink = CollectSink::default();
    s.execute(req("SELECT 'happy'::tn_mood"), &sink)
        .await
        .unwrap();
    let cell = sink.rows.lock().unwrap()[0][0].clone();
    assert_eq!(
        cell,
        CellValue::Text("happy".to_string()),
        "an enum must render as its label — if this is hex, Kind::Enum is not \
         reported and binary_is_text needs another way to recognise enums"
    );

    // ...and money must never be mistaken for text, whatever its bytes.
    let sink = CollectSink::default();
    s.execute(req("SELECT 1.00::money"), &sink).await.unwrap();
    let cell = sink.rows.lock().unwrap()[0][0].clone();
    assert!(
        matches!(cell, CellValue::Other { .. }),
        "money must not be rendered as text, got {cell:?}"
    );

    s.execute(req("DROP TYPE IF EXISTS tn_mood CASCADE"), &NullSink)
        .await
        .unwrap();
}
