use std::collections::BTreeMap;
use std::sync::Mutex as StdMutex;

use super::*;

fn config(path: &std::path::Path, read_only: bool) -> ConnectionConfig {
    ConnectionConfig {
        driver_id: "sqlite".into(),
        name: "t".into(),
        environment: Environment::Dev,
        read_only,
        host: String::new(),
        port: 0,
        database: path.display().to_string(),
        username: String::new(),
        secret_ref: None,
        tls_mode: TlsMode::Disabled,
        tls_ca_path: None,
        options: BTreeMap::from([(OPTION_CREATE.to_string(), "true".to_string())]),
        default_statement_timeout_ms: 0,
    }
}

#[derive(Default)]
struct Collect {
    batches: StdMutex<Vec<RowBatch>>,
}

#[async_trait]
impl BatchSink for Collect {
    async fn deliver(&self, batch: RowBatch) -> Result<(), Box<DriverError>> {
        self.batches.lock().unwrap().push(batch);
        Ok(())
    }
}

impl Collect {
    fn rows(&self) -> Vec<Vec<CellValue>> {
        self.batches
            .lock()
            .unwrap()
            .iter()
            .flat_map(|b| b.rows.clone())
            .collect()
    }
    fn columns(&self) -> Vec<ColumnMeta> {
        self.batches
            .lock()
            .unwrap()
            .iter()
            .find(|b| !b.columns.is_empty())
            .map(|b| b.columns.clone())
            .unwrap_or_default()
    }
}

fn req(sql: &str) -> QueryRequest {
    QueryRequest {
        execution_id: ExecutionId::new(),
        sql: sql.into(),
        params: vec![],
        row_limit: 0,
    }
}

async fn run_sql(s: &mut SqliteSession, sql: &str) -> Result<ExecutionSummary, Box<DriverError>> {
    s.execute(req(sql), &Collect::default()).await
}

async fn fresh() -> (tempfile::TempDir, SqliteSession) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("t.db");
    let s = SqliteDriver
        .connect_concrete(config(&path, false))
        .await
        .unwrap();
    (dir, s)
}

#[tokio::test]
async fn values_map_exactly_and_declared_types_are_reported() {
    let (_d, mut s) = fresh().await;
    run_sql(
        &mut s,
        "CREATE TABLE t (i INTEGER, r REAL, s TEXT, b BLOB, n VARCHAR(10))",
    )
    .await
    .unwrap();
    run_sql(
        &mut s,
        "INSERT INTO t VALUES (9007199254740993, 1.5, 'héllo', x'00ff', NULL)",
    )
    .await
    .unwrap();
    let sink = Collect::default();
    s.execute(req("SELECT i, r, s, b, n, 1 + 1 AS e FROM t"), &sink)
        .await
        .unwrap();
    let rows = sink.rows();
    assert_eq!(
        rows[0],
        vec![
            CellValue::Int(9_007_199_254_740_993),
            CellValue::Float(1.5),
            CellValue::Text("héllo".into()),
            CellValue::Bytes(vec![0, 255].into()),
            CellValue::Null,
            CellValue::Int(2),
        ]
    );
    let types: Vec<String> = sink.columns().into_iter().map(|c| c.db_type).collect();
    // Declared types as declared; an expression gets its value's class.
    assert_eq!(
        types,
        ["INTEGER", "REAL", "TEXT", "BLOB", "VARCHAR(10)", "INTEGER"]
    );
}

#[tokio::test]
async fn a_read_stops_at_the_cap_and_says_there_was_more() {
    let (_d, mut s) = fresh().await;
    let mut r =
        req("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n) SELECT x FROM n");
    // An endless series: only stopping at the cap ever returns.
    r.row_limit = 2_500;
    let sink = Collect::default();
    let summary = s.execute(r, &sink).await.unwrap();
    assert_eq!(summary.rows_returned, 2_500);
    assert!(summary.more_rows);
    assert_eq!(sink.rows().len(), 2_500);
    // Batches are bounded and contiguous, and the last says so.
    let batches = sink.batches.lock().unwrap();
    assert!(batches.iter().all(|b| b.rows.len() <= BATCH_SIZE));
    assert!(batches.last().unwrap().is_last);
    for (i, b) in batches.iter().enumerate() {
        assert_eq!(b.sequence, i as u64);
    }
}

#[tokio::test]
async fn exactly_the_cap_is_not_more() {
    let (_d, mut s) = fresh().await;
    let mut r = req("SELECT 1 UNION ALL SELECT 2");
    r.row_limit = 2;
    let summary = s.execute(r, &Collect::default()).await.unwrap();
    assert_eq!(summary.rows_returned, 2);
    assert!(!summary.more_rows);
}

#[tokio::test]
async fn a_write_is_never_cut_short_by_the_cap() {
    let (_d, mut s) = fresh().await;
    run_sql(&mut s, "CREATE TABLE t (x INTEGER)").await.unwrap();
    let mut r = req(
        "INSERT INTO t WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 50) \
         SELECT x FROM n RETURNING x",
    );
    r.row_limit = 10;
    let summary = s.execute(r, &Collect::default()).await.unwrap();
    assert_eq!(summary.rows_returned, 50);
    assert!(!summary.more_rows);
    assert_eq!(summary.rows_affected, Some(50));
}

#[tokio::test]
async fn rows_affected_is_this_statements_count() {
    let (_d, mut s) = fresh().await;
    run_sql(&mut s, "CREATE TABLE t (x INTEGER)").await.unwrap();
    run_sql(&mut s, "INSERT INTO t VALUES (1), (2), (3)")
        .await
        .unwrap();
    let up = run_sql(&mut s, "UPDATE t SET x = x + 1 WHERE x > 1")
        .await
        .unwrap();
    assert_eq!(up.rows_affected, Some(2));
    // DDL after DML: not the stale count of the UPDATE.
    let ddl = run_sql(&mut s, "CREATE TABLE u (y)").await.unwrap();
    assert_eq!(ddl.rows_affected, Some(0));
}

#[tokio::test]
async fn numbered_placeholders_bind_by_number_not_by_appearance() {
    let (_d, mut s) = fresh().await;
    let sink = Collect::default();
    let mut r = req("SELECT $2 AS b, $1 AS a, $2 AS b2");
    r.params = vec![ParamValue::Text("one".into()), ParamValue::Int(2)];
    s.execute(r, &sink).await.unwrap();
    assert_eq!(
        sink.rows()[0],
        vec![
            CellValue::Int(2),
            CellValue::Text("one".into()),
            CellValue::Int(2)
        ]
    );
}

#[tokio::test]
async fn several_statements_are_refused_not_half_run() {
    let (_d, mut s) = fresh().await;
    run_sql(&mut s, "CREATE TABLE t (x)").await.unwrap();
    let err = run_sql(&mut s, "INSERT INTO t VALUES (1); DROP TABLE t")
        .await
        .unwrap_err();
    assert_eq!(err.category, ErrorCategory::Syntax);
    let sink = Collect::default();
    s.execute(req("SELECT count(*) FROM t"), &sink)
        .await
        .unwrap();
    assert_eq!(sink.rows()[0], vec![CellValue::Int(0)]);
}

#[tokio::test]
async fn errors_carry_a_category_and_the_extended_code() {
    let (_d, mut s) = fresh().await;
    let e = run_sql(&mut s, "SELEC 1").await.unwrap_err();
    assert_eq!(e.category, ErrorCategory::Syntax);
    assert_eq!(e.native_code.as_deref(), Some("SQLITE_ERROR"));
    let e = run_sql(&mut s, "SELECT * FROM nope").await.unwrap_err();
    assert_eq!(e.category, ErrorCategory::SchemaMissing);
    run_sql(&mut s, "CREATE TABLE t (x INTEGER PRIMARY KEY, y UNIQUE)")
        .await
        .unwrap();
    run_sql(&mut s, "INSERT INTO t VALUES (1, 'a')")
        .await
        .unwrap();
    let e = run_sql(&mut s, "INSERT INTO t VALUES (2, 'a')")
        .await
        .unwrap_err();
    assert_eq!(e.category, ErrorCategory::ConstraintViolation);
    assert_eq!(e.native_code.as_deref(), Some("SQLITE_CONSTRAINT_UNIQUE"));
    assert!(e.original_message.unwrap().contains("t.y"));
    // Foreign keys are enforced.
    run_sql(&mut s, "CREATE TABLE c (p INTEGER REFERENCES t(x))")
        .await
        .unwrap();
    let e = run_sql(&mut s, "INSERT INTO c VALUES (99)")
        .await
        .unwrap_err();
    assert_eq!(
        e.native_code.as_deref(),
        Some("SQLITE_CONSTRAINT_FOREIGNKEY")
    );
}

#[tokio::test]
async fn a_missing_file_is_not_created_unless_asked() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("missing.db");
    let mut cfg = config(&path, false);
    cfg.options.clear();
    let e = SqliteDriver
        .connect_concrete(cfg.clone())
        .await
        .err()
        .unwrap();
    assert_eq!(e.category, ErrorCategory::DatabaseMissing);
    assert!(!path.exists());
    let report = SqliteDriver.test(cfg).await.unwrap();
    assert!(!report.passed());
}

#[tokio::test]
async fn a_file_that_is_not_a_database_fails_on_open() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("notes.txt");
    std::fs::write(
        &path,
        "this is not a database, just some text that is long enough",
    )
    .unwrap();
    let e = SqliteDriver
        .connect_concrete(config(&path, false))
        .await
        .err()
        .unwrap();
    assert_eq!(e.native_code.as_deref(), Some("SQLITE_NOTADB"));
}

#[tokio::test]
async fn cancel_interrupts_a_running_statement() {
    let (_d, mut s) = fresh().await;
    let handle = s.cancel_handle();
    let canceller = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(150)).await;
        handle.cancel().await.unwrap();
    });
    let started = Instant::now();
    // Endless and producing no rows: only an interrupt ends it.
    let e = run_sql(
        &mut s,
        "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n) SELECT count(*) FROM n",
    )
    .await
    .unwrap_err();
    canceller.await.unwrap();
    assert_eq!(e.category, ErrorCategory::Cancelled);
    assert_eq!(e.native_code.as_deref(), Some("SQLITE_INTERRUPT"));
    assert!(started.elapsed() < Duration::from_secs(5));
    // The session is fine afterwards.
    run_sql(&mut s, "SELECT 1").await.unwrap();
}

#[tokio::test]
async fn a_statement_timeout_is_reported_as_one() {
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = config(&dir.path().join("t.db"), false);
    cfg.default_statement_timeout_ms = 100;
    let mut s = SqliteDriver.connect_concrete(cfg).await.unwrap();
    let e = run_sql(
        &mut s,
        "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n) SELECT count(*) FROM n",
    )
    .await
    .unwrap_err();
    assert_eq!(e.category, ErrorCategory::StatementTimeout);
}

#[tokio::test]
async fn transactions_begin_commit_rollback_and_typed_begin_is_seen() {
    let (_d, mut s) = fresh().await;
    run_sql(&mut s, "CREATE TABLE t (x)").await.unwrap();
    s.begin(TransactionOptions::default()).await.unwrap();
    assert!(s.in_transaction().await.unwrap());
    run_sql(&mut s, "INSERT INTO t VALUES (1)").await.unwrap();
    s.rollback().await.unwrap();
    assert!(!s.in_transaction().await.unwrap());
    assert_eq!(
        s.commit().await.unwrap_err().category,
        ErrorCategory::Internal
    );
    // A BEGIN typed in the editor is a transaction too.
    run_sql(&mut s, "BEGIN").await.unwrap();
    assert!(s.in_transaction().await.unwrap());
    run_sql(&mut s, "SAVEPOINT sp").await.unwrap();
    run_sql(&mut s, "INSERT INTO t VALUES (2)").await.unwrap();
    run_sql(&mut s, "RELEASE SAVEPOINT sp").await.unwrap();
    s.commit().await.unwrap();
    let sink = Collect::default();
    s.execute(req("SELECT x FROM t"), &sink).await.unwrap();
    assert_eq!(sink.rows(), vec![vec![CellValue::Int(2)]]);
}

async fn read_only_on(dir: &tempfile::TempDir) -> SqliteSession {
    let path = dir.path().join("ro.db");
    {
        let mut w = SqliteDriver
            .connect_concrete(config(&path, false))
            .await
            .unwrap();
        run_sql(&mut w, "CREATE TABLE t (x)").await.unwrap();
        run_sql(&mut w, "INSERT INTO t VALUES (1)").await.unwrap();
    }
    SqliteDriver
        .connect_concrete(config(&path, true))
        .await
        .unwrap()
}

#[tokio::test]
async fn read_only_refuses_writes() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = read_only_on(&dir).await;
    for sql in [
        "INSERT INTO t VALUES (2)",
        "UPDATE t SET x = 3",
        "DELETE FROM t",
        "DROP TABLE t",
        "CREATE TABLE u (y)",
        "CREATE TEMP TABLE scratch (y)",
    ] {
        let e = run_sql(&mut s, sql).await.unwrap_err();
        assert_eq!(e.category, ErrorCategory::ReadOnlyViolation, "{sql}: {e:?}");
    }
    run_sql(&mut s, "SELECT * FROM t").await.unwrap();
}

#[tokio::test]
async fn read_only_holds_after_query_only_is_switched_off() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = read_only_on(&dir).await;
    // The pragma itself may run; it lasts until the next statement at most,
    // and the file is opened read-only besides.
    let _ = run_sql(&mut s, "PRAGMA query_only = OFF").await;
    let e = run_sql(&mut s, "INSERT INTO t VALUES (2)")
        .await
        .unwrap_err();
    assert_eq!(e.category, ErrorCategory::ReadOnlyViolation);
    let sink = Collect::default();
    s.execute(req("PRAGMA query_only"), &sink).await.unwrap();
    assert_eq!(sink.rows(), vec![vec![CellValue::Int(1)]]);
}

#[tokio::test]
async fn read_only_refuses_writes_through_attach_and_vacuum_into() {
    let dir = tempfile::tempdir().unwrap();
    let other = dir.path().join("other.db");
    {
        let mut w = SqliteDriver
            .connect_concrete(config(&other, false))
            .await
            .unwrap();
        run_sql(&mut w, "CREATE TABLE o (z)").await.unwrap();
    }
    let mut s = read_only_on(&dir).await;
    let lit = other.display().to_string().replace('\'', "''");
    run_sql(&mut s, &format!("ATTACH '{lit}' AS o"))
        .await
        .unwrap();
    let e = run_sql(&mut s, "INSERT INTO o.o VALUES (1)")
        .await
        .unwrap_err();
    assert_eq!(e.category, ErrorCategory::ReadOnlyViolation, "{e:?}");
    // A URI asking for read-write does not get it either.
    let uri = format!("file:{}?mode=rw", other.display());
    if run_sql(&mut s, &format!("ATTACH '{uri}' AS o2"))
        .await
        .is_ok()
    {
        let e = run_sql(&mut s, "INSERT INTO o2.o VALUES (1)")
            .await
            .unwrap_err();
        assert_eq!(e.category, ErrorCategory::ReadOnlyViolation);
    }
    // A new file the read-only database would be copied into.
    let copy = dir.path().join("copy.db");
    let e = run_sql(
        &mut s,
        &format!(
            "VACUUM INTO '{}'",
            copy.display().to_string().replace('\'', "''")
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(e.category, ErrorCategory::ReadOnlyViolation);
    assert!(!copy.exists());
    // Nothing was written to the attached file.
    let mut w = SqliteDriver
        .connect_concrete(config(&other, false))
        .await
        .unwrap();
    let sink = Collect::default();
    w.execute(req("SELECT count(*) FROM o"), &sink)
        .await
        .unwrap();
    assert_eq!(sink.rows(), vec![vec![CellValue::Int(0)]]);
}

#[tokio::test]
async fn read_only_never_creates_a_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("nope.db");
    assert!(SqliteDriver
        .connect_concrete(config(&path, true))
        .await
        .is_err());
    assert!(!path.exists());
}

#[tokio::test]
async fn metadata_lists_schemas_objects_and_columns() {
    let (dir, mut s) = fresh().await;
    run_sql(
        &mut s,
        "CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, \
         full TEXT GENERATED ALWAYS AS (email || '!') VIRTUAL)",
    )
    .await
    .unwrap();
    run_sql(
        &mut s,
        "CREATE TABLE logs (msg TEXT, user_id INTEGER REFERENCES users(id))",
    )
    .await
    .unwrap();
    run_sql(&mut s, "CREATE INDEX logs_user ON logs (user_id)")
        .await
        .unwrap();
    run_sql(&mut s, "CREATE VIEW v AS SELECT email FROM users")
        .await
        .unwrap();
    run_sql(
        &mut s,
        "CREATE TABLE kv (k TEXT PRIMARY KEY, v) WITHOUT ROWID",
    )
    .await
    .unwrap();
    let other = dir.path().join("aux.db").display().to_string();
    run_sql(&mut s, &format!("ATTACH '{other}' AS aux"))
        .await
        .unwrap();

    let schemas = s.metadata(MetadataRequest::ListSchemas).await.unwrap();
    assert_eq!(schemas.payload, serde_json::json!(["main", "aux"]));

    let objects = s
        .metadata(MetadataRequest::ListObjects {
            schema: "main".into(),
        })
        .await
        .unwrap()
        .payload;
    let names: Vec<(&str, &str)> = objects
        .as_array()
        .unwrap()
        .iter()
        .map(|o| (o["name"].as_str().unwrap(), o["kind"].as_str().unwrap()))
        .collect();
    assert_eq!(
        names,
        [
            ("kv", "table"),
            ("logs", "table"),
            ("users", "table"),
            ("v", "view")
        ]
    );

    let users = s
        .metadata(MetadataRequest::DescribeObject {
            schema: "main".into(),
            name: "users".into(),
        })
        .await
        .unwrap()
        .payload;
    let cols = users["columns"].as_array().unwrap();
    assert_eq!(cols[0]["name"], "id");
    assert_eq!(cols[0]["primaryKey"], true);
    assert_eq!(cols[1]["nullable"], false);
    assert_eq!(cols[2]["generated"], true);

    // No declared key: the rowid is the key, and is not itself editable.
    let logs = s
        .metadata(MetadataRequest::DescribeObject {
            schema: "main".into(),
            name: "logs".into(),
        })
        .await
        .unwrap()
        .payload;
    let lc = logs["columns"].as_array().unwrap();
    assert_eq!(lc[0]["name"], "rowid");
    assert_eq!(lc[0]["primaryKey"], true);
    assert_eq!(lc[0]["generated"], true);
    assert_eq!(logs["indexes"][0]["name"], "logs_user");

    // WITHOUT ROWID: its declared key, no rowid.
    let kv = s
        .metadata(MetadataRequest::DescribeObject {
            schema: "main".into(),
            name: "kv".into(),
        })
        .await
        .unwrap()
        .payload;
    assert!(kv["columns"]
        .as_array()
        .unwrap()
        .iter()
        .all(|c| c["name"] != "rowid"));

    let rels = s
        .metadata(MetadataRequest::Relationships {
            schema: "main".into(),
        })
        .await
        .unwrap()
        .payload;
    assert_eq!(rels[0]["from"], "logs");
    assert_eq!(rels[0]["to"], "users");

    let cons = s
        .metadata(MetadataRequest::ListConstraints {
            schema: "main".into(),
            table: "users".into(),
        })
        .await
        .unwrap()
        .payload;
    let kinds: Vec<&str> = cons
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["kind"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, ["primary key", "unique"]);

    let found = s
        .metadata(MetadataRequest::SearchObjects {
            term: "mail".into(),
            limit: 10,
        })
        .await
        .unwrap()
        .payload;
    assert!(found["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|i| i["column"] == "email" && i["name"] == "users"));

    // A name is a value, never SQL.
    let e = s
        .metadata(MetadataRequest::ObjectDetails {
            schema: "main\".sqlite_schema; --".into(),
            name: "users".into(),
            object_kind: "table".into(),
        })
        .await
        .unwrap_err();
    assert_eq!(e.category, ErrorCategory::SchemaMissing);

    let e = s
        .metadata(MetadataRequest::ServerActivity)
        .await
        .unwrap_err();
    assert_eq!(e.category, ErrorCategory::Unsupported);
}

#[tokio::test]
async fn explain_query_plan_returns_rows() {
    let (_d, mut s) = fresh().await;
    run_sql(&mut s, "CREATE TABLE t (x INTEGER PRIMARY KEY)")
        .await
        .unwrap();
    let sink = Collect::default();
    s.execute(req("EXPLAIN QUERY PLAN SELECT * FROM t WHERE x = 1"), &sink)
        .await
        .unwrap();
    let cols: Vec<String> = sink.columns().into_iter().map(|c| c.name).collect();
    assert!(cols.contains(&"detail".to_string()), "{cols:?}");
    assert!(!sink.rows().is_empty());
}

/// A sink that fills up after the first batch, as the app's store does.
struct FullAfterOne {
    seen: StdMutex<usize>,
}

#[async_trait]
impl BatchSink for FullAfterOne {
    async fn deliver(&self, batch: RowBatch) -> Result<(), Box<DriverError>> {
        *self.seen.lock().unwrap() += batch.rows.len();
        Ok(())
    }
    fn wants_rows(&self) -> bool {
        *self.seen.lock().unwrap() == 0
    }
}

#[tokio::test]
async fn a_full_sink_gets_counts_not_rows() {
    let (_d, mut s) = fresh().await;
    let sink = FullAfterOne {
        seen: StdMutex::new(0),
    };
    let summary = s
        .execute(
            req("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 5000) SELECT x FROM n"),
            &sink,
        )
        .await
        .unwrap();
    assert_eq!(summary.rows_returned, 5000);
    assert_eq!(*sink.seen.lock().unwrap(), BATCH_SIZE);
}
