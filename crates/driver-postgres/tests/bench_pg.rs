//! Timing runs against a live PostgreSQL database (see docs/benchmarks).
//!
//! Not a test of correctness and not run by default:
//!     TUPLENEST_TEST_PG_DB=shop cargo test --release -p tuplenest-driver-postgres \
//!         --test bench_pg -- --ignored --nocapture --test-threads=1
//!
//! Connection comes from the same TUPLENEST_TEST_PG_* variables as
//! `live_pg.rs`. The database must have a table `orders` with at least 20,001
//! rows (the dataset in docs/benchmarks/README.md has 250,000).
//!
//! Every measurement is repeated `TUPLENEST_BENCH_RUNS` times (default 10)
//! after one warm-up run, and reported as median / min / max.

use std::collections::BTreeMap;
use std::io::Write as _;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use tuplenest_driver_api::*;
use tuplenest_driver_postgres::PostgresDriver;
use tuplenest_result_stream::RowStore;

/// The desktop app's result-store caps (apps/desktop/src-tauri/src/pg.rs,
/// RESULT_STORE_CAP and RESULT_STORE_BYTES).
const ROW_CAP: usize = 20_000;
const BYTE_CAP: usize = 128 * 1024 * 1024;

fn config() -> ConnectionConfig {
    ConnectionConfig {
        driver_id: "postgres".into(),
        name: "bench".into(),
        environment: Environment::Dev,
        read_only: true,
        host: std::env::var("TUPLENEST_TEST_PG_HOST").unwrap_or_else(|_| "localhost".into()),
        port: std::env::var("TUPLENEST_TEST_PG_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(5432),
        database: std::env::var("TUPLENEST_TEST_PG_DB").unwrap_or_else(|_| "shop".into()),
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

fn runs() -> usize {
    std::env::var("TUPLENEST_BENCH_RUNS")
        .ok()
        .and_then(|r| r.parse().ok())
        .unwrap_or(10)
}

fn req(sql: &str, row_limit: u64) -> QueryRequest {
    QueryRequest {
        execution_id: ExecutionId::new(),
        sql: sql.into(),
        params: vec![],
        row_limit,
    }
}

fn report(name: &str, mut ms: Vec<f64>) {
    ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = ms.len();
    let median = if n % 2 == 1 {
        ms[n / 2]
    } else {
        (ms[n / 2 - 1] + ms[n / 2]) / 2.0
    };
    println!(
        "BENCH\t{name}\tmedian {median:.2} ms\tmin {:.2}\tmax {:.2}\tn={n}",
        ms[0],
        ms[n - 1]
    );
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

/// Counts rows and notes when the first batch arrived. Decoding happens in
/// the driver; nothing is kept.
struct CountSink {
    started: Instant,
    first_batch: Mutex<Option<Duration>>,
    rows: Mutex<u64>,
}

impl CountSink {
    fn new() -> Self {
        Self {
            started: Instant::now(),
            first_batch: Mutex::new(None),
            rows: Mutex::new(0),
        }
    }
}

#[async_trait]
impl BatchSink for CountSink {
    async fn deliver(&self, batch: RowBatch) -> Result<(), Box<DriverError>> {
        self.first_batch
            .lock()
            .unwrap()
            .get_or_insert_with(|| self.started.elapsed());
        *self.rows.lock().unwrap() += batch.rows.len() as u64;
        Ok(())
    }
}

/// Approximates the desktop app's StoreSink: each row is written as a JSON
/// array of its cells and pushed into a RowStore with the app's caps; rows
/// past the cap are only counted. The app's own row writer lives in the app
/// crate; this one writes the same shapes for the column types used here
/// (bigint, text, numeric, timestamptz).
struct StoreSink {
    store: Mutex<RowStore>,
}

impl StoreSink {
    fn new() -> Self {
        Self {
            store: Mutex::new(RowStore::with_budget(ROW_CAP, BYTE_CAP)),
        }
    }
}

fn write_cell(buf: &mut Vec<u8>, c: &CellValue) {
    match c {
        CellValue::Null => buf.extend_from_slice(b"null"),
        CellValue::Bool(b) => write!(buf, "{b}").unwrap(),
        CellValue::Int(i) => write!(buf, "{i}").unwrap(),
        CellValue::Float(f) => serde_json::to_writer(&mut *buf, f).unwrap(),
        CellValue::Text(s) => serde_json::to_writer(&mut *buf, s).unwrap(),
        CellValue::Json(j) => buf.extend_from_slice(j.get().as_bytes()),
        CellValue::Bytes(b) => serde_json::to_writer(&mut *buf, &b.len()).unwrap(),
        CellValue::Other(o) => serde_json::to_writer(&mut *buf, &o.rendered).unwrap(),
    }
}

#[async_trait]
impl BatchSink for StoreSink {
    fn wants_rows(&self) -> bool {
        !self.store.lock().unwrap().is_full()
    }

    async fn deliver(&self, batch: RowBatch) -> Result<(), Box<DriverError>> {
        let mut store = self.store.lock().unwrap();
        let mut buf = Vec::new();
        for row in batch.rows {
            if store.is_full() {
                store.skip();
                continue;
            }
            buf.clear();
            buf.push(b'[');
            for (i, c) in row.iter().enumerate() {
                if i > 0 {
                    buf.push(b',');
                }
                write_cell(&mut buf, c);
            }
            buf.push(b']');
            store.push(std::str::from_utf8(&buf).unwrap());
        }
        Ok(())
    }
}

#[tokio::test]
#[ignore = "benchmark: requires live PostgreSQL with the benchmark dataset"]
async fn bench_pg_connect() {
    let mut t = vec![];
    for i in 0..=runs() {
        let started = Instant::now();
        let s = PostgresDriver.connect_concrete(config()).await.unwrap();
        if i > 0 {
            t.push(ms(started.elapsed()));
        }
        drop(s);
    }
    report("pg connect (TCP localhost, no TLS)", t);
}

#[tokio::test]
#[ignore = "benchmark: requires live PostgreSQL with the benchmark dataset"]
async fn bench_pg_result_streaming() {
    let mut s = PostgresDriver.connect_concrete(config()).await.unwrap();

    // 1. Exactly 20,000 rows, every row read, decoded and counted.
    let (mut total, mut first) = (vec![], vec![]);
    for i in 0..=runs() {
        let sink = CountSink::new();
        let summary = s
            .execute(req("SELECT * FROM orders LIMIT 20000", 0), &sink)
            .await
            .unwrap();
        assert_eq!(summary.rows_returned, 20_000);
        if i > 0 {
            total.push(ms(sink.started.elapsed()));
            first.push(ms(sink.first_batch.lock().unwrap().unwrap()));
        }
    }
    report("pg 20,000 rows (LIMIT 20000), decode only: total", total);
    report(
        "pg 20,000 rows (LIMIT 20000), decode only: first batch",
        first,
    );

    // 2. The app's path: unbounded SELECT, row_limit = cap, rows stored.
    let (mut total, mut stored) = (vec![], (0, 0));
    for i in 0..=runs() {
        let sink = StoreSink::new();
        let started = Instant::now();
        let summary = s
            .execute(req("SELECT * FROM orders", ROW_CAP as u64), &sink)
            .await
            .unwrap();
        let took = started.elapsed();
        assert_eq!(summary.rows_returned, ROW_CAP as u64);
        assert!(
            summary.more_rows,
            "the table must have more rows than the cap"
        );
        let store = sink.store.lock().unwrap();
        assert_eq!(store.stored(), ROW_CAP);
        stored = (store.bytes(), store.ram_bytes());
        drop(store);
        if i > 0 {
            total.push(ms(took));
        }
    }
    report(
        "pg SELECT * FROM orders, row_limit 20,000, stored in RowStore: until cap hit",
        total,
    );
    println!(
        "INFO\tRowStore at cap: {:.1} MB row text, {:.1} MB compressed in RAM",
        stored.0 as f64 / 1_048_576.0,
        stored.1 as f64 / 1_048_576.0
    );

    // 3. Reference: the whole table with no row_limit, decode and count only.
    let mut total = vec![];
    let mut rows = 0;
    for i in 0..=runs() {
        let sink = CountSink::new();
        let summary = s
            .execute(req("SELECT * FROM orders", 0), &sink)
            .await
            .unwrap();
        rows = summary.rows_returned;
        if i > 0 {
            total.push(ms(sink.started.elapsed()));
        }
    }
    report(
        &format!("pg SELECT * FROM orders, no row_limit ({rows} rows), decode only"),
        total,
    );
}

#[tokio::test]
#[ignore = "benchmark: requires live PostgreSQL with the benchmark dataset"]
async fn bench_pg_schema_discovery() {
    let s = PostgresDriver.connect_concrete(config()).await.unwrap();
    let mut walk = vec![];
    let mut counts = (0, 0);
    for i in 0..=runs() {
        let started = Instant::now();
        s.metadata(MetadataRequest::ServerInfo).await.unwrap();
        let schemas: Vec<String> = serde_json::from_value(
            s.metadata(MetadataRequest::ListSchemas)
                .await
                .unwrap()
                .payload,
        )
        .unwrap();
        let mut objects = 0;
        for schema in &schemas {
            let list = s
                .metadata(MetadataRequest::ListObjects {
                    schema: schema.clone(),
                })
                .await
                .unwrap()
                .payload;
            for o in list.as_array().unwrap() {
                objects += 1;
                s.metadata(MetadataRequest::DescribeObject {
                    schema: schema.clone(),
                    name: o["name"].as_str().unwrap().to_string(),
                })
                .await
                .unwrap();
            }
            s.metadata(MetadataRequest::Relationships {
                schema: schema.clone(),
            })
            .await
            .unwrap();
        }
        counts = (schemas.len(), objects);
        if i > 0 {
            walk.push(ms(started.elapsed()));
        }
    }
    report(
        &format!(
            "pg schema walk: ServerInfo + ListSchemas + ListObjects/Relationships per schema \
             + DescribeObject per object ({} schemas, {} objects)",
            counts.0, counts.1
        ),
        walk,
    );

    let mut list = vec![];
    for i in 0..=runs() {
        let started = Instant::now();
        s.metadata(MetadataRequest::ListObjects {
            schema: "public".into(),
        })
        .await
        .unwrap();
        if i > 0 {
            list.push(ms(started.elapsed()));
        }
    }
    report("pg ListObjects public", list);

    let mut describe = vec![];
    for i in 0..=runs() {
        let started = Instant::now();
        s.metadata(MetadataRequest::DescribeObject {
            schema: "public".into(),
            name: "orders".into(),
        })
        .await
        .unwrap();
        if i > 0 {
            describe.push(ms(started.elapsed()));
        }
    }
    report("pg DescribeObject public.orders", describe);
}

#[tokio::test]
#[ignore = "benchmark: requires live PostgreSQL with the benchmark dataset"]
async fn bench_pg_cancel_latency() {
    let mut s = PostgresDriver.connect_concrete(config()).await.unwrap();
    let mut latency = vec![];
    for i in 0..=runs() {
        let handle = s.cancel_handle();
        let (tx, rx) = tokio::sync::oneshot::channel();
        let canceller = tokio::spawn(async move {
            // Let the statement reach the server and start sleeping.
            tokio::time::sleep(Duration::from_millis(500)).await;
            let at = Instant::now();
            handle.cancel().await.unwrap();
            tx.send(at).unwrap();
        });
        let err = s
            .execute(req("SELECT pg_sleep(30)", 0), &NullSink)
            .await
            .expect_err("must be cancelled");
        let returned = Instant::now();
        canceller.await.unwrap();
        let asked = rx.await.unwrap();
        assert_eq!(err.category, ErrorCategory::Cancelled, "{err:?}");
        if i > 0 {
            latency.push(ms(returned - asked));
        }
    }
    report(
        "pg cancel: SELECT pg_sleep(30), cancel() called -> execute returns",
        latency,
    );
}

struct NullSink;

#[async_trait]
impl BatchSink for NullSink {
    async fn deliver(&self, _batch: RowBatch) -> Result<(), Box<DriverError>> {
        Ok(())
    }
}
