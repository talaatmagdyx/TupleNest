use std::collections::BTreeMap;
use std::sync::Mutex;
use async_trait::async_trait;
use tuplenest_driver_api::*;
use tuplenest_driver_postgres::{PostgresDriver, PostgresSession};

fn cfg(read_only: bool) -> ConnectionConfig {
    ConnectionConfig {
        driver_id: "postgres".into(), name: "probe".into(), environment: Environment::Dev,
        read_only, host: "localhost".into(), port: 5432,
        database: "tuplenest_audit_pg".into(),
        username: std::env::var("USER").unwrap(),
        secret_ref: None, tls_mode: TlsMode::Disabled, tls_ca_path: None,
        options: BTreeMap::new(), default_statement_timeout_ms: 0,
    }
}
#[derive(Default)]
struct Collect { rows: Mutex<Vec<Vec<CellValue>>>, cols: Mutex<Vec<ColumnMeta>> }
#[async_trait]
impl BatchSink for Collect {
    async fn deliver(&self, b: RowBatch) -> Result<(), Box<DriverError>> {
        if !b.columns.is_empty() { *self.cols.lock().unwrap() = b.columns.clone(); }
        self.rows.lock().unwrap().extend(b.rows); Ok(())
    }
}
fn req(sql: &str, params: Vec<ParamValue>) -> QueryRequest {
    QueryRequest { execution_id: ExecutionId::new(), sql: sql.into(), params, row_limit: 0, timeout_ms: 0 }
}
fn short(s: String) -> String { if s.len() > 3000 { format!("{}…[{} bytes]", &s[..200], s.len()) } else { s } }
async fn run(s: &mut PostgresSession, label: &str, sql: &str, params: Vec<ParamValue>) -> bool {
    let sink = Collect::default();
    match s.execute(req(sql, params), &sink).await {
        Ok(sum) => {
            let rows = sink.rows.lock().unwrap();
            let cols = sink.cols.lock().unwrap();
            let types: Vec<_> = cols.iter().map(|c| c.db_type.clone()).collect();
            let cells = rows.iter().map(|r| r.iter().map(|c| serde_json::to_string(c).unwrap()).collect::<Vec<_>>().join(" | ")).collect::<Vec<_>>().join(" ;; ");
            println!("[{label}] OK  sql={sql:?} types={types:?} affected={:?} returned={} cells={}", sum.rows_affected, sum.rows_returned, short(cells));
            true
        }
        Err(e) => { println!("[{label}] ERR sql={sql:?} category={:?} title={:?} code={:?} msg={:?}", e.category, e.title, e.native_code, e.original_message.as_deref().map(|m| short(m.to_string()))); false }
    }
}

#[tokio::main]
async fn main() {
    let which: Vec<String> = std::env::args().skip(1).collect();
    let want = |k: &str| which.is_empty() || which.iter().any(|w| w == k);
    let d = PostgresDriver;

    if want("types") {
        let mut s = d.connect_concrete(cfg(false)).await.unwrap();
        run(&mut s, "setup", "DROP TYPE IF EXISTS mood CASCADE", vec![]).await;
        run(&mut s, "setup", "CREATE TYPE mood AS ENUM ('sad','ok','happy')", vec![]).await;
        run(&mut s, "setup", "DROP DOMAIN IF EXISTS posint", vec![]).await;
        run(&mut s, "setup", "CREATE DOMAIN posint AS int CHECK (VALUE > 0)", vec![]).await;
        for q in [
            "SELECT 9007199254740993::int8, (-9223372036854775808)::int8, 9223372036854775807::int8",
            "SELECT 123456789012345678901234567890.123456789012345678901234567890::numeric, 0.000000000000000000001::numeric, 'NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric, 1.500::numeric, 100::numeric(10,-2), 1e-20::numeric, 0::numeric(5,2), (-0.00)::numeric(5,2)",
            "SELECT 'NaN'::float8, 'Infinity'::float8, '-Infinity'::float8, '-0'::float8, 0.1::float4, 1e-5::float8, 1e300::float8, 16777217::float4, 3.4028235e38::float4",
            "SELECT 'infinity'::timestamp, '-infinity'::timestamptz, 'infinity'::date",
            "SELECT '0044-03-15 BC'::date, '4713-01-01 BC'::date, '0044-03-15 12:00:00 BC'::timestamp, '294276-12-31'::timestamp, '5874897-12-31'::date",
            "SELECT '2024-03-10 12:34:56.123456+02'::timestamptz, '2024-03-10 12:34:56.120000'::timestamp, '12:34:56.5'::time, '12:34:56+02'::timetz, '24:00:00'::time",
            "SELECT '1 year 2 mons 3 days 04:05:06'::interval, now() - now()",
            "SELECT NULL::text, ''::text, 'NULL'::text, ' '::text",
            "SELECT '{\"b\":1,\"a\":2,\"a\":3}'::json, '{\"b\":1,\"a\":2,\"a\":3}'::jsonb, '{ \"n\" : 12345678901234567890123, \"f\": 1.10, \"e\": 1E2, \"big\": 9007199254740993, \"d\": 0.1234567890123456789012345 }'::json, '{\"n\":12345678901234567890123, \"d\": 0.1234567890123456789012345, \"z\": 1.10}'::jsonb",
            "SELECT 'null'::jsonb, 'null'::json, '\"abc\"'::jsonb, '1'::jsonb, NULL::jsonb",
            "SELECT ARRAY[1,NULL,3], ARRAY['a,b','NULL',NULL,'','x y','q\"r'], ARRAY[[1,2],[3,4]], ARRAY[1.5,2.5]::numeric[], ARRAY['2024-01-01']::date[], '{}'::int[], ARRAY['NaN'::float8,'Infinity'::float8]",
            "SELECT 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid, '\\xDEADBEEF'::bytea, ''::bytea",
            "SELECT 'happy'::mood, 5::posint, int4range(1,10), '12.34'::money, '<a>x</a>'::xml, '192.168.1.1/24'::inet, '08:00:2b:01:02:03'::macaddr, B'1010'::bit(4), point(1,2), 'pg_class'::regclass, '1/0'::pg_lsn, 'a b'::tsvector, 'x'::\"char\", 'abc'::char(5), 'abc'::name, 1::oid, 'happy'::mood::text",
            "SELECT E'caf\\u00e9 \\U0001F600 e\\u0301 \\u202e rtl', E'a\\tb\\nc'",
            "SELECT length(repeat('x', 1048577)), repeat('x', 1048577)",
            "SELECT repeat('é', 600000)",
            "SELECT decode(repeat('ab', 1048577), 'hex')",
            "SELECT ('\"' || repeat('x', 1048577) || '\"')::jsonb",
            "SELECT ARRAY[repeat('x', 1048577)]",
        ] { run(&mut s, "types", q, vec![]).await; }
        // row cap count
        run(&mut s, "types", "SELECT count(*) FROM generate_series(1,25000)", vec![]).await;
    }

    if want("params") {
        let mut s = d.connect_concrete(cfg(false)).await.unwrap();
        run(&mut s, "setup", "DROP TABLE IF EXISTS p", vec![]).await;
        run(&mut s, "setup", "CREATE TABLE p (i4 int, i8 bigint, n numeric, t text, ts timestamptz, d date, u uuid, b bool, f8 float8, j jsonb)", vec![]).await;
        run(&mut s, "setup", "INSERT INTO p VALUES (1, 9007199254740993, 1.5, 'x', now(), current_date, 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', true, 0.1, '{}')", vec![]).await;
        use ParamValue as P;
        run(&mut s, "params", "SELECT i8 FROM p WHERE i8 = $1", vec![P::Text("9007199254740993".into())]).await;
        run(&mut s, "params", "SELECT i4 FROM p WHERE i4 = $1", vec![P::Int(1)]).await;
        run(&mut s, "params", "SELECT i4 FROM p WHERE i4 = $1", vec![P::Int(4294967297)]).await;
        run(&mut s, "params", "SELECT n FROM p WHERE n = $1", vec![P::Int(1)]).await;
        run(&mut s, "params", "SELECT n FROM p WHERE n = $1", vec![P::Float(1.5)]).await;
        run(&mut s, "params", "SELECT n FROM p WHERE n = $1", vec![P::Text("1.5".into())]).await;
        run(&mut s, "params", "SELECT t FROM p WHERE t = $1", vec![P::Int(123)]).await;
        run(&mut s, "params", "SELECT t FROM p WHERE t = $1", vec![P::Bool(true)]).await;
        run(&mut s, "params", "SELECT ts FROM p WHERE ts > $1", vec![P::Text("2020-01-01".into())]).await;
        run(&mut s, "params", "SELECT d FROM p WHERE d = $1", vec![P::Text("2020-01-01".into())]).await;
        run(&mut s, "params", "SELECT u FROM p WHERE u = $1", vec![P::Text("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11".into())]).await;
        run(&mut s, "params", "SELECT i4 FROM p WHERE i4 IS NOT DISTINCT FROM $1", vec![P::Null]).await;
        run(&mut s, "params", "SELECT t FROM p WHERE t IS NOT DISTINCT FROM $1", vec![P::Null]).await;
        run(&mut s, "params", "SELECT f8 FROM p WHERE f8 = $1", vec![P::Float(0.1)]).await;
        run(&mut s, "params", "SELECT f8 FROM p WHERE f8 = $1", vec![P::Int(1)]).await;
        run(&mut s, "params", "SELECT $1", vec![P::Int(1)]).await;
        run(&mut s, "params", "SELECT $1::text::uuid", vec![P::Text("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11".into())]).await;
        run(&mut s, "params", "SELECT $1::text::int", vec![P::Null]).await;
        // multi statement
        run(&mut s, "multi", "SELECT 1; SELECT 2", vec![]).await;
        run(&mut s, "multi", "BEGIN; DROP TABLE p; COMMIT", vec![]).await;
        run(&mut s, "multi", "SELECT 1;", vec![]).await;
        // rows affected
        run(&mut s, "affected", "UPDATE p SET t = 'y'", vec![]).await;
        run(&mut s, "affected", "CREATE TEMP TABLE zz AS SELECT 1", vec![]).await;
        // varchar truncation via explicit cast (row edit / import style)
        run(&mut s, "setup", "DROP TABLE IF EXISTS vc", vec![]).await;
        run(&mut s, "setup", "CREATE TABLE vc (id int primary key, v varchar(5), c char(3), n numeric(6,2), b bit(4))", vec![]).await;
        run(&mut s, "setup", "INSERT INTO vc VALUES (1,'abc','ab',1.25,B'1010')", vec![]).await;
        run(&mut s, "vc-plain", "UPDATE vc SET v = $1 WHERE id = 1", vec![P::Text("abcdefghij".into())]).await;
        run(&mut s, "vc-cast", "UPDATE \"public\".\"vc\" SET \"v\" = $1::text::character varying(5) WHERE \"id\" = $2::text::integer AND \"v\" IS NOT DISTINCT FROM $3::text::character varying(5)", vec![P::Text("abcdefghij".into()), P::Text("1".into()), P::Text("abc".into())]).await;
        run(&mut s, "vc-cast", "UPDATE vc SET c = $1::text::character(3) WHERE id = 1", vec![P::Text("abcdef".into())]).await;
        run(&mut s, "vc-cast", "UPDATE vc SET b = $1::text::bit(4) WHERE id = 1", vec![P::Text("11110000".into())]).await;
        run(&mut s, "vc-cast", "SELECT * FROM vc", vec![]).await;
    }

    if want("tx") {
        let mut s = d.connect_concrete(cfg(false)).await.unwrap();
        run(&mut s, "setup", "DROP TABLE IF EXISTS txt", vec![]).await;
        run(&mut s, "setup", "CREATE TABLE txt (id int primary key, v text)", vec![]).await;
        // B: commit of an aborted transaction
        println!("begin -> {:?}", s.begin(TransactionOptions::default()).await.map(|_| ()).map_err(|e| e.title.clone()));
        run(&mut s, "tx", "INSERT INTO txt VALUES (1,'kept?')", vec![]).await;
        run(&mut s, "tx", "SELECT 1/0", vec![]).await;
        println!("server_in_transaction (aborted) -> {:?}", s.server_in_transaction().await.map_err(|e| e.title.clone()));
        println!("COMMIT of aborted tx -> {:?}", s.commit().await.map_err(|e| e.title.clone()));
        println!("server_in_transaction after -> {:?}", s.server_in_transaction().await.map_err(|e| e.title.clone()));
        run(&mut s, "tx", "SELECT count(*) AS rows_after_commit FROM txt", vec![]).await;
        // typed BEGIN, then begin() button
        run(&mut s, "tx", "BEGIN", vec![]).await;
        println!("begin() while typed BEGIN open -> {:?}", s.begin(TransactionOptions::default()).await.map(|_| ()).map_err(|e| e.title.clone()));
        run(&mut s, "tx", "INSERT INTO txt VALUES (2,'x')", vec![]).await;
        println!("rollback -> {:?}", s.rollback().await.map_err(|e| e.title.clone()));
        println!("in tx -> {:?}", s.server_in_transaction().await.map_err(|e| e.title.clone()));
        run(&mut s, "tx", "SELECT count(*) FROM txt", vec![]).await;
        // typed COMMIT executed through execute() with trailing statement text
        run(&mut s, "tx", "COMMIT", vec![]).await;
        // savepoint
        println!("begin -> {:?}", s.begin(TransactionOptions::default()).await.map(|_| ()).map_err(|e| e.title.clone()));
        run(&mut s, "tx", "INSERT INTO txt VALUES (3,'user work')", vec![]).await;
        run(&mut s, "tx", "SAVEPOINT tuplenest_edit", vec![]).await;
        run(&mut s, "tx", "INSERT INTO txt VALUES (3,'dup')", vec![]).await;
        run(&mut s, "tx", "ROLLBACK TO SAVEPOINT tuplenest_edit", vec![]).await;
        run(&mut s, "tx", "SELECT * FROM txt", vec![]).await;
        // cancel inside a transaction
        let h = s.cancel_handle();
        let t = tokio::spawn(async move { tokio::time::sleep(std::time::Duration::from_millis(700)).await; h.cancel().await.map_err(|e| e.title.clone()) });
        run(&mut s, "cancel-in-tx", "SELECT pg_sleep(20)", vec![]).await;
        println!("cancel result {:?}", t.await.unwrap());
        run(&mut s, "cancel-in-tx", "SELECT * FROM txt", vec![]).await;
        println!("in tx after cancel -> {:?}", s.server_in_transaction().await.map_err(|e| e.title.clone()));
        println!("COMMIT after cancel -> {:?}", s.commit().await.map_err(|e| e.title.clone()));
        run(&mut s, "cancel-in-tx", "SELECT * FROM txt", vec![]).await;
    }

    if want("kill") {
        // killed while idle
        let mut s = d.connect_concrete(cfg(false)).await.unwrap();
        let admin = d.connect_concrete(cfg(false)).await.unwrap();
        let sink = Collect::default();
        s.execute(req("SELECT pg_backend_pid()", vec![]), &sink).await.unwrap();
        let pid = match sink.rows.lock().unwrap()[0][0] { CellValue::Int(p) => p as i32, _ => 0 };
        println!("begin -> {:?}", s.begin(TransactionOptions::default()).await.map(|_| ()).map_err(|e| e.title.clone()));
        println!("terminate idle backend {pid} -> {:?}", admin.admin_backend(pid, true).await.map_err(|e| e.title.clone()));
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        println!("is_broken after idle kill = {}", s.is_broken());
        run(&mut s, "kill-idle", "SELECT 1", vec![]).await;
        println!("is_broken = {}", s.is_broken());
        println!("commit -> {:?}", s.commit().await.map_err(|e| (e.category, e.title.clone())));
        // killed mid-query
        let mut s2 = d.connect_concrete(cfg(false)).await.unwrap();
        let sink = Collect::default();
        s2.execute(req("SELECT pg_backend_pid()", vec![]), &sink).await.unwrap();
        let pid2 = match sink.rows.lock().unwrap()[0][0] { CellValue::Int(p) => p as i32, _ => 0 };
        let t = tokio::spawn(async move { tokio::time::sleep(std::time::Duration::from_millis(700)).await; admin.admin_backend(pid2, true).await.map_err(|e| e.title.clone()) });
        run(&mut s2, "kill-running", "SELECT pg_sleep(20)", vec![]).await;
        println!("terminate running -> {:?}; is_broken={}", t.await.unwrap(), s2.is_broken());
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        println!("is_broken later={}", s2.is_broken());
        run(&mut s2, "kill-running", "SELECT 1", vec![]).await;
    }


    if want("misc") {
        let mut s = d.connect_concrete(cfg(false)).await.unwrap();
        use ParamValue as P;
        // paramCount() counts $1 inside a dollar-quoted body, so the app binds 1 value to a 0-parameter statement
        run(&mut s, "fnbody", "CREATE OR REPLACE FUNCTION audit_inc(int) RETURNS int AS $$ SELECT $1 + 1 $$ LANGUAGE sql", vec![P::Int(1)]).await;
        run(&mut s, "fnbody", "CREATE OR REPLACE FUNCTION audit_inc(int) RETURNS int AS $$ SELECT $1 + 1 $$ LANGUAGE sql", vec![]).await;
        for n in [32767usize, 32768, 65535] {
            let sql = format!("SELECT count(*) FROM (VALUES {}) v", (1..=n).map(|i| format!("(${i}::text)")).collect::<Vec<_>>().join(","));
            let sink = Collect::default();
            let r = s.execute(req(&sql, (0..n).map(|_| P::Text("x".into())).collect()), &sink).await;
            println!("[wide] {n} bind params -> {:?}", r.map(|x| x.rows_returned).map_err(|e| (e.title.clone(), e.original_message.clone())));
        }
        run(&mut s, "void", "SELECT pg_sleep(0)", vec![]).await;
        run(&mut s, "citext-like", "SELECT 'x'::regtype, 'a=>1'::text, '(1,2)'::record", vec![]).await;
    }
    if want("ro") {
        let mut w = d.connect_concrete(cfg(false)).await.unwrap();
        run(&mut w, "setup", "DROP TABLE IF EXISTS ro_t", vec![]).await;
        run(&mut w, "setup", "CREATE TABLE ro_t (id int primary key, v text)", vec![]).await;
        run(&mut w, "setup", "INSERT INTO ro_t VALUES (1,'a')", vec![]).await;
        run(&mut w, "setup", "CREATE SEQUENCE IF NOT EXISTS ro_seq", vec![]).await;
        let mut s = d.connect_concrete(cfg(true)).await.unwrap();
        for q in [
            "INSERT INTO ro_t VALUES (2,'b')",
            "SET default_transaction_read_only = off",
            "INSERT INTO ro_t VALUES (3,'c')",
            "SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE",
            "UPDATE ro_t SET v='z'",
            "SELECT set_config('default_transaction_read_only','off',false)",
            "DELETE FROM ro_t",
            "RESET ALL",
            "TRUNCATE ro_t",
            "BEGIN READ WRITE",
            "INSERT INTO ro_t VALUES (4,'d')",
            "ROLLBACK",
            "BEGIN",
            "SET TRANSACTION READ WRITE",
            "INSERT INTO ro_t VALUES (5,'e')",
            "COMMIT",
            "BEGIN",
            "SET transaction_read_only = off",
            "INSERT INTO ro_t VALUES (6,'f')",
            "COMMIT",
            "BEGIN READ WRITE",
            "COMMIT AND CHAIN",
            "INSERT INTO ro_t VALUES (7,'g')",
            "ROLLBACK",
            "DO $$ BEGIN INSERT INTO ro_t VALUES (8,'h'); END $$",
            "/* x */ DO $$ BEGIN NULL; END $$",
            "WITH d AS (DELETE FROM ro_t RETURNING *) SELECT * FROM d",
            "SELECT nextval('ro_seq')",
            "EXPLAIN ANALYZE DELETE FROM ro_t",
            "SELECT * INTO ro_copy FROM ro_t",
            // side effects PostgreSQL permits in a read-only transaction
            "CREATE TEMP TABLE ro_tmp AS SELECT * FROM ro_t",
            "INSERT INTO ro_tmp VALUES (99,'temp write')",
            "VACUUM ro_t",
            "ANALYZE ro_t",
            "CHECKPOINT",
            "NOTIFY ch, 'hello'",
            "SELECT pg_advisory_lock(42)",
            "SELECT lo_create(0)",
            "REINDEX TABLE ro_t",
            "CLUSTER ro_t USING ro_t_pkey",
            "REFRESH MATERIALIZED VIEW nope",
            "SELECT pg_stat_reset()",
            "SELECT * FROM ro_t FOR UPDATE",
            "LOCK TABLE ro_t IN ACCESS EXCLUSIVE MODE",
            "PREPARE w AS INSERT INTO ro_t VALUES (10,'p')",
            "EXECUTE w",
            "SELECT count(*) FROM ro_t",
        ] { run(&mut s, "ro", q, vec![]).await; }
        let marker = std::env::var("PROBE_MARKER").unwrap_or_default();
        if !marker.is_empty() {
            run(&mut s, "ro", &format!("COPY (SELECT 1) TO PROGRAM 'touch {marker}'"), vec![]).await;
            println!("marker exists after COPY TO PROGRAM on read-only profile: {}", std::path::Path::new(&marker).exists());
        }
        // terminate another backend from a read-only profile
        let mut victim = d.connect_concrete(cfg(false)).await.unwrap();
        let sink = Collect::default();
        victim.execute(req("SELECT pg_backend_pid()", vec![]), &sink).await.unwrap();
        let pid = match sink.rows.lock().unwrap()[0][0] { CellValue::Int(p) => p, _ => 0 };
        run(&mut s, "ro", &format!("SELECT pg_terminate_backend({pid})"), vec![]).await;
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        println!("victim broken = {}", victim.is_broken());
        run(&mut w, "ro-check", "SELECT * FROM ro_t ORDER BY id", vec![]).await;
        // statement timeout
        let mut c = cfg(false); c.default_statement_timeout_ms = 300;
        let mut st = d.connect_concrete(c).await.unwrap();
        run(&mut st, "timeout", "SELECT pg_sleep(2)", vec![]).await;
        run(&mut st, "timeout", "SET statement_timeout = 0", vec![]).await;
        run(&mut st, "timeout", "SELECT pg_sleep(0.6)", vec![]).await;
    }
}
