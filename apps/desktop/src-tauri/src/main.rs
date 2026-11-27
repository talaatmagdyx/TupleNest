//! TupleNest desktop shell (master spec §52).
//!
//! Only narrow commands are exposed to the WebView. Secrets and database
//! state stay in the Rust core.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;

use tauri::Manager;
use tuplenest_workspace_store::Store;

mod assistant;
mod connections;
mod export;
mod pg;
mod sort;
mod trim;

struct AppState {
    store: Mutex<Store>,
    /// Keeps the background log writer alive for the app's lifetime.
    _log_guard: Option<tuplenest_telemetry::LogGuard>,
}

#[derive(serde::Serialize)]
struct AppInfo {
    name: String,
    version: String,
    os: String,
}

#[tauri::command]
fn app_get_info(app: tauri::AppHandle) -> AppInfo {
    let pkg = app.package_info();
    AppInfo {
        name: pkg.name.clone(),
        version: pkg.version.to_string(),
        os: std::env::consts::OS.to_string(),
    }
}

/// Settings rows the generic commands must not touch.
///
/// The assistant's row holds the keychain reference of the Anthropic key.
/// Were the WebView able to write it, it could point the reference at any
/// other keychain entry — a database password — and the next question would
/// send that to api.anthropic.com in the `x-api-key` header. Only the
/// `assistant_*` commands read or write it.
fn reserved_setting(key: &str) -> Result<(), String> {
    if key == assistant::config::SETTINGS_KEY {
        return Err(format!(
            "the `{key}` setting is managed by its own commands"
        ));
    }
    Ok(())
}

#[tauri::command]
fn settings_get(
    state: tauri::State<'_, AppState>,
    key: String,
) -> Result<Option<serde_json::Value>, String> {
    reserved_setting(&key)?;
    state
        .store
        .lock()
        .map_err(|_| "store lock poisoned".to_string())?
        .setting_get(&key)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn settings_set(
    state: tauri::State<'_, AppState>,
    key: String,
    value: serde_json::Value,
) -> Result<(), String> {
    reserved_setting(&key)?;
    state
        .store
        .lock()
        .map_err(|_| "store lock poisoned".to_string())?
        .setting_set(&key, &value)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn layout_save(
    state: tauri::State<'_, AppState>,
    workspace_id: String,
    layout_json: String,
) -> Result<(), String> {
    let store = state
        .store
        .lock()
        .map_err(|_| "store lock poisoned".to_string())?;
    store
        .workspace_upsert(&workspace_id, &workspace_id)
        .map_err(|e| e.to_string())?;
    store
        .layout_save(&workspace_id, &layout_json)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn layout_load(
    state: tauri::State<'_, AppState>,
    workspace_id: String,
) -> Result<Option<String>, String> {
    state
        .store
        .lock()
        .map_err(|_| "store lock poisoned".to_string())?
        .layout_load(&workspace_id)
        .map_err(|e| e.to_string())
}

/// The most rows one `history_list` / `audit_list` call returns.
///
/// The limit comes from the WebView. Without a ceiling a single call could
/// ask for the whole table — every statement ever run, each with its SQL
/// text — and hold it in Rust, in the IPC payload and in the page at once.
const LIST_LIMIT_MAX: usize = 1_000;

fn list_limit(requested: Option<usize>, default: usize) -> usize {
    requested.unwrap_or(default).min(LIST_LIMIT_MAX)
}

#[tauri::command]
fn history_list(
    state: tauri::State<'_, AppState>,
    search: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<tuplenest_workspace_store::HistoryEntry>, String> {
    state
        .store
        .lock()
        .map_err(|_| "store lock poisoned".to_string())?
        .history_list(
            search.as_deref().filter(|s| !s.is_empty()),
            list_limit(limit, 50),
        )
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn history_favorite(
    state: tauri::State<'_, AppState>,
    id: String,
    favorite: bool,
) -> Result<(), String> {
    state
        .store
        .lock()
        .map_err(|_| "store lock poisoned".to_string())?
        .history_set_favorite(&id, favorite)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn history_clear(
    state: tauri::State<'_, AppState>,
    include_favorites: Option<bool>,
) -> Result<(), String> {
    state
        .store
        .lock()
        .map_err(|_| "store lock poisoned".to_string())?
        .history_clear(include_favorites.unwrap_or(false))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn snippet_list(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<tuplenest_workspace_store::SnippetRecord>, String> {
    state
        .store
        .lock()
        .map_err(|_| "store lock poisoned".to_string())?
        .snippet_list()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn snippet_save(
    state: tauri::State<'_, AppState>,
    id: Option<String>,
    name: String,
    body: String,
    tags: Option<String>,
) -> Result<tuplenest_workspace_store::SnippetRecord, String> {
    let rec = tuplenest_workspace_store::SnippetRecord {
        id: id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        name,
        body,
        tags,
    };
    let store = state
        .store
        .lock()
        .map_err(|_| "store lock poisoned".to_string())?;
    store.snippet_upsert(&rec).map_err(|e| e.to_string())?;
    Ok(rec)
}

#[tauri::command]
fn snippet_delete(state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    state
        .store
        .lock()
        .map_err(|_| "store lock poisoned".to_string())?
        .snippet_delete(&id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn audit_list(
    state: tauri::State<'_, AppState>,
    limit: Option<usize>,
) -> Result<Vec<tuplenest_workspace_store::AuditEntry>, String> {
    state
        .store
        .lock()
        .map_err(|_| "store lock poisoned".to_string())?
        .audit_list(list_limit(limit, 200))
        .map_err(|e| e.to_string())
}

/// Save an export to a user-chosen file — dialog and write both Rust-side.
///
/// Security review TAURI-01: previously the frontend opened the save dialog and
/// then called the fs plugin's `writeTextFile(path, contents)` itself, so the
/// capability had to grant `fs:allow-write-text-file` with no scope. A
/// compromised WebView could have called it with any absolute path
/// (`~/.zshrc`, a LaunchAgent) — arbitrary-write / persistence, entirely
/// outside the "user picked it" invariant the comment claimed.
///
/// Here the WebView supplies only the *contents* and a suggested name; it never
/// supplies a path. The native save panel runs in the backend, and the write
/// goes only to what the user chose there. The fs plugin write permission is
/// therefore removed from the capability entirely — the invariant is now
/// enforced by construction, not by convention.
#[tauri::command]
fn export_save(
    app: tauri::AppHandle,
    default_name: String,
    contents: String,
    filter_name: Option<String>,
    extensions: Option<Vec<String>>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let mut builder = app.dialog().file().set_file_name(&default_name);
    if let (Some(name), Some(exts)) = (filter_name, extensions.as_ref()) {
        let refs: Vec<&str> = exts.iter().map(String::as_str).collect();
        builder = builder.add_filter(name, &refs);
    }
    // blocking_* must run off the main thread; sync command handlers do.
    match builder.blocking_save_file() {
        Some(fp) => {
            let path = fp.into_path().map_err(|e| e.to_string())?;
            std::fs::write(&path, contents).map_err(|e| e.to_string())?;
            Ok(Some(path.to_string_lossy().into_owned()))
        }
        None => Ok(None), // user cancelled — not an error
    }
}

/// A file the user chose, open and waiting for the rest of the document.
///
/// The path is held here rather than handed to the WebView: `export_save`'s
/// invariant is that the front end never names a file, and streaming must not
/// quietly reintroduce a path parameter to get around it. The front end gets a
/// path back only to put a filename in a toast.
struct ExportSink {
    writer: std::io::BufWriter<std::fs::File>,
    path: std::path::PathBuf,
}

impl ExportSink {
    fn create(path: std::path::PathBuf) -> std::io::Result<Self> {
        let file = std::fs::File::create(&path)?;
        Ok(Self {
            writer: std::io::BufWriter::new(file),
            path,
        })
    }

    fn write(&mut self, chunk: &str) -> std::io::Result<()> {
        use std::io::Write;
        self.writer.write_all(chunk.as_bytes())
    }

    fn finish(mut self) -> std::io::Result<()> {
        use std::io::Write;
        self.writer.flush()
    }

    /// Close and remove the partial file.
    fn abort(self) {
        drop(self.writer);
        let _ = std::fs::remove_file(&self.path);
    }
}

#[derive(Default)]
struct ExportState(Mutex<Option<ExportSink>>);

/// Open the save panel and start a streamed export.
///
/// The dialog comes first, before a single row is formatted. The old export
/// gathered every row, built the whole document as one string, and only then
/// asked where to put it — so cancelling threw away all the work, and until the
/// panel appeared there was nothing on screen to say the app was doing
/// anything at all.
///
/// Returns the chosen path, or None if the user cancelled.
#[tauri::command]
fn export_begin(
    app: tauri::AppHandle,
    state: tauri::State<'_, ExportState>,
    default_name: String,
    filter_name: Option<String>,
    extensions: Option<Vec<String>>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    // Checked before and again after the dialog, without holding the lock
    // while it is open: a modal dialog can sit there for minutes, and every
    // other export command would wait on the lock behind it.
    if state
        .0
        .lock()
        .map_err(|_| "export lock poisoned")?
        .is_some()
    {
        return Err("an export is already in progress".into());
    }

    let mut builder = app.dialog().file().set_file_name(&default_name);
    if let (Some(name), Some(exts)) = (filter_name, extensions.as_ref()) {
        let refs: Vec<&str> = exts.iter().map(String::as_str).collect();
        builder = builder.add_filter(name, &refs);
    }
    // blocking_* must run off the main thread; sync command handlers do.
    let Some(fp) = builder.blocking_save_file() else {
        return Ok(None); // cancelled — not an error
    };
    let path = fp.into_path().map_err(|e| e.to_string())?;
    let mut slot = state.0.lock().map_err(|_| "export lock poisoned")?;
    if slot.is_some() {
        return Err("an export is already in progress".into());
    }
    let sink = ExportSink::create(path.clone()).map_err(|e| e.to_string())?;
    *slot = Some(sink);
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Flush and close. The file is only complete once this returns.
#[tauri::command]
fn export_finish(state: tauri::State<'_, ExportState>) -> Result<(), String> {
    let mut slot = state.0.lock().map_err(|_| "export lock poisoned")?;
    let sink = slot.take().ok_or("no export in progress")?;
    sink.finish().map_err(|e| e.to_string())
}

/// Rows one `export_result_page` call formats and writes.
const EXPORT_PAGE_MAX: usize = 1_000;

/// Rows a clipboard copy holds at most; the page asks for no more than this
/// (`COPY_ROW_CAP` in App.tsx), and the ceiling is enforced here as well.
const COPY_ROW_MAX: usize = 10_000;

/// Run blocking work — formatting, a file write, a std lock — off the async
/// workers. There are only two to four of those (`worker_threads`), and one
/// stuck in a disk write is one fewer to carry a cancel.
async fn off_runtime<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())?
}

/// Format one page of the stored result and append it to the open export.
///
/// Rows go from the backend's store straight into the file; the WebView only
/// drives the loop (progress, Cancel) and never holds them. Returns how many
/// rows were written — fewer than `limit` means the result ended.
#[tauri::command]
async fn export_result_page(
    app: tauri::AppHandle,
    kind: export::Kind,
    mode: export::Mode,
    offset: usize,
    limit: usize,
    total: usize,
) -> Result<usize, String> {
    off_runtime(move || {
        let pg = app.state::<pg::PgState>();
        let export = app.state::<ExportState>();
        let (chunk, n) =
            pg::export_page(&pg, kind, mode, offset, limit.min(EXPORT_PAGE_MAX), total)?;
        let mut slot = export.0.lock().map_err(|_| "export lock poisoned")?;
        let sink = slot.as_mut().ok_or("no export in progress")?;
        sink.write(&chunk).map_err(|e| e.to_string())?;
        Ok(n)
    })
    .await
}

/// Put the first `limit` rows on the system clipboard as one document, and
/// return how many rows that was.
///
/// The clipboard takes a single string, so this is the one place the whole
/// text exists at once — and it exists once. It used to be returned to the
/// page for `navigator.clipboard.writeText`, which made three copies of it:
/// here, in the IPC payload, and in the WebView. Now the text goes from this
/// process straight to the pasteboard and only the count crosses the bridge.
#[tauri::command]
async fn copy_result_text(
    app: tauri::AppHandle,
    kind: export::Kind,
    mode: export::Mode,
    limit: usize,
) -> Result<usize, String> {
    off_runtime(move || {
        let pg = app.state::<pg::PgState>();
        let (text, rows) = pg::export_document(&pg, kind, mode, limit.min(COPY_ROW_MAX))?;
        // One clipboard for the life of the app: on X11 and Wayland the text
        // is served by whoever set it, and is gone once that handle drops.
        static CLIPBOARD: std::sync::Mutex<Option<arboard::Clipboard>> =
            std::sync::Mutex::new(None);
        let mut slot = CLIPBOARD.lock().unwrap_or_else(|e| e.into_inner());
        if slot.is_none() {
            *slot = Some(arboard::Clipboard::new().map_err(|e| e.to_string())?);
        }
        let clipboard = slot.as_mut().expect("set just above");
        clipboard.set_text(text).map_err(|e| e.to_string())?;
        Ok(rows)
    })
    .await
}

/// Abandon an export and remove what was written.
///
/// A half-written CSV is worse than no CSV: it opens, it parses, and it is
/// missing rows with nothing on its face to say so. Failure deletes the file
/// rather than leaving that lying around.
#[tauri::command]
fn export_abort(state: tauri::State<'_, ExportState>) -> Result<(), String> {
    let mut slot = state.0.lock().map_err(|_| "export lock poisoned")?;
    if let Some(sink) = slot.take() {
        sink.abort();
    }
    Ok(())
}

/// The app menu, with macOS's native About panel swapped for ours.
///
/// The menu bar's "About TupleNest" opened a bare system panel showing the
/// version and nothing else, while the palette and Settings opened the real
/// one — two different About boxes, and the menu bar is where people look
/// first.
///
/// This starts from `Menu::default` and changes one item rather than building
/// a menu from scratch: the default carries the standard Edit submenu, and on
/// macOS that submenu is what makes Cut/Copy/Paste work in a webview at all.
/// Hand-rolling the menu and forgetting it would silently break ⌘C everywhere
/// in the app.
///
/// The swap is macOS-only. Windows and Linux have no application submenu to
/// put an About in; there the palette and Settings are the way to it, which is
/// the platform convention anyway.
fn build_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    let menu = tauri::menu::Menu::default(app)?;

    #[cfg(target_os = "macos")]
    {
        use tauri::menu::{MenuItem, MenuItemKind};

        // The first submenu is the application menu, and its first item is the
        // predefined About. Both are positional facts about `Menu::default`,
        // so every step is checked: a Tauri release that reorders this should
        // leave the stock menu alone, not panic or drop Edit.
        if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() {
            let first = app_menu.items()?.into_iter().next();
            if let Some(MenuItemKind::Predefined(predefined)) = first {
                let about = MenuItem::with_id(app, "about", "About TupleNest", true, None::<&str>)?;
                app_menu.remove(&predefined)?;
                app_menu.prepend(&about)?;
            }
        }
    }

    // Analysing a pasted plan is the one thing here that works with no
    // connection at all, so it is also the one thing a new user has no reason
    // to go looking for in the sidebar. The menu bar is where people look for
    // "what can this app do".
    //
    // The submenu is found by its text rather than its position: unlike the
    // application menu above, File's index is not something to rely on. No
    // accelerator — the obvious one, ⌘⇧V, is macOS's Paste and Match Style,
    // and taking it would break pasting inside the app's own text fields.
    //
    // `Menu::default` builds no File submenu at all on Linux and the BSDs, so
    // there the loop finds nothing and does nothing. That is the right outcome
    // rather than a bug to work around: the activity rail and the command
    // palette both reach the analyser on every platform, and inventing a File
    // menu where the platform's own default has none would be out of place.
    {
        use tauri::menu::{MenuItem, MenuItemKind};

        for item in menu.items()? {
            if let MenuItemKind::Submenu(submenu) = item {
                if submenu.text()? == "File" {
                    let paste = MenuItem::with_id(
                        app,
                        "paste-plan",
                        "Analyze a Pasted Plan…",
                        true,
                        None::<&str>,
                    )?;
                    submenu.prepend(&paste)?;
                    break;
                }
            }
        }
    }

    Ok(menu)
}

/// How many threads run async work.
///
/// Tauri's default runtime starts one worker per core. This app's async work
/// is a handful of sockets and the commands the one window sends, so on a
/// 12-core laptop that was a dozen threads — each with a stack and an
/// allocator cache — with almost nothing to do. Two is the floor rather than
/// one because some commands format or sort on the worker they run on, and a
/// second lets a cancel through meanwhile.
fn worker_threads(cores: usize) -> usize {
    cores.clamp(2, 4)
}

fn main() {
    // Must be handed over before anything touches `tauri::async_runtime`, and
    // must outlive `run` — hence a binding that lives to the end of `main`.
    let cores = std::thread::available_parallelism().map_or(2, |n| n.get());
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(worker_threads(cores))
        // spawn_blocking threads are created on demand; 512 is tokio's cap
        // for servers. Idle ones exit after the keep-alive.
        .max_blocking_threads(16)
        .thread_keep_alive(std::time::Duration::from_secs(5))
        .enable_all()
        .build()
        .expect("the async runtime starts");
    tauri::async_runtime::set(runtime.handle().clone());

    tauri::Builder::default()
        .menu(build_menu)
        .on_menu_event(|app, event| {
            // The frontend owns these windows, so the menu only announces the
            // intent. Failing to emit is not worth killing the app over — the
            // palette still reaches both.
            use tauri::Emitter;
            match event.id().0.as_str() {
                "about" => {
                    let _ = app.emit("menu:about", ());
                }
                "paste-plan" => {
                    let _ = app.emit("menu:paste-plan", ());
                }
                _ => {}
            }
        })
        // Auto-update. Payloads are verified against the minisign public key in
        // tauri.conf.json — an update that isn't signed with our private key is
        // rejected, so a compromised release host still cannot ship code.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Native dialogs: the ask/confirm prompts, and the save panel that the
        // Rust `export_save` command drives. The fs plugin is deliberately not
        // registered — the WebView has no filesystem access; exports write
        // Rust-side through export_save (security review TAURI-01).
        .plugin(tauri_plugin_dialog::init())
        // Hands the About box's links to the real browser. A plain <a href>
        // would navigate *this* webview and the app would vanish behind a web
        // page with no way back. The capability file allows two exact URLs and
        // nothing else — notably not `opener:default`, which would permit any
        // https:// URL the frontend cared to pass.
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            // Lock the whole app-data tree to the owner (0700 on Unix) so no
            // other local user can read the connection DB, history, cache or
            // logs beneath it. Each store also tightens its own files; this is
            // the umbrella. (Security review FILE-02.)
            tuplenest_telemetry::secure_dir(&dir);

            // E0.7: structured file logging (rotated daily) + crash capture.
            // JSON logs in release; human-readable in dev.
            let log_guard =
                tuplenest_telemetry::init_app(&dir.join("logs"), !cfg!(debug_assertions)).ok();
            tuplenest_telemetry::install_panic_hook(dir.join("crashes"));
            tracing::info!(
                component = "app",
                version = env!("CARGO_PKG_VERSION"),
                "TupleNest starting"
            );

            let store = Store::open(&dir.join("tuplenest.db"))
                .map_err(|e| -> Box<dyn std::error::Error> { format!("{e}").into() })?;
            app.manage(AppState {
                store: Mutex::new(store),
                _log_guard: log_guard,
            });
            let cache =
                tuplenest_metadata_cache::MetadataCache::open(&dir.join("metadata-cache.db"))
                    .map_err(|e| -> Box<dyn std::error::Error> { format!("{e}").into() })?;
            app.manage(pg::PgState::new(cache));
            // Keychain entries from passwords tested but never saved. On its
            // own thread: a keychain call can wait on a system prompt, and
            // nothing about opening the window should wait with it.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                use tauri::Manager;
                let swept = pg::sweep_pending_secrets(
                    &handle.state::<AppState>().store,
                    &tuplenest_credential_store::KeychainStore::new(),
                );
                if swept > 0 {
                    tracing::info!(
                        component = "credentials",
                        swept,
                        "removed keychain entries no profile owns"
                    );
                }
            });
            app.manage(ExportState::default());
            app.manage(assistant::AssistantState::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_get_info,
            export_save,
            export_begin,
            export_result_page,
            copy_result_text,
            export_finish,
            export_abort,
            settings_get,
            settings_set,
            layout_save,
            layout_load,
            history_list,
            history_favorite,
            history_clear,
            snippet_list,
            snippet_save,
            snippet_delete,
            audit_list,
            connections::connection_save,
            connections::connection_list,
            connections::connection_delete,
            pg::pg_secret_save,
            pg::pg_test,
            pg::pg_connect,
            pg::pg_disconnect,
            pg::pg_query,
            pg::pg_rows,
            pg::pg_chart,
            pg::pg_metadata,
            pg::pg_metadata_cached,
            pg::pg_activity,
            pg::pg_relationships,
            pg::pg_admin_backend,
            pg::pg_begin,
            pg::pg_in_transaction,
            pg::pg_commit,
            pg::pg_rollback,
            pg::pg_cancel,
            assistant::assistant_settings_get,
            assistant::assistant_settings_set,
            assistant::assistant_key_save,
            assistant::assistant_key_remove,
            assistant::assistant_anthropic_test,
            assistant::assistant_ollama_test,
            assistant::assistant_models,
            assistant::assistant_ask,
            assistant::assistant_cancel
        ])
        // Nothing here handles window close, deliberately.
        //
        // The red X did nothing at all: no close, no quit. The obvious reading
        // was the Cocoa convention — macOS keeps an app alive after its last
        // window — so the first fix was an `on_window_event` that caught
        // `Destroyed` and called `exit(0)`. It changed nothing, because the
        // premise was wrong twice over. Tauri already exits once the last
        // window is destroyed, so the handler was answering a question nobody
        // asked; and `Destroyed` was never firing anyway.
        //
        // The real cause was one line away, in `capabilities/default.json`.
        // `core:default` grants only the read-only window commands, not
        // `allow-destroy`. The close guard in App.tsx ends in
        // `getCurrentWindow().destroy()`; the ACL rejected it, the rejection
        // surfaced nowhere, and the X became inert. Granting the permission is
        // the whole fix — verified by running this binary with the exit
        // handler disabled and watching the app quit anyway.
        //
        // Left as a comment rather than deleted quietly because the wrong fix
        // was plausible, self-consistent, and shipped a real `exit(0)` that
        // would have looked load-bearing to the next reader.
        .run(tauri::generate_context!())
        .expect("error while running TupleNest");
}

#[cfg(test)]
mod limit_tests {
    use super::{list_limit, off_runtime, LIST_LIMIT_MAX};

    #[test]
    fn a_missing_limit_takes_the_default() {
        assert_eq!(list_limit(None, 50), 50);
        assert_eq!(list_limit(Some(10), 50), 10);
    }

    #[test]
    fn a_huge_limit_is_clamped() {
        assert_eq!(list_limit(Some(usize::MAX), 50), LIST_LIMIT_MAX);
        assert_eq!(list_limit(Some(LIST_LIMIT_MAX + 1), 200), LIST_LIMIT_MAX);
    }

    #[test]
    fn blocking_work_reports_its_result_and_its_error() {
        tauri::async_runtime::block_on(async {
            assert_eq!(off_runtime(|| Ok(7)).await, Ok(7));
            let failed: Result<(), String> = off_runtime(|| Err("no result".into())).await;
            assert_eq!(failed, Err("no result".into()));
        });
    }
}

#[cfg(test)]
mod reserved_setting_tests {
    #[test]
    fn the_assistant_row_is_closed_to_the_generic_commands() {
        assert!(super::reserved_setting("assistant").is_err());
        assert!(super::reserved_setting("theme").is_ok());
    }
}

#[cfg(test)]
mod runtime_tests {
    #[test]
    fn worker_threads_stay_between_two_and_four() {
        assert_eq!(super::worker_threads(1), 2);
        assert_eq!(super::worker_threads(3), 3);
        assert_eq!(super::worker_threads(16), 4);
    }
}

/// The capability file must grant every window command the frontend calls.
///
/// Written after the red X shipped broken in v0.1.0-beta.1. `App.tsx` calls
/// `getCurrentWindow().destroy()`; `capabilities/default.json` listed only
/// `core:default`, which covers the read-only window commands and not
/// `allow-destroy`. Tauri's ACL rejected the call, and because
/// `@tauri-apps/api` never awaits its own `destroy()` inside the
/// close-requested listener, the rejection produced no error, no log, and no
/// console output. The button simply stopped working, and 1644 passing tests
/// had nothing to say about it — the break lived between a TypeScript file and
/// a JSON file, which no unit test in either language was looking at.
///
/// This checks the two against each other. It cannot prove `destroy()` works
/// at runtime; only launching the app does that. It catches the one piece that
/// is mechanically checkable: a call the source really makes, with the
/// matching permission silently absent.
#[cfg(test)]
mod capability_tests {
    use std::collections::BTreeSet;
    use std::path::PathBuf;

    fn desktop_dir() -> PathBuf {
        // CARGO_MANIFEST_DIR is apps/desktop/src-tauri.
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("src-tauri has a parent")
            .to_path_buf()
    }

    /// Permission names inside `core:window:default`, which `core:default`
    /// pulls in. Anything outside this list needs granting by hand.
    const CORE_WINDOW_DEFAULT: &[&str] = &[
        "activity-name",
        "available-monitors",
        "current-monitor",
        "cursor-position",
        "get-all-windows",
        "inner-position",
        "inner-size",
        "internal-toggle-maximize",
        "is-always-on-top",
        "is-closable",
        "is-decorated",
        "is-enabled",
        "is-focused",
        "is-fullscreen",
        "is-maximizable",
        "is-maximized",
        "is-minimizable",
        "is-minimized",
        "is-resizable",
        "is-visible",
        "monitor-from-point",
        "outer-position",
        "outer-size",
        "primary-monitor",
        "scale-factor",
        "scene-identifier",
        "theme",
        "title",
    ];

    /// Every `getCurrentWindow().foo()` in the frontend, as permission names.
    ///
    /// Event subscriptions (`onCloseRequested`, `listen`, `once`) are
    /// `core:event`, not window commands, so they are skipped.
    fn window_calls_in_frontend() -> BTreeSet<String> {
        let mut found = BTreeSet::new();
        let src = desktop_dir().join("src");
        let mut stack = vec![src];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).expect("frontend src is readable") {
                let path = entry.expect("readable dir entry").path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                let is_ts = matches!(
                    path.extension().and_then(|e| e.to_str()),
                    Some("ts") | Some("tsx")
                );
                if !is_ts {
                    continue;
                }
                let text = std::fs::read_to_string(&path).expect("source file is utf-8");
                for (_, rest) in text
                    .match_indices("getCurrentWindow().")
                    .map(|(i, m)| (i, &text[i + m.len()..]))
                {
                    let method: String = rest
                        .chars()
                        .take_while(|c| c.is_ascii_alphanumeric())
                        .collect();
                    if method.is_empty()
                        || method.starts_with("on")
                        || method == "listen"
                        || method == "once"
                    {
                        continue;
                    }
                    // camelCase -> kebab-case, matching Tauri's permission names.
                    let mut perm = String::new();
                    for c in method.chars() {
                        if c.is_ascii_uppercase() {
                            perm.push('-');
                            perm.push(c.to_ascii_lowercase());
                        } else {
                            perm.push(c);
                        }
                    }
                    found.insert(perm);
                }
            }
        }
        found
    }

    fn granted_permissions() -> BTreeSet<String> {
        let raw =
            std::fs::read_to_string(desktop_dir().join("src-tauri/capabilities/default.json"))
                .expect("capability file exists");
        let json: serde_json::Value = serde_json::from_str(&raw).expect("capability file is JSON");
        json["permissions"]
            .as_array()
            .expect("permissions is an array")
            .iter()
            .filter_map(|p| {
                p.as_str()
                    .or_else(|| p["identifier"].as_str())
                    .map(str::to_owned)
            })
            .collect()
    }

    /// Guards the test below: if the frontend stops matching this pattern —
    /// renamed import, extracted helper — the scan returns nothing and every
    /// assertion passes vacuously, which is the failure this file exists to
    /// prevent.
    #[test]
    fn scan_finds_the_calls_it_is_checking() {
        assert!(
            window_calls_in_frontend().contains("destroy"),
            "expected to find getCurrentWindow().destroy() in the frontend; if that call \
             moved or was renamed, update this scan — do not delete it, or the check below \
             silently starts asserting nothing"
        );
    }

    #[test]
    fn every_window_call_the_frontend_makes_is_granted() {
        let granted = granted_permissions();
        for perm in window_calls_in_frontend() {
            if CORE_WINDOW_DEFAULT.contains(&perm.as_str()) {
                continue; // covered by core:default
            }
            let needed = format!("core:window:allow-{perm}");
            assert!(
                granted.contains(&needed),
                "the frontend calls getCurrentWindow().{perm}(), but \
                 capabilities/default.json does not grant {needed}, and core:default does \
                 not cover it. Tauri's ACL will reject the call at runtime; the rejection \
                 is swallowed inside @tauri-apps/api, so the feature fails silently with \
                 no error anywhere."
            );
        }
    }
}

#[cfg(test)]
mod export_sink_tests {
    use super::ExportSink;

    fn tmp(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("tuplenest-export-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir.join(name)
    }

    #[test]
    fn chunks_land_end_to_end_in_order() {
        // The whole point of streaming is that the file is assembled from
        // pieces; if they were buffered wrongly or written out of order the
        // frontend would have no way to tell.
        let path = tmp("ordered.csv");
        let mut sink = ExportSink::create(path.clone()).expect("create");
        sink.write("id,name").expect("write");
        sink.write("\n1,ada").expect("write");
        sink.write("\n2,grace").expect("write");
        sink.finish().expect("finish");
        assert_eq!(
            std::fs::read_to_string(&path).expect("read"),
            "id,name\n1,ada\n2,grace"
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn nothing_is_on_disk_until_finish_flushes() {
        // BufWriter holds small writes in memory. That is the point — but it
        // also means "the file exists" is not the same as "the file is
        // complete", which is why finish() is a separate step the frontend
        // must reach before it claims a successful save.
        let path = tmp("unflushed.csv");
        let mut sink = ExportSink::create(path.clone()).expect("create");
        sink.write("id,name").expect("write");
        assert_eq!(std::fs::read_to_string(&path).expect("read"), "");
        sink.finish().expect("finish");
        assert_eq!(std::fs::read_to_string(&path).expect("read"), "id,name");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn abort_takes_the_partial_file_with_it() {
        // A truncated CSV opens, parses, and is missing rows with nothing on
        // its face to say so. Leaving one behind after a failed export is
        // worse than leaving nothing.
        let path = tmp("aborted.csv");
        let mut sink = ExportSink::create(path.clone()).expect("create");
        sink.write("id,name\n1,ada").expect("write");
        sink.abort();
        assert!(!path.exists(), "abort must remove the partial file");
    }
}
