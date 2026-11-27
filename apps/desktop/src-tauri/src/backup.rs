//! Backup and restore for PostgreSQL profiles, with the user's own
//! `pg_dump` and `pg_restore`.
//!
//! Security invariants:
//! - The tools run as child processes from an argument list — no shell, so
//!   nothing in a database or host name is ever interpreted.
//! - The password is never on the command line, where any local user could
//!   read it from the process table. It goes in a PGPASSFILE written 0600 in
//!   a private 0700 temp directory, removed when the run ends (and only if
//!   it cannot be expressed there — a line break — in PGPASSWORD, set for
//!   the child alone). The app's own PGPASSWORD is never passed on.
//! - The WebView names a saved profile by id and never a path: the file is
//!   chosen in a native dialog here, or is one this app recorded.
//! - Restoring into a profile tagged prod or staging needs its database name
//!   typed back, checked here as well as in the page; a read-only profile is
//!   never restored into.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Mutex as StdMutex;

use tuplenest_workspace_store::{BackupRecord, ConnectionRecord};

/// Settings key of the directory holding the tools, when the user set one.
/// Reserved: only `backup_tools_set` writes it, after checking it.
pub const TOOLS_SETTING: &str = "pg_tools_path";
pub const PROGRESS_EVENT: &str = "backup:progress";
pub const DONE_EVENT: &str = "backup:done";

/// libpq variables that must not leak from the app's environment into the
/// child: a password, a service file that names another server.
const CLEARED_ENV: [&str; 4] = ["PGPASSWORD", "PGPASSFILE", "PGSERVICE", "PGSERVICEFILE"];

/// Where a run connects: a saved profile's address, never anything else.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    pub tls_mode: String,
    pub tls_ca_path: Option<String>,
}

impl Target {
    pub fn of(profile: &ConnectionRecord) -> Result<Self, String> {
        if crate::engine::Engine::parse(Some(&profile.engine))
            != Ok(crate::engine::Engine::Postgres)
        {
            return Err("Backup and restore are available for PostgreSQL connections only.".into());
        }
        if crate::pg::saved_ssh(profile).is_some() {
            return Err(
                "Backup and restore through an SSH tunnel are not supported yet. Nothing was run."
                    .into(),
            );
        }
        let db = profile.database.trim();
        // libpq reads a dbname holding `=`, or starting with a URI prefix, as
        // a whole connection string — which could name another host.
        if db.is_empty()
            || db.contains('=')
            || db.starts_with("postgres://")
            || db.starts_with("postgresql://")
        {
            return Err(format!(
                "`{db}` cannot be passed to pg_dump as a database name. Nothing was run."
            ));
        }
        Ok(Self {
            host: profile.host.clone(),
            port: profile.port,
            database: db.to_string(),
            username: profile.username.clone(),
            tls_mode: profile.tls_mode.clone(),
            tls_ca_path: profile.tls_ca_path.clone().filter(|p| !p.trim().is_empty()),
        })
    }

    fn common_args(&self) -> Vec<OsString> {
        [
            "--verbose",
            "--no-password",
            "--host",
            self.host.as_str(),
            "--port",
            self.port.to_string().as_str(),
            "--username",
            self.username.as_str(),
        ]
        .into_iter()
        .map(OsString::from)
        .collect()
    }

    /// `pg_dump` arguments: custom format (compressed, and what pg_restore
    /// reads), written to `out`.
    pub fn dump_args(&self, out: &Path) -> Vec<OsString> {
        let mut args = self.common_args();
        args.extend(
            ["--format=custom", "--file"]
                .into_iter()
                .map(OsString::from),
        );
        args.push(out.as_os_str().to_owned());
        args.extend(
            ["--dbname", self.database.as_str()]
                .into_iter()
                .map(OsString::from),
        );
        args
    }

    /// `pg_restore` arguments: into this database, from `file`. `--` ends
    /// the options, so a file name can never be read as one.
    pub fn restore_args(&self, file: &Path) -> Vec<OsString> {
        let mut args = self.common_args();
        args.extend(
            ["--dbname", self.database.as_str(), "--"]
                .into_iter()
                .map(OsString::from),
        );
        args.push(file.as_os_str().to_owned());
        args
    }

    /// libpq settings for the child, matching the profile's TLS policy.
    /// `verify-*` without a CA file trusts the system roots, as the app's own
    /// driver does (`sslrootcert=system`, libpq 16+).
    pub fn env(&self) -> Vec<(&'static str, OsString)> {
        let mode = match self.tls_mode.as_str() {
            "disabled" => "disable",
            "prefer" => "prefer",
            "verify-ca" => "verify-ca",
            _ => "verify-full",
        };
        let mut env = vec![
            ("PGSSLMODE", OsString::from(mode)),
            ("PGCONNECT_TIMEOUT", OsString::from("15")),
            ("PGAPPNAME", OsString::from("TupleNest backup")),
        ];
        match (&self.tls_ca_path, mode.starts_with("verify")) {
            (Some(ca), _) => env.push(("PGSSLROOTCERT", OsString::from(ca))),
            (None, true) => env.push(("PGSSLROOTCERT", OsString::from("system"))),
            (None, false) => {}
        }
        env
    }
}

/// One `.pgpass` field: `\` and `:` escaped with a backslash.
fn pgpass_field(s: &str) -> String {
    s.replace('\\', "\\\\").replace(':', "\\:")
}

/// The one line of the private PGPASSFILE for `target`.
pub fn pgpass_line(target: &Target, password: &str) -> String {
    format!(
        "{}:{}:{}:{}:{}\n",
        pgpass_field(&target.host),
        target.port,
        pgpass_field(&target.database),
        pgpass_field(&target.username),
        pgpass_field(password)
    )
}

/// How the child gets the password.
pub enum PasswordFor {
    None,
    /// A PGPASSFILE in a private temp directory; both go when this is dropped.
    File {
        _dir: tempfile::TempDir,
        path: PathBuf,
    },
    /// PGPASSWORD for the child only: a password with a line break, which a
    /// pgpass file cannot hold.
    Env(String),
}

impl PasswordFor {
    pub fn new(target: &Target, password: Option<&str>) -> std::io::Result<Self> {
        let Some(password) = password.filter(|p| !p.is_empty()) else {
            return Ok(Self::None);
        };
        if password.contains(['\n', '\r']) {
            return Ok(Self::Env(password.to_string()));
        }
        let dir = tempfile::Builder::new()
            .prefix("tuplenest-pgpass-")
            .tempdir()?;
        // Owner-only, said here rather than trusted to the crate's default.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700))?;
        }
        let path = dir.path().join("pgpass");
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        use std::io::Write;
        let mut file = options.open(&path)?;
        file.write_all(pgpass_line(target, password).as_bytes())?;
        file.sync_all()?;
        Ok(Self::File { _dir: dir, path })
    }

    pub fn env(&self) -> Vec<(&'static str, OsString)> {
        match self {
            Self::None => vec![],
            Self::File { path, .. } => vec![("PGPASSFILE", path.clone().into_os_string())],
            Self::Env(p) => vec![("PGPASSWORD", OsString::from(p))],
        }
    }
}

/// `pg_dump` / `pg_restore` with the platform's suffix.
pub fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

/// Subdirectories of `parent` named `<prefix><version>`, newest version
/// first, each joined with `tail`.
fn versioned(parent: &Path, prefix: &str, tail: &str) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(parent) else {
        return vec![];
    };
    let mut found: Vec<(f64, PathBuf)> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let rest = name.strip_prefix(prefix)?;
            let digits: String = rest
                .chars()
                .take_while(|c| c.is_ascii_digit() || *c == '.')
                .collect();
            let version = digits.parse::<f64>().ok()?;
            Some((version, e.path().join(tail)))
        })
        .collect();
    found.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    found.into_iter().map(|(_, p)| p).collect()
}

/// Where the tools usually are, after PATH: Homebrew (both prefixes, and
/// keg-only libpq), Postgres.app, the EDB installers, Debian and RHEL.
fn common_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = [
        "/opt/homebrew/bin",
        "/opt/homebrew/opt/libpq/bin",
        "/usr/local/bin",
        "/usr/local/opt/libpq/bin",
        "/Applications/Postgres.app/Contents/Versions/latest/bin",
        "/usr/bin",
    ]
    .into_iter()
    .map(PathBuf::from)
    .collect();
    dirs.extend(versioned(
        Path::new("/opt/homebrew/opt"),
        "postgresql@",
        "bin",
    ));
    dirs.extend(versioned(Path::new("/usr/local/opt"), "postgresql@", "bin"));
    dirs.extend(versioned(Path::new("/Library/PostgreSQL"), "", "bin"));
    dirs.extend(versioned(Path::new("/usr/lib/postgresql"), "", "bin"));
    dirs.extend(versioned(Path::new("/usr"), "pgsql-", "bin"));
    dirs.extend(versioned(
        Path::new(r"C:\Program Files\PostgreSQL"),
        "",
        "bin",
    ));
    dirs
}

/// The directories searched, in order: the one the user set, then PATH, then
/// the usual install locations.
pub fn search_dirs(configured: Option<&Path>, path_env: Option<&std::ffi::OsStr>) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = configured.map(Path::to_path_buf).into_iter().collect();
    if let Some(path) = path_env {
        dirs.extend(std::env::split_paths(path));
    }
    dirs.extend(common_dirs());
    dirs
}

pub fn find_tool(name: &str, dirs: &[PathBuf]) -> Option<PathBuf> {
    dirs.iter().map(|d| d.join(exe(name))).find(|p| p.is_file())
}

/// The table a verbose line says is being dumped or restored, if any.
pub fn table_of(line: &str) -> Option<&str> {
    let rest = line
        .split_once("dumping contents of table ")
        .or_else(|| line.split_once("processing data for table "))?
        .1;
    Some(rest.trim().trim_matches('"'))
}

/// May this profile be restored into, with what was typed? Prod and staging
/// need the database name typed back, as the worst guard case does.
pub fn restore_allowed(profile: &ConnectionRecord, confirm: Option<&str>) -> Result<(), String> {
    if profile.read_only {
        return Err(format!(
            "{} is marked read-only, so nothing is restored into it.",
            profile.name
        ));
    }
    if let Some(env @ ("prod" | "staging")) = profile.environment.as_deref() {
        if confirm.map(str::trim) != Some(profile.database.trim()) {
            return Err(format!(
                "Restoring into a {env} connection needs its database name, {}, typed to confirm. Nothing was restored.",
                profile.database
            ));
        }
    }
    Ok(())
}

/// A suggested file name kept to a file name: no directories, no leading dot.
pub fn file_name_only(suggested: &str) -> String {
    let name = Path::new(suggested)
        .file_name()
        .map(|n| n.to_string_lossy().trim_start_matches('.').to_string())
        .unwrap_or_default();
    if name.is_empty() {
        "backup.dump".into()
    } else {
        name
    }
}

/// The run in progress: its id, and how to stop it.
#[derive(Default)]
pub struct BackupState {
    job: StdMutex<Option<(String, tokio::sync::oneshot::Sender<()>)>>,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    id: String,
    tables: u64,
    line: String,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Done {
    id: String,
    status: &'static str,
    message: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    id: String,
    file: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tools {
    pg_dump: Option<String>,
    pg_restore: Option<String>,
    configured: Option<String>,
}

fn store_of(
    app: &crate::AppState,
) -> Result<std::sync::MutexGuard<'_, tuplenest_workspace_store::Store>, String> {
    app.store
        .lock()
        .map_err(|_| "store lock poisoned".to_string())
}

fn configured_dir(app: &crate::AppState) -> Option<PathBuf> {
    store_of(app)
        .ok()?
        .setting_get::<String>(TOOLS_SETTING)
        .ok()
        .flatten()
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
}

fn tools(app: &crate::AppState) -> (Option<PathBuf>, Vec<PathBuf>) {
    let configured = configured_dir(app);
    let dirs = search_dirs(configured.as_deref(), std::env::var_os("PATH").as_deref());
    (configured, dirs)
}

fn missing(name: &str) -> String {
    format!(
        "{name} was not found. Install the PostgreSQL client tools (Homebrew: brew install libpq; \
         Debian/Ubuntu: apt install postgresql-client; or the installer from postgresql.org), \
         or set the folder that holds {name} on this page. Nothing was run."
    )
}

#[tauri::command]
pub fn backup_tools(app: tauri::State<'_, crate::AppState>) -> Tools {
    let (configured, dirs) = tools(&app);
    let show = |p: Option<PathBuf>| p.map(|p| p.to_string_lossy().into_owned());
    Tools {
        pg_dump: show(find_tool("pg_dump", &dirs)),
        pg_restore: show(find_tool("pg_restore", &dirs)),
        configured: show(configured),
    }
}

/// Sets (or, with None, clears) the folder the tools are taken from. It must
/// be a folder holding pg_dump or pg_restore: this is a path the app will
/// execute from, so the generic settings command may not write it.
#[tauri::command]
pub fn backup_tools_set(
    app: tauri::State<'_, crate::AppState>,
    dir: Option<String>,
) -> Result<Tools, String> {
    let dir = dir.filter(|d| !d.trim().is_empty());
    if let Some(d) = &dir {
        let p = Path::new(d.trim());
        if find_tool("pg_dump", &[p.to_path_buf()]).is_none()
            && find_tool("pg_restore", &[p.to_path_buf()]).is_none()
        {
            return Err(format!(
                "{} does not hold {} or {}.",
                p.display(),
                exe("pg_dump"),
                exe("pg_restore")
            ));
        }
    }
    store_of(&app)?
        .setting_set(TOOLS_SETTING, &dir.map(|d| d.trim().to_string()))
        .map_err(|e| e.to_string())?;
    Ok(backup_tools(app))
}

#[tauri::command]
pub fn backup_list(app: tauri::State<'_, crate::AppState>) -> Result<Vec<BackupRecord>, String> {
    store_of(&app)?.backup_list(50).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn backup_cancel(state: tauri::State<'_, BackupState>) -> bool {
    let job = state.job.lock().ok().and_then(|mut j| j.take());
    match job {
        Some((_, stop)) => stop.send(()).is_ok(),
        None => false,
    }
}

fn profile(app: &crate::AppState, id: &str) -> Result<ConnectionRecord, String> {
    store_of(app)?
        .connection_get(id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No saved connection with that id.".to_string())
}

fn busy(state: &BackupState) -> Result<(), String> {
    match state
        .job
        .lock()
        .map_err(|_| "backup lock poisoned")?
        .as_ref()
    {
        Some(_) => Err("A backup or restore is already running.".into()),
        None => Ok(()),
    }
}

/// Back up a saved profile's database to a file chosen in the save panel.
/// None when the panel was cancelled.
#[tauri::command]
pub fn backup_start(
    handle: tauri::AppHandle,
    app: tauri::State<'_, crate::AppState>,
    state: tauri::State<'_, BackupState>,
    connection_id: String,
    default_name: Option<String>,
) -> Result<Option<Started>, String> {
    use tauri_plugin_dialog::DialogExt;
    busy(&state)?;
    let profile = profile(&app, &connection_id)?;
    let target = Target::of(&profile)?;
    let (_, dirs) = tools(&app);
    let tool = find_tool("pg_dump", &dirs).ok_or_else(|| missing("pg_dump"))?;
    let name = file_name_only(
        default_name
            .as_deref()
            .unwrap_or(&format!("{}.dump", target.database)),
    );
    let Some(fp) = handle
        .dialog()
        .file()
        .set_file_name(&name)
        .add_filter("PostgreSQL backup", &["dump", "backup"])
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let out = fp.into_path().map_err(|e| e.to_string())?;
    let args = target.dump_args(&out);
    launch(
        handle, &app, &state, &profile, &target, "backup", tool, args, out, true,
    )
    .map(Some)
}

/// Restore into a saved profile's database, from a recorded backup or from
/// a file chosen in the open panel. None when the panel was cancelled.
#[tauri::command]
pub fn backup_restore(
    handle: tauri::AppHandle,
    app: tauri::State<'_, crate::AppState>,
    state: tauri::State<'_, BackupState>,
    connection_id: String,
    backup_id: Option<String>,
    confirm: Option<String>,
) -> Result<Option<Started>, String> {
    use tauri_plugin_dialog::DialogExt;
    busy(&state)?;
    let profile = profile(&app, &connection_id)?;
    let target = Target::of(&profile)?;
    restore_allowed(&profile, confirm.as_deref())?;
    let (_, dirs) = tools(&app);
    let tool = find_tool("pg_restore", &dirs).ok_or_else(|| missing("pg_restore"))?;
    let file = match backup_id {
        Some(id) => {
            let rec = store_of(&app)?
                .backup_get(&id)
                .map_err(|e| e.to_string())?
                .filter(|r| r.kind == "backup" && r.status == "done")
                .ok_or("That backup is not one this app finished.")?;
            PathBuf::from(rec.file_path)
        }
        None => {
            let Some(fp) = handle
                .dialog()
                .file()
                .add_filter("PostgreSQL backup", &["dump", "backup", "tar"])
                .blocking_pick_file()
            else {
                return Ok(None);
            };
            fp.into_path().map_err(|e| e.to_string())?
        }
    };
    if !file.is_file() {
        return Err(format!("{} is no longer there.", file.display()));
    }
    let args = target.restore_args(&file);
    launch(
        handle, &app, &state, &profile, &target, "restore", tool, args, file, false,
    )
    .map(Some)
}

#[allow(clippy::too_many_arguments)]
fn launch(
    handle: tauri::AppHandle,
    app: &crate::AppState,
    state: &BackupState,
    profile: &ConnectionRecord,
    target: &Target,
    kind: &'static str,
    tool: PathBuf,
    args: Vec<OsString>,
    file: PathBuf,
    remove_on_failure: bool,
) -> Result<Started, String> {
    let password = crate::pg::resolve_password(&profile.secret_ref)?;
    let secret = PasswordFor::new(target, password.as_ref().map(|s| s.expose()))
        .map_err(|e| format!("Could not prepare the password file: {e}. Nothing was run."))?;
    let id = uuid::Uuid::new_v4().to_string();
    let (stop, stopped) = tokio::sync::oneshot::channel();
    {
        let mut job = state.job.lock().map_err(|_| "backup lock poisoned")?;
        if job.is_some() {
            return Err("A backup or restore is already running.".into());
        }
        let store = store_of(app)?;
        store.backup_mark_interrupted().map_err(|e| e.to_string())?;
        store
            .backup_start(
                &id,
                Some(&profile.id),
                kind,
                &target.database,
                &file.to_string_lossy(),
            )
            .map_err(|e| e.to_string())?;
        *job = Some((id.clone(), stop));
    }
    let mut env = target.env();
    env.extend(secret.env());
    tracing::info!(component = "backup", kind, db = %target.database, "run started");
    let started = Started {
        id: id.clone(),
        file: file.to_string_lossy().into_owned(),
    };
    tauri::async_runtime::spawn(run(
        handle,
        id,
        tool,
        args,
        env,
        secret,
        file,
        remove_on_failure,
        stopped,
    ));
    Ok(started)
}

/// The last few non-empty lines a failed run wrote, for its message.
fn tail(lines: &[String]) -> Option<String> {
    let kept: Vec<&str> = lines
        .iter()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect();
    let from = kept.len().saturating_sub(4);
    (!kept.is_empty()).then(|| kept[from..].join("\n"))
}

#[allow(clippy::too_many_arguments)]
async fn run(
    handle: tauri::AppHandle,
    id: String,
    tool: PathBuf,
    args: Vec<OsString>,
    env: Vec<(&'static str, OsString)>,
    secret: PasswordFor,
    file: PathBuf,
    remove_on_failure: bool,
    stopped: tokio::sync::oneshot::Receiver<()>,
) {
    use tauri::{Emitter, Manager};
    use tokio::io::AsyncBufReadExt;

    let mut cmd = tokio::process::Command::new(&tool);
    cmd.args(&args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    for k in CLEARED_ENV {
        cmd.env_remove(k);
    }
    cmd.envs(env);

    let (status, message) = match cmd.spawn() {
        Err(e) => (
            "failed",
            Some(format!("{} could not be started: {e}", tool.display())),
        ),
        Ok(mut child) => {
            let reader = child.stderr.take().map(|stderr| {
                let (handle, id) = (handle.clone(), id.clone());
                tauri::async_runtime::spawn(async move {
                    let mut lines = tokio::io::BufReader::new(stderr).lines();
                    let mut seen: Vec<String> = Vec::new();
                    let mut tables = 0u64;
                    while let Ok(Some(line)) = lines.next_line().await {
                        if table_of(&line).is_some() {
                            tables += 1;
                        }
                        let _ = handle.emit(
                            PROGRESS_EVENT,
                            Progress {
                                id: id.clone(),
                                tables,
                                line: line.clone(),
                            },
                        );
                        seen.push(line);
                        if seen.len() > 50 {
                            seen.remove(0);
                        }
                    }
                    seen
                })
            });
            let waited = tokio::select! {
                r = child.wait() => Some(r),
                _ = stopped => None,
            };
            if waited.is_none() {
                let _ = child.kill().await;
            }
            let lines = match reader {
                Some(r) => r.await.unwrap_or_default(),
                None => vec![],
            };
            match waited {
                None => ("cancelled", Some("Cancelled.".to_string())),
                Some(Ok(s)) if s.success() => ("done", None),
                Some(Ok(s)) => (
                    "failed",
                    Some(tail(&lines).unwrap_or_else(|| format!("exited with {s}"))),
                ),
                Some(Err(e)) => ("failed", Some(e.to_string())),
            }
        }
    };
    // The password file and its directory go now, however the run ended.
    drop(secret);
    if status != "done" && remove_on_failure {
        // A half-written dump looks like a backup and is not one.
        let _ = std::fs::remove_file(&file);
    }
    let bytes = std::fs::metadata(&file).ok().map(|m| m.len());
    let app = handle.state::<crate::AppState>();
    if let Ok(store) = app.store.lock() {
        if let Err(e) = store.backup_finish(&id, status, bytes, message.as_deref()) {
            tracing::warn!(component = "backup", error = %e, "could not record the end of a run");
        }
    }
    let state = handle.state::<BackupState>();
    if let Ok(mut job) = state.job.lock() {
        if job.as_ref().is_some_and(|(j, _)| *j == id) {
            *job = None;
        }
    }
    tracing::info!(component = "backup", status, "run finished");
    let _ = handle.emit(
        DONE_EVENT,
        Done {
            id,
            status,
            message,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile() -> ConnectionRecord {
        ConnectionRecord {
            id: "p1".into(),
            name: "orders-prod".into(),
            engine: "postgres".into(),
            environment: Some("prod".into()),
            color: None,
            read_only: false,
            host: "db.internal".into(),
            port: 5433,
            database: "orders".into(),
            username: "app".into(),
            secret_ref: Some("tn-secret-1".into()),
            tls_mode: "verify-full".into(),
            tls_ca_path: None,
            ssh_json: None,
            options_json: None,
            statement_timeout_ms: 0,
        }
    }

    fn strings(args: &[OsString]) -> Vec<String> {
        args.iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    const PASSWORD: &str = "s3cr:et\\pw";

    #[test]
    fn dump_arguments_are_an_argv_list_with_no_password() {
        let t = Target::of(&profile()).unwrap();
        let args = strings(&t.dump_args(Path::new("/tmp/orders 1.dump")));
        assert_eq!(
            args,
            vec![
                "--verbose",
                "--no-password",
                "--host",
                "db.internal",
                "--port",
                "5433",
                "--username",
                "app",
                "--format=custom",
                "--file",
                "/tmp/orders 1.dump",
                "--dbname",
                "orders",
            ]
        );
        assert!(!args.iter().any(|a| a.contains("s3cr")));
    }

    #[test]
    fn restore_arguments_end_options_before_the_file() {
        let t = Target::of(&profile()).unwrap();
        let args = strings(&t.restore_args(Path::new("-rf.dump")));
        let n = args.len();
        assert_eq!(&args[n - 4..], ["--dbname", "orders", "--", "-rf.dump"]);
        assert!(args.contains(&"--no-password".to_string()));
    }

    #[test]
    fn the_password_goes_in_a_private_file_that_is_removed() {
        let t = Target::of(&profile()).unwrap();
        let secret = PasswordFor::new(&t, Some(PASSWORD)).unwrap();
        let env = secret.env();
        assert_eq!(env.len(), 1);
        assert_eq!(env[0].0, "PGPASSFILE");
        let path = PathBuf::from(&env[0].1);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "db.internal:5433:orders:app:s3cr\\:et\\\\pw\n"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
            let dir = std::fs::metadata(path.parent().unwrap()).unwrap();
            assert_eq!(dir.permissions().mode() & 0o777, 0o700);
        }
        // Not in any argument or other variable.
        assert!(!strings(&t.dump_args(Path::new("/x")))
            .iter()
            .any(|a| a.contains(PASSWORD)));
        assert!(!t
            .env()
            .iter()
            .any(|(_, v)| v.to_string_lossy().contains("s3cr")));
        let dir = path.parent().unwrap().to_path_buf();
        drop(secret);
        assert!(!path.exists(), "the password file outlived the run");
        assert!(!dir.exists(), "its directory outlived the run");
    }

    #[test]
    fn a_password_with_a_line_break_goes_to_the_child_environment_only() {
        let t = Target::of(&profile()).unwrap();
        let secret = PasswordFor::new(&t, Some("a\nb")).unwrap();
        let env = secret.env();
        assert_eq!(env, vec![("PGPASSWORD", OsString::from("a\nb"))]);
        assert!(matches!(
            PasswordFor::new(&t, None).unwrap(),
            PasswordFor::None
        ));
        assert!(matches!(
            PasswordFor::new(&t, Some("")).unwrap(),
            PasswordFor::None
        ));
        assert!(PasswordFor::None.env().is_empty());
        // The app's own variables are cleared from the child.
        assert!(CLEARED_ENV.contains(&"PGPASSWORD"));
    }

    #[test]
    fn tls_follows_the_profile() {
        let mut p = profile();
        let env = |p: &ConnectionRecord| {
            Target::of(p)
                .unwrap()
                .env()
                .into_iter()
                .map(|(k, v)| format!("{k}={}", v.to_string_lossy()))
                .collect::<Vec<_>>()
        };
        assert!(env(&p).contains(&"PGSSLMODE=verify-full".to_string()));
        assert!(env(&p).contains(&"PGSSLROOTCERT=system".to_string()));
        p.tls_ca_path = Some("/etc/ca.pem".into());
        p.tls_mode = "verify-ca".into();
        assert!(env(&p).contains(&"PGSSLROOTCERT=/etc/ca.pem".to_string()));
        assert!(env(&p).contains(&"PGSSLMODE=verify-ca".to_string()));
        p.tls_ca_path = None;
        p.tls_mode = "disabled".into();
        assert!(env(&p).contains(&"PGSSLMODE=disable".to_string()));
        assert!(!env(&p).iter().any(|e| e.starts_with("PGSSLROOTCERT")));
        p.tls_mode = "prefer".into();
        assert!(env(&p).contains(&"PGSSLMODE=prefer".to_string()));
    }

    #[test]
    fn refuses_what_it_cannot_run_safely() {
        let mut p = profile();
        p.database = "host=evil dbname=x".into();
        assert!(Target::of(&p).is_err());
        p.database = "postgresql://evil/x".into();
        assert!(Target::of(&p).is_err());
        p.database = " ".into();
        assert!(Target::of(&p).is_err());
        let mut p = profile();
        p.engine = "sqlite".into();
        assert!(Target::of(&p).unwrap_err().contains("PostgreSQL"));
        let mut p = profile();
        p.ssh_json = Some(
            r#"{"host":"bastion","port":22,"username":"u","keyPath":"/k","fingerprint":""}"#.into(),
        );
        assert!(Target::of(&p).unwrap_err().contains("SSH"));
    }

    #[test]
    fn restoring_into_prod_or_staging_needs_the_database_name_typed() {
        let mut p = profile();
        assert!(restore_allowed(&p, None).is_err());
        assert!(restore_allowed(&p, Some("order")).is_err());
        assert!(restore_allowed(&p, Some(" orders ")).is_ok());
        p.environment = Some("staging".into());
        assert!(restore_allowed(&p, Some("x"))
            .unwrap_err()
            .contains("staging"));
        p.environment = Some("dev".into());
        assert!(restore_allowed(&p, None).is_ok());
        p.read_only = true;
        assert!(restore_allowed(&p, Some("orders"))
            .unwrap_err()
            .contains("read-only"));
    }

    #[test]
    fn finds_the_tools_where_they_are() {
        let root = tempfile::tempdir().unwrap();
        let configured = root.path().join("mine");
        let on_path = root.path().join("path");
        for d in [&configured, &on_path] {
            std::fs::create_dir_all(d).unwrap();
        }
        std::fs::write(on_path.join(exe("pg_dump")), "").unwrap();
        std::fs::write(on_path.join(exe("pg_restore")), "").unwrap();
        let path_env = std::env::join_paths([&on_path]).unwrap();

        let dirs = search_dirs(Some(&configured), Some(&path_env));
        assert_eq!(dirs[0], configured);
        assert_eq!(
            find_tool("pg_dump", &dirs),
            Some(on_path.join(exe("pg_dump")))
        );

        // The folder the user set wins over PATH.
        std::fs::write(configured.join(exe("pg_dump")), "").unwrap();
        assert_eq!(
            find_tool("pg_dump", &dirs),
            Some(configured.join(exe("pg_dump")))
        );
        assert_eq!(find_tool("no_such_tool", &dirs[..2]), None);
    }

    #[test]
    fn versioned_installs_newest_first() {
        let root = tempfile::tempdir().unwrap();
        for v in ["9.6", "16", "17", "notaversion"] {
            std::fs::create_dir_all(root.path().join(format!("postgresql@{v}"))).unwrap();
        }
        let found = versioned(root.path(), "postgresql@", "bin");
        assert_eq!(
            found,
            vec![
                root.path().join("postgresql@17/bin"),
                root.path().join("postgresql@16/bin"),
                root.path().join("postgresql@9.6/bin"),
            ]
        );
        assert!(versioned(&root.path().join("missing"), "", "bin").is_empty());
    }

    #[test]
    fn reads_progress_from_verbose_output() {
        assert_eq!(
            table_of(r#"pg_dump: dumping contents of table "public.line_items""#),
            Some("public.line_items")
        );
        assert_eq!(
            table_of(r#"pg_restore: processing data for table "public.orders""#),
            Some("public.orders")
        );
        assert_eq!(table_of("pg_dump: reading extensions"), None);
    }

    #[test]
    fn a_failed_run_says_its_last_lines() {
        let lines: Vec<String> = ["a", "", "b", "c", "d", "e"].map(String::from).to_vec();
        assert_eq!(tail(&lines).as_deref(), Some("b\nc\nd\ne"));
        assert_eq!(tail(&[]), None);
    }

    #[test]
    fn a_suggested_name_stays_a_file_name() {
        assert_eq!(file_name_only("../../etc/orders.dump"), "orders.dump");
        assert_eq!(file_name_only(".hidden.dump"), "hidden.dump");
        assert_eq!(file_name_only(""), "backup.dump");
    }

    /// The real tools, when this machine has them and a local server: a
    /// dump of the test database, restored into a scratch one. Ignored by
    /// default, like the driver's live suite.
    #[test]
    #[ignore]
    fn live_dump_and_restore_round_trip() {
        let dirs = search_dirs(None, std::env::var_os("PATH").as_deref());
        let (Some(dump), Some(restore)) =
            (find_tool("pg_dump", &dirs), find_tool("pg_restore", &dirs))
        else {
            return;
        };
        let mut p = profile();
        p.host = std::env::var("TUPLENEST_TEST_PG_HOST").unwrap_or_else(|_| "localhost".into());
        p.port = 5432;
        p.username = std::env::var("TUPLENEST_TEST_PG_USER")
            .or_else(|_| std::env::var("USER"))
            .unwrap();
        p.database = "postgres".into();
        p.tls_mode = "disabled".into();
        let t = Target::of(&p).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("postgres.dump");
        let status = std::process::Command::new(&dump)
            .args(t.dump_args(&out))
            .envs(t.env())
            .status()
            .unwrap();
        assert!(status.success());
        assert!(std::fs::metadata(&out).unwrap().len() > 0);
        let list = std::process::Command::new(&restore)
            .arg("--list")
            .arg(&out)
            .output()
            .unwrap();
        assert!(list.status.success());
    }
}
