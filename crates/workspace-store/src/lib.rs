//! Local SQLite application store (master spec §53.1, Phase 0 schema v1).
//!
//! Stores settings, workspaces, layouts, and tabs. Never stores secrets.

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("store schema version {found} is newer than supported version {supported}")]
    FutureSchema { found: i64, supported: i64 },
    #[error("invalid JSON in store: {0}")]
    Json(#[from] serde_json::Error),
}

const SCHEMA_VERSION: i64 = 5;

const MIGRATION_V1: &str = r#"
CREATE TABLE meta        (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE settings    (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE workspaces  (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER, updated_at INTEGER);
CREATE TABLE layouts     (workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
                          layout_json TEXT NOT NULL, updated_at INTEGER);
CREATE TABLE tabs        (id TEXT PRIMARY KEY,
                          workspace_id TEXT REFERENCES workspaces(id),
                          kind TEXT NOT NULL, title TEXT, position INTEGER,
                          pinned INTEGER DEFAULT 0, state_json TEXT);
"#;

/// Phase 1 (E1.2): connection profiles. `secret_ref` is a keychain
/// reference — the secret itself never touches SQLite.
const MIGRATION_V2: &str = r#"
CREATE TABLE connections (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, driver TEXT NOT NULL DEFAULT 'postgres',
  environment TEXT CHECK (environment IN ('dev','test','staging','prod')),
  color TEXT, read_only INTEGER DEFAULT 0,
  host TEXT, port INTEGER, database TEXT, username TEXT,
  secret_ref TEXT,
  tls_mode TEXT NOT NULL DEFAULT 'verify-full', tls_ca_path TEXT,
  ssh_json TEXT,
  options_json TEXT, created_at INTEGER, updated_at INTEGER
);
"#;

/// Phase 1 (E1.5): query history. `sql_text` is NULL for prod-tagged
/// connections when text exclusion applies.
const MIGRATION_V3: &str = r#"
CREATE TABLE query_history (
  id TEXT PRIMARY KEY,
  connection_key TEXT NOT NULL,
  sql_text TEXT,
  status TEXT NOT NULL CHECK (status IN ('success','error','cancelled')),
  error_text TEXT,
  rows_returned INTEGER NOT NULL DEFAULT 0,
  rows_affected INTEGER,
  started_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  favorite INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_history_search ON query_history(connection_key, started_at DESC);
"#;

/// Phase 2/6: reusable SQL snippets and a prod audit trail.
const MIGRATION_V4: &str = r#"
CREATE TABLE snippets (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, body TEXT NOT NULL,
  tags TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY, connection_key TEXT NOT NULL, environment TEXT,
  sql_text TEXT NOT NULL, at INTEGER NOT NULL
);
CREATE INDEX idx_audit_conn ON audit_log(connection_key, at DESC);
"#;

/// Repair for databases that recorded v4 without ever getting v4's tables.
///
/// A build recorded `schema_version = 4` on databases that do not have
/// `snippets` or `audit_log`. Because the runner trusts the recorded number,
/// v4 could never run again on those files: saving a snippet failed with "no
/// such table" forever, and — worse — the production audit log silently
/// recorded nothing.
///
/// Everything here is `IF NOT EXISTS`, so it is a no-op on a database that
/// really did get v4, and it repairs one that did not. Migrations from here on
/// are written this way: a version number is a claim about the schema, and
/// this is what it costs when the claim is wrong.
const MIGRATION_V5: &str = r#"
CREATE TABLE IF NOT EXISTS snippets (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, body TEXT NOT NULL,
  tags TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY, connection_key TEXT NOT NULL, environment TEXT,
  sql_text TEXT NOT NULL, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_conn ON audit_log(connection_key, at DESC);
"#;

pub struct Store {
    conn: Connection,
}

/// Restrict a SQLite database and its WAL/SHM siblings to owner-only (0600) on
/// Unix. This file holds connection profiles, full query history and the prod
/// audit log; the shipped umask left it 0644 (world-readable). The containing
/// directory is also locked to 0700 by the app on startup, but 0600 here is
/// defense-in-depth for the case where the file is later copied out. No-op on
/// Windows, which relies on the user-profile ACL. (Security review FILE-02.)
pub fn secure_sqlite_files(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for suffix in ["", "-wal", "-shm"] {
            let p = if suffix.is_empty() {
                path.to_path_buf()
            } else {
                let mut s = path.as_os_str().to_owned();
                s.push(suffix);
                std::path::PathBuf::from(s)
            };
            if let Ok(meta) = std::fs::metadata(&p) {
                let mut perms = meta.permissions();
                perms.set_mode(0o600);
                let _ = std::fs::set_permissions(&p, perms);
            }
        }
    }
    #[cfg(not(unix))]
    let _ = path;
}

impl Store {
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        let store = Self::init(Connection::open(path)?)?;
        secure_sqlite_files(path);
        Ok(store)
    }

    pub fn open_in_memory() -> Result<Self, StoreError> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self, StoreError> {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let store = Self { conn };
        store.migrate()?;
        Ok(store)
    }

    fn schema_version(&self) -> Result<i64, StoreError> {
        let exists: Option<String> = self
            .conn
            .query_row(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='meta'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        if exists.is_none() {
            return Ok(0);
        }
        let v: Option<String> = self
            .conn
            .query_row(
                "SELECT value FROM meta WHERE key='schema_version'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        Ok(v.and_then(|s| s.parse().ok()).unwrap_or(0))
    }

    fn migrate(&self) -> Result<(), StoreError> {
        let current = self.schema_version()?;
        if current > SCHEMA_VERSION {
            // Downgrade is refused with a clear error (Phase 0 acceptance test).
            return Err(StoreError::FutureSchema {
                found: current,
                supported: SCHEMA_VERSION,
            });
        }
        if current < 1 {
            self.conn.execute_batch(MIGRATION_V1)?;
        }
        if current < 2 {
            self.conn.execute_batch(MIGRATION_V2)?;
        }
        if current < 3 {
            self.conn.execute_batch(MIGRATION_V3)?;
        }
        if current < 4 {
            self.conn.execute_batch(MIGRATION_V4)?;
        }
        if current < 5 {
            self.conn.execute_batch(MIGRATION_V5)?;
        }
        if current < SCHEMA_VERSION {
            self.conn.execute(
                "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?1)",
                params![SCHEMA_VERSION.to_string()],
            )?;
        }
        Ok(())
    }

    // --- Settings -----------------------------------------------------------

    pub fn setting_set<T: serde::Serialize>(&self, key: &str, value: &T) -> Result<(), StoreError> {
        let json = serde_json::to_string(value)?;
        self.conn.execute(
            "INSERT INTO settings (key, value_json, updated_at)
             VALUES (?1, ?2, unixepoch())
             ON CONFLICT(key) DO UPDATE SET value_json=?2, updated_at=unixepoch()",
            params![key, json],
        )?;
        Ok(())
    }

    pub fn setting_get<T: serde::de::DeserializeOwned>(
        &self,
        key: &str,
    ) -> Result<Option<T>, StoreError> {
        let json: Option<String> = self
            .conn
            .query_row(
                "SELECT value_json FROM settings WHERE key=?1",
                params![key],
                |r| r.get(0),
            )
            .optional()?;
        Ok(match json {
            Some(j) => Some(serde_json::from_str(&j)?),
            None => None,
        })
    }

    // --- Workspaces and layout ------------------------------------------------

    pub fn workspace_upsert(&self, id: &str, name: &str) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO workspaces (id, name, created_at, updated_at)
             VALUES (?1, ?2, unixepoch(), unixepoch())
             ON CONFLICT(id) DO UPDATE SET name=?2, updated_at=unixepoch()",
            params![id, name],
        )?;
        Ok(())
    }

    pub fn layout_save(&self, workspace_id: &str, layout_json: &str) -> Result<(), StoreError> {
        // Validate it is JSON before persisting.
        let _: serde_json::Value = serde_json::from_str(layout_json)?;
        self.conn.execute(
            "INSERT INTO layouts (workspace_id, layout_json, updated_at)
             VALUES (?1, ?2, unixepoch())
             ON CONFLICT(workspace_id) DO UPDATE SET layout_json=?2, updated_at=unixepoch()",
            params![workspace_id, layout_json],
        )?;
        Ok(())
    }

    pub fn layout_load(&self, workspace_id: &str) -> Result<Option<String>, StoreError> {
        Ok(self
            .conn
            .query_row(
                "SELECT layout_json FROM layouts WHERE workspace_id=?1",
                params![workspace_id],
                |r| r.get(0),
            )
            .optional()?)
    }

    // --- Tabs ------------------------------------------------------------------

    pub fn tabs_replace(
        &mut self,
        workspace_id: &str,
        tabs: &[TabRecord],
    ) -> Result<(), StoreError> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "DELETE FROM tabs WHERE workspace_id=?1",
            params![workspace_id],
        )?;
        for t in tabs {
            tx.execute(
                "INSERT INTO tabs (id, workspace_id, kind, title, position, pinned, state_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    t.id,
                    workspace_id,
                    t.kind,
                    t.title,
                    t.position,
                    t.pinned as i64,
                    t.state_json
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn tabs_list(&self, workspace_id: &str) -> Result<Vec<TabRecord>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, kind, title, position, pinned, state_json
             FROM tabs WHERE workspace_id=?1 ORDER BY position",
        )?;
        let rows = stmt
            .query_map(params![workspace_id], |r| {
                Ok(TabRecord {
                    id: r.get(0)?,
                    kind: r.get(1)?,
                    title: r.get(2)?,
                    position: r.get(3)?,
                    pinned: r.get::<_, i64>(4)? != 0,
                    state_json: r.get(5)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    // --- Connections (schema v2, E1.2) --------------------------------------

    /// Insert or update a connection profile. `record.secret_ref` must be a
    /// keychain reference — this store never sees secret values.
    pub fn connection_upsert(&self, record: &ConnectionRecord) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO connections
               (id, name, driver, environment, color, read_only,
                host, port, database, username, secret_ref,
                tls_mode, tls_ca_path, ssh_json, options_json,
                created_at, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,unixepoch(),unixepoch())
             ON CONFLICT(id) DO UPDATE SET
               name=?2, driver=?3, environment=?4, color=?5, read_only=?6,
               host=?7, port=?8, database=?9, username=?10, secret_ref=?11,
               tls_mode=?12, tls_ca_path=?13, ssh_json=?14, options_json=?15,
               updated_at=unixepoch()",
            params![
                record.id,
                record.name,
                record.driver,
                record.environment,
                record.color,
                record.read_only as i64,
                record.host,
                record.port as i64,
                record.database,
                record.username,
                record.secret_ref,
                record.tls_mode,
                record.tls_ca_path,
                record.ssh_json,
                record.options_json,
            ],
        )?;
        Ok(())
    }

    pub fn connection_get(&self, id: &str) -> Result<Option<ConnectionRecord>, StoreError> {
        let row = self
            .conn
            .query_row(
                &format!("{CONNECTION_SELECT} WHERE id = ?1"),
                params![id],
                Self::row_to_connection,
            )
            .optional()?;
        Ok(row)
    }

    pub fn connection_list(&self) -> Result<Vec<ConnectionRecord>, StoreError> {
        let mut stmt = self
            .conn
            .prepare(&format!("{CONNECTION_SELECT} ORDER BY name COLLATE NOCASE"))?;
        let rows = stmt
            .query_map([], Self::row_to_connection)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Deletes the profile; returns its secret_ref (if any) so the caller
    /// can remove the keychain entry too.
    pub fn connection_delete(&self, id: &str) -> Result<Option<String>, StoreError> {
        let secret_ref: Option<Option<String>> = self
            .conn
            .query_row(
                "SELECT secret_ref FROM connections WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()?;
        self.conn
            .execute("DELETE FROM connections WHERE id = ?1", params![id])?;
        Ok(secret_ref.flatten())
    }

    // --- Query history (schema v3, E1.5) ------------------------------------

    /// Records one execution. Retention: keeps the newest `retention`
    /// non-favorite entries; favorites are never pruned.
    pub fn history_add(&self, entry: &HistoryEntry, retention: usize) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO query_history
               (id, connection_key, sql_text, status, error_text,
                rows_returned, rows_affected, started_at, duration_ms, favorite)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![
                entry.id,
                entry.connection_key,
                entry.sql_text,
                entry.status,
                entry.error_text,
                entry.rows_returned as i64,
                entry.rows_affected.map(|v| v as i64),
                entry.started_at,
                entry.duration_ms as i64,
                entry.favorite as i64,
            ],
        )?;
        self.conn.execute(
            "DELETE FROM query_history
             WHERE favorite = 0 AND id NOT IN (
               SELECT id FROM query_history WHERE favorite = 0
               ORDER BY started_at DESC LIMIT ?1
             )",
            params![retention as i64],
        )?;
        Ok(())
    }

    /// Newest-first history, optionally filtered by a case-insensitive
    /// substring of the SQL text.
    pub fn history_list(
        &self,
        search: Option<&str>,
        limit: usize,
    ) -> Result<Vec<HistoryEntry>, StoreError> {
        let like = search.map(|s| format!("%{s}%"));
        let sql = "SELECT id, connection_key, sql_text, status, error_text,
                          rows_returned, rows_affected, started_at, duration_ms, favorite
                   FROM query_history
                   WHERE (?1 IS NULL OR sql_text LIKE ?1)
                   ORDER BY started_at DESC, rowid DESC LIMIT ?2";
        let mut stmt = self.conn.prepare(sql)?;
        let rows = stmt
            .query_map(params![like, limit as i64], Self::row_to_history)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn history_set_favorite(&self, id: &str, favorite: bool) -> Result<(), StoreError> {
        self.conn.execute(
            "UPDATE query_history SET favorite = ?2 WHERE id = ?1",
            params![id, favorite as i64],
        )?;
        Ok(())
    }

    /// Clears history; favorites survive unless `include_favorites`.
    pub fn history_clear(&self, include_favorites: bool) -> Result<(), StoreError> {
        if include_favorites {
            self.conn.execute("DELETE FROM query_history", [])?;
        } else {
            self.conn
                .execute("DELETE FROM query_history WHERE favorite = 0", [])?;
        }
        Ok(())
    }

    // --- Snippets (schema v4, Phase 2) --------------------------------------

    pub fn snippet_upsert(&self, s: &SnippetRecord) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO snippets (id, name, body, tags, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, unixepoch(), unixepoch())
             ON CONFLICT(id) DO UPDATE SET name=?2, body=?3, tags=?4, updated_at=unixepoch()",
            params![s.id, s.name, s.body, s.tags],
        )?;
        Ok(())
    }

    pub fn snippet_list(&self) -> Result<Vec<SnippetRecord>, StoreError> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, name, body, tags FROM snippets ORDER BY name COLLATE NOCASE")?;
        let rows = stmt
            .query_map([], |r| {
                Ok(SnippetRecord {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    body: r.get(2)?,
                    tags: r.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn snippet_delete(&self, id: &str) -> Result<(), StoreError> {
        self.conn
            .execute("DELETE FROM snippets WHERE id = ?1", params![id])?;
        Ok(())
    }

    // --- Audit log (schema v4, Phase 6) -------------------------------------

    /// Appends a full-text audit entry (used for prod connections where the
    /// history intentionally omits the SQL). Keeps the newest 5,000.
    pub fn audit_add(
        &self,
        connection_key: &str,
        environment: Option<&str>,
        sql_text: &str,
    ) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO audit_log (id, connection_key, environment, sql_text, at)
             VALUES (?1, ?2, ?3, ?4, unixepoch())",
            params![
                uuid::Uuid::new_v4().to_string(),
                connection_key,
                environment,
                sql_text
            ],
        )?;
        self.conn.execute(
            "DELETE FROM audit_log WHERE id NOT IN (
               SELECT id FROM audit_log ORDER BY at DESC LIMIT 5000)",
            [],
        )?;
        Ok(())
    }

    pub fn audit_list(&self, limit: usize) -> Result<Vec<AuditEntry>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT connection_key, environment, sql_text, at FROM audit_log
             ORDER BY at DESC LIMIT ?1",
        )?;
        let rows = stmt
            .query_map(params![limit as i64], |r| {
                Ok(AuditEntry {
                    connection_key: r.get(0)?,
                    environment: r.get(1)?,
                    sql_text: r.get(2)?,
                    at: r.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    fn row_to_history(r: &rusqlite::Row<'_>) -> rusqlite::Result<HistoryEntry> {
        Ok(HistoryEntry {
            id: r.get(0)?,
            connection_key: r.get(1)?,
            sql_text: r.get(2)?,
            status: r.get(3)?,
            error_text: r.get(4)?,
            rows_returned: r.get::<_, i64>(5)? as u64,
            rows_affected: r.get::<_, Option<i64>>(6)?.map(|v| v as u64),
            started_at: r.get(7)?,
            duration_ms: r.get::<_, i64>(8)? as u64,
            favorite: r.get::<_, i64>(9)? != 0,
        })
    }

    fn row_to_connection(r: &rusqlite::Row<'_>) -> rusqlite::Result<ConnectionRecord> {
        Ok(ConnectionRecord {
            id: r.get(0)?,
            name: r.get(1)?,
            driver: r.get(2)?,
            environment: r.get(3)?,
            color: r.get(4)?,
            read_only: r.get::<_, i64>(5)? != 0,
            host: r.get(6)?,
            port: r.get::<_, i64>(7)? as u16,
            database: r.get(8)?,
            username: r.get(9)?,
            secret_ref: r.get(10)?,
            tls_mode: r.get(11)?,
            tls_ca_path: r.get(12)?,
            ssh_json: r.get(13)?,
            options_json: r.get(14)?,
        })
    }
}

const CONNECTION_SELECT: &str = "SELECT id, name, driver, environment, color, read_only,
        host, port, database, username, secret_ref,
        tls_mode, tls_ca_path, ssh_json, options_json FROM connections";

/// A saved connection profile. Never contains a secret value.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionRecord {
    pub id: String,
    pub name: String,
    pub driver: String,
    pub environment: Option<String>,
    pub color: Option<String>,
    pub read_only: bool,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    /// Opaque keychain reference (see credential-store), never the secret.
    pub secret_ref: Option<String>,
    pub tls_mode: String,
    pub tls_ca_path: Option<String>,
    pub ssh_json: Option<String>,
    pub options_json: Option<String>,
}

/// A reusable SQL snippet (Phase 2).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetRecord {
    pub id: String,
    pub name: String,
    pub body: String,
    pub tags: Option<String>,
}

/// A prod audit entry (Phase 6): full SQL text, always retained.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub connection_key: String,
    pub environment: Option<String>,
    pub sql_text: String,
    pub at: i64,
}

/// One recorded execution. `sql_text` may be None (prod text exclusion).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub connection_key: String,
    pub sql_text: Option<String>,
    /// 'success' | 'error' | 'cancelled'
    pub status: String,
    pub error_text: Option<String>,
    pub rows_returned: u64,
    pub rows_affected: Option<u64>,
    /// Unix seconds.
    pub started_at: i64,
    pub duration_ms: u64,
    pub favorite: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TabRecord {
    pub id: String,
    pub kind: String,
    pub title: Option<String>,
    pub position: i64,
    pub pinned: bool,
    pub state_json: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_fresh_store_to_current() {
        let store = Store::open_in_memory().unwrap();
        assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
    }

    #[cfg(unix)]
    #[test]
    fn on_disk_db_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tuplenest.db");
        let store = Store::open(&path).unwrap();
        // Force the WAL/SHM siblings into existence with a write.
        store.setting_set("k", &serde_json::json!("v")).unwrap();
        secure_sqlite_files(&path);
        for suffix in ["", "-wal", "-shm"] {
            let p = std::path::PathBuf::from(format!("{}{}", path.display(), suffix));
            if let Ok(meta) = std::fs::metadata(&p) {
                assert_eq!(
                    meta.permissions().mode() & 0o777,
                    0o600,
                    "{p:?} must be owner-only, not world-readable"
                );
            }
        }
    }

    #[test]
    fn fresh_store_has_the_tables_its_version_claims() {
        // The version number is a claim about the schema. Recording 4 without
        // creating v4's tables is exactly the bug that shipped: every snippet
        // save failed, and the prod audit log recorded nothing at all.
        let store = Store::open_in_memory().unwrap();
        store.snippet_list().expect("snippets table missing");
        store
            .conn
            .query_row("SELECT count(*) FROM audit_log", [], |r| r.get::<_, i64>(0))
            .expect("audit_log table missing");
    }

    #[test]
    fn repairs_a_store_that_recorded_v4_without_v4s_tables() {
        // A real database from this machine: schema_version = 4, no snippets
        // and no audit_log. The runner trusts the number, so v4 could never
        // run again and the feature was broken forever.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("broken.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(MIGRATION_V1).unwrap();
            conn.execute_batch(MIGRATION_V2).unwrap();
            conn.execute_batch(MIGRATION_V3).unwrap();
            // v4 skipped, but claimed:
            conn.execute(
                "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '4')",
                [],
            )
            .unwrap();
        }

        let store = Store::open(&path).unwrap();
        assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
        store
            .snippet_list()
            .expect("snippets should have been repaired");

        // And it actually works now, rather than merely existing.
        store
            .snippet_upsert(&SnippetRecord {
                id: "s1".into(),
                name: "recent users".into(),
                body: "select * from users".into(),
                tags: None,
            })
            .unwrap();
        assert_eq!(store.snippet_list().unwrap().len(), 1);
    }

    #[test]
    fn repair_leaves_a_healthy_v4_store_alone() {
        // The repair is IF NOT EXISTS, so it must not disturb a database that
        // really did get v4 — including the rows already in it.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ok.db");
        {
            let store = Store::open(&path).unwrap();
            store
                .snippet_upsert(&SnippetRecord {
                    id: "keep".into(),
                    name: "keep me".into(),
                    body: "select 1".into(),
                    tags: None,
                })
                .unwrap();
        }
        let store = Store::open(&path).unwrap();
        let all = store.snippet_list().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].name, "keep me");
    }

    #[test]
    fn upgrades_v1_store_to_v2_preserving_data() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("v1.db");
        // Build a genuine v1 store on disk.
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(MIGRATION_V1).unwrap();
            conn.execute(
                "INSERT INTO meta (key, value) VALUES ('schema_version', '1')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO settings (key, value_json, updated_at) VALUES ('theme','\"dark\"',0)",
                [],
            )
            .unwrap();
        }
        // Reopen: must migrate to the current version and keep old data.
        let store = Store::open(&path).unwrap();
        assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
        assert_eq!(
            store.setting_get::<String>("theme").unwrap().unwrap(),
            "dark"
        );
        assert!(store.connection_list().unwrap().is_empty());
    }

    fn sample_connection(id: &str, name: &str) -> ConnectionRecord {
        ConnectionRecord {
            id: id.into(),
            name: name.into(),
            driver: "postgres".into(),
            environment: Some("dev".into()),
            color: Some("#3fa7ff".into()),
            read_only: false,
            host: "localhost".into(),
            port: 5432,
            database: "postgres".into(),
            username: "talaat".into(),
            secret_ref: Some("tn-secret-abc".into()),
            tls_mode: "disabled".into(),
            tls_ca_path: None,
            ssh_json: None,
            options_json: None,
        }
    }

    #[test]
    fn connection_crud_roundtrip() {
        let store = Store::open_in_memory().unwrap();
        let mut rec = sample_connection("c1", "Local PG");
        store.connection_upsert(&rec).unwrap();
        assert_eq!(store.connection_get("c1").unwrap().unwrap(), rec);

        // Update in place keeps a single row.
        rec.name = "Local PG (renamed)".into();
        rec.read_only = true;
        store.connection_upsert(&rec).unwrap();
        let listed = store.connection_list().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0], rec);

        // List is name-sorted, case-insensitive.
        store
            .connection_upsert(&sample_connection("c2", "aurora"))
            .unwrap();
        let names: Vec<_> = store
            .connection_list()
            .unwrap()
            .into_iter()
            .map(|c| c.name)
            .collect();
        assert_eq!(names, vec!["aurora", "Local PG (renamed)"]);

        // Delete returns the secret_ref for keychain cleanup.
        let secret_ref = store.connection_delete("c1").unwrap();
        assert_eq!(secret_ref.as_deref(), Some("tn-secret-abc"));
        assert!(store.connection_get("c1").unwrap().is_none());
        // Idempotent delete.
        assert!(store.connection_delete("c1").unwrap().is_none());
    }

    fn history(id: &str, started_at: i64, sql: Option<&str>, favorite: bool) -> HistoryEntry {
        HistoryEntry {
            id: id.into(),
            connection_key: "talaat@localhost:5432/postgres".into(),
            sql_text: sql.map(String::from),
            status: "success".into(),
            error_text: None,
            rows_returned: 42,
            rows_affected: None,
            started_at,
            duration_ms: 7,
            favorite,
        }
    }

    #[test]
    fn history_roundtrip_search_and_favorite() {
        let store = Store::open_in_memory().unwrap();
        store
            .history_add(&history("h1", 100, Some("select * from users"), false), 100)
            .unwrap();
        store
            .history_add(
                &history("h2", 200, Some("update orders set x=1"), false),
                100,
            )
            .unwrap();
        store
            .history_add(&history("h3", 300, None, false), 100) // prod: no text
            .unwrap();

        // Newest first.
        let all = store.history_list(None, 10).unwrap();
        assert_eq!(
            all.iter().map(|h| h.id.as_str()).collect::<Vec<_>>(),
            vec!["h3", "h2", "h1"]
        );
        assert_eq!(all[0].sql_text, None);
        assert_eq!(all[2].rows_returned, 42);

        // Search hits SQL text only.
        let hits = store.history_list(Some("users"), 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "h1");

        // Favorite toggle round-trips.
        store.history_set_favorite("h1", true).unwrap();
        assert!(store.history_list(Some("users"), 10).unwrap()[0].favorite);
    }

    #[test]
    fn history_retention_prunes_oldest_but_spares_favorites() {
        let store = Store::open_in_memory().unwrap();
        store
            .history_add(&history("old-fav", 1, Some("select 1"), true), 3)
            .unwrap();
        for i in 0..5 {
            store
                .history_add(
                    &history(&format!("h{i}"), 10 + i, Some("select 2"), false),
                    3,
                )
                .unwrap();
        }
        let ids: Vec<_> = store
            .history_list(None, 100)
            .unwrap()
            .into_iter()
            .map(|h| h.id)
            .collect();
        // 3 newest non-favorites kept + the favorite, regardless of age.
        assert_eq!(ids, vec!["h4", "h3", "h2", "old-fav"]);

        // Clear keeps favorites by default, removes them when asked.
        store.history_clear(false).unwrap();
        let ids: Vec<_> = store
            .history_list(None, 100)
            .unwrap()
            .into_iter()
            .map(|h| h.id)
            .collect();
        assert_eq!(ids, vec!["old-fav"]);
        store.history_clear(true).unwrap();
        assert!(store.history_list(None, 100).unwrap().is_empty());
    }

    #[test]
    fn upgrades_v2_store_to_v3() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("v2.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(MIGRATION_V1).unwrap();
            conn.execute_batch(MIGRATION_V2).unwrap();
            conn.execute(
                "INSERT INTO meta (key, value) VALUES ('schema_version', '2')",
                [],
            )
            .unwrap();
        }
        let store = Store::open(&path).unwrap();
        assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
        assert!(store.history_list(None, 10).unwrap().is_empty());
    }

    #[test]
    fn snippets_and_audit_roundtrip() {
        let store = Store::open_in_memory().unwrap();
        store
            .snippet_upsert(&SnippetRecord {
                id: "s1".into(),
                name: "count rows".into(),
                body: "select count(*) from ".into(),
                tags: Some("util".into()),
            })
            .unwrap();
        store
            .snippet_upsert(&SnippetRecord {
                id: "s1".into(),
                name: "count rows".into(),
                body: "select count(*) from orders".into(),
                tags: None,
            })
            .unwrap();
        let list = store.snippet_list().unwrap();
        assert_eq!(list.len(), 1, "upsert keeps one row");
        assert_eq!(list[0].body, "select count(*) from orders");
        store.snippet_delete("s1").unwrap();
        assert!(store.snippet_list().unwrap().is_empty());

        store
            .audit_add("app@prod:5432/pay", Some("prod"), "delete from t")
            .unwrap();
        let audit = store.audit_list(10).unwrap();
        assert_eq!(audit.len(), 1);
        assert_eq!(audit[0].sql_text, "delete from t");
        assert_eq!(audit[0].environment.as_deref(), Some("prod"));
    }

    #[test]
    fn upgrades_v3_store_to_v4() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("v3.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(MIGRATION_V1).unwrap();
            conn.execute_batch(MIGRATION_V2).unwrap();
            conn.execute_batch(MIGRATION_V3).unwrap();
            conn.execute(
                "INSERT INTO meta (key, value) VALUES ('schema_version', '3')",
                [],
            )
            .unwrap();
        }
        let store = Store::open(&path).unwrap();
        // Against the constant, not a literal: a version bump is not a reason
        // for this test to fail, and pinning the number here is what let the
        // v4 gap go unnoticed.
        assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
        assert!(store.snippet_list().unwrap().is_empty());
        assert!(store.audit_list(10).unwrap().is_empty());
    }

    #[test]
    fn connection_rejects_invalid_environment() {
        let store = Store::open_in_memory().unwrap();
        let mut rec = sample_connection("c1", "bad env");
        rec.environment = Some("production".into()); // not in CHECK list
        assert!(store.connection_upsert(&rec).is_err());
    }

    #[test]
    fn refuses_future_schema() {
        let store = Store::open_in_memory().unwrap();
        store
            .conn
            .execute("UPDATE meta SET value='999' WHERE key='schema_version'", [])
            .unwrap();
        let err = store.migrate().unwrap_err();
        assert!(matches!(err, StoreError::FutureSchema { found: 999, .. }));
    }

    #[test]
    fn settings_roundtrip_json() {
        let store = Store::open_in_memory().unwrap();
        store.setting_set("theme", &"dark").unwrap();
        store
            .setting_set("density", &serde_json::json!({"rows": "compact"}))
            .unwrap();
        assert_eq!(
            store.setting_get::<String>("theme").unwrap().unwrap(),
            "dark"
        );
        assert!(store.setting_get::<String>("missing").unwrap().is_none());
    }

    #[test]
    fn layout_roundtrip_and_validation() {
        let store = Store::open_in_memory().unwrap();
        store.workspace_upsert("ws1", "Default").unwrap();
        store.layout_save("ws1", r#"{"split":"vertical"}"#).unwrap();
        assert_eq!(
            store.layout_load("ws1").unwrap().unwrap(),
            r#"{"split":"vertical"}"#
        );
        assert!(store.layout_save("ws1", "not-json").is_err());
    }

    #[test]
    fn tabs_replace_and_restore_ordered() {
        let mut store = Store::open_in_memory().unwrap();
        store.workspace_upsert("ws1", "Default").unwrap();
        let tabs = vec![
            TabRecord {
                id: "t1".into(),
                kind: "sql".into(),
                title: Some("query 1".into()),
                position: 0,
                pinned: true,
                state_json: None,
            },
            TabRecord {
                id: "t2".into(),
                kind: "table".into(),
                title: None,
                position: 1,
                pinned: false,
                state_json: Some(r#"{"table":"users"}"#.into()),
            },
        ];
        store.tabs_replace("ws1", &tabs).unwrap();
        assert_eq!(store.tabs_list("ws1").unwrap(), tabs);
    }
}
