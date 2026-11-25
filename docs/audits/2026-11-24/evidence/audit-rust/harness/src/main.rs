// Audit harness: drives the real driver + result-stream. StoreSink below is a
// REPLICA of apps/desktop/src-tauri/src/pg.rs StoreSink (binary crate, cannot
// be linked): same caps (20_000 rows / 128 MiB), same row format.
use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use tuplenest_driver_api::*;
use tuplenest_driver_postgres::PostgresDriver;
use tuplenest_result_stream::RowStore;

fn cfg() -> ConnectionConfig {
    ConnectionConfig {
        driver_id: "postgres".into(),
        name: "audit".into(),
        environment: Environment::Dev,
        read_only: false,
        host: "localhost".into(),
        port: 5432,
        database: "tuplenest_audit_rust".into(),
        username: std::env::var("USER").unwrap(),
        secret_ref: None,
        tls_mode: TlsMode::Disabled,
        tls_ca_path: None,
        options: BTreeMap::new(),
        default_statement_timeout_ms: 0,
    }
}
fn req(sql: &str) -> QueryRequest {
    QueryRequest { execution_id: ExecutionId::new(), sql: sql.into(), params: vec![], row_limit: 0, timeout_ms: 0 }
}

fn footprint() -> (u64, u64) {
    // (phys_footprint, resident) in bytes
    unsafe {
        let mut info: libc::rusage_info_v2 = std::mem::zeroed();
        let r = libc::proc_pid_rusage(libc::getpid(), libc::RUSAGE_INFO_V2, &mut info as *mut _ as *mut libc::rusage_info_t);
        assert_eq!(r, 0);
        (info.ri_phys_footprint, info.ri_resident_size)
    }
}
fn mb(b: u64) -> f64 { b as f64 / 1048576.0 }
fn mem(label: &str) {
    let (f, r) = footprint();
    println!("MEM {label}: footprint={:.1}MB rss={:.1}MB", mb(f), mb(r));
}
fn trim() {
    extern "C" { fn malloc_zone_pressure_relief(zone: *mut std::ffi::c_void, goal: usize) -> usize; }
    unsafe { malloc_zone_pressure_relief(std::ptr::null_mut(), 0); }
}
fn fds() -> usize {
    let out = std::process::Command::new("lsof").args(["-p", &std::process::id().to_string()]).output().unwrap();
    String::from_utf8_lossy(&out.stdout).lines().count().saturating_sub(1)
}

fn write_cell(out: &mut Vec<u8>, cell: &CellValue) {
    const MAXSAFE: u64 = (1 << 53) - 1;
    match cell {
        CellValue::Null => out.extend_from_slice(b"null"),
        CellValue::Bool(b) => out.extend_from_slice(if *b { b"true" } else { b"false" }),
        CellValue::Int(i) if i.unsigned_abs() > MAXSAFE => { out.push(b'"'); serde_json::to_writer(&mut *out, i).unwrap(); out.push(b'"'); }
        CellValue::Int(i) => serde_json::to_writer(&mut *out, i).unwrap(),
        CellValue::Float(f) if f.is_finite() => serde_json::to_writer(&mut *out, f).unwrap(),
        CellValue::Float(_) => out.extend_from_slice(b"\"NaN\""),
        CellValue::Text(t) => serde_json::to_writer(&mut *out, t.as_str()).unwrap(),
        CellValue::Bytes(b) => { out.extend_from_slice(b"\"\\\\x"); for x in b.iter() { out.extend_from_slice(format!("{x:02x}").as_bytes()); } out.push(b'"'); }
        CellValue::Json(j) => out.extend_from_slice(j.get().as_bytes()),
        CellValue::Other(o) => serde_json::to_writer(&mut *out, o.rendered.as_str()).unwrap(),
    }
}

struct StoreSink { inner: Mutex<RowStore>, batches: Mutex<(u64, usize)> }
impl StoreSink {
    fn new() -> Self { Self { inner: Mutex::new(RowStore::with_budget(20_000, 128 * 1024 * 1024)), batches: Mutex::new((0, 0)) } }
}
#[async_trait]
impl BatchSink for StoreSink {
    fn wants_rows(&self) -> bool { !self.inner.lock().unwrap().is_full() }
    async fn deliver(&self, batch: RowBatch) -> Result<(), Box<DriverError>> {
        let mut s = self.inner.lock().unwrap();
        { let mut b = self.batches.lock().unwrap(); b.0 += 1; b.1 = b.1.max(batch.rows.len()); }
        let mut buf = Vec::new();
        for row in batch.rows {
            if s.is_full() { s.skip(); continue; }
            buf.clear();
            buf.push(b'[');
            for (i, c) in row.iter().enumerate() { if i > 0 { buf.push(b','); } write_cell(&mut buf, c); }
            buf.push(b']');
            s.push(std::str::from_utf8(&buf).unwrap());
        }
        Ok(())
    }
}
struct NullSink;
#[async_trait]
impl BatchSink for NullSink { async fn deliver(&self, _b: RowBatch) -> Result<(), Box<DriverError>> { Ok(()) } }

fn wide_sql(n: u64) -> String {
    let cols: Vec<String> = (0..50).map(|c| match c % 5 {
        0 => format!("g + {c} as c{c}"),
        1 => format!("'value-{c}-' || g as c{c}"),
        2 => format!("null::text as c{c}"),
        3 => format!("(g % 7 = 0) as c{c}"),
        _ => format!("(g::numeric / 3)::numeric(20,6) as c{c}"),
    }).collect();
    format!("select {} from generate_series(1,{n}) g", cols.join(", "))
}
fn mixed_sql(n: u64) -> String {
    format!("select g, repeat('x', 2000) || g as long_s, '日本語 🐘 ünï — ' || g as uni, \
      case when g % 10 = 0 then g end as mostly_null, null::int as n1, null::text as n2, null::timestamptz as n3, \
      jsonb_build_object('id', g, 'tags', array['a','b','ç'], 'nested', jsonb_build_object('k', repeat('j', 200))) as j, \
      case when g % ({n}/4) = 0 then decode(repeat('ab', 2*1024*1024), 'hex') end as big_bytea, \
      case when g % 1000 = 0 then decode(repeat('cd', 512), 'hex') end as small_bytea \
      from generate_series(1,{n}) g")
}

async fn big(name: &str, sql: &str, sink_kind: &str) {
    let mut s = PostgresDriver.connect_concrete(cfg()).await.unwrap();
    mem("connected");
    let t = Instant::now();
    if sink_kind == "null" {
        let sum = s.execute(req(sql), &NullSink).await.unwrap();
        println!("RESULT {name} sink=null rows_returned={} ms={}", sum.rows_returned, t.elapsed().as_millis());
        mem("after_query");
    } else {
        let sink = StoreSink::new();
        let sum = s.execute(req(sql), &sink).await.unwrap();
        let ms = t.elapsed().as_millis();
        let b = *sink.batches.lock().unwrap();
        let mut store = sink.inner.into_inner().unwrap();
        mem("after_query_before_shrink");
        store.shrink_to_fit();
        trim();
        println!("RESULT {name} sink=store rows_returned={} stored={} store_seen={} truncated={} text_bytes={} ram_compressed={} spilled={} blocks={} batches={} max_batch_rows={} ms={}",
            sum.rows_returned, store.stored(), store.total_seen(), store.truncated() || sum.rows_returned > store.stored() as u64,
            store.bytes(), store.ram_bytes(), store.file_bytes(), store.blocks(), b.0, b.1, ms);
        mem("result_held_after_shrink_trim");
        // integrity: read first and last stored row
        let n = store.stored();
        let t2 = Instant::now();
        let w = store.window(n.saturating_sub(1), 1).unwrap();
        println!("LASTROW len={} read_us={}", w.get(0).map_or(0, |r| r.len()), t2.elapsed().as_micros());
        println!("FDS result_held={}", fds());
        drop(w);
        drop(store);
        mem("after_drop_no_trim");
        trim();
        mem("after_drop_and_trim");
    }
    drop(s);
    tokio::time::sleep(Duration::from_millis(200)).await;
    trim();
    mem("after_disconnect_trim");
}

async fn sessions(ctl: &mut tuplenest_driver_postgres::PostgresSession) -> String {
    struct Cap(Mutex<String>);
    #[async_trait]
    impl BatchSink for Cap { async fn deliver(&self, b: RowBatch) -> Result<(), Box<DriverError>> {
        for r in b.rows { *self.0.lock().unwrap() = format!("{:?}", r[0]); } Ok(()) } }
    let c = Cap(Mutex::new(String::new()));
    ctl.execute(req("select count(*) from pg_stat_activity where datname='tuplenest_audit_rust' and pid <> pg_backend_pid()"), &c).await.unwrap();
    let v = c.0.lock().unwrap().clone(); v
}

async fn seq() {
    let mut ctl = PostgresDriver.connect_concrete(cfg()).await.unwrap();
    let mut s = PostgresDriver.connect_concrete(cfg()).await.unwrap();
    // warm-up
    for _ in 0..3 { let sink = StoreSink::new(); s.execute(req(&wide_sql(10_000)), &sink).await.unwrap(); }
    trim();
    let (f0, r0) = footprint(); let fd0 = fds();
    println!("SEQ before: footprint={:.1}MB rss={:.1}MB fds={} other_sessions={}", mb(f0), mb(r0), fd0, sessions(&mut ctl).await);
    let t = Instant::now();
    let mut prev: Option<RowStore> = None;
    for i in 0..100 {
        let sink = StoreSink::new();
        s.execute(req(&wide_sql(10_000)), &sink).await.unwrap();
        let mut st = sink.inner.into_inner().unwrap();
        st.shrink_to_fit();
        drop(prev.replace(st)); // as the app: new result replaces old
        trim();
        if i % 25 == 24 { let (f, r) = footprint(); println!("SEQ iter {}: footprint={:.1}MB rss={:.1}MB", i + 1, mb(f), mb(r)); }
    }
    drop(prev); trim();
    let (f1, r1) = footprint();
    println!("SEQ after 100 queries ({} ms): footprint={:.1}MB rss={:.1}MB fds={} other_sessions={}", t.elapsed().as_millis(), mb(f1), mb(r1), fds(), sessions(&mut ctl).await);
}

async fn conn() {
    let mut ctl = PostgresDriver.connect_concrete(cfg()).await.unwrap();
    for _ in 0..3 { let s = PostgresDriver.connect_concrete(cfg()).await.unwrap(); drop(s); }
    tokio::time::sleep(Duration::from_millis(500)).await; trim();
    let (f0, r0) = footprint();
    println!("CONN before: footprint={:.1}MB rss={:.1}MB fds={} other_sessions={}", mb(f0), mb(r0), fds(), sessions(&mut ctl).await);
    let t = Instant::now();
    for _ in 0..100 {
        let mut s = PostgresDriver.connect_concrete(cfg()).await.unwrap();
        s.execute(req("select 1"), &NullSink).await.unwrap();
        drop(s);
    }
    let ms = t.elapsed().as_millis();
    println!("CONN immediately after 100 cycles ({ms} ms): fds={} other_sessions={}", fds(), sessions(&mut ctl).await);
    tokio::time::sleep(Duration::from_millis(1500)).await; trim();
    let (f1, r1) = footprint();
    println!("CONN after settle: footprint={:.1}MB rss={:.1}MB fds={} other_sessions={}", mb(f1), mb(r1), fds(), sessions(&mut ctl).await);
}

async fn kill() {
    let mut ctl = PostgresDriver.connect_concrete(cfg()).await.unwrap();
    let mut s = PostgresDriver.connect_concrete(cfg()).await.unwrap();
    let h = tokio::spawn(async move {
        let r = s.execute(req("select pg_sleep(20)"), &NullSink).await;
        let first = r.err().map(|e| format!("category={:?} title={:?} code={:?} msg={:?}", e.category, e.title, e.native_code, e.original_message));
        let broken1 = s.is_broken();
        let r2 = s.execute(req("select 1"), &NullSink).await;
        let second = r2.err().map(|e| format!("category={:?} title={:?} msg={:?}", e.category, e.title, e.original_message));
        (first, broken1, second, s.is_broken())
    });
    tokio::time::sleep(Duration::from_millis(1500)).await;
    ctl.execute(req("select pg_terminate_backend(pid) from pg_stat_activity where datname='tuplenest_audit_rust' and query like 'select pg_sleep%' and pid <> pg_backend_pid()"), &NullSink).await.unwrap();
    let (first, b1, second, b2) = h.await.unwrap();
    println!("KILL first_error: {first:?}\nKILL is_broken_after_first={b1}\nKILL second_error: {second:?}\nKILL is_broken_after_second={b2}");
}

async fn cancel_then_reuse() {
    let mut s = PostgresDriver.connect_concrete(cfg()).await.unwrap();
    let h = s.cancel_handle();
    let t = Instant::now();
    let c = tokio::spawn(async move { tokio::time::sleep(Duration::from_millis(800)).await; h.cancel().await.map_err(|e| e.title.clone()) });
    let r = s.execute(req(&wide_sql(50_000_000)), &StoreSink::new()).await;
    println!("CANCEL streaming query: err={:?} after {} ms; cancel_call={:?}", r.err().map(|e| (e.category, e.title.clone())), t.elapsed().as_millis(), c.await.unwrap());
    let r2 = s.execute(req("select 1"), &NullSink).await;
    println!("CANCEL reuse session ok={} broken={}", r2.is_ok(), s.is_broken());
}

async fn sshhang() {
    // A listener that accepts TCP and never speaks SSH.
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move { let mut keep = vec![]; loop { if let Ok((s, _)) = l.accept().await { keep.push(s); } } });
    let cfg = tuplenest_ssh_core::SshTunnelConfig {
        ssh_host: "127.0.0.1".into(), ssh_port: port, username: "x".into(),
        auth: tuplenest_ssh_core::SshAuth::KeyFile { path: "/nonexistent".into(), passphrase: None },
        host_key: tuplenest_ssh_core::HostKeyPolicy::KnownHosts, target_host: "localhost".into(), target_port: 5432 };
    let secs: u64 = std::env::var("HANG_SECS").ok().and_then(|s| s.parse().ok()).unwrap_or(45);
    let t = Instant::now();
    match tokio::time::timeout(Duration::from_secs(secs), tuplenest_ssh_core::open_tunnel(cfg)).await {
        Ok(r) => println!("SSHHANG returned after {} ms: {:?}", t.elapsed().as_millis(), r.err().map(|e| e.to_string())),
        Err(_) => println!("SSHHANG open_tunnel still pending after {secs}s against a silent TCP peer (harness gave up)"),
    }
}

fn spill() {
    // 1) normal spill round-trip with a tiny RAM limit
    let before = fds();
    let mut st = RowStore::with_budget(200_000, usize::MAX).with_layout(8 * 1024, 64 * 1024);
    for i in 0..200_000u32 { st.push(&format!("[{i},\"row-{i}-{}\"]", "p".repeat((i % 97) as usize))); }
    st.shrink_to_fit();
    let mut ok = true; let mut n = 0usize;
    st.for_each(|i, r| { n += 1; if !r.starts_with(&format!("[{i},")) { ok = false; } }).unwrap();
    println!("SPILL normal: stored={} spilled={} file_bytes={} ram_bytes={} scan_rows={} intact={} fds_delta={}", st.stored(), st.spilled(), st.file_bytes(), st.ram_bytes(), n, ok, fds() as i64 - before as i64);
    drop(st);
    println!("SPILL after drop: fds_delta={}", fds() as i64 - before as i64);
    // 2) temp dir missing: spill must fail -> RAM fallback
    std::env::set_var("TMPDIR", "/nonexistent-audit-tmp-dir");
    let mut st = RowStore::with_budget(200_000, usize::MAX).with_layout(8 * 1024, 64 * 1024);
    for i in 0..200_000u32 { st.push(&format!("[{i},\"row-{i}\"]")); }
    st.shrink_to_fit();
    let mut ok = true; let mut n = 0usize;
    st.for_each(|i, r| { n += 1; if !r.starts_with(&format!("[{i},")) { ok = false; } }).unwrap();
    println!("SPILL tmp-missing: tempdir={:?} stored={} spilled={} file_bytes={} ram_bytes={} (ram_limit=65536) scan_rows={} intact={}", std::env::temp_dir(), st.stored(), st.spilled(), st.file_bytes(), st.ram_bytes(), n, ok);
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(4).max_blocking_threads(16).enable_all().build().unwrap();
    mem("start");
    rt.block_on(async {
        match args[1].as_str() {
            "narrow" => big("narrow", &format!("select g, md5(g::text) as h from generate_series(1,{}) g", args[2]), &args[3]).await,
            "wide" => big("wide50", &wide_sql(args[2].parse().unwrap()), &args[3]).await,
            "mixed" => big("mixed", &mixed_sql(args[2].parse().unwrap()), &args[3]).await,
            "sql" => big("sql", &args[2], &args[3]).await,
            "seq" => seq().await,
            "conn" => conn().await,
            "kill" => kill().await,
            "cancel" => cancel_then_reuse().await,
            "sshhang" => sshhang().await,
            "spill" => spill(),
            _ => panic!("unknown"),
        }
    });
}
