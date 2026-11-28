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
//! after one warm-up run, and reported as median, p95, p99, min and max.

use std::collections::BTreeMap;
use std::io::Write as _;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use tuplenest_driver_api::*;
use tuplenest_driver_postgres::{PostgresDriver, PostgresSession};
use tuplenest_result_stream::RowStore;

/// The desktop app's result-store caps (apps/desktop/src-tauri/src/pg.rs,
/// RESULT_STORE_CAP and RESULT_STORE_BYTES).
const ROW_CAP: usize = 20_000;
const BYTE_CAP: usize = 128 * 1024 * 1024;

/// CI runs this crate's ignored tests against a database without the
/// benchmark dataset, so the benchmarks also need an explicit opt-in.
fn enabled() -> bool {
    std::env::var_os("TUPLENEST_BENCH_PG").is_some()
}

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
    // Nearest-rank percentiles; with fewer than 20 samples p95 and p99 are
    // simply the maximum, so read them only from a run with enough repeats.
    let pct = |p: f64| ms[((p * n as f64).ceil() as usize).clamp(1, n) - 1];
    println!(
        "BENCH\t{name}\tmedian {median:.2} ms\tp95 {:.2}\tp99 {:.2}\tmin {:.2}\tmax {:.2}\tn={n}",
        pct(0.95),
        pct(0.99),
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
#[ignore = "benchmark: requires TUPLENEST_BENCH_PG and the benchmark dataset"]
async fn bench_pg_connect() {
    if !enabled() {
        return;
    }
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
#[ignore = "benchmark: requires TUPLENEST_BENCH_PG and the benchmark dataset"]
async fn bench_pg_result_streaming() {
    if !enabled() {
        return;
    }
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
#[ignore = "benchmark: requires TUPLENEST_BENCH_PG and the benchmark dataset"]
async fn bench_pg_schema_discovery() {
    if !enabled() {
        return;
    }
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
#[ignore = "benchmark: requires TUPLENEST_BENCH_PG and the benchmark dataset"]
async fn bench_pg_cancel_latency() {
    if !enabled() {
        return;
    }
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

/// Keeps the first cell of the first row, as text.
#[derive(Default)]
struct FirstCell(Mutex<Option<String>>);

#[async_trait]
impl BatchSink for FirstCell {
    async fn deliver(&self, batch: RowBatch) -> Result<(), Box<DriverError>> {
        let mut first = self.0.lock().unwrap();
        if first.is_none() {
            if let Some(CellValue::Text(t)) = batch.rows.first().and_then(|r| r.first()) {
                *first = Some(t.to_string());
            }
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Large schemas. Needs TUPLENEST_BENCH_PG and TUPLENEST_BENCH_PG_LARGE: it
// creates a throwaway database per size (CREATE DATABASE through the database
// named by TUPLENEST_BENCH_PG_ADMIN_DB, default `postgres`), fills it with
// tables, measures and drops it again. The benchmark dataset is not touched.
// ---------------------------------------------------------------------------

fn large_enabled() -> bool {
    enabled() && std::env::var_os("TUPLENEST_BENCH_PG_LARGE").is_some()
}

/// Table counts to build, `TUPLENEST_BENCH_PG_LARGE_SIZES` (default 1000,10000).
fn large_sizes() -> Vec<usize> {
    std::env::var("TUPLENEST_BENCH_PG_LARGE_SIZES")
        .unwrap_or_else(|_| "1000,10000".into())
        .split(',')
        .map(|s| s.trim().parse().expect("TUPLENEST_BENCH_PG_LARGE_SIZES"))
        .collect()
}

/// Repetitions of the full walk, which takes seconds at 10,000 tables.
fn walk_runs() -> usize {
    std::env::var("TUPLENEST_BENCH_WALK_RUNS")
        .ok()
        .and_then(|r| r.parse().ok())
        .unwrap_or(5)
}

fn writable(database: &str) -> ConnectionConfig {
    let mut c = config();
    c.read_only = false;
    c.database = database.into();
    c
}

async fn exec(s: &mut PostgresSession, sql: &str) {
    s.execute(req(sql, 0), &NullSink)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e:?}"));
}

/// ServerInfo, ListSchemas, then per schema ListObjects, DescribeObject per
/// object and Relationships: the same walk as `bench_pg_schema_discovery`.
async fn walk(s: &PostgresSession) -> (usize, usize) {
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
    (schemas.len(), objects)
}

/// Times one metadata request; also returns the size of its JSON payload.
async fn time_metadata(s: &PostgresSession, request: MetadataRequest) -> (Vec<f64>, usize) {
    let mut t = vec![];
    let mut bytes = 0;
    for i in 0..=runs() {
        let started = Instant::now();
        let r = s.metadata(request.clone()).await.unwrap();
        if i > 0 {
            t.push(ms(started.elapsed()));
        }
        bytes = r.payload.to_string().len();
    }
    (t, bytes)
}

/// Builds `n` tables named t00001..: `id bigint` primary key, `parent_id`,
/// `name text`, `amount numeric(12,2)`, `created_at timestamptz`. Every
/// even-numbered table has a foreign key from `parent_id` to the table before
/// it and an index on `parent_id`. Created 200 tables per statement so one
/// transaction never holds more locks than a default server allows.
async fn build_tables(s: &mut PostgresSession, n: usize) {
    for start in (1..=n).step_by(200) {
        let end = (start + 199).min(n);
        exec(
            s,
            &format!(
                "DO $$ DECLARE t text; p text; BEGIN
                   FOR i IN {start}..{end} LOOP
                     t := 't' || lpad(i::text, 5, '0');
                     p := 't' || lpad((i - 1)::text, 5, '0');
                     EXECUTE format('CREATE TABLE %I (id bigint PRIMARY KEY, parent_id bigint %s,
                       name text NOT NULL, amount numeric(12,2),
                       created_at timestamptz NOT NULL DEFAULT now())', t,
                       CASE WHEN i % 2 = 0 THEN format('REFERENCES %I (id)', p) ELSE '' END);
                     IF i % 2 = 0 THEN
                       EXECUTE format('CREATE INDEX ON %I (parent_id)', t);
                     END IF;
                   END LOOP;
                 END $$"
            ),
        )
        .await;
    }
}

#[tokio::test]
#[ignore = "benchmark: requires TUPLENEST_BENCH_PG and TUPLENEST_BENCH_PG_LARGE"]
async fn bench_pg_large_schema() {
    use futures_util::FutureExt as _;
    if !large_enabled() {
        return;
    }
    let admin_db =
        std::env::var("TUPLENEST_BENCH_PG_ADMIN_DB").unwrap_or_else(|_| "postgres".into());
    for n in large_sizes() {
        let db = format!("tuplenest_bench_{n}_tables");
        let mut admin = PostgresDriver
            .connect_concrete(writable(&admin_db))
            .await
            .unwrap();
        exec(
            &mut admin,
            &format!("DROP DATABASE IF EXISTS {db} WITH (FORCE)"),
        )
        .await;
        exec(&mut admin, &format!("CREATE DATABASE {db}")).await;

        let measured = std::panic::AssertUnwindSafe(async {
            let started = Instant::now();
            let mut w = PostgresDriver
                .connect_concrete(writable(&db))
                .await
                .unwrap();
            build_tables(&mut w, n).await;
            exec(&mut w, "ANALYZE").await;
            drop(w);
            println!(
                "INFO\tbuilt {n} tables ({} foreign keys, {} extra indexes) in {:.1} s",
                n / 2,
                n / 2,
                started.elapsed().as_secs_f64()
            );

            let mut c = config();
            c.database = db.clone();
            let s = PostgresDriver.connect_concrete(c).await.unwrap();
            let mid = format!("t{:05}", n / 2);

            let (t, _) = time_metadata(&s, MetadataRequest::ListSchemas).await;
            report(&format!("pg {n} tables: ListSchemas"), t);
            let (t, bytes) = time_metadata(
                &s,
                MetadataRequest::ListObjects {
                    schema: "public".into(),
                },
            )
            .await;
            report(&format!("pg {n} tables: ListObjects public"), t);
            println!(
                "INFO\tpg {n} tables: ListObjects payload {:.2} MB JSON",
                bytes as f64 / 1_048_576.0
            );
            let (t, _) = time_metadata(
                &s,
                MetadataRequest::DescribeObject {
                    schema: "public".into(),
                    name: mid.clone(),
                },
            )
            .await;
            report(&format!("pg {n} tables: DescribeObject public.{mid}"), t);
            let (t, bytes) = time_metadata(
                &s,
                MetadataRequest::Relationships {
                    schema: "public".into(),
                },
            )
            .await;
            report(&format!("pg {n} tables: Relationships public"), t);
            println!(
                "INFO\tpg {n} tables: Relationships payload {:.2} MB JSON",
                bytes as f64 / 1_048_576.0
            );

            let mut t = vec![];
            let mut counts = (0, 0);
            for i in 0..=walk_runs() {
                let started = Instant::now();
                counts = walk(&s).await;
                if i > 0 {
                    t.push(ms(started.elapsed()));
                }
            }
            report(
                &format!(
                    "pg {n} tables: full walk ({} schemas, {} objects, {} requests)",
                    counts.0,
                    counts.1,
                    2 + 2 * counts.0 + counts.1
                ),
                t,
            );
        })
        .catch_unwind()
        .await;

        exec(
            &mut admin,
            &format!("DROP DATABASE IF EXISTS {db} WITH (FORCE)"),
        )
        .await;
        if let Err(panic) = measured {
            std::panic::resume_unwind(panic);
        }
    }
}

// ---------------------------------------------------------------------------
// Added latency. Needs TUPLENEST_BENCH_PG and TUPLENEST_BENCH_PG_LATENCY. The
// driver connects through a TCP proxy on 127.0.0.1 that holds every chunk of
// bytes for half the round-trip time in each direction before passing it on.
// Chunks are delayed, not serialised, so bandwidth is not limited: this models
// distance, not a slow link. The cancel request goes through the proxy too.
// ---------------------------------------------------------------------------

fn latency_enabled() -> bool {
    enabled() && std::env::var_os("TUPLENEST_BENCH_PG_LATENCY").is_some()
}

/// Round-trip times to add, `TUPLENEST_BENCH_PG_RTTS` in ms (default 0,20,80).
fn rtts() -> Vec<u64> {
    std::env::var("TUPLENEST_BENCH_PG_RTTS")
        .unwrap_or_else(|_| "0,20,80".into())
        .split(',')
        .map(|s| s.trim().parse().expect("TUPLENEST_BENCH_PG_RTTS"))
        .collect()
}

async fn delayed_pipe(
    mut from: tokio::net::tcp::OwnedReadHalf,
    mut to: tokio::net::tcp::OwnedWriteHalf,
    one_way: Duration,
) {
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(tokio::time::Instant, Vec<u8>)>();
    let writer = tokio::spawn(async move {
        while let Some((at, bytes)) = rx.recv().await {
            // tokio's timer has 1 ms resolution; at 0 ms skip it, so the
            // baseline is the proxy hop alone.
            if !one_way.is_zero() {
                tokio::time::sleep_until(at + one_way).await;
            }
            if to.write_all(&bytes).await.is_err() {
                break;
            }
        }
        let _ = to.shutdown().await;
    });
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        match from.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if tx
                    .send((tokio::time::Instant::now(), buf[..n].to_vec()))
                    .is_err()
                {
                    break;
                }
            }
        }
    }
    drop(tx);
    let _ = writer.await;
}

/// Starts a proxy to `host:port` that adds `rtt` of round-trip time and
/// returns its local port. It runs until the test's runtime shuts down.
async fn latency_proxy(host: String, port: u16, rtt: Duration) -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let local = listener.local_addr().unwrap().port();
    let one_way = rtt / 2;
    tokio::spawn(async move {
        while let Ok((client, _)) = listener.accept().await {
            let server = tokio::net::TcpStream::connect((host.as_str(), port))
                .await
                .unwrap();
            client.set_nodelay(true).unwrap();
            server.set_nodelay(true).unwrap();
            let (cr, cw) = client.into_split();
            let (sr, sw) = server.into_split();
            tokio::spawn(delayed_pipe(cr, sw, one_way));
            tokio::spawn(delayed_pipe(sr, cw, one_way));
        }
    });
    local
}

fn latency_runs() -> usize {
    std::env::var("TUPLENEST_BENCH_LATENCY_RUNS")
        .ok()
        .and_then(|r| r.parse().ok())
        .unwrap_or(20)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "benchmark: requires TUPLENEST_BENCH_PG and TUPLENEST_BENCH_PG_LATENCY"]
async fn bench_pg_latency() {
    if !latency_enabled() {
        return;
    }
    let base = config();
    let runs = latency_runs();
    for rtt in rtts() {
        let port = latency_proxy(base.host.clone(), base.port, Duration::from_millis(rtt)).await;
        // Prefer negotiates TLS when the server offers it, without verifying
        // the certificate; whether it was used is checked below, not assumed.
        for tls in [TlsMode::Disabled, TlsMode::Prefer] {
            let label = format!(
                "pg +{rtt} ms RTT, {}",
                if tls == TlsMode::Disabled {
                    "no TLS"
                } else {
                    "TLS"
                }
            );
            let mut c = base.clone();
            c.host = "127.0.0.1".into();
            c.port = port;
            c.tls_mode = tls;

            let mut t = vec![];
            for i in 0..=runs {
                let started = Instant::now();
                let s = PostgresDriver.connect_concrete(c.clone()).await.unwrap();
                if i > 0 {
                    t.push(ms(started.elapsed()));
                }
                drop(s);
            }
            report(&format!("{label}: connect"), t);

            let mut s = PostgresDriver.connect_concrete(c.clone()).await.unwrap();
            let probe = FirstCell::default();
            s.execute(
                req(
                    "SELECT ssl::text FROM pg_stat_ssl WHERE pid = pg_backend_pid()",
                    0,
                ),
                &probe,
            )
            .await
            .unwrap();
            let ssl = probe.0.lock().unwrap().clone().unwrap_or_default();
            println!("INFO\t{label}: pg_stat_ssl.ssl = {ssl}");

            let mut t = vec![];
            for i in 0..=runs {
                let started = Instant::now();
                s.execute(req("SELECT 1", 0), &NullSink).await.unwrap();
                if i > 0 {
                    t.push(ms(started.elapsed()));
                }
            }
            report(&format!("{label}: SELECT 1"), t);

            let mut t = vec![];
            for i in 0..=runs {
                let sink = StoreSink::new();
                let started = Instant::now();
                let summary = s
                    .execute(req("SELECT * FROM orders", ROW_CAP as u64), &sink)
                    .await
                    .unwrap();
                assert_eq!(summary.rows_returned, ROW_CAP as u64);
                if i > 0 {
                    t.push(ms(started.elapsed()));
                }
            }
            report(
                &format!("{label}: SELECT * FROM orders, row_limit 20,000, stored"),
                t,
            );

            let mut t = vec![];
            let mut counts = (0, 0);
            for i in 0..=runs {
                let started = Instant::now();
                counts = walk(&s).await;
                if i > 0 {
                    t.push(ms(started.elapsed()));
                }
            }
            report(
                &format!(
                    "{label}: schema walk ({} schemas, {} objects)",
                    counts.0, counts.1
                ),
                t,
            );

            let mut t = vec![];
            for i in 0..=runs {
                let handle = s.cancel_handle();
                let (tx, rx) = tokio::sync::oneshot::channel();
                let canceller = tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(500 + rtt)).await;
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
                    t.push(ms(returned - asked));
                }
            }
            report(&format!("{label}: cancel -> execute returns"), t);
        }
    }
}

// ---------------------------------------------------------------------------
// Driver soak. Needs TUPLENEST_BENCH_PG and TUPLENEST_BENCH_SOAK_SECS. Repeats
// a fixed workload on the benchmark dataset for that many seconds and samples
// this test process's resident size and open file descriptors every
// TUPLENEST_BENCH_SOAK_INTERVAL seconds (default 30), printed and, with
// TUPLENEST_BENCH_SOAK_CSV, written as CSV.
//
// One iteration: the app's 20,000-row read stored in a RowStore, a full schema
// walk and a `SELECT 1`; every 10th iteration also a cancel of `pg_sleep` and a
// fresh connection (the old one dropped).
// ---------------------------------------------------------------------------

fn resident_mb() -> f64 {
    let out = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse::<f64>()
        .unwrap_or(f64::NAN)
        / 1024.0
}

fn open_fds() -> usize {
    std::fs::read_dir("/dev/fd").map(|d| d.count()).unwrap_or(0)
}

#[tokio::test]
#[ignore = "benchmark: requires TUPLENEST_BENCH_PG and TUPLENEST_BENCH_SOAK_SECS"]
async fn bench_pg_soak() {
    if !enabled() {
        return;
    }
    let Some(secs) = std::env::var("TUPLENEST_BENCH_SOAK_SECS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
    else {
        return;
    };
    let interval = std::env::var("TUPLENEST_BENCH_SOAK_INTERVAL")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(30);
    let mut csv = std::env::var("TUPLENEST_BENCH_SOAK_CSV")
        .ok()
        .map(|p| std::fs::File::create(p).unwrap());
    let mut line = |l: String| {
        println!("SOAK\t{l}");
        if let Some(f) = csv.as_mut() {
            writeln!(f, "{l}").unwrap();
        }
    };
    line("elapsed_s,iterations,resident_mb,open_fds,iteration_median_ms,iteration_max_ms,cancels_missed".into());

    let started = Instant::now();
    let mut s = PostgresDriver.connect_concrete(config()).await.unwrap();
    let mut iterations = 0u64;
    let mut missed = 0u64;
    let mut window: Vec<f64> = vec![];
    let mut next_sample = Duration::ZERO;
    loop {
        let done = started.elapsed() >= Duration::from_secs(secs);
        if done || started.elapsed() >= next_sample {
            window.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let (med, max) = match window.len() {
                0 => (f64::NAN, f64::NAN),
                n => (window[n / 2], window[n - 1]),
            };
            line(format!(
                "{:.0},{iterations},{:.1},{},{med:.1},{max:.1},{missed}",
                started.elapsed().as_secs_f64(),
                resident_mb(),
                open_fds()
            ));
            window.clear();
            next_sample += Duration::from_secs(interval);
        }
        if done {
            break;
        }

        let t = Instant::now();
        let sink = StoreSink::new();
        let summary = s
            .execute(req("SELECT * FROM orders", ROW_CAP as u64), &sink)
            .await
            .unwrap();
        assert_eq!(summary.rows_returned, ROW_CAP as u64);
        drop(sink);
        walk(&s).await;
        s.execute(req("SELECT 1", 0), &NullSink).await.unwrap();
        if iterations % 10 == 9 {
            let handle = s.cancel_handle();
            // The same 500 ms head start as bench_pg_cancel_latency: a cancel
            // that arrives before the statement is running cancels nothing.
            // That is counted, not fatal, and pg_sleep is short so it costs 5 s.
            let canceller = tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(500)).await;
                handle.cancel().await.unwrap();
            });
            match s.execute(req("SELECT pg_sleep(5)", 0), &NullSink).await {
                Err(err) => assert_eq!(err.category, ErrorCategory::Cancelled, "{err:?}"),
                Ok(_) => missed += 1,
            }
            canceller.await.unwrap();
            drop(s);
            s = PostgresDriver.connect_concrete(config()).await.unwrap();
        }
        iterations += 1;
        window.push(ms(t.elapsed()));
    }
}
