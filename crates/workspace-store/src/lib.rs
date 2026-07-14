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

const SCHEMA_VERSION: i64 = 1;

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

pub struct Store {
    conn: Connection,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        Self::init(Connection::open(path)?)
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
    fn migrates_fresh_store_to_v1() {
        let store = Store::open_in_memory().unwrap();
        assert_eq!(store.schema_version().unwrap(), 1);
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
