//! Phase 0 PoC commands: PostgreSQL connect / test / query / cancel.
//!
//! Security invariants:
//! - The WebView sends a password exactly once (`pg_secret_save`); it is
//!   stored in the OS keychain and only the opaque ref returns to the UI.
//! - Query commands accept the ref; resolution happens here in the backend.
//! - Secrets and full query results never appear in logs.

use std::collections::BTreeMap;
use std::sync::Mutex as StdMutex;

use async_trait::async_trait;
use tokio::sync::Mutex as AsyncMutex;
use tuplenest_credential_store::{CredentialStore, KeychainStore, Secret};
use tuplenest_driver_api::{
    BatchSink, CellValue, ConnectionConfig, DatabaseSession, DriverError, Environment, ExecutionId,
    MetadataRequest, QueryRequest, RowBatch, SecretRef, TlsMode,
};
use tuplenest_driver_postgres::{PgCancelHandle, PostgresDriver, PostgresSession};

/// Connection parameters as sent from the WebView. Never contains a password.
#[derive(serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PgParams {
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    /// Opaque keychain reference from `pg_secret_save`, if auth is needed.
    pub secret_ref: Option<String>,
    /// "disabled" | "prefer" | "verify-ca" | "verify-full" (default).
    pub tls_mode: Option<String>,
    pub tls_ca_path: Option<String>,
    /// dev/test/staging/prod — prod suppresses query text in history.
    pub environment: Option<String>,
    /// Ask the server to refuse writes for the whole session.
    pub read_only: Option<bool>,
    /// Ceiling on a single statement, in milliseconds. 0 (the default) means
    /// no limit — PostgreSQL's own meaning, and the right default for an IDE
    /// where a query that takes an hour may be exactly what was intended.
    pub statement_timeout_ms: Option<u64>,
    /// Optional SSH tunnel; DB traffic then flows through the tunnel.
    pub ssh: Option<SshParams>,
}

/// SSH tunnel parameters (E1.2). Key-file auth; passphrase-less keys or
/// agent-managed keys for now. No secrets are stored here.
#[derive(serde::Deserialize, serde::Serialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SshParams {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub key_path: String,
    /// Pinned SHA-256 host key fingerprint. Empty → known_hosts policy.
    #[serde(default)]
    pub fingerprint: String,
}

impl SshParams {
    fn tunnel_config(
        &self,
        target_host: &str,
        target_port: u16,
    ) -> tuplenest_ssh_core::SshTunnelConfig {
        tuplenest_ssh_core::SshTunnelConfig {
            ssh_host: self.host.clone(),
            ssh_port: self.port,
            username: self.username.clone(),
            auth: tuplenest_ssh_core::SshAuth::KeyFile {
                path: self.key_path.clone(),
                passphrase: None,
            },
            host_key: if self.fingerprint.trim().is_empty() {
                tuplenest_ssh_core::HostKeyPolicy::KnownHosts
            } else {
                tuplenest_ssh_core::HostKeyPolicy::PinnedFingerprint(
                    self.fingerprint.trim().to_string(),
                )
            },
            target_host: target_host.to_string(),
            target_port,
        }
    }
}

fn parse_tls_mode(s: Option<&str>) -> Result<TlsMode, String> {
    match s.unwrap_or("verify-full") {
        "disabled" => Ok(TlsMode::Disabled),
        "prefer" => Ok(TlsMode::Prefer),
        "verify-ca" => Ok(TlsMode::VerifyCa),
        "verify-full" => Ok(TlsMode::VerifyFull),
        other => Err(format!("unknown tls mode `{other}`")),
    }
}

impl PgParams {
    fn to_config(&self) -> Result<ConnectionConfig, String> {
        self.to_config_endpoint(&self.host, self.port)
    }

    /// Build a config pointed at an override endpoint (the tunnel's local
    /// port) while keeping all other settings.
    fn to_config_endpoint(&self, host: &str, port: u16) -> Result<ConnectionConfig, String> {
        Ok(ConnectionConfig {
            driver_id: "postgres".into(),
            name: format!("{}@{}/{}", self.username, self.host, self.database),
            environment: Environment::Dev,
            read_only: self.read_only.unwrap_or(false),
            host: host.to_string(),
            port,
            database: self.database.clone(),
            username: self.username.clone(),
            secret_ref: self.secret_ref.as_deref().map(SecretRef::new),
            tls_mode: parse_tls_mode(self.tls_mode.as_deref())?,
            tls_ca_path: self.tls_ca_path.clone(),
            options: BTreeMap::new(),
            // Was hard-coded to 0, which made the driver's statement_timeout
            // support unreachable: the feature existed, was tested against a
            // live server, and could not be switched on from the app.
            default_statement_timeout_ms: self.statement_timeout_ms.unwrap_or(0),
        })
    }
}

pub struct PgState {
    session: AsyncMutex<Option<PostgresSession>>,
    cancel: StdMutex<Option<PgCancelHandle>>,
    /// Metadata cache (E1.3): instant explorer loads + offline browsing.
    cache: StdMutex<tuplenest_metadata_cache::MetadataCache>,
    /// Cache key of the currently connected session.
    cache_key: StdMutex<Option<String>>,
    /// Secret refs written by `pg_secret_save` in this app session — the
    /// password the user just typed into the form. See `authorize_secret`.
    fresh_secrets: StdMutex<std::collections::HashSet<String>>,
    /// Last query's rows, held backend-side for windowed paging.
    result: StdMutex<Option<StoredResult>>,
    /// Environment tag of the connected profile (prod → history text off).
    connected_env: StdMutex<Option<String>>,
    /// Open SSH tunnel backing the current session, if any.
    tunnel: StdMutex<Option<tuplenest_ssh_core::SshTunnel>>,
}

impl PgState {
    /// Was this secret ref written by `pg_secret_save` in this app session?
    pub fn is_fresh_secret(&self, key: &str) -> bool {
        self.fresh_secrets
            .lock()
            .map(|s| s.contains(key))
            .unwrap_or(false)
    }

    /// The ref now belongs to a saved profile: from here on it is bound to
    /// that profile's connection, not usable anywhere.
    pub fn bind_secret(&self, key: &str) {
        if let Ok(mut s) = self.fresh_secrets.lock() {
            s.remove(key);
        }
    }

    /// Drops cached metadata for a database nothing points at any more.
    /// `invalidate` existed and was never called, so the cache kept every
    /// schema of every profile ever deleted.
    pub fn forget_cached_metadata(&self, key: &str) {
        if let Ok(cache) = self.cache.lock() {
            let _ = cache.invalidate(key);
        }
    }

    pub fn new(cache: tuplenest_metadata_cache::MetadataCache) -> Self {
        Self {
            session: AsyncMutex::new(None),
            cancel: StdMutex::new(None),
            cache: StdMutex::new(cache),
            cache_key: StdMutex::new(None),
            fresh_secrets: StdMutex::new(Default::default()),
            result: StdMutex::new(None),
            connected_env: StdMutex::new(None),
            tunnel: StdMutex::new(None),
        }
    }
}

/// Stable, secret-free cache identity for a connection target.
fn cache_key_of(p: &PgParams) -> String {
    cache_key(&p.username, &p.host, p.port, &p.database)
}

/// The metadata cache's key for one database as one user.
pub fn cache_key(username: &str, host: &str, port: u16, database: &str) -> String {
    format!("{username}@{host}:{port}/{database}")
}

/*
 * May these parameters use this stored secret?
 *
 * The WebView names the secret by reference and also names the host, so a
 * compromised WebView could send a production profile's ref with
 * `host: "attacker"`, `tlsMode: "disabled"` — and a server asking for
 * cleartext auth would receive the password. The ref is honoured only when:
 *  - it was written in this app session (the password the user just typed
 *    into this form), or
 *  - it belongs to a saved profile for the same host, port, database and
 *    user — that profile's own connection.
 * Editing a saved profile's host without re-entering its password therefore
 * asks for the password again, which is exactly the case being prevented.
 */
fn authorize_secret(
    app: &crate::AppState,
    state: &PgState,
    params: &PgParams,
) -> Result<(), String> {
    let Some(key) = params.secret_ref.as_deref() else {
        return Ok(());
    };
    if state
        .fresh_secrets
        .lock()
        .map_err(|_| "secret lock poisoned")?
        .contains(key)
    {
        return Ok(());
    }
    let profiles = app
        .store
        .lock()
        .map_err(|_| "store lock poisoned")?
        .connection_list()
        .map_err(|e| e.to_string())?;
    let owned = profiles
        .iter()
        .any(|r| r.secret_ref.as_deref() == Some(key) && profile_matches(r, params));
    if owned {
        Ok(())
    } else {
        Err("The saved password belongs to a different server or user. Enter the password again to use it here.".into())
    }
}

/*
 * Does `params` describe exactly this saved profile's connection?
 *
 * Not just where (host, port, database, user) but how: the TLS mode, the CA
 * file and the SSH hop. Matching only the address let a compromised WebView
 * keep a profile's host and send its password with `tlsMode: "disabled"`, or
 * through an SSH bastion of its own choosing, to a server that asks for
 * cleartext auth.
 */
pub fn profile_matches(r: &tuplenest_workspace_store::ConnectionRecord, p: &PgParams) -> bool {
    let tls = |m: Option<&str>| {
        m.filter(|m| !m.is_empty())
            .unwrap_or("verify-full")
            .to_string()
    };
    let ca = |c: Option<&str>| c.filter(|c| !c.trim().is_empty()).map(str::to_string);
    let saved_ssh: Option<SshParams> = r
        .ssh_json
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .and_then(|s| serde_json::from_str(s).ok());
    r.host == p.host
        && r.port == p.port
        && r.database == p.database
        && r.username == p.username
        && tls(Some(&r.tls_mode)) == tls(p.tls_mode.as_deref())
        && ca(r.tls_ca_path.as_deref()) == ca(p.tls_ca_path.as_deref())
        && saved_ssh == p.ssh
}

fn resolve_password(secret_ref: &Option<String>) -> Result<Option<Secret>, String> {
    match secret_ref {
        None => Ok(None),
        Some(key) => KeychainStore::new()
            .get(&SecretRef::new(key.clone()))
            .map(Some)
            .map_err(|e| e.to_string()),
    }
}

/// Flatten a DriverError into the string the frontend shows.
///
/// This used to be `e.to_string()`, and DriverError's Display is `{title}` —
/// so the driver would carefully collect the SQLSTATE, the server's message,
/// DETAIL, HINT and the constraint name, and this one line would throw all of
/// it away. An unmapped failure reached the user as the two words "Database
/// error", which is the least useful sentence a database tool can say.
///
/// Layout contract: the title stays on line one, alone. `isConnectionLost`
/// in the frontend matches a prefix of the first line, and the status bar
/// shows only the first line; everything below it is the full report for the
/// error box. All fields are sanitized upstream by design (no credentials).
/// A network-category failure means the session is gone. Close it (with its
/// cancel handle and tunnel, before the slot is released) and say "Connection
/// lost:", which the WebView recognises — it used to notice only on Run, so
/// a failed Commit or Begin left it showing a live session and an open
/// transaction that no longer existed.
fn lost_or_error(state: &PgState, slot: &mut Option<PostgresSession>, e: &DriverError) -> String {
    let msg = err_to_string(e);
    if !matches!(e.category, tuplenest_driver_api::ErrorCategory::Network) {
        return msg;
    }
    *slot = None;
    if let Ok(mut c) = state.cancel.lock() {
        *c = None;
    }
    if let Ok(mut t) = state.tunnel.lock() {
        *t = None;
    }
    tracing::warn!(
        component = "pg",
        "session marked broken after network error"
    );
    format!("Connection lost: {msg} — the session was closed. Reconnect to continue; nothing was re-run.")
}

fn err_to_string(e: &DriverError) -> String {
    let mut out = e.title.clone();
    if let Some(code) = &e.native_code {
        out.push_str(&format!(" [SQLSTATE {code}]"));
    }
    if let Some(msg) = &e.original_message {
        if msg != &e.title {
            out.push('\n');
            out.push_str(msg);
        }
    }
    if !e.explanation.is_empty() {
        out.push('\n');
        out.push_str(&e.explanation);
    }
    for action in &e.suggested_actions {
        out.push_str("\nTry: ");
        out.push_str(action);
    }
    out
}

/// The error form that is safe to WRITE TO DISK (query history).
///
/// Security review PRIV-01: `err_to_string` (what the user sees) includes the
/// server's `original_message` — which for a constraint violation is
/// `Detail: Key (email)=(alice@example.com) already exists.`, i.e. real row
/// values. Persisting that to `tuplenest.db` contradicted PRIVACY.md's promise
/// that row data is memory-only, and it happened even on prod connections.
///
/// This keeps only fields that cannot carry row values: the fixed title (a
/// hardcoded string from `normalize_error`), the SQLSTATE, and the category
/// enum. DETAIL/HINT/CONTEXT are deliberately dropped. The full report still
/// reaches the UI in memory via `err_to_string`; only the disk copy is reduced.
fn persisted_error(e: &DriverError) -> String {
    let mut s = e.title.clone();
    if let Some(code) = &e.native_code {
        s.push_str(&format!(" [SQLSTATE {code}]"));
    }
    if let Ok(cat) = serde_json::to_string(&e.category) {
        s.push_str(&format!(" ({})", cat.trim_matches('"')));
    }
    s
}

#[cfg(test)]
mod persisted_error_tests {
    use super::*;
    use tuplenest_driver_api::ErrorCategory;

    #[test]
    fn keeps_title_sqlstate_category_but_drops_row_values() {
        // The full display error carries the server DETAIL with a real value.
        let e = DriverError::new(ErrorCategory::ConstraintViolation, "Constraint violation")
            .with_native_code("23505")
            .with_original_message(
                "duplicate key value violates unique constraint \"users_email_key\"\n\
                 Detail: Key (email)=(alice@example.com) already exists.",
            );
        let disk = persisted_error(&e);
        assert_eq!(
            disk,
            "Constraint violation [SQLSTATE 23505] (constraint_violation)"
        );
        // The row value must NOT be in what we persist.
        assert!(
            !disk.contains("alice@example.com"),
            "row value leaked to disk: {disk}"
        );
        assert!(
            !disk.to_lowercase().contains("detail"),
            "DETAIL leaked to disk: {disk}"
        );
    }

    #[test]
    fn works_without_a_sqlstate() {
        let e = DriverError::new(ErrorCategory::Network, "Connection closed")
            .with_original_message("connection reset by peer to db.prod.internal");
        // No native_code; still no message body persisted.
        assert_eq!(persisted_error(&e), "Connection closed (network)");
    }
}

#[cfg(test)]
mod err_to_string_tests {
    use super::*;
    use tuplenest_driver_api::ErrorCategory;

    #[test]
    fn keeps_every_field_the_driver_collected() {
        let e = DriverError::new(ErrorCategory::ConstraintViolation, "Constraint violation")
            .with_native_code("23505")
            .with_original_message(
                "duplicate key value violates unique constraint \"books_pkey\"\n\
                 Detail: Key (id)=(1) already exists.\n\
                 On: table \"books\", constraint \"books_pkey\"",
            );
        let s = err_to_string(&e);
        assert!(
            s.starts_with("Constraint violation [SQLSTATE 23505]\n"),
            "{s}"
        );
        assert!(s.contains("duplicate key value"), "{s}");
        assert!(s.contains("Detail: Key (id)=(1) already exists."), "{s}");
        assert!(s.contains("constraint \"books_pkey\""), "{s}");
    }

    #[test]
    fn title_owns_the_first_line_alone() {
        // The status bar takes line one; the frontend's connection-lost check
        // matches a prefix of it. Multi-line messages must not leak into it.
        let e = DriverError::new(ErrorCategory::Syntax, "Syntax error")
            .with_native_code("42601")
            .with_original_message("syntax error at or near \"selct\"");
        let first = err_to_string(&e);
        let first = first.lines().next().unwrap();
        assert_eq!(first, "Syntax error [SQLSTATE 42601]");
    }

    #[test]
    fn no_duplicate_when_message_equals_title() {
        let e = DriverError::new(ErrorCategory::Network, "Connection closed")
            .with_original_message("Connection closed");
        assert_eq!(err_to_string(&e), "Connection closed");
    }

    #[test]
    fn suggested_actions_render_as_try_lines() {
        let e = DriverError::new(ErrorCategory::Network, "Connection closed")
            .with_original_message("connection reset by peer")
            .with_suggested_action("Reconnect and retry if the statement is safe to re-run");
        let s = err_to_string(&e);
        assert!(
            s.ends_with("Try: Reconnect and retry if the statement is safe to re-run"),
            "{s}"
        );
    }
}

/// Stores a password in the OS keychain; returns the opaque reference key.
/// This is the ONLY command that ever sees a secret, and it does not log it.
#[tauri::command]
pub fn pg_secret_save(
    state: tauri::State<'_, PgState>,
    password: String,
    reuse_ref: Option<String>,
) -> Result<String, String> {
    // Only a ref written this session may be overwritten. A saved profile's
    // ref is never touched here: the password goes into a new entry, and
    // `connection_save` swaps it in (deleting the old one) when the profile
    // is saved. That keeps saved passwords out of reach of anything that can
    // call this command, and keeps the new password unbound — fresh — only
    // until its profile is saved.
    let reuse = reuse_ref.filter(|k| {
        !k.is_empty()
            && state
                .fresh_secrets
                .lock()
                .map(|s| s.contains(k))
                .unwrap_or(false)
    });
    let key = save_secret(password, reuse)?;
    state
        .fresh_secrets
        .lock()
        .map_err(|_| "secret lock poisoned")?
        .insert(key.clone());
    Ok(key)
}

fn save_secret(password: String, reuse_ref: Option<String>) -> Result<String, String> {
    let store = KeychainStore::new();
    // Reuse the ref the form already holds instead of minting a new keychain
    // entry every time. Previously each Test/connect of a typed password
    // created a fresh tn-secret-* entry that nothing referenced unless the
    // profile was later saved — orphans that accumulated forever, since the
    // keyring crate offers no way to enumerate and sweep them. Reusing bounds a
    // whole test-then-save session (or repeated tests while editing a profile)
    // to a single entry. (Security review CRED-01.)
    match reuse_ref.filter(|k| !k.is_empty()) {
        Some(key) => {
            let r = SecretRef::new(key.clone());
            store
                .replace(&r, Secret::new(password))
                .map_err(|e| e.to_string())?;
            Ok(key)
        }
        None => store
            .set(Secret::new(password))
            .map(|r| r.key().to_string())
            .map_err(|e| e.to_string()),
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestStageOut {
    name: String,
    passed: bool,
    duration_ms: u64,
    detail: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestReportOut {
    server_version: Option<String>,
    stages: Vec<TestStageOut>,
}

fn stage_out(s: tuplenest_driver_api::TestStage) -> TestStageOut {
    TestStageOut {
        name: s.name,
        passed: matches!(s.status, tuplenest_driver_api::TestStageStatus::Passed),
        duration_ms: s.duration_ms,
        detail: s.detail,
    }
}

/// Staged connection test (E1.2): DNS → TCP → [ssh] via connection-core /
/// ssh-core, then auth + server version via the driver. Stops at the first
/// failure. With SSH configured the network probe targets the SSH host and
/// the driver connects through a temporary tunnel.
#[tauri::command]
pub async fn pg_test(
    app: tauri::State<'_, crate::AppState>,
    state: tauri::State<'_, PgState>,
    params: PgParams,
) -> Result<TestReportOut, String> {
    authorize_secret(&app, &state, &params)?;
    let (probe_host, probe_port) = match &params.ssh {
        Some(ssh) => (ssh.host.clone(), ssh.port),
        None => (params.host.clone(), params.port),
    };
    let probe = tuplenest_connection_core::probe(
        &probe_host,
        probe_port,
        std::time::Duration::from_secs(5),
    )
    .await;
    let mut stages: Vec<TestStageOut> = probe.stages.into_iter().map(stage_out).collect();

    if !probe.reachable {
        return Ok(TestReportOut {
            server_version: None,
            stages,
        });
    }

    // Optional SSH stage: open a throwaway tunnel, timed.
    let mut tunnel = None;
    if let Some(ssh) = &params.ssh {
        let started = std::time::Instant::now();
        match tuplenest_ssh_core::open_tunnel(ssh.tunnel_config(&params.host, params.port)).await {
            Ok(t) => {
                stages.push(TestStageOut {
                    name: "ssh".into(),
                    passed: true,
                    duration_ms: started.elapsed().as_millis() as u64,
                    detail: Some(format!("{}@{}:{}", ssh.username, ssh.host, ssh.port)),
                });
                tunnel = Some(t);
            }
            Err(e) => {
                stages.push(TestStageOut {
                    name: "ssh".into(),
                    passed: false,
                    duration_ms: started.elapsed().as_millis() as u64,
                    detail: Some(e.to_string()),
                });
                return Ok(TestReportOut {
                    server_version: None,
                    stages,
                });
            }
        }
    }

    let config = match &tunnel {
        Some(t) => params.to_config_endpoint("127.0.0.1", t.local_port())?,
        None => params.to_config()?,
    };
    // The keychain can block — on a permission prompt, for as long as the
    // user takes — so it runs off the async workers.
    let secret_ref = params.secret_ref.clone();
    let password = tauri::async_runtime::spawn_blocking(move || resolve_password(&secret_ref))
        .await
        .map_err(|e| e.to_string())??;
    let report = PostgresDriver
        .test_with_password(&config, password.as_ref().map(|s| s.expose()))
        .await
        .map_err(|e| err_to_string(&e))?;
    stages.extend(report.stages.into_iter().map(|mut s| {
        // In the combined report the driver's "connect" stage is the
        // authenticated session open, i.e. the auth stage.
        if s.name == "connect" {
            s.name = "auth".into();
        }
        stage_out(s)
    }));
    Ok(TestReportOut {
        server_version: report.server_version,
        stages,
    })
}

#[tauri::command]
pub async fn pg_connect(
    app: tauri::State<'_, crate::AppState>,
    state: tauri::State<'_, PgState>,
    params: PgParams,
) -> Result<(), String> {
    authorize_secret(&app, &state, &params)?;
    // The keychain can block — on a permission prompt, for as long as the
    // user takes — so it runs off the async workers.
    let secret_ref = params.secret_ref.clone();
    let password = tauri::async_runtime::spawn_blocking(move || resolve_password(&secret_ref))
        .await
        .map_err(|e| e.to_string())??;

    // E1.2: with SSH configured, open the tunnel first and point the
    // driver at its local end. The tunnel lives as long as the session.
    let (tunnel, config) = match &params.ssh {
        Some(ssh) => {
            let tunnel =
                tuplenest_ssh_core::open_tunnel(ssh.tunnel_config(&params.host, params.port))
                    .await
                    .map_err(|e| format!("SSH tunnel: {e}"))?;
            let config = params.to_config_endpoint("127.0.0.1", tunnel.local_port())?;
            (Some(tunnel), config)
        }
        None => (None, params.to_config()?),
    };

    let session = PostgresDriver
        .connect_concrete_with_password(config, password.as_ref().map(|s| s.expose()))
        .await
        .map_err(|e| err_to_string(&e))?;
    // Take the session slot first, then publish the new cancel handle. The
    // other order pointed Cancel at the new, idle backend while the old
    // session's query was still running (and still holding the lock).
    let mut slot = lock_session(&state).await?;
    *slot = Some(session);
    // All of it published before the slot is released: a metadata request
    // queued behind this connect must see the new cache key, not file the
    // new database's schema under the old profile's. The previous result
    // belongs to the old database; paging it now would show its rows.
    *state.cancel.lock().map_err(|_| "cancel lock poisoned")? =
        slot.as_ref().map(|s| s.cancel_handle());
    *state.tunnel.lock().map_err(|_| "tunnel lock poisoned")? = tunnel;
    *state.cache_key.lock().map_err(|_| "key lock poisoned")? = Some(cache_key_of(&params));
    *state
        .connected_env
        .lock()
        .map_err(|_| "env lock poisoned")? = params.environment.clone();
    *state.result.lock().map_err(|_| "result lock poisoned")? = None;
    drop(slot);
    tracing::info!(
        component = "pg",
        host = %params.host,
        db = %params.database,
        tunneled = params.ssh.is_some(),
        "session opened"
    );
    Ok(())
}

#[tauri::command]
pub async fn pg_disconnect(state: tauri::State<'_, PgState>) -> Result<(), String> {
    let mut slot = lock_session(&state).await?;
    *slot = None;
    // Cleared while the session slot is still held. After it is released, a
    // reconnect waiting on the lock can install its own cancel handle and
    // tunnel — and a late clear here would drop them.
    *state.cancel.lock().map_err(|_| "cancel lock poisoned")? = None;
    *state.result.lock().map_err(|_| "result lock poisoned")? = None;
    // Dropping the tunnel closes the SSH session.
    *state.tunnel.lock().map_err(|_| "tunnel lock poisoned")? = None;
    drop(slot);
    tracing::info!(component = "pg", "session closed");
    Ok(())
}

fn json_to_param(v: serde_json::Value) -> tuplenest_driver_api::ParamValue {
    use tuplenest_driver_api::ParamValue as P;
    match v {
        serde_json::Value::Null => P::Null,
        serde_json::Value::Bool(b) => P::Bool(b),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                P::Int(i)
            } else {
                P::Float(n.as_f64().unwrap_or(0.0))
            }
        }
        serde_json::Value::String(s) => P::Text(s),
        other => P::Json(other),
    }
}

/// `Number.MAX_SAFE_INTEGER`: the largest integer a JavaScript number holds exactly.
const JS_MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

fn cell_to_json(cell: CellValue) -> serde_json::Value {
    match cell {
        CellValue::Null => serde_json::Value::Null,
        CellValue::Bool(b) => b.into(),
        // JavaScript numbers are doubles: past 2^53 an int8 is silently
        // rounded (9007199254740993 arrives as …992), in the grid, in exports
        // and in the WHERE of a row edit. Send those as exact text.
        CellValue::Int(i) if i.unsigned_abs() > JS_MAX_SAFE_INTEGER => i.to_string().into(),
        CellValue::Int(i) => i.into(),
        // JSON has no NaN or Infinity. Mapping them to null showed (and
        // exported) a real value as NULL; PostgreSQL's own spelling is exact.
        CellValue::Float(f) => serde_json::Number::from_f64(f)
            .map(serde_json::Value::Number)
            .unwrap_or_else(|| {
                if f.is_nan() {
                    "NaN".into()
                } else if f > 0.0 {
                    "Infinity".into()
                } else {
                    "-Infinity".into()
                }
            }),
        CellValue::Text(t) => t.into(),
        CellValue::Bytes(b) => format!("\\x{}", hex(&b)).into(),
        CellValue::Json(v) => v,
        CellValue::Other { rendered, .. } => rendered.into(),
    }
}

fn hex(bytes: &[u8]) -> String {
    // One pre-sized buffer. `format!` per byte was one heap allocation per
    // byte: a 5 MB bytea cost five million of them (measured 51× slower).
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(DIGITS[(b >> 4) as usize] as char);
        out.push(DIGITS[(b & 0x0f) as usize] as char);
    }
    out
}

/// Backend-held result of the last query: the WebView pages windows out of
/// this store (`pg_rows`) instead of receiving the full row set over IPC.
pub struct StoredResult {
    columns: Vec<(String, String)>,
    store: tuplenest_result_stream::RowStore<Vec<serde_json::Value>>,
}

/// Hard cap on rows kept for scrolling. Beyond this the stream is still
/// drained and counted, but rows are dropped and the result marked truncated.
const RESULT_STORE_CAP: usize = 100_000;

/// Hard cap on *memory* kept for scrolling, whichever comes first.
///
/// The row cap alone was not a memory bound, only a bound on rows: 100,000
/// rows of a `jsonb` column holding 10 MB documents is a terabyte, and nothing
/// stopped it. Wide rows are exactly the case where a user has no intuition
/// for how much they just asked for.
///
/// 256 MB: comfortably more than any result someone reads, far less than
/// enough to take the machine down with it.
const RESULT_STORE_BYTES: usize = 256 * 1024 * 1024;

/// Rough in-memory size of one row, for the byte budget.
///
/// An estimate, not a measurement: what matters is that a 10 MB document
/// counts as far more than a small integer, not that the number is exact.
/// `serde_json::to_string` on every row would be a real cost on the hot path
/// to buy precision nobody needs.
fn approx_bytes(row: &[serde_json::Value]) -> usize {
    /*
     * What a row really costs. Every cell is a `serde_json::Value` held inline
     * in the row's Vec — 32 bytes, even for NULL — and every heap allocation
     * carries allocator overhead. Counting a NULL as 8 bytes let a 200-column,
     * mostly-NULL result of 100k rows reach 1.1 GB while the estimate said it
     * was under the 256 MB budget (measured).
     */
    const VALUE: usize = std::mem::size_of::<serde_json::Value>();
    const ALLOC: usize = 16; // per heap allocation: header and rounding
    fn heap(v: &serde_json::Value) -> usize {
        match v {
            serde_json::Value::Null | serde_json::Value::Bool(_) | serde_json::Value::Number(_) => {
                0
            }
            serde_json::Value::String(s) => ALLOC + s.capacity(),
            serde_json::Value::Array(a) => {
                ALLOC + a.len() * VALUE + a.iter().map(heap).sum::<usize>()
            }
            serde_json::Value::Object(o) => o
                .iter()
                // key String + value + a map node
                .map(|(k, v)| ALLOC + k.len() + VALUE + 48 + heap(v))
                .sum::<usize>(),
        }
    }
    // The row's own Vec header in the store, its buffer, and every cell.
    24 + ALLOC + row.len() * VALUE + row.iter().map(heap).sum::<usize>()
}

/// Streams batches into a bounded RowStore.
struct StoreSink {
    inner: StdMutex<StoredResult>,
}

#[async_trait]
impl BatchSink for StoreSink {
    fn wants_rows(&self) -> bool {
        self.inner
            .lock()
            .map(|i| !i.store.is_full())
            .unwrap_or(false)
    }

    async fn deliver(&self, batch: RowBatch) -> Result<(), Box<DriverError>> {
        let mut inner = self.inner.lock().expect("sink lock");
        if inner.columns.is_empty() {
            inner.columns = batch
                .columns
                .iter()
                .map(|c| (c.name.clone(), c.db_type.clone()))
                .collect();
        }
        for row in batch.rows {
            // Past the cap the row is only counted. Converting it first was
            // all the work of storing it, for a row thrown away (a 1M-row
            // query converted 900k rows it then dropped).
            if inner.store.is_full() {
                inner.store.skip();
                continue;
            }
            let json: Vec<serde_json::Value> = row.into_iter().map(cell_to_json).collect();
            let bytes = approx_bytes(&json);
            inner.store.push_sized(json, bytes);
        }
        Ok(())
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResultOut {
    columns: Vec<ColumnOut>,
    /// Rows seen from the server (including any dropped past the cap).
    total_rows: u64,
    /// Rows available for paging via `pg_rows`.
    stored_rows: usize,
    truncated: bool,
    rows_affected: Option<u64>,
    elapsed_ms: u64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnOut {
    name: String,
    db_type: String,
}

/// Does this statement opt out of query history? A `-- tuplenest:no-history`
/// line comment anywhere in the SQL suppresses the history row (e.g. before a
/// `ALTER ROLE … PASSWORD …`). It does NOT suppress the prod audit log — that
/// is an accountability record and must not be silenceable by a comment.
fn opts_out_of_history(sql: &str) -> bool {
    sql.to_ascii_lowercase().contains("tuplenest:no-history")
}

/// Best-effort redaction of secret literals before SQL is written to disk.
///
/// `tuplenest_telemetry::redact_text` already handles `password=…` and
/// connection-string URLs, but SQL's own shapes use a keyword + whitespace +
/// quoted literal (`PASSWORD 'x'`, `IDENTIFIED BY 'x'`, `ENCRYPTED PASSWORD
/// 'x'`) that it doesn't match. This scrubs those, then defers to redact_text.
/// Documented as best-effort, not a guarantee — the honest position is that
/// truly sensitive statements should be run with history disabled.
fn redact_sql(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let lower = sql.to_ascii_lowercase();
    let mut i = 0;
    // Keywords after which a quoted literal is a secret.
    const MARKERS: [&str; 2] = ["password", "identified by"];
    while i < sql.len() {
        let mut matched = false;
        for m in MARKERS {
            if lower[i..].starts_with(m) {
                // Emit the keyword, then look for the next quoted literal and
                // replace its contents.
                let after = i + m.len();
                let rest = &sql[after..];
                let ws = rest.len() - rest.trim_start().len();
                let body = &rest[ws..];
                if let Some(q @ ('\'' | '"')) = body.chars().next() {
                    if let Some(close) = body[1..].find(q) {
                        out.push_str(&sql[i..after]); // keyword
                        out.push_str(&rest[..ws]); // whitespace
                        out.push(q);
                        out.push_str("[REDACTED]");
                        out.push(q);
                        i = after + ws + 1 + close + 1;
                        matched = true;
                        break;
                    }
                }
            }
        }
        if !matched {
            let ch = sql[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    tuplenest_telemetry::redact_text(&out)
}

#[cfg(test)]
mod redact_sql_tests {
    use super::*;

    #[test]
    fn scrubs_create_role_password_literal() {
        let out = redact_sql("CREATE ROLE app PASSWORD 'hunter2'");
        assert!(!out.contains("hunter2"), "{out}");
        assert!(out.contains("PASSWORD '[REDACTED]'"), "{out}");
    }

    #[test]
    fn scrubs_alter_user_and_identified_by() {
        assert!(!redact_sql("ALTER USER x PASSWORD 'p@ss'").contains("p@ss"));
        assert!(!redact_sql("... IDENTIFIED BY \"sekret\"").contains("sekret"));
    }

    #[test]
    fn defers_to_telemetry_for_kv_and_urls() {
        assert!(!redact_sql("copy from 'postgresql://u:pw@h/db'").contains("pw"));
    }

    #[test]
    fn leaves_ordinary_sql_alone() {
        let sql = "SELECT * FROM users WHERE id = 1";
        assert_eq!(redact_sql(sql), sql);
    }

    #[test]
    fn no_history_directive_detected_case_insensitively() {
        assert!(opts_out_of_history(
            "-- TupleNest:No-History\nALTER ROLE x PASSWORD 'y'"
        ));
        assert!(!opts_out_of_history("SELECT 1"));
    }
}

/// Records an execution in query history (E1.5). Prod-tagged connections
/// store no SQL text. History failures never fail the query itself.
#[allow(clippy::too_many_arguments)]
fn record_history(
    app: &crate::AppState,
    state: &PgState,
    sql: &str,
    status: &str,
    error_text: Option<String>,
    rows_returned: u64,
    rows_affected: Option<u64>,
    duration_ms: u64,
) {
    let connection_key = state
        .cache_key
        .lock()
        .ok()
        .and_then(|k| k.clone())
        .unwrap_or_else(|| "<unknown>".into());
    let is_prod = state
        .connected_env
        .lock()
        .ok()
        .and_then(|e| e.clone())
        .as_deref()
        == Some("prod");
    let no_history = opts_out_of_history(sql);
    // Store SQL redacted of secret literals; prod history still omits it
    // entirely. The `-- tuplenest:no-history` directive drops the history row.
    let sql_text = if is_prod || no_history {
        None
    } else {
        Some(redact_sql(sql))
    };
    let entry = tuplenest_workspace_store::HistoryEntry {
        id: uuid::Uuid::new_v4().to_string(),
        connection_key,
        sql_text,
        status: status.to_string(),
        error_text,
        rows_returned,
        rows_affected,
        started_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0),
        duration_ms,
        favorite: false,
    };
    if let Ok(store) = app.store.lock() {
        // The no-history directive suppresses only the history row (timing,
        // counts, status) that carries no value without its SQL. It records
        // nothing rather than a contentless row.
        if !no_history {
            if let Err(e) = store.history_add(&entry, 1_000) {
                tracing::warn!(component = "history", error = %e, "failed to record history");
            }
        }
        // Prod audit trail: retained even under the no-history directive — it is
        // an accountability record, not user history, and must not be
        // silenceable by a comment. SQL is redacted of secret literals but
        // otherwise kept in full.
        if is_prod {
            let _ = store.audit_add(&entry.connection_key, Some("prod"), &redact_sql(sql));
        }
    }
}

/// Runs SQL on the active session. Rows stream into the backend store;
/// the WebView pages them with `pg_rows`.
#[tauri::command]
pub async fn pg_query(
    app: tauri::State<'_, crate::AppState>,
    state: tauri::State<'_, PgState>,
    sql: String,
    params: Option<Vec<serde_json::Value>>,
) -> Result<QueryResultOut, String> {
    // The previous result is kept until a new row set replaces it. Clearing
    // it up front freed memory a little sooner, but every statement — a row
    // edit's UPDATE, a SAVEPOINT, an import's INSERT, a failed EXPLAIN — then
    // emptied the store the grid was still paging, so its rows came back
    // empty, sort blanked it and export wrote a header-only file. The cost:
    // while a new query runs, the old result (at most the store budget) stays.

    let started_wall = std::time::Instant::now();
    let mut guard = state.session.lock().await;
    let session = guard.as_mut().ok_or("not connected")?;

    let sink = StoreSink {
        inner: StdMutex::new(StoredResult {
            columns: Vec::new(),
            store: tuplenest_result_stream::RowStore::with_budget(
                RESULT_STORE_CAP,
                RESULT_STORE_BYTES,
            ),
        }),
    };
    // JSON param values from the WebView → typed ParamValue. Text is the
    // safe default; the server casts as needed for the placeholder's type.
    let bound: Vec<tuplenest_driver_api::ParamValue> = params
        .unwrap_or_default()
        .into_iter()
        .map(json_to_param)
        .collect();
    let request = QueryRequest {
        execution_id: ExecutionId::new(),
        sql: sql.clone(),
        params: bound,
        row_limit: 0,
        timeout_ms: 0,
    };
    let summary = match session.execute(request, &sink).await {
        Ok(summary) => summary,
        Err(e) => {
            // E1.1: a network-category failure means the session is broken.
            // Mark it dead so nothing can silently re-run on a half-open
            // connection; the user must reconnect explicitly.
            let broken = matches!(e.category, tuplenest_driver_api::ErrorCategory::Network);
            // Persist the reduced form (no DETAIL/row values); show the full
            // report in memory. Compute the disk copy before `e` is consumed.
            let persisted = persisted_error(&e);
            let msg = err_to_string(&e);
            let status = if msg.to_lowercase().contains("cancel") {
                "cancelled"
            } else {
                "error"
            };
            record_history(
                &app,
                &state,
                &sql,
                status,
                Some(persisted),
                0,
                None,
                started_wall.elapsed().as_millis() as u64,
            );
            if broken {
                *guard = None; // session
                               // Before releasing the slot, for the same reason as Disconnect.
                *state.cancel.lock().map_err(|_| "cancel lock poisoned")? = None;
                *state.tunnel.lock().map_err(|_| "tunnel lock poisoned")? = None;
                drop(guard);
                tracing::warn!(
                    component = "pg",
                    "session marked broken after network error"
                );
                return Err(format!(
                    "Connection lost: {msg} — the session was closed. Reconnect to continue; nothing was re-run."
                ));
            }
            return Err(msg);
        }
    };
    let stored = sink.inner.into_inner().map_err(|_| "sink lock poisoned")?;
    record_history(
        &app,
        &state,
        &sql,
        "success",
        None,
        summary.rows_returned.max(stored.store.total_seen()),
        summary.rows_affected,
        summary.duration_ms,
    );
    tracing::info!(
        component = "pg",
        rows = summary.rows_returned.max(stored.store.total_seen()),
        duration_ms = summary.duration_ms,
        "query finished" // NOTE: query text is deliberately not logged
    );
    let out = QueryResultOut {
        columns: stored
            .columns
            .iter()
            .map(|(name, db_type)| ColumnOut {
                name: name.clone(),
                db_type: db_type.clone(),
            })
            .collect(),
        // The driver stops handing rows over once the store is full, so the
        // store has not seen them all; the driver has counted them.
        total_rows: summary.rows_returned.max(stored.store.total_seen()),
        stored_rows: stored.store.stored(),
        truncated: stored.store.truncated() || summary.rows_returned > stored.store.stored() as u64,
        rows_affected: summary.rows_affected,
        elapsed_ms: summary.duration_ms,
    };
    if !stored.columns.is_empty() {
        *state.result.lock().map_err(|_| "result lock poisoned")? = Some(stored);
    }
    Ok(out)
}

/// Pages a window of rows out of the last query's backend store.
#[tauri::command]
pub fn pg_rows(
    state: tauri::State<'_, PgState>,
    offset: usize,
    limit: usize,
) -> Result<Box<serde_json::value::RawValue>, String> {
    let guard = state.result.lock().map_err(|_| "result lock poisoned")?;
    let stored = guard.as_ref().ok_or("no result")?;
    // Serialized straight from the store. `.to_vec()` deep-cloned every row
    // of the window first, only to serialize the clone and drop it.
    let window = stored.store.window(offset, limit.min(1_000));
    serde_json::value::to_raw_value(window).map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataOut {
    pub payload: serde_json::Value,
    /// True when served from the local cache rather than the live server.
    pub cached: bool,
    /// Unix seconds of the cache write, when `cached`.
    pub fetched_at: Option<i64>,
}

/// (object_type, schema_scope, name_scope) addressing for a request.
fn cache_scope(request: &MetadataRequest) -> (&'static str, String, String) {
    match request {
        MetadataRequest::ServerInfo => ("server", String::new(), String::new()),
        MetadataRequest::ListSchemas => ("schema", String::new(), String::new()),
        MetadataRequest::ListObjects { schema } => ("object", schema.clone(), String::new()),
        MetadataRequest::DescribeObject { schema, name } => {
            ("columns", schema.clone(), name.clone())
        }
        // Live-only requests are never cached.
        MetadataRequest::ServerActivity => ("activity", String::new(), String::new()),
        MetadataRequest::Relationships { schema } => ("rels", schema.clone(), String::new()),
        MetadataRequest::ListPartitions { schema, table } => {
            ("partitions", schema.clone(), table.clone())
        }
        // Index usage counters are live numbers — caching them would show
        // "never scanned" for an index that is being scanned right now.
        MetadataRequest::ListIndexes { schema, table } => {
            ("indexes", schema.clone(), table.clone())
        }
        MetadataRequest::ListConstraints { schema, table } => {
            ("constraints", schema.clone(), table.clone())
        }
        // Sizes and usage counters are live facts; a cached copy would be a lie
        // with a timestamp on it.
        MetadataRequest::ObjectDetails { schema, name, .. } => {
            ("details", schema.clone(), name.clone())
        }
        MetadataRequest::ListTypes { schema } => ("types", schema.clone(), String::new()),
        MetadataRequest::ListRoutines { schema } => ("routines", schema.clone(), String::new()),
        // Every one of these reads a live counter, a live size, or the current
        // contents of the database. Caching any of them would hand the user a
        // stale number wearing the costume of a fresh one — and these are
        // exactly the numbers people act on.
        MetadataRequest::IndexHealth { schema } => (
            "index_health",
            schema.clone().unwrap_or_default(),
            String::new(),
        ),
        MetadataRequest::TableHealth { schema } => (
            "table_health",
            schema.clone().unwrap_or_default(),
            String::new(),
        ),
        MetadataRequest::TopQueries { .. } => ("top_queries", String::new(), String::new()),
        MetadataRequest::SearchObjects { term, .. } => ("search", term.clone(), String::new()),
        MetadataRequest::PartitionOverview { schema, table } => {
            ("partition_overview", schema.clone(), table.clone())
        }
    }
}

fn read_cache(
    state: &PgState,
    key: &str,
    request: &MetadataRequest,
) -> Result<Option<MetadataOut>, String> {
    let cache = state.cache.lock().map_err(|_| "cache lock poisoned")?;
    let (object_type, schema, name) = cache_scope(request);
    let out = match request {
        MetadataRequest::ListSchemas | MetadataRequest::ListObjects { .. } => {
            let entries = cache
                .list(key, object_type, &schema)
                .map_err(|e| e.to_string())?;
            if entries.is_empty() {
                None
            } else {
                let fetched_at = entries.iter().map(|e| e.fetched_at).min();
                let items: Result<Vec<serde_json::Value>, _> = entries
                    .iter()
                    .map(|e| serde_json::from_str(&e.payload_json))
                    .collect();
                Some(MetadataOut {
                    payload: serde_json::Value::Array(items.map_err(|e| e.to_string())?),
                    cached: true,
                    fetched_at,
                })
            }
        }
        _ => cache
            .get(key, object_type, &schema, &name)
            .map_err(|e| e.to_string())?
            .map(|entry| {
                Ok::<_, String>(MetadataOut {
                    payload: serde_json::from_str(&entry.payload_json)
                        .map_err(|e| e.to_string())?,
                    cached: true,
                    fetched_at: Some(entry.fetched_at),
                })
            })
            .transpose()?,
    };
    Ok(out)
}

fn write_cache(
    state: &PgState,
    key: &str,
    request: &MetadataRequest,
    payload: &serde_json::Value,
) -> Result<(), String> {
    let mut cache = state.cache.lock().map_err(|_| "cache lock poisoned")?;
    let (object_type, schema, name) = cache_scope(request);
    match request {
        MetadataRequest::ListSchemas => {
            // Payload is an array of schema-name strings.
            let entries: Vec<(String, String)> = payload
                .as_array()
                .unwrap_or(&vec![])
                .iter()
                .filter_map(|v| {
                    v.as_str()
                        .map(|s| (s.to_string(), serde_json::json!(s).to_string()))
                })
                .collect();
            cache
                .replace_list(key, object_type, &schema, &entries)
                .map_err(|e| e.to_string())
        }
        MetadataRequest::ListObjects { .. } => {
            // Payload is an array of {name, kind, comment} objects.
            let entries: Vec<(String, String)> = payload
                .as_array()
                .unwrap_or(&vec![])
                .iter()
                .filter_map(|v| v["name"].as_str().map(|n| (n.to_string(), v.to_string())))
                .collect();
            cache
                .replace_list(key, object_type, &schema, &entries)
                .map_err(|e| e.to_string())
        }
        _ => cache
            .put(key, object_type, &schema, &name, &payload.to_string())
            .map_err(|e| e.to_string()),
    }
}

/// Metadata for the explorer tree (E1.3). Live when connected — with
/// write-through to the cache — falling back to cached data on live errors.
#[tauri::command]
pub async fn pg_metadata(
    state: tauri::State<'_, PgState>,
    request: MetadataRequest,
) -> Result<MetadataOut, String> {
    let guard = state.session.lock().await;
    // Read under the session lock: taken before it, a request queued behind
    // a reconnect cached the new database's schema under the old key.
    let key = state
        .cache_key
        .lock()
        .map_err(|_| "key lock poisoned")?
        .clone();
    let session = guard.as_ref().ok_or("not connected")?;
    match session.metadata(request.clone()).await {
        Ok(response) => {
            if let Some(key) = &key {
                // Cache failures must never break live metadata.
                if let Err(e) = write_cache(&state, key, &request, &response.payload) {
                    tracing::warn!(component = "metadata-cache", error = %e, "write-through failed");
                }
            }
            Ok(MetadataOut {
                payload: response.payload,
                cached: false,
                fetched_at: None,
            })
        }
        Err(live_err) => {
            if let Some(key) = &key {
                if let Some(cached) = read_cache(&state, key, &request)? {
                    tracing::warn!(
                        component = "metadata-cache",
                        "serving stale cache after live failure"
                    );
                    return Ok(cached);
                }
            }
            Err(err_to_string(&live_err))
        }
    }
}

/// Live server activity for the monitoring panel (Phase 6). Not cached.
#[tauri::command]
pub async fn pg_activity(state: tauri::State<'_, PgState>) -> Result<serde_json::Value, String> {
    let mut guard = state.session.lock().await;
    let session = guard.as_ref().ok_or("not connected")?;
    match session.metadata(MetadataRequest::ServerActivity).await {
        Ok(r) => Ok(r.payload),
        Err(e) => Err(lost_or_error(&state, &mut guard, &e)),
    }
}

/// Foreign-key relationships for the ER view (Phase 2).
#[tauri::command]
pub async fn pg_relationships(
    state: tauri::State<'_, PgState>,
    schema: String,
) -> Result<serde_json::Value, String> {
    let guard = state.session.lock().await;
    let session = guard.as_ref().ok_or("not connected")?;
    session
        .metadata(MetadataRequest::Relationships { schema })
        .await
        .map(|r| r.payload)
        .map_err(|e| err_to_string(&e))
}

/// Cancel (soft) or terminate (hard) a backend by pid from the monitor.
#[tauri::command]
pub async fn pg_admin_backend(
    state: tauri::State<'_, PgState>,
    pid: i32,
    terminate: bool,
) -> Result<bool, String> {
    let guard = state.session.lock().await;
    let session = guard.as_ref().ok_or("not connected")?;
    session
        .admin_backend(pid, terminate)
        .await
        .map_err(|e| err_to_string(&e))
}

/// Cache-only metadata: renders the explorer for a saved profile before —
/// or without — connecting. Never touches the network.
#[tauri::command]
pub fn pg_metadata_cached(
    state: tauri::State<'_, PgState>,
    params: PgParams,
    request: MetadataRequest,
) -> Result<Option<MetadataOut>, String> {
    read_cache(&state, &cache_key_of(&params), &request)
}

// --- Transactions (E1.4) ----------------------------------------------------

#[tauri::command]
pub async fn pg_begin(state: tauri::State<'_, PgState>) -> Result<(), String> {
    let mut guard = state.session.lock().await;
    let session = guard.as_mut().ok_or("not connected")?;
    match session
        .begin(tuplenest_driver_api::TransactionOptions::default())
        .await
    {
        Ok(_) => Ok(()),
        Err(e) => Err(lost_or_error(&state, &mut guard, &e)),
    }
}

/// Whether the server has a transaction open on this session — including one
/// the user began by typing `BEGIN`, which `pg_begin` never saw.
#[tauri::command]
pub async fn pg_in_transaction(state: tauri::State<'_, PgState>) -> Result<bool, String> {
    let mut guard = state.session.lock().await;
    let session = guard.as_ref().ok_or("not connected")?;
    match session.server_in_transaction().await {
        Ok(v) => Ok(v),
        Err(e) => Err(lost_or_error(&state, &mut guard, &e)),
    }
}

#[tauri::command]
pub async fn pg_commit(state: tauri::State<'_, PgState>) -> Result<(), String> {
    let mut guard = state.session.lock().await;
    let session = guard.as_mut().ok_or("not connected")?;
    match session.commit().await {
        Ok(()) => Ok(()),
        Err(e) => Err(lost_or_error(&state, &mut guard, &e)),
    }
}

#[tauri::command]
pub async fn pg_rollback(state: tauri::State<'_, PgState>) -> Result<(), String> {
    let mut guard = state.session.lock().await;
    let session = guard.as_mut().ok_or("not connected")?;
    match session.rollback().await {
        Ok(()) => Ok(()),
        Err(e) => Err(lost_or_error(&state, &mut guard, &e)),
    }
}

/*
 * The session slot, for replacing or dropping it.
 *
 * `pg_query` holds the session lock for the whole query, so Disconnect (or a
 * reconnect) used to wait until a long query finished by itself — minutes, on
 * a big table. If the lock is busy, cancel what holds it first. The cancel is
 * bounded: it dials the server, which after a network loss may never answer.
 */
async fn lock_session<'a>(
    state: &'a PgState,
) -> Result<tokio::sync::MutexGuard<'a, Option<tuplenest_driver_postgres::PostgresSession>>, String>
{
    if let Ok(guard) = state.session.try_lock() {
        return Ok(guard);
    }
    // Cancel, then wait a bounded time — and again: tokio's mutex is FIFO, so
    // a query queued behind the running one gets the lock first and must be
    // cancelled too; and a cancel that lands before the statement reaches the
    // server does nothing. Three rounds, then say so rather than hang (a
    // half-open socket used to block here until the OS gave up on TCP).
    let step = std::time::Duration::from_secs(5);
    for _ in 0..3 {
        let handle = state
            .cancel
            .lock()
            .map_err(|_| "cancel lock poisoned")?
            .clone();
        if let Some(h) = handle {
            let _ = tokio::time::timeout(step, h.cancel()).await;
        }
        if let Ok(guard) = tokio::time::timeout(step, state.session.lock()).await {
            return Ok(guard);
        }
    }
    Err("The running query did not stop after three cancel requests. Try again, or restart the app if the server is unreachable.".into())
}

/// Cancels the in-flight query via the wire-protocol cancel key. Does not
/// require the session lock, so it works while `pg_query` is blocked.
#[tauri::command]
pub async fn pg_cancel(state: tauri::State<'_, PgState>) -> Result<(), String> {
    let handle = state
        .cancel
        .lock()
        .map_err(|_| "cancel lock poisoned")?
        .clone()
        .ok_or("not connected")?;
    handle.cancel().await.map_err(|e| err_to_string(&e))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Disconnect used to wait for a running query to finish by itself, since
    /// `pg_query` holds the session lock throughout. It must cancel instead.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "requires live PostgreSQL (TUPLENEST_TEST_PG_*)"]
    async fn taking_the_session_cancels_a_running_query_instead_of_waiting() {
        let env = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.into());
        let config = tuplenest_driver_api::ConnectionConfig {
            driver_id: "postgres".into(),
            name: "t".into(),
            environment: tuplenest_driver_api::Environment::Dev,
            read_only: false,
            host: env("TUPLENEST_TEST_PG_HOST", "localhost"),
            port: env("TUPLENEST_TEST_PG_PORT", "5432").parse().unwrap(),
            database: env("TUPLENEST_TEST_PG_DB", "postgres"),
            username: env("TUPLENEST_TEST_PG_USER", "postgres"),
            secret_ref: None,
            tls_mode: tuplenest_driver_api::TlsMode::Disabled,
            tls_ca_path: None,
            options: Default::default(),
            default_statement_timeout_ms: 0,
        };
        let pw = std::env::var("TUPLENEST_TEST_PG_PASSWORD").ok();
        let session = tuplenest_driver_postgres::PostgresDriver
            .connect_concrete_with_password(config, pw.as_deref())
            .await
            .unwrap();
        let state = std::sync::Arc::new(PgState::new(
            tuplenest_metadata_cache::MetadataCache::open_in_memory().unwrap(),
        ));
        *state.cancel.lock().unwrap() = Some(session.cancel_handle());
        *state.session.lock().await = Some(session);

        // One query running, and a second one queued behind it on the lock —
        // tokio's mutex is FIFO, so the queued one gets the lock next and has
        // to be cancelled as well.
        let sleep = |st: std::sync::Arc<PgState>| {
            tokio::spawn(async move {
                let mut g = st.session.lock().await;
                let req = QueryRequest {
                    execution_id: ExecutionId::new(),
                    sql: "SELECT pg_sleep(30)".into(),
                    params: vec![],
                    row_limit: 0,
                    timeout_ms: 0,
                };
                struct NullSink;
                #[async_trait]
                impl BatchSink for NullSink {
                    async fn deliver(&self, _: RowBatch) -> Result<(), Box<DriverError>> {
                        Ok(())
                    }
                }
                g.as_mut().unwrap().execute(req, &NullSink).await
            })
        };
        let running = sleep(state.clone());
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let queued = sleep(state.clone());
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        let started = std::time::Instant::now();
        let slot = lock_session(&state).await.unwrap();
        assert!(
            started.elapsed() < std::time::Duration::from_secs(16),
            "waited for the queries instead of cancelling them"
        );
        drop(slot);
        assert!(
            running.await.unwrap().is_err(),
            "the running query should have been cancelled"
        );
        assert!(
            queued.await.unwrap().is_err(),
            "the queued query should have been cancelled"
        );
    }

    fn app_with_profile() -> crate::AppState {
        let store = tuplenest_workspace_store::Store::open_in_memory().unwrap();
        store
            .connection_upsert(&tuplenest_workspace_store::ConnectionRecord {
                id: "p1".into(),
                name: "prod".into(),
                driver: "postgres".into(),
                environment: Some("prod".into()),
                color: None,
                read_only: false,
                host: "prod.db".into(),
                port: 5432,
                database: "app".into(),
                username: "svc".into(),
                secret_ref: Some("tn-secret-prod".into()),
                tls_mode: "verify-full".into(),
                tls_ca_path: None,
                ssh_json: None,
                options_json: None,
                statement_timeout_ms: 0,
            })
            .unwrap();
        crate::AppState {
            store: std::sync::Mutex::new(store),
            _log_guard: None,
        }
    }

    fn params(host: &str, secret: Option<&str>) -> PgParams {
        serde_json::from_value(serde_json::json!({
            "host": host, "port": 5432, "database": "app", "username": "svc",
            "secretRef": secret, "tlsMode": "verify-full"
        }))
        .unwrap()
    }

    #[test]
    fn a_saved_password_only_goes_to_its_own_server() {
        // A compromised WebView could send a prod profile's ref with
        // host: "evil" and TLS off, and receive the password in cleartext.
        let app = app_with_profile();
        let pg = PgState::new(tuplenest_metadata_cache::MetadataCache::open_in_memory().unwrap());
        assert!(authorize_secret(&app, &pg, &params("prod.db", Some("tn-secret-prod"))).is_ok());
        assert!(
            authorize_secret(&app, &pg, &params("evil.example", Some("tn-secret-prod"))).is_err()
        );
        let mut other_user = params("prod.db", Some("tn-secret-prod"));
        other_user.username = "postgres".into();
        assert!(authorize_secret(&app, &pg, &other_user).is_err());
        assert!(authorize_secret(&app, &pg, &params("anywhere", None)).is_ok());
        // Same address, weaker channel: the downgrade this binding stops.
        let mut plaintext = params("prod.db", Some("tn-secret-prod"));
        plaintext.tls_mode = Some("disabled".into());
        assert!(
            authorize_secret(&app, &pg, &plaintext).is_err(),
            "TLS downgrade must be refused"
        );
        let mut via_bastion = params("prod.db", Some("tn-secret-prod"));
        via_bastion.ssh = Some(SshParams {
            host: "attacker.example".into(),
            port: 22,
            username: "x".into(),
            key_path: "~/.ssh/id_ed25519".into(),
            fingerprint: "SHA256:attacker".into(),
        });
        assert!(
            authorize_secret(&app, &pg, &via_bastion).is_err(),
            "a different SSH hop must be refused"
        );
        // A password typed into the form this session may be tried anywhere.
        pg.fresh_secrets
            .lock()
            .unwrap()
            .insert("tn-secret-new".into());
        assert!(authorize_secret(&app, &pg, &params("new.db", Some("tn-secret-new"))).is_ok());
        // Once its profile is saved, a fresh ref is bound like any other.
        pg.bind_secret("tn-secret-new");
        assert!(authorize_secret(&app, &pg, &params("new.db", Some("tn-secret-new"))).is_err());
    }

    #[test]
    fn non_finite_floats_are_shown_as_postgres_spells_them_not_as_null() {
        assert_eq!(
            cell_to_json(CellValue::Float(f64::NAN)),
            serde_json::json!("NaN")
        );
        assert_eq!(
            cell_to_json(CellValue::Float(f64::INFINITY)),
            serde_json::json!("Infinity")
        );
        assert_eq!(
            cell_to_json(CellValue::Float(f64::NEG_INFINITY)),
            serde_json::json!("-Infinity")
        );
        assert_eq!(cell_to_json(CellValue::Float(1.5)), serde_json::json!(1.5));
    }

    #[test]
    fn hex_matches_the_per_byte_format() {
        let bytes: Vec<u8> = (0..=255).collect();
        let slow: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hex(&bytes), slow);
        assert_eq!(hex(&[]), "");
    }

    #[test]
    fn a_null_cell_costs_what_a_value_costs() {
        // 200 NULL columns: the old estimate said 1,624 bytes; the row really
        // holds 200 inline Values of 32 bytes each.
        let row = vec![serde_json::Value::Null; 200];
        assert!(approx_bytes(&row) >= 200 * std::mem::size_of::<serde_json::Value>());
    }

    #[test]
    fn int8_past_2_pow_53_reaches_the_webview_as_exact_text() {
        // As a JSON number this would be rounded by JSON.parse in the WebView.
        assert_eq!(
            cell_to_json(CellValue::Int(9_007_199_254_740_993)),
            serde_json::json!("9007199254740993")
        );
        assert_eq!(
            cell_to_json(CellValue::Int(-9_007_199_254_740_993)),
            serde_json::json!("-9007199254740993")
        );
        assert_eq!(
            cell_to_json(CellValue::Int(i64::MIN)),
            serde_json::json!(i64::MIN.to_string())
        );
        // Safe integers stay numbers, so nothing else changes shape.
        assert_eq!(
            cell_to_json(CellValue::Int(9_007_199_254_740_991)),
            serde_json::json!(9_007_199_254_740_991_i64)
        );
        assert_eq!(cell_to_json(CellValue::Int(42)), serde_json::json!(42));
    }
}
