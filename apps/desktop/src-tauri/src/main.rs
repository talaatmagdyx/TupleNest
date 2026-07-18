//! TupleNest desktop shell (master spec §52).
//!
//! Only narrow commands are exposed to the WebView. Secrets and database
//! state stay in the Rust core.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;

use tauri::Manager;
use tuplenest_workspace_store::Store;

mod connections;
mod pg;

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

#[tauri::command]
fn settings_get(
    state: tauri::State<'_, AppState>,
    key: String,
) -> Result<Option<serde_json::Value>, String> {
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
            limit.unwrap_or(50),
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
        .audit_list(limit.unwrap_or(200))
        .map_err(|e| e.to_string())
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

    Ok(menu)
}

fn main() {
    tauri::Builder::default()
        .menu(build_menu)
        .on_menu_event(|app, event| {
            if event.id() == "about" {
                // The frontend owns the About box, so the menu only announces
                // the intent. Failing to emit is not worth killing the app
                // over — the palette still reaches it.
                use tauri::Emitter;
                let _ = app.emit("menu:about", ());
            }
        })
        // Auto-update. Payloads are verified against the minisign public key in
        // tauri.conf.json — an update that isn't signed with our private key is
        // rejected, so a compromised release host still cannot ship code.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Save dialog + write access, scoped by the capability file to paths
        // the user picks in the dialog — no ambient filesystem access.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // Hands the About box's links to the real browser. A plain <a href>
        // would navigate *this* webview and the app would vanish behind a web
        // page with no way back. The capability file allows two exact URLs and
        // nothing else — notably not `opener:default`, which would permit any
        // https:// URL the frontend cared to pass.
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;

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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_get_info,
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
            pg::pg_metadata,
            pg::pg_metadata_cached,
            pg::pg_activity,
            pg::pg_relationships,
            pg::pg_admin_backend,
            pg::pg_begin,
            pg::pg_commit,
            pg::pg_rollback,
            pg::pg_cancel
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
