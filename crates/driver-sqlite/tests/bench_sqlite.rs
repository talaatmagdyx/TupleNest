//! Timing runs against a SQLite file (see docs/benchmarks).
//!
//! Not a test of correctness and not run by default:
//!     TUPLENEST_BENCH_SQLITE=/path/to/analytics.sqlite \
//!         cargo test --release -p tuplenest-driver-sqlite --test bench_sqlite \
//!         -- --ignored --nocapture --test-threads=1
//!
//! The file must have a table `events` with at least 20,001 rows (the
//! dataset in docs/benchmarks/README.md has 50,000). It is opened read-only.
//!
//! Every measurement is repeated `TUPLENEST_BENCH_RUNS` times (default 10)
//! after one warm-up run, and reported as median, p95, p99, min and max.

use std::collections::BTreeMap;
use std::io::Write as _;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use tuplenest_driver_api::*;
use tuplenest_driver_sqlite::SqliteDriver;
use tuplenest_result_stream::RowStore;

/// The desktop app's result-store caps (apps/desktop/src-tauri/src/pg.rs,
/// RESULT_STORE_CAP and RESULT_STORE_BYTES).
const ROW_CAP: usize = 20_000;
const BYTE_CAP: usize = 128 * 1024 * 1024;

fn config() -> Option<ConnectionConfig> {
    let Ok(path) = std::env::var("TUPLENEST_BENCH_SQLITE") else {
        eprintln!("skipping: set TUPLENEST_BENCH_SQLITE to the benchmark database file");
        return None;
    };
    Some(ConnectionConfig {
        driver_id: "sqlite".into(),
        name: "bench".into(),
        environment: Environment::Dev,
        read_only: true,
        host: String::new(),
        port: 0,
        database: path,
        username: String::new(),
        secret_ref: None,
        tls_mode: TlsMode::Disabled,
        tls_ca_path: None,
        options: BTreeMap::new(),
        default_statement_timeout_ms: 0,
    })
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

/// Counts rows and notes when the first batch arrived. Nothing is kept.
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
/// past the cap are only counted.
struct StoreSink {
    store: Mutex<RowStore>,
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

struct VersionSink(Mutex<String>);

#[async_trait]
impl BatchSink for VersionSink {
    async fn deliver(&self, batch: RowBatch) -> Result<(), Box<DriverError>> {
        if let Some(CellValue::Text(v)) = batch.rows.first().and_then(|r| r.first()) {
            *self.0.lock().unwrap() = v.clone();
        }
        Ok(())
    }
}

struct NullSink;

#[async_trait]
impl BatchSink for NullSink {
    async fn deliver(&self, _batch: RowBatch) -> Result<(), Box<DriverError>> {
        Ok(())
    }
}

#[tokio::test]
#[ignore = "benchmark: requires TUPLENEST_BENCH_SQLITE"]
async fn bench_sqlite_open() {
    let Some(cfg) = config() else { return };
    let mut t = vec![];
    for i in 0..=runs() {
        let started = Instant::now();
        let s = SqliteDriver.connect_concrete(cfg.clone()).await.unwrap();
        if i > 0 {
            t.push(ms(started.elapsed()));
        }
        drop(s);
    }
    report("sqlite open (read-only)", t);
}

#[tokio::test]
#[ignore = "benchmark: requires TUPLENEST_BENCH_SQLITE"]
async fn bench_sqlite_result_streaming() {
    let Some(cfg) = config() else { return };
    let mut s = SqliteDriver.connect_concrete(cfg).await.unwrap();

    let version = VersionSink(Mutex::new(String::new()));
    s.execute(req("SELECT sqlite_version()", 0), &version)
        .await
        .unwrap();
    println!(
        "INFO\tSQLite library version: {}",
        version.0.lock().unwrap()
    );

    let (mut total, mut first) = (vec![], vec![]);
    for i in 0..=runs() {
        let sink = CountSink::new();
        let summary = s
            .execute(req("SELECT * FROM events LIMIT 20000", 0), &sink)
            .await
            .unwrap();
        assert_eq!(summary.rows_returned, 20_000);
        if i > 0 {
            total.push(ms(sink.started.elapsed()));
            first.push(ms(sink.first_batch.lock().unwrap().unwrap()));
        }
    }
    report(
        "sqlite 20,000 rows (LIMIT 20000), decode only: total",
        total,
    );
    report(
        "sqlite 20,000 rows (LIMIT 20000), decode only: first batch",
        first,
    );

    let (mut total, mut stored) = (vec![], (0, 0));
    for i in 0..=runs() {
        let sink = StoreSink {
            store: Mutex::new(RowStore::with_budget(ROW_CAP, BYTE_CAP)),
        };
        let started = Instant::now();
        let summary = s
            .execute(req("SELECT * FROM events", ROW_CAP as u64), &sink)
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
        "sqlite SELECT * FROM events, row_limit 20,000, stored in RowStore: until cap hit",
        total,
    );
    println!(
        "INFO\tRowStore at cap: {:.1} MB row text, {:.1} MB compressed in RAM",
        stored.0 as f64 / 1_048_576.0,
        stored.1 as f64 / 1_048_576.0
    );

    let mut total = vec![];
    let mut rows = 0;
    for i in 0..=runs() {
        let sink = CountSink::new();
        let summary = s
            .execute(req("SELECT * FROM events", 0), &sink)
            .await
            .unwrap();
        rows = summary.rows_returned;
        if i > 0 {
            total.push(ms(sink.started.elapsed()));
        }
    }
    report(
        &format!("sqlite SELECT * FROM events, no row_limit ({rows} rows), decode only"),
        total,
    );
}

#[tokio::test]
#[ignore = "benchmark: requires TUPLENEST_BENCH_SQLITE"]
async fn bench_sqlite_schema_discovery() {
    let Some(cfg) = config() else { return };
    let s = SqliteDriver.connect_concrete(cfg).await.unwrap();
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
            "sqlite schema walk: ServerInfo + ListSchemas + ListObjects/Relationships per schema \
             + DescribeObject per object ({} schemas, {} objects)",
            counts.0, counts.1
        ),
        walk,
    );
}

#[tokio::test]
#[ignore = "benchmark: requires TUPLENEST_BENCH_SQLITE"]
async fn bench_sqlite_cancel_latency() {
    let Some(cfg) = config() else { return };
    let mut s = SqliteDriver.connect_concrete(cfg).await.unwrap();
    let mut latency = vec![];
    for i in 0..=runs() {
        let handle = s.cancel_handle();
        let (tx, rx) = tokio::sync::oneshot::channel();
        let canceller = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let at = Instant::now();
            handle.cancel().await.unwrap();
            tx.send(at).unwrap();
        });
        // Never ends on its own: counts an unbounded recursive sequence.
        let err = s
            .execute(
                req(
                    "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) \
                     SELECT count(*) FROM c",
                    0,
                ),
                &NullSink,
            )
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
        "sqlite cancel: unbounded recursive CTE, cancel() called -> execute returns",
        latency,
    );
}

// ---------------------------------------------------------------------------
// Large schemas. Needs TUPLENEST_BENCH_SQLITE (any value; the file it names is
// not used here) and TUPLENEST_BENCH_SQLITE_LARGE. For each size it builds a
// new database in a temporary directory, opens it read-only through the
// driver, measures, and deletes it.
// ---------------------------------------------------------------------------

/// Table counts to build, `TUPLENEST_BENCH_SQLITE_LARGE_SIZES` (default 1000,10000).
fn large_sizes() -> Option<Vec<usize>> {
    std::env::var_os("TUPLENEST_BENCH_SQLITE")?;
    std::env::var_os("TUPLENEST_BENCH_SQLITE_LARGE")?;
    Some(
        std::env::var("TUPLENEST_BENCH_SQLITE_LARGE_SIZES")
            .unwrap_or_else(|_| "1000,10000".into())
            .split(',')
            .map(|s| {
                s.trim()
                    .parse()
                    .expect("TUPLENEST_BENCH_SQLITE_LARGE_SIZES")
            })
            .collect(),
    )
}

/// Repetitions of the full walk, which takes seconds at 10,000 tables.
fn walk_runs() -> usize {
    std::env::var("TUPLENEST_BENCH_WALK_RUNS")
        .ok()
        .and_then(|r| r.parse().ok())
        .unwrap_or(5)
}

/// The same table shapes as the PostgreSQL large-schema benchmark: `n` tables
/// t00001.., `id integer primary key`, `parent_id`, `name`, `amount`,
/// `created_at`; every even-numbered table has a foreign key from `parent_id`
/// to the table before it and an index on `parent_id`. One transaction.
fn build_tables(path: &std::path::Path, n: usize) {
    let mut conn = rusqlite::Connection::open(path).unwrap();
    let tx = conn.transaction().unwrap();
    for i in 1..=n {
        let fk = if i % 2 == 0 {
            format!(" REFERENCES t{:05}(id)", i - 1)
        } else {
            String::new()
        };
        tx.execute_batch(&format!(
            "CREATE TABLE t{i:05} (id integer PRIMARY KEY, parent_id integer{fk}, \
             name text NOT NULL, amount numeric, created_at text NOT NULL);"
        ))
        .unwrap();
        if i % 2 == 0 {
            tx.execute_batch(&format!(
                "CREATE INDEX t{i:05}_parent ON t{i:05} (parent_id);"
            ))
            .unwrap();
        }
    }
    tx.commit().unwrap();
}

#[tokio::test]
#[ignore = "benchmark: requires TUPLENEST_BENCH_SQLITE and TUPLENEST_BENCH_SQLITE_LARGE"]
async fn bench_sqlite_large_schema() {
    let Some(sizes) = large_sizes() else { return };
    for n in sizes {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(format!("{n}-tables.sqlite"));
        let started = Instant::now();
        build_tables(&path, n);
        println!(
            "INFO\tbuilt {n} tables ({} foreign keys, {} extra indexes) in {:.1} s, {:.1} MB file",
            n / 2,
            n / 2,
            started.elapsed().as_secs_f64(),
            std::fs::metadata(&path).unwrap().len() as f64 / 1_048_576.0
        );

        let cfg = ConnectionConfig {
            database: path.to_string_lossy().into_owned(),
            ..config().unwrap_or_else(|| unreachable!())
        };
        let s = SqliteDriver.connect_concrete(cfg).await.unwrap();
        let mid = format!("t{:05}", n / 2);
        let requests = [
            ("ListSchemas".to_string(), MetadataRequest::ListSchemas),
            (
                "ListObjects main".to_string(),
                MetadataRequest::ListObjects {
                    schema: "main".into(),
                },
            ),
            (
                format!("DescribeObject main.{mid}"),
                MetadataRequest::DescribeObject {
                    schema: "main".into(),
                    name: mid.clone(),
                },
            ),
            (
                "Relationships main".to_string(),
                MetadataRequest::Relationships {
                    schema: "main".into(),
                },
            ),
        ];
        for (name, request) in requests {
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
            report(&format!("sqlite {n} tables: {name}"), t);
            println!(
                "INFO\tsqlite {n} tables: {name} payload {:.2} MB JSON",
                bytes as f64 / 1_048_576.0
            );
        }

        let mut t = vec![];
        let mut counts = (0, 0);
        for i in 0..=walk_runs() {
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
                t.push(ms(started.elapsed()));
            }
        }
        report(
            &format!(
                "sqlite {n} tables: full walk ({} schemas, {} objects, {} requests)",
                counts.0,
                counts.1,
                2 + 2 * counts.0 + counts.1
            ),
            t,
        );
        drop(s);
    }
}
