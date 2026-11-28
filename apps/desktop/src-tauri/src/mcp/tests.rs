//! The MCP server end to end, over in-memory pipes, against a fake database
//! and an in-memory keychain. Nothing here touches the OS keychain.

use std::sync::{Arc, Mutex as StdMutex};

use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tuplenest_credential_store::{CredentialStore, MemoryStore, Secret};
use tuplenest_driver_api::{
    BatchSink, CellValue, ColumnMeta, DriverError, ExecutionId, ExecutionStatus, ExecutionSummary,
    QueryRequest, RowBatch,
};
use tuplenest_workspace_store::{ConnectionRecord, McpAccess, Store};

use super::backend::{Connector, OpenTarget, Session};
use super::server::{check_statement, McpServer, ROW_CAP};
use super::{serve, Protocol};

// ---- a fake database -------------------------------------------------------

#[derive(Default)]
struct Log {
    /// `read_only` of every session opened, in order.
    opened_read_only: Vec<bool>,
    /// The password each open was given.
    passwords: Vec<Option<String>>,
    /// Every statement executed.
    executed: Vec<String>,
    /// Audit rows that existed when each statement executed.
    audit_rows_at_execute: Vec<usize>,
}

struct FakeDb {
    log: Arc<StdMutex<Log>>,
    store: Arc<StdMutex<Store>>,
    rows: usize,
}

struct FakeSession {
    log: Arc<StdMutex<Log>>,
    store: Arc<StdMutex<Store>>,
    rows: usize,
}

#[async_trait]
impl Session for FakeSession {
    async fn execute(
        &mut self,
        request: QueryRequest,
        sink: &dyn BatchSink,
    ) -> Result<ExecutionSummary, Box<DriverError>> {
        let audited = self.store.lock().unwrap().audit_list(10_000).unwrap().len();
        {
            let mut log = self.log.lock().unwrap();
            log.executed.push(request.sql.clone());
            log.audit_rows_at_execute.push(audited);
        }
        let rows: Vec<Vec<CellValue>> = (0..self.rows)
            .map(|i| vec![CellValue::Text(format!("row {i}"))])
            .collect();
        let mut delivered = 0u64;
        for chunk in rows.chunks(100) {
            if !sink.wants_rows() {
                break;
            }
            delivered += chunk.len() as u64;
            sink.deliver(RowBatch {
                execution_id: request.execution_id,
                sequence: 0,
                columns: vec![ColumnMeta {
                    name: "x".into(),
                    db_type: "text".into(),
                    nullable: None,
                }],
                rows: chunk.to_vec(),
                is_last: false,
            })
            .await?;
        }
        Ok(ExecutionSummary {
            execution_id: ExecutionId::new(),
            status: ExecutionStatus::Success,
            rows_affected: None,
            rows_returned: delivered,
            more_rows: delivered < self.rows as u64,
            duration_ms: 1,
            messages: vec![],
        })
    }
}

#[async_trait]
impl Connector for FakeDb {
    async fn open(&self, target: OpenTarget) -> Result<Box<dyn Session>, String> {
        let mut log = self.log.lock().unwrap();
        log.opened_read_only.push(target.config.read_only);
        log.passwords
            .push(target.password.as_ref().map(|s| s.expose().to_string()));
        Ok(Box::new(FakeSession {
            log: self.log.clone(),
            store: self.store.clone(),
            rows: self.rows,
        }))
    }
}

struct Fixture {
    store: Arc<StdMutex<Store>>,
    keychain: Arc<MemoryStore>,
    log: Arc<StdMutex<Log>>,
    rows: usize,
}

impl Fixture {
    fn new() -> Self {
        Self::with_store(Store::open_in_memory().unwrap())
    }

    fn with_store(store: Store) -> Self {
        Self {
            store: Arc::new(StdMutex::new(store)),
            keychain: Arc::new(MemoryStore::new()),
            log: Arc::default(),
            rows: 1,
        }
    }

    /// Saves a profile and gives it `access`.
    fn profile(&self, id: &str, env: &str, access: McpAccess) -> ConnectionRecord {
        let password = self.keychain.set(Secret::new(format!("pw-{id}"))).unwrap();
        let rec = ConnectionRecord {
            id: id.into(),
            name: format!("{id} db"),
            engine: "postgres".into(),
            environment: Some(env.into()),
            color: None,
            read_only: false,
            host: format!("{id}.internal"),
            port: 5432,
            database: "app".into(),
            username: "ops".into(),
            secret_ref: Some(password.key().to_string()),
            tls_mode: "verify-full".into(),
            tls_ca_path: None,
            ssh_json: None,
            options_json: None,
            statement_timeout_ms: 0,
        };
        let store = self.store.lock().unwrap();
        store.connection_upsert(&rec).unwrap();
        store.mcp_access_set(id, access).unwrap();
        rec
    }

    fn server(&self) -> McpServer {
        let mut server = McpServer::new(
            self.store.clone(),
            self.keychain.clone(),
            Arc::new(FakeDb {
                log: self.log.clone(),
                store: self.store.clone(),
                rows: self.rows,
            }),
        );
        server.set_client(Some("Claude Desktop"));
        server
    }

    fn executed(&self) -> Vec<String> {
        self.log.lock().unwrap().executed.clone()
    }
}

async fn call(server: &mut McpServer, tool: &str, args: Value) -> (Value, bool) {
    let out = server.call_tool(tool, &args).await.expect("a known tool");
    let value = serde_json::from_str(&out.text).unwrap_or(Value::String(out.text.clone()));
    (value, out.is_error)
}

// ---- the protocol over pipes -----------------------------------------------

/// A client talking to a running server through in-memory pipes.
struct Client {
    write: tokio::io::WriteHalf<tokio::io::DuplexStream>,
    read: tokio::io::Lines<BufReader<tokio::io::ReadHalf<tokio::io::DuplexStream>>>,
    server: tokio::task::JoinHandle<std::io::Result<()>>,
}

impl Client {
    fn start(server: McpServer) -> Self {
        let (client_end, server_end) = tokio::io::duplex(1 << 16);
        let (sr, sw) = tokio::io::split(server_end);
        let server = tokio::spawn(serve(BufReader::new(sr), sw, Protocol::new(server)));
        let (cr, cw) = tokio::io::split(client_end);
        Self {
            write: cw,
            read: BufReader::new(cr).lines(),
            server,
        }
    }

    async fn send(&mut self, msg: &str) {
        self.write.write_all(msg.as_bytes()).await.unwrap();
        self.write.write_all(b"\n").await.unwrap();
    }

    async fn recv(&mut self) -> Value {
        let line = self.read.next_line().await.unwrap().expect("a reply");
        serde_json::from_str(&line).expect("each line is one JSON message")
    }

    async fn request(&mut self, msg: Value) -> Value {
        self.send(&msg.to_string()).await;
        self.recv().await
    }

    async fn initialize(&mut self) -> Value {
        self.request(json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2025-03-26", "capabilities": {},
                       "clientInfo": {"name": "Claude Desktop", "version": "1.0"}}
        }))
        .await
    }
}

#[tokio::test]
async fn handshake_then_tool_listing() {
    let f = Fixture::new();
    let mut c = Client::start(f.server());
    let init = c.initialize().await;
    assert_eq!(init["id"], 1);
    assert_eq!(init["result"]["protocolVersion"], "2025-03-26");
    assert_eq!(init["result"]["serverInfo"]["name"], "tuplenest");
    assert!(init["result"]["capabilities"]["tools"].is_object());

    // A notification gets no reply: the next line read is the ping's.
    c.send(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#)
        .await;
    let pong = c
        .request(json!({"jsonrpc": "2.0", "id": "p", "method": "ping"}))
        .await;
    assert_eq!(pong, json!({"jsonrpc": "2.0", "id": "p", "result": {}}));

    let tools = c
        .request(json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}))
        .await;
    let names: Vec<&str> = tools["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        [
            "list_connections",
            "list_schemas",
            "list_tables",
            "describe_table",
            "run_query",
            "explain"
        ]
    );
    for t in tools["result"]["tools"].as_array().unwrap() {
        assert_eq!(t["inputSchema"]["type"], "object", "{}", t["name"]);
        assert_eq!(t["inputSchema"]["additionalProperties"], false);
    }

    // Closing the input ends the server cleanly.
    c.write.shutdown().await.unwrap();
    c.server.await.unwrap().unwrap();
}

#[tokio::test]
async fn an_unknown_protocol_version_gets_the_newest() {
    let f = Fixture::new();
    let mut c = Client::start(f.server());
    let init = c
        .request(json!({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                        "params": {"protocolVersion": "1999-01-01"}}))
        .await;
    assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
}

#[tokio::test]
async fn malformed_and_unknown_messages_get_json_rpc_errors() {
    let f = Fixture::new();
    let mut c = Client::start(f.server());

    c.send("{not json").await;
    assert_eq!(c.recv().await["error"]["code"], -32700);

    c.send(r#"[{"jsonrpc":"2.0","id":1,"method":"ping"}]"#)
        .await;
    assert_eq!(c.recv().await["error"]["code"], -32600);

    let before_init = c
        .request(json!({"jsonrpc": "2.0", "id": 3, "method": "tools/list"}))
        .await;
    assert_eq!(before_init["error"]["code"], -32600);

    let no_version = c.request(json!({"id": 4, "method": "ping"})).await;
    assert_eq!(no_version["error"]["code"], -32600);

    let no_method = c.request(json!({"jsonrpc": "2.0", "id": 5})).await;
    assert_eq!(no_method["error"]["code"], -32600);

    c.initialize().await;
    let unknown = c
        .request(json!({"jsonrpc": "2.0", "id": 6, "method": "resources/list"}))
        .await;
    assert_eq!(unknown["error"]["code"], -32601);

    let bad_tool = c
        .request(json!({"jsonrpc": "2.0", "id": 7, "method": "tools/call",
                        "params": {"name": "drop_everything", "arguments": {}}}))
        .await;
    assert_eq!(bad_tool["error"]["code"], -32602);

    let no_name = c
        .request(json!({"jsonrpc": "2.0", "id": 8, "method": "tools/call", "params": {}}))
        .await;
    assert_eq!(no_name["error"]["code"], -32602);

    // A response from the client (to a request never made) is ignored; the
    // next reply is the ping's.
    c.send(r#"{"jsonrpc":"2.0","id":99,"result":{}}"#).await;
    let pong = c
        .request(json!({"jsonrpc": "2.0", "id": 9, "method": "ping"}))
        .await;
    assert_eq!(pong["id"], 9);
}

#[tokio::test]
async fn a_line_too_long_is_refused_and_the_stream_goes_on() {
    let f = Fixture::new();
    let mut c = Client::start(f.server());
    // Written from a task: the server reads while this is still writing.
    let mut write = c.write;
    let writer = tokio::spawn(async move {
        let big = vec![b'x'; super::LINE_MAX + 10];
        write.write_all(&big).await.unwrap();
        write.write_all(b"\n").await.unwrap();
        write
            .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}\n")
            .await
            .unwrap();
        write
    });
    let refused = c.read.next_line().await.unwrap().unwrap();
    assert!(refused.contains("Message too large"), "{refused}");
    let pong: Value = serde_json::from_str(&c.read.next_line().await.unwrap().unwrap()).unwrap();
    assert_eq!(pong["id"], 1);
    drop(writer.await.unwrap());
}

#[tokio::test]
async fn a_tool_call_over_the_pipe_carries_its_result_as_text() {
    let f = Fixture::new();
    f.profile("dev", "dev", McpAccess::ReadOnly);
    let mut c = Client::start(f.server());
    c.initialize().await;
    let reply = c
        .request(json!({"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                        "params": {"name": "list_connections"}}))
        .await;
    assert_eq!(reply["result"]["isError"], false);
    let text = reply["result"]["content"][0]["text"].as_str().unwrap();
    let body: Value = serde_json::from_str(text).unwrap();
    assert_eq!(body["connections"][0]["id"], "dev");
}

// ---- visibility ------------------------------------------------------------

#[tokio::test]
async fn an_off_connection_is_invisible_and_unusable() {
    let f = Fixture::new();
    f.profile("hidden", "dev", McpAccess::Off);
    f.profile("shown", "dev", McpAccess::ReadOnly);
    let mut s = f.server();

    let (list, err) = call(&mut s, "list_connections", json!({})).await;
    assert!(!err);
    let ids: Vec<&str> = list["connections"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["shown"]);

    // By id, by name, and a name that never existed: one answer for all.
    let mut answers = Vec::new();
    for name in ["hidden", "hidden db", "never-saved"] {
        let (out, err) = call(
            &mut s,
            "run_query",
            json!({"connection": name, "sql": "select 1"}),
        )
        .await;
        assert!(err, "{name}");
        answers.push(out);
    }
    assert!(answers.iter().all(|a| *a == answers[0]));
    for tool in ["list_schemas", "explain"] {
        let (_, err) = call(
            &mut s,
            tool,
            json!({"connection": "hidden", "sql": "select 1"}),
        )
        .await;
        assert!(err);
    }
    assert!(
        f.log.lock().unwrap().opened_read_only.is_empty(),
        "nothing was opened"
    );
}

#[tokio::test]
async fn the_listing_shows_no_secrets() {
    let f = Fixture::new();
    f.profile("p", "prod", McpAccess::ReadOnly);
    let mut s = f.server();
    let (list, _) = call(&mut s, "list_connections", json!({})).await;
    let c = &list["connections"][0];
    assert_eq!(c["environment"], "prod");
    assert_eq!(c["access"], "read_only");
    assert_eq!(c["engine"], "postgresql");
    assert_eq!(c["host"], "p.internal");
    let text = list.to_string();
    assert!(!text.contains("tn-secret"), "{text}");
    assert!(!text.contains("pw-p"), "{text}");
    assert!(!text.contains("ops"), "no user name: {text}");
}

#[tokio::test]
async fn switching_a_connection_off_takes_effect_on_the_next_call() {
    let f = Fixture::new();
    f.profile("dev", "dev", McpAccess::ReadOnly);
    let mut s = f.server();
    let (_, err) = call(
        &mut s,
        "run_query",
        json!({"connection": "dev", "sql": "select 1"}),
    )
    .await;
    assert!(!err);
    f.store
        .lock()
        .unwrap()
        .mcp_access_set("dev", McpAccess::Off)
        .unwrap();
    let (_, err) = call(
        &mut s,
        "run_query",
        json!({"connection": "dev", "sql": "select 2"}),
    )
    .await;
    assert!(err);
    assert_eq!(f.executed(), ["select 1"]);
}

// ---- read only -------------------------------------------------------------

#[tokio::test]
async fn read_only_opens_a_server_enforced_read_only_session() {
    let f = Fixture::new();
    f.profile("dev", "dev", McpAccess::ReadOnly);
    let mut s = f.server();
    let (out, err) = call(
        &mut s,
        "run_query",
        json!({"connection": "dev db", "sql": "select x from t"}),
    )
    .await;
    assert!(!err, "{out}");
    assert_eq!(out["rows"], json!([["row 0"]]));
    assert_eq!(out["columns"], json!([{"name": "x", "type": "text"}]));
    assert_eq!(out["truncated"], false);
    let log = f.log.lock().unwrap();
    // `read_only` is what makes the driver set the session READ ONLY,
    // re-check it before each statement, and send only what reads.
    assert_eq!(log.opened_read_only, [true]);
    assert_eq!(log.passwords, [Some("pw-dev".to_string())]);
}

#[tokio::test]
async fn a_prod_profile_is_read_only_at_most() {
    let f = Fixture::new();
    f.profile("p", "prod", McpAccess::ReadOnly);
    let err = f
        .store
        .lock()
        .unwrap()
        .mcp_access_set("p", McpAccess::ReadWrite)
        .unwrap_err();
    assert!(err.to_string().contains("prod or staging"), "{err}");
    let mut s = f.server();
    call(
        &mut s,
        "run_query",
        json!({"connection": "p", "sql": "select 1"}),
    )
    .await;
    assert_eq!(f.log.lock().unwrap().opened_read_only, [true]);
}

#[tokio::test]
async fn a_profile_marked_read_only_in_the_app_stays_read_only() {
    let f = Fixture::new();
    let mut rec = f.profile("dev", "dev", McpAccess::ReadWrite);
    rec.read_only = true;
    f.store.lock().unwrap().connection_upsert(&rec).unwrap();
    let mut s = f.server();
    let (list, _) = call(&mut s, "list_connections", json!({})).await;
    assert_eq!(list["connections"][0]["access"], "read_only");
    call(
        &mut s,
        "run_query",
        json!({"connection": "dev", "sql": "select 1"}),
    )
    .await;
    assert_eq!(f.log.lock().unwrap().opened_read_only, [true]);
}

// ---- read and write --------------------------------------------------------

#[tokio::test]
async fn read_write_refuses_what_the_guard_would_ask_about() {
    let f = Fixture::new();
    f.profile("dev", "dev", McpAccess::ReadWrite);
    let mut s = f.server();
    for sql in [
        "DELETE FROM users",
        "UPDATE users SET active = false WHERE 1=1",
        "DROP TABLE users",
        "TRUNCATE users",
        "ALTER TABLE users ADD COLUMN x int",
        "GRANT ALL ON users TO public",
        "REVOKE ALL ON users FROM public",
        "DO $$ BEGIN DELETE FROM users; END $$",
        "CALL purge()",
        "COPY users FROM '/tmp/x.csv'",
        "EXPLAIN ANALYZE DELETE FROM users",
    ] {
        let (out, err) = call(
            &mut s,
            "run_query",
            json!({"connection": "dev", "sql": sql}),
        )
        .await;
        assert!(err, "{sql} should be refused");
        let text = out.as_str().unwrap_or_default();
        assert!(text.starts_with("Refused:"), "{sql}: {text}");
        assert!(text.contains("Nothing was run"), "{sql}: {text}");
    }
    assert!(f.executed().is_empty(), "{:?}", f.executed());

    // What the guard lets through runs, on a writable session.
    for sql in [
        "UPDATE users SET active = false WHERE id = 7",
        "INSERT INTO users (name) VALUES ('ada')",
        "DELETE FROM users WHERE id = 7",
    ] {
        let (out, err) = call(
            &mut s,
            "run_query",
            json!({"connection": "dev", "sql": sql}),
        )
        .await;
        assert!(!err, "{sql}: {out}");
    }
    assert_eq!(f.executed().len(), 3);
    assert_eq!(f.log.lock().unwrap().opened_read_only, [false]);
}

#[tokio::test]
async fn a_change_of_access_reopens_the_session() {
    let f = Fixture::new();
    f.profile("dev", "dev", McpAccess::ReadWrite);
    let mut s = f.server();
    call(
        &mut s,
        "run_query",
        json!({"connection": "dev", "sql": "select 1"}),
    )
    .await;
    call(
        &mut s,
        "run_query",
        json!({"connection": "dev", "sql": "select 2"}),
    )
    .await;
    f.store
        .lock()
        .unwrap()
        .mcp_access_set("dev", McpAccess::ReadOnly)
        .unwrap();
    call(
        &mut s,
        "run_query",
        json!({"connection": "dev", "sql": "select 3"}),
    )
    .await;
    assert_eq!(f.log.lock().unwrap().opened_read_only, [false, true]);
}

#[test]
fn every_access_refuses_several_statements_and_transaction_control() {
    for access in [McpAccess::ReadOnly, McpAccess::ReadWrite] {
        for sql in [
            "select 1; select 2",
            "select 1;delete from t",
            "BEGIN",
            "begin; update t set a = 1 where id = 1",
            "COMMIT",
            "ROLLBACK",
            "SAVEPOINT a",
            "RELEASE SAVEPOINT a",
            "START TRANSACTION",
            "   ",
            "-- only a comment",
        ] {
            assert!(check_statement(access, sql).is_err(), "{access:?}: {sql}");
        }
        for sql in [
            "select 1;",
            "select 1 ;  \n",
            "select ';' as semi",
            "select $$a;b$$",
            "select 1 -- ; trailing",
        ] {
            assert!(check_statement(access, sql).is_ok(), "{access:?}: {sql}");
        }
    }
    assert!(check_statement(McpAccess::Off, "select 1").is_err());
}

// ---- audit and history -----------------------------------------------------

#[tokio::test]
async fn prod_and_staging_statements_are_audited_before_they_run() {
    let f = Fixture::new();
    f.profile("p", "prod", McpAccess::ReadOnly);
    f.profile("s", "staging", McpAccess::ReadOnly);
    f.profile("d", "dev", McpAccess::ReadOnly);
    let mut s = f.server();
    for c in ["p", "s", "d"] {
        let (out, err) = call(
            &mut s,
            "run_query",
            json!({"connection": c, "sql": "select 1"}),
        )
        .await;
        assert!(!err, "{out}");
    }
    let (_, err) = call(
        &mut s,
        "explain",
        json!({"connection": "p", "sql": "select 2"}),
    )
    .await;
    assert!(!err);

    let audit = f.store.lock().unwrap().audit_list(10).unwrap();
    assert_eq!(
        audit.len(),
        3,
        "prod, staging, and the prod explain; not dev"
    );
    for row in &audit {
        assert_eq!(row.actor.as_deref(), Some("MCP · Claude Desktop"));
    }
    let envs: Vec<_> = audit
        .iter()
        .map(|a| a.environment.clone().unwrap())
        .collect();
    assert!(envs.contains(&"prod".to_string()) && envs.contains(&"staging".to_string()));
    assert!(audit.iter().any(|a| a.sql_text == "EXPLAIN select 2"));
    // Each audited statement's row was already there when it executed.
    assert_eq!(f.log.lock().unwrap().audit_rows_at_execute, [1, 2, 2, 3]);
}

#[tokio::test]
async fn a_failed_audit_write_refuses_the_statement() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("tuplenest.db");
    let f = Fixture::with_store(Store::open(&path).unwrap());
    f.profile("p", "prod", McpAccess::ReadOnly);
    // As a full disk or a damaged file would: the insert fails.
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute_batch(
            "CREATE TRIGGER no_audit BEFORE INSERT ON audit_log
             BEGIN SELECT RAISE(FAIL, 'disk I/O error'); END;",
        )
        .unwrap();
    let mut s = f.server();
    let (out, err) = call(
        &mut s,
        "run_query",
        json!({"connection": "p", "sql": "select * from payments"}),
    )
    .await;
    assert!(err);
    let text = out.as_str().unwrap();
    assert!(text.starts_with("Not run:"), "{text}");
    assert!(text.contains("audit log"), "{text}");
    assert!(f.executed().is_empty(), "nothing reached the database");
}

#[tokio::test]
async fn history_records_the_mcp_client_and_hides_prod_sql() {
    let f = Fixture::new();
    f.profile("p", "prod", McpAccess::ReadOnly);
    f.profile("d", "dev", McpAccess::ReadOnly);
    let mut s = f.server();
    call(
        &mut s,
        "run_query",
        json!({"connection": "d", "sql": "select 'dev'"}),
    )
    .await;
    call(
        &mut s,
        "run_query",
        json!({"connection": "p", "sql": "select 'prod'"}),
    )
    .await;
    call(
        &mut s,
        "run_query",
        json!({"connection": "d", "sql": "-- tuplenest:no-history\nselect 'quiet'"}),
    )
    .await;
    let history = f.store.lock().unwrap().history_list(None, 10).unwrap();
    assert_eq!(history.len(), 2, "the no-history statement left no row");
    for h in &history {
        assert_eq!(h.actor.as_deref(), Some("MCP · Claude Desktop"));
        assert_eq!(h.status, "success");
    }
    let texts: Vec<_> = history.iter().map(|h| h.sql_text.clone()).collect();
    assert!(texts.contains(&Some("select 'dev'".into())));
    assert!(texts.contains(&None), "prod keeps no SQL in history");
}

#[tokio::test]
async fn metadata_reads_are_neither_audited_nor_in_history() {
    let f = Fixture::new();
    f.profile("p", "prod", McpAccess::ReadOnly);
    let mut s = f.server();
    let (out, err) = call(&mut s, "list_schemas", json!({"connection": "p"})).await;
    assert!(!err, "{out}");
    assert_eq!(out["schemas"], json!(["row 0"]));
    let (out, err) = call(
        &mut s,
        "list_tables",
        json!({"connection": "p", "schema": "public"}),
    )
    .await;
    assert!(!err, "{out}");
    assert_eq!(out["tables"][0]["name"], "row 0");
    let (out, err) = call(
        &mut s,
        "describe_table",
        json!({"connection": "p", "schema": "public", "table": "users"}),
    )
    .await;
    assert!(!err, "{out}");
    assert_eq!(out["columns"][0]["name"], "row 0");
    assert_eq!(out["indexes"][0]["definition"], Value::Null);
    let store = f.store.lock().unwrap();
    assert!(store.audit_list(10).unwrap().is_empty());
    assert!(store.history_list(None, 10).unwrap().is_empty());
}

// ---- results and inputs ----------------------------------------------------

#[tokio::test]
async fn results_stop_at_the_row_cap_and_say_so() {
    let mut f = Fixture::new();
    f.rows = ROW_CAP + 100;
    f.profile("d", "dev", McpAccess::ReadOnly);
    let mut s = f.server();
    let (out, err) = call(
        &mut s,
        "run_query",
        json!({"connection": "d", "sql": "select x"}),
    )
    .await;
    assert!(!err);
    assert_eq!(out["rows"].as_array().unwrap().len(), ROW_CAP);
    assert_eq!(out["rowCount"], ROW_CAP);
    assert_eq!(out["truncated"], true);
}

/// Phase 2 safety verification, guarantee 5: at most 1 MB per result, as
/// well as at most 500 rows. Rows of 64 KiB each: the byte cap is reached
/// at the 16th, long before the row cap.
#[tokio::test]
async fn results_stop_at_the_byte_cap_and_say_so() {
    struct WideDb;
    struct WideSession;
    #[async_trait]
    impl Session for WideSession {
        async fn execute(
            &mut self,
            request: QueryRequest,
            sink: &dyn BatchSink,
        ) -> Result<ExecutionSummary, Box<DriverError>> {
            let mut delivered = 0u64;
            for _ in 0..100 {
                if !sink.wants_rows() {
                    break;
                }
                delivered += 1;
                sink.deliver(RowBatch {
                    execution_id: request.execution_id,
                    sequence: 0,
                    columns: vec![ColumnMeta {
                        name: "doc".into(),
                        db_type: "text".into(),
                        nullable: None,
                    }],
                    rows: vec![vec![CellValue::Text("x".repeat(64 * 1024))]],
                    is_last: false,
                })
                .await?;
            }
            Ok(ExecutionSummary {
                execution_id: ExecutionId::new(),
                status: ExecutionStatus::Success,
                rows_affected: None,
                rows_returned: delivered,
                more_rows: false,
                duration_ms: 1,
                messages: vec![],
            })
        }
    }
    #[async_trait]
    impl Connector for WideDb {
        async fn open(&self, _: OpenTarget) -> Result<Box<dyn Session>, String> {
            Ok(Box::new(WideSession))
        }
    }

    let f = Fixture::new();
    f.profile("d", "dev", McpAccess::ReadOnly);
    let mut s = McpServer::new(f.store.clone(), f.keychain.clone(), Arc::new(WideDb));
    let (out, err) = call(
        &mut s,
        "run_query",
        json!({"connection": "d", "sql": "select doc from big"}),
    )
    .await;
    assert!(!err, "{out}");
    let rows = out["rows"].as_array().unwrap();
    assert!(!rows.is_empty() && rows.len() < 16, "{} rows", rows.len());
    assert_eq!(out["truncated"], true);
    let bytes: usize = rows.iter().map(|r| r.to_string().len()).sum();
    assert!(
        bytes <= super::server::BYTE_CAP,
        "{bytes} bytes of rows returned"
    );
}

#[tokio::test]
async fn explain_never_runs_the_statement() {
    let f = Fixture::new();
    f.profile("d", "dev", McpAccess::ReadWrite);
    let mut s = f.server();
    for sql in [
        "ANALYZE DELETE FROM users",
        "(ANALYZE) DELETE FROM users",
        "EXPLAIN ANALYZE DELETE FROM users",
        "VERBOSE SELECT 1",
        "DROP TABLE users",
    ] {
        let (out, err) = call(&mut s, "explain", json!({"connection": "d", "sql": sql})).await;
        assert!(err, "{sql}: {out}");
    }
    assert!(f.executed().is_empty());
    let (out, err) = call(
        &mut s,
        "explain",
        json!({"connection": "d", "sql": "DELETE FROM users"}),
    )
    .await;
    assert!(!err, "{out}");
    assert_eq!(out["plan"], "row 0");
    assert_eq!(f.executed(), ["EXPLAIN DELETE FROM users"]);
}

#[tokio::test]
async fn every_input_is_validated() {
    let f = Fixture::new();
    f.profile("d", "dev", McpAccess::ReadOnly);
    let mut s = f.server();
    let cases = [
        ("run_query", json!({"connection": "d"})),
        ("run_query", json!({"sql": "select 1"})),
        ("run_query", json!({"connection": "d", "sql": 7})),
        ("run_query", json!({"connection": "d", "sql": ""})),
        (
            "run_query",
            json!({"connection": "d", "sql": "select 1", "extra": true}),
        ),
        (
            "run_query",
            json!({"connection": "d", "sql": "select 1", "params": "x"}),
        ),
        (
            "run_query",
            json!({"connection": "d", "sql": "select 1", "params": vec![1; 101]}),
        ),
        (
            "run_query",
            json!({"connection": "d", "sql": "select '\u{0}'"}),
        ),
        (
            "run_query",
            json!({"connection": "d", "sql": "x".repeat(300 * 1024)}),
        ),
        ("run_query", json!("not an object")),
        ("list_connections", json!({"anything": 1})),
        ("list_tables", json!({"connection": "d"})),
        (
            "describe_table",
            json!({"connection": "d", "schema": "public"}),
        ),
        (
            "describe_table",
            json!({"connection": "d", "schema": "public", "table": "x".repeat(300)}),
        ),
    ];
    for (tool, args) in cases {
        let (_, err) = call(&mut s, tool, args.clone()).await;
        assert!(err, "{tool} {args}");
    }
    assert!(f.executed().is_empty());
    // Valid params pass through.
    let (out, err) = call(
        &mut s,
        "run_query",
        json!({"connection": "d", "sql": "select $1, $2, $3, $4, $5, $6",
               "params": [1, 2.5, "a", null, true, {"k": 1}]}),
    )
    .await;
    assert!(!err, "{out}");
}

#[tokio::test]
async fn two_profiles_with_one_name_must_be_named_by_id() {
    let f = Fixture::new();
    let mut a = f.profile("a", "dev", McpAccess::ReadOnly);
    a.name = "twin".into();
    let mut b = f.profile("b", "dev", McpAccess::ReadOnly);
    b.name = "twin".into();
    {
        let store = f.store.lock().unwrap();
        store.connection_upsert(&a).unwrap();
        store.connection_upsert(&b).unwrap();
    }
    let mut s = f.server();
    let (out, err) = call(
        &mut s,
        "run_query",
        json!({"connection": "twin", "sql": "select 1"}),
    )
    .await;
    assert!(err);
    assert!(out.as_str().unwrap().contains("use its id"));
    let (_, err) = call(
        &mut s,
        "run_query",
        json!({"connection": "b", "sql": "select 1"}),
    )
    .await;
    assert!(!err);
}

#[test]
fn the_client_name_is_cleaned_before_it_is_recorded() {
    use super::server::clean_client_name;
    assert_eq!(clean_client_name(Some("Cursor")), "Cursor");
    assert_eq!(clean_client_name(Some("  ")), "unknown client");
    assert_eq!(clean_client_name(None), "unknown client");
    assert_eq!(clean_client_name(Some("a\nb\u{7}c")), "abc");
    assert_eq!(clean_client_name(Some(&"x".repeat(500))).len(), 64);
}

// ---- settings commands -----------------------------------------------------

#[test]
fn the_config_snippet_names_this_binary_and_the_subcommand() {
    let info =
        super::commands::info_for("/Applications/TupleNest.app/Contents/MacOS/tuplenest-desktop");
    assert_eq!(info.args, ["mcp"]);
    let config: Value = serde_json::from_str(&info.config).unwrap();
    assert_eq!(
        config,
        json!({"mcpServers": {"tuplenest": {
            "command": "/Applications/TupleNest.app/Contents/MacOS/tuplenest-desktop",
            "args": ["mcp"]}}})
    );
}

#[test]
fn the_settings_rows_say_where_read_write_is_allowed() {
    let f = Fixture::new();
    f.profile("p", "prod", McpAccess::ReadOnly);
    f.profile("d", "dev", McpAccess::Off);
    let store = f.store.lock().unwrap();
    let rows = super::commands::access_rows(&store).unwrap();
    let p = rows.iter().find(|r| r.id == "p").unwrap();
    assert!(!p.read_write_allowed);
    assert_eq!(p.access, McpAccess::ReadOnly);
    let d = rows.iter().find(|r| r.id == "d").unwrap();
    assert!(d.read_write_allowed);
    assert_eq!(d.access, McpAccess::Off);

    super::commands::set_access(&store, "d", "read_write").unwrap();
    assert_eq!(store.mcp_access_get("d").unwrap(), McpAccess::ReadWrite);
    assert!(super::commands::set_access(&store, "p", "read_write").is_err());
    assert!(super::commands::set_access(&store, "d", "admin").is_err());
}

#[test]
fn the_data_directory_and_keychain_follow_the_bundle_identifier() {
    // The MCP process must open the app's own store and read the keychain
    // entries the app wrote; both are keyed by this identifier.
    // The test binary is not in a bundle: the compiled identifier.
    assert_eq!(super::identifier(), "app.tuplenest.desktop");
    if let Some(dir) = super::app_data_dir() {
        assert!(dir.ends_with("app.tuplenest.desktop"));
    }
}

#[test]
fn the_identifier_is_the_running_bundles_not_only_the_compiled_one() {
    use super::{compiled_identifier_from, plist_identifier, resolve_identifier};
    const PLIST: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>tuplenest-desktop</string>
  <key>CFBundleIdentifier</key>
  <string>app.tuplenest.desktop.verify</string>
</dict>
</plist>"#;
    assert_eq!(
        plist_identifier(PLIST).as_deref(),
        Some("app.tuplenest.desktop.verify")
    );
    assert_eq!(plist_identifier("<dict></dict>"), None);
    assert_eq!(
        plist_identifier("<key>CFBundleIdentifier</key><string>../etc</string>"),
        None,
        "never a path"
    );

    // A bundle made with `--config '{"identifier":"…verify"}'`.
    let tmp = tempfile::tempdir().unwrap();
    let macos = tmp.path().join("TupleNest.app/Contents/MacOS");
    std::fs::create_dir_all(&macos).unwrap();
    std::fs::write(macos.parent().unwrap().join("Info.plist"), PLIST).unwrap();
    let exe = macos.join("tuplenest-desktop");
    assert_eq!(
        resolve_identifier(Some(&exe), "app.tuplenest.desktop"),
        "app.tuplenest.desktop.verify"
    );
    // Not in a bundle, or no readable plist: the compiled identifier.
    let bare = tmp.path().join("bin/tuplenest-desktop");
    assert_eq!(
        resolve_identifier(Some(&bare), "app.tuplenest.desktop"),
        "app.tuplenest.desktop"
    );
    assert_eq!(
        resolve_identifier(None, "app.tuplenest.desktop"),
        "app.tuplenest.desktop"
    );

    // The compile-time override wins over tauri.conf.json when it names one.
    let conf = r#"{"identifier":"app.tuplenest.desktop"}"#;
    assert_eq!(
        compiled_identifier_from(
            Some(r#"{"identifier":"app.tuplenest.desktop.verify"}"#),
            conf
        ),
        "app.tuplenest.desktop.verify"
    );
    assert_eq!(
        compiled_identifier_from(Some(r#"{"productName":"x"}"#), conf),
        "app.tuplenest.desktop"
    );
    assert_eq!(
        compiled_identifier_from(None, conf),
        "app.tuplenest.desktop"
    );
}

// ---- live --------------------------------------------------------------------

/// Against a real PostgreSQL (TUPLENEST_TEST_PG_*), through the real driver:
/// a read-only grant reads and is refused a write; a read-write grant still
/// has its destructive statements refused.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires live PostgreSQL (TUPLENEST_TEST_PG_*)"]
async fn live_read_only_reads_and_refuses_writes() {
    let env = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.into());
    let store = Arc::new(StdMutex::new(Store::open_in_memory().unwrap()));
    let keychain = Arc::new(MemoryStore::new());
    let secret_ref = std::env::var("TUPLENEST_TEST_PG_PASSWORD")
        .ok()
        .map(|pw| keychain.set(Secret::new(pw)).unwrap().key().to_string());
    let rec = |id: &str| ConnectionRecord {
        id: id.into(),
        name: id.into(),
        engine: "postgres".into(),
        environment: Some("dev".into()),
        color: None,
        read_only: false,
        host: env("TUPLENEST_TEST_PG_HOST", "localhost"),
        port: env("TUPLENEST_TEST_PG_PORT", "5432").parse().unwrap(),
        database: env("TUPLENEST_TEST_PG_DB", "postgres"),
        username: std::env::var("TUPLENEST_TEST_PG_USER")
            .or_else(|_| std::env::var("USER"))
            .unwrap_or_else(|_| "postgres".into()),
        secret_ref: secret_ref.clone(),
        tls_mode: "disabled".into(),
        tls_ca_path: None,
        ssh_json: None,
        options_json: None,
        statement_timeout_ms: 0,
    };
    {
        let s = store.lock().unwrap();
        s.connection_upsert(&rec("ro")).unwrap();
        s.mcp_access_set("ro", McpAccess::ReadOnly).unwrap();
        s.connection_upsert(&rec("rw")).unwrap();
        s.mcp_access_set("rw", McpAccess::ReadWrite).unwrap();
    }
    let mut s = McpServer::new(store, keychain, Arc::new(super::backend::DriverConnector));
    s.set_client(Some("live test"));

    let (out, err) = call(
        &mut s,
        "run_query",
        json!({"connection": "ro", "sql": "select $1::int + 1 as n, 'a'::text as t", "params": [41]}),
    )
    .await;
    assert!(!err, "{out}");
    assert_eq!(out["rows"], json!([[42, "a"]]));

    let (out, err) = call(
        &mut s,
        "run_query",
        json!({"connection": "ro", "sql": "insert into tuplenest_mcp_nowhere values (1)"}),
    )
    .await;
    assert!(err, "{out}");
    assert!(out.as_str().unwrap().contains("read-only"), "{out}");

    // The server's own read-only mode, not just the allowlist: a SELECT that
    // writes through a CTE is refused by PostgreSQL.
    let (out, err) = call(
        &mut s,
        "run_query",
        json!({"connection": "ro", "sql": "with x as (insert into tuplenest_mcp_nowhere values (1) returning 1) select * from x"}),
    )
    .await;
    assert!(err, "{out}");

    let (out, err) = call(
        &mut s,
        "run_query",
        json!({"connection": "ro", "sql": "select * from generate_series(1, 1000)"}),
    )
    .await;
    assert!(!err, "{out}");
    assert_eq!(out["rows"].as_array().unwrap().len(), ROW_CAP);
    assert_eq!(out["truncated"], true);

    let (out, err) = call(&mut s, "list_schemas", json!({"connection": "ro"})).await;
    assert!(!err, "{out}");
    assert!(out["schemas"]
        .as_array()
        .unwrap()
        .contains(&json!("public")));

    let (out, err) = call(
        &mut s,
        "describe_table",
        json!({"connection": "ro", "schema": "pg_catalog", "table": "pg_class"}),
    )
    .await;
    assert!(!err, "{out}");
    assert_eq!(out["columns"][0]["name"], "oid");
    assert!(!out["indexes"].as_array().unwrap().is_empty());

    let (out, err) = call(
        &mut s,
        "explain",
        json!({"connection": "ro", "sql": "select * from pg_class where oid = 1"}),
    )
    .await;
    assert!(!err, "{out}");
    assert!(out["plan"].as_str().unwrap().contains("pg_class"), "{out}");

    let (out, err) = call(
        &mut s,
        "run_query",
        json!({"connection": "rw", "sql": "delete from tuplenest_mcp_nowhere"}),
    )
    .await;
    assert!(err);
    assert!(
        out.as_str().unwrap().starts_with("Refused: DELETE"),
        "{out}"
    );

    let (out, err) = call(
        &mut s,
        "run_query",
        json!({"connection": "rw", "sql": "select 1 as one"}),
    )
    .await;
    assert!(!err, "{out}");
    assert_eq!(out["rows"], json!([[1]]));
}

// ---- SQLite, through the real driver (a temp file: no server, no network) ----

/// A saved SQLite profile with `access`, on a file holding two tables.
fn sqlite_fixture(
    dir: &tempfile::TempDir,
    env: &str,
    access: McpAccess,
) -> (McpServer, Arc<StdMutex<Store>>) {
    let path = dir.path().join("app.db");
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE);
             CREATE TABLE logs (msg TEXT, user_id INTEGER REFERENCES users(id));
             CREATE INDEX logs_user ON logs (user_id);
             INSERT INTO users VALUES (1, 'a@example.com'), (2, 'b@example.com');",
        )
        .unwrap();
    }
    let store = Arc::new(StdMutex::new(Store::open_in_memory().unwrap()));
    let keychain = Arc::new(MemoryStore::new());
    let rec = ConnectionRecord {
        id: "lite".into(),
        name: "lite".into(),
        engine: "sqlite".into(),
        environment: Some(env.into()),
        color: None,
        read_only: false,
        host: String::new(),
        port: 0,
        database: path.display().to_string(),
        username: String::new(),
        secret_ref: None,
        tls_mode: "disabled".into(),
        tls_ca_path: None,
        ssh_json: None,
        options_json: None,
        statement_timeout_ms: 0,
    };
    {
        let s = store.lock().unwrap();
        s.connection_upsert(&rec).unwrap();
        s.mcp_access_set("lite", access).unwrap();
    }
    let mut server = McpServer::new(
        store.clone(),
        keychain,
        Arc::new(super::backend::DriverConnector),
    );
    server.set_client(Some("sqlite test"));
    (server, store)
}

#[tokio::test]
async fn sqlite_is_off_by_default_like_any_profile() {
    let dir = tempfile::tempdir().unwrap();
    let (mut s, store) = sqlite_fixture(&dir, "dev", McpAccess::ReadOnly);
    store
        .lock()
        .unwrap()
        .mcp_access_set("lite", McpAccess::Off)
        .unwrap();
    let (out, _) = call(&mut s, "list_connections", json!({})).await;
    assert_eq!(out["connections"], json!([]));
    let (_, err) = call(&mut s, "list_schemas", json!({"connection": "lite"})).await;
    assert!(err);
}

#[tokio::test]
async fn sqlite_tools_list_describe_query_and_explain() {
    let dir = tempfile::tempdir().unwrap();
    let (mut s, _) = sqlite_fixture(&dir, "dev", McpAccess::ReadOnly);

    let (out, _) = call(&mut s, "list_connections", json!({})).await;
    assert_eq!(out["connections"][0]["engine"], "sqlite");
    assert!(out["connections"][0]["path"]
        .as_str()
        .unwrap()
        .ends_with("app.db"));
    assert!(out["connections"][0].get("host").is_none());

    let (out, err) = call(&mut s, "list_schemas", json!({"connection": "lite"})).await;
    assert!(!err, "{out}");
    assert_eq!(out["schemas"], json!(["main"]));

    let (out, err) = call(
        &mut s,
        "list_tables",
        json!({"connection": "lite", "schema": "main"}),
    )
    .await;
    assert!(!err, "{out}");
    assert_eq!(
        out["tables"],
        json!([{"name": "logs", "kind": "table"}, {"name": "users", "kind": "table"}])
    );

    let (out, err) = call(
        &mut s,
        "describe_table",
        json!({"connection": "lite", "schema": "main", "table": "logs"}),
    )
    .await;
    assert!(!err, "{out}");
    assert_eq!(out["columns"][0]["name"], "msg");
    assert_eq!(out["columns"][0]["nullable"], true);
    assert!(out["constraints"]
        .as_array()
        .unwrap()
        .iter()
        .any(|c| c["kind"] == "foreign key"
            && c["definition"]
                .as_str()
                .unwrap()
                .contains("REFERENCES users(id)")));
    assert_eq!(out["indexes"][0]["name"], "logs_user");

    let (out, err) = call(
        &mut s,
        "describe_table",
        json!({"connection": "lite", "schema": "main", "table": "users"}),
    )
    .await;
    assert!(!err, "{out}");
    let kinds: Vec<&str> = out["constraints"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["kind"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, ["primary key", "unique"]);

    let (out, err) = call(
        &mut s,
        "describe_table",
        json!({"connection": "lite", "schema": "main", "table": "nope"}),
    )
    .await;
    assert!(err, "{out}");

    let (out, err) = call(
        &mut s,
        "run_query",
        json!({"connection": "lite", "sql": "SELECT id, email FROM users WHERE id = $1", "params": [2]}),
    )
    .await;
    assert!(!err, "{out}");
    assert_eq!(out["rows"], json!([[2, "b@example.com"]]));

    let (out, err) = call(
        &mut s,
        "run_query",
        json!({"connection": "lite", "sql":
            "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n) SELECT x FROM n"}),
    )
    .await;
    assert!(!err, "{out}");
    assert_eq!(out["rows"].as_array().unwrap().len(), ROW_CAP);
    assert_eq!(out["truncated"], true);

    let (out, err) = call(
        &mut s,
        "explain",
        json!({"connection": "lite", "sql": "SELECT * FROM users WHERE id = 1"}),
    )
    .await;
    assert!(!err, "{out}");
    assert!(out["plan"].as_str().unwrap().contains("users"), "{out}");
}

#[tokio::test]
async fn sqlite_read_only_access_refuses_writes_in_the_engine() {
    let dir = tempfile::tempdir().unwrap();
    let (mut s, _) = sqlite_fixture(&dir, "dev", McpAccess::ReadOnly);
    for sql in [
        "INSERT INTO users VALUES (3, 'c@example.com')",
        "UPDATE users SET email = 'x' WHERE id = 1",
        "DROP TABLE logs",
    ] {
        let (out, err) = call(
            &mut s,
            "run_query",
            json!({"connection": "lite", "sql": sql}),
        )
        .await;
        assert!(err, "{sql}: {out}");
        assert!(out.as_str().unwrap().contains("read-only"), "{out}");
    }
    // An explained write is only planned, so a read-only grant may have it.
    let (out, err) = call(
        &mut s,
        "explain",
        json!({"connection": "lite", "sql": "DELETE FROM users WHERE id = 1"}),
    )
    .await;
    assert!(!err, "{out}");
    let (out, _) = call(
        &mut s,
        "run_query",
        json!({"connection": "lite", "sql": "SELECT count(*) FROM users"}),
    )
    .await;
    assert_eq!(out["rows"], json!([[2]]));
}

#[tokio::test]
async fn sqlite_read_write_still_refuses_what_the_guard_would_ask_about() {
    let dir = tempfile::tempdir().unwrap();
    let (mut s, _) = sqlite_fixture(&dir, "dev", McpAccess::ReadWrite);
    for sql in [
        "DELETE FROM logs",
        "UPDATE users SET email = 'x'",
        "DROP TABLE logs",
        "DELETE FROM [logs]",
        "DELETE FROM `where`",
    ] {
        let (out, err) = call(
            &mut s,
            "run_query",
            json!({"connection": "lite", "sql": sql}),
        )
        .await;
        assert!(err, "{sql}: {out}");
        assert!(out.as_str().unwrap().starts_with("Refused:"), "{out}");
    }
    let (out, err) = call(
        &mut s,
        "run_query",
        json!({"connection": "lite", "sql": "UPDATE users SET email = 'z@example.com' WHERE id = 1"}),
    )
    .await;
    assert!(!err, "{out}");
    assert_eq!(out["rowsAffected"], 1);
}

#[tokio::test]
async fn sqlite_on_prod_is_read_only_and_audited_before_it_runs() {
    let dir = tempfile::tempdir().unwrap();
    // Read-only at most on prod, as for PostgreSQL.
    let (mut s, store) = sqlite_fixture(&dir, "prod", McpAccess::ReadOnly);
    let (out, err) = call(
        &mut s,
        "run_query",
        json!({"connection": "lite", "sql": "INSERT INTO users VALUES (9, 'p@example.com')"}),
    )
    .await;
    assert!(err, "{out}");
    let (out, err) = call(
        &mut s,
        "run_query",
        json!({"connection": "lite", "sql": "SELECT email FROM users WHERE id = 1"}),
    )
    .await;
    assert!(!err, "{out}");
    let audit = store.lock().unwrap().audit_list(10).unwrap();
    assert!(audit
        .iter()
        .any(|a| a.sql_text.contains("SELECT email FROM users")));
    assert!(audit
        .iter()
        .all(|a| a.connection_key.starts_with("sqlite:")));
}
