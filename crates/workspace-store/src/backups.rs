//! Backup and restore runs (schema v11): what `pg_dump` / `pg_restore` was
//! asked to do, where the file is, and how it ended. Never a password.

use rusqlite::{params, OptionalExtension};

use crate::{Store, StoreError};

/// `IF NOT EXISTS`, per the note above V5 in lib.rs.
pub(crate) const MIGRATION_V11: &str = r#"
CREATE TABLE IF NOT EXISTS backups (
  id TEXT PRIMARY KEY,
  connection_id TEXT REFERENCES connections(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('backup','restore')),
  database TEXT NOT NULL,
  file_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','done','failed','cancelled')),
  bytes INTEGER,
  message TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_backups_started ON backups(started_at);
"#;

/// Runs kept; older ones are pruned on insert. The files themselves are the
/// user's and are never deleted by this.
const RETENTION: i64 = 200;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupRecord {
    pub id: String,
    pub connection_id: Option<String>,
    /// "backup" | "restore"
    pub kind: String,
    pub database: String,
    pub file_path: String,
    /// "running" | "done" | "failed" | "cancelled"
    pub status: String,
    pub bytes: Option<u64>,
    pub message: Option<String>,
    /// Unix seconds.
    pub started_at: i64,
    pub finished_at: Option<i64>,
}

const SELECT: &str = "SELECT id, connection_id, kind, database, file_path, status, bytes, message,
        started_at, finished_at FROM backups";

fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<BackupRecord> {
    Ok(BackupRecord {
        id: r.get(0)?,
        connection_id: r.get(1)?,
        kind: r.get(2)?,
        database: r.get(3)?,
        file_path: r.get(4)?,
        status: r.get(5)?,
        bytes: r.get::<_, Option<i64>>(6)?.map(|b| b.max(0) as u64),
        message: r.get(7)?,
        started_at: r.get(8)?,
        finished_at: r.get(9)?,
    })
}

impl Store {
    /// Records a run that is starting.
    pub fn backup_start(
        &self,
        id: &str,
        connection_id: Option<&str>,
        kind: &str,
        database: &str,
        file_path: &str,
    ) -> Result<(), StoreError> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO backups (id, connection_id, kind, database, file_path, status, started_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 'running', unixepoch())",
            params![id, connection_id, kind, database, file_path],
        )?;
        tx.execute(
            "DELETE FROM backups WHERE rowid IN (
               SELECT rowid FROM backups ORDER BY started_at DESC, rowid DESC LIMIT -1 OFFSET ?1)",
            params![RETENTION],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Records how a run ended.
    pub fn backup_finish(
        &self,
        id: &str,
        status: &str,
        bytes: Option<u64>,
        message: Option<&str>,
    ) -> Result<(), StoreError> {
        if !matches!(status, "done" | "failed" | "cancelled") {
            return Err(StoreError::Refused(format!(
                "`{status}` is not how a run ends"
            )));
        }
        self.conn.execute(
            "UPDATE backups SET status = ?2, bytes = ?3, message = ?4, finished_at = unixepoch()
             WHERE id = ?1",
            params![id, status, bytes.map(|b| b as i64), message],
        )?;
        Ok(())
    }

    /// A run still marked running when none is: the app quit or crashed
    /// during it. Called before a new run starts.
    pub fn backup_mark_interrupted(&self) -> Result<(), StoreError> {
        self.conn.execute(
            "UPDATE backups SET status = 'failed', message = 'Interrupted: TupleNest closed during the run.',
               finished_at = unixepoch() WHERE status = 'running'",
            [],
        )?;
        Ok(())
    }

    /// Newest first.
    pub fn backup_list(&self, limit: usize) -> Result<Vec<BackupRecord>, StoreError> {
        let mut stmt = self.conn.prepare(&format!(
            "{SELECT} ORDER BY started_at DESC, rowid DESC LIMIT ?1"
        ))?;
        let rows = stmt
            .query_map(params![limit as i64], row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn backup_get(&self, id: &str) -> Result<Option<BackupRecord>, StoreError> {
        Ok(self
            .conn
            .query_row(&format!("{SELECT} WHERE id = ?1"), params![id], row)
            .optional()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_run_is_recorded_and_finished() {
        let store = Store::open_in_memory().unwrap();
        store
            .backup_start("b1", None, "backup", "shop", "/tmp/shop.dump")
            .unwrap();
        let r = store.backup_get("b1").unwrap().unwrap();
        assert_eq!((r.status.as_str(), r.finished_at), ("running", None));
        store.backup_finish("b1", "done", Some(4096), None).unwrap();
        let r = store.backup_get("b1").unwrap().unwrap();
        assert_eq!(r.status, "done");
        assert_eq!(r.bytes, Some(4096));
        assert!(r.finished_at.is_some());
        assert!(store.backup_finish("b1", "running", None, None).is_err());
        assert!(store.backup_get("nope").unwrap().is_none());
    }

    #[test]
    fn newest_first_and_stale_runs_are_marked_interrupted() {
        let store = Store::open_in_memory().unwrap();
        store.backup_start("b1", None, "backup", "a", "/a").unwrap();
        store
            .backup_start("b2", None, "restore", "b", "/b")
            .unwrap();
        let ids: Vec<_> = store
            .backup_list(10)
            .unwrap()
            .into_iter()
            .map(|r| r.id)
            .collect();
        assert_eq!(ids, vec!["b2", "b1"]);
        store.backup_mark_interrupted().unwrap();
        assert!(store
            .backup_list(10)
            .unwrap()
            .iter()
            .all(|r| r.status == "failed"
                && r.message.as_deref().unwrap().starts_with("Interrupted")));
    }

    #[test]
    fn old_runs_are_pruned() {
        let store = Store::open_in_memory().unwrap();
        for i in 0..(RETENTION + 5) {
            store
                .backup_start(&format!("b{i}"), None, "backup", "a", "/a")
                .unwrap();
        }
        assert_eq!(store.backup_list(1_000).unwrap().len() as i64, RETENTION);
        assert!(store.backup_get("b0").unwrap().is_none());
    }

    #[test]
    fn refuses_an_unknown_kind() {
        let store = Store::open_in_memory().unwrap();
        assert!(store.backup_start("b1", None, "copy", "a", "/a").is_err());
    }

    #[test]
    fn upgrades_a_v10_database() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("v10.db");
        {
            let store = Store::open(&path).unwrap();
            store.setting_set("theme", &"light").unwrap();
            store
                .conn
                .execute_batch(
                    "DROP TABLE backups; UPDATE meta SET value = '10' WHERE key = 'schema_version';",
                )
                .unwrap();
        }
        let store = Store::open(&path).unwrap();
        assert_eq!(
            store.setting_get::<String>("theme").unwrap().unwrap(),
            "light"
        );
        store.backup_start("b1", None, "backup", "a", "/a").unwrap();
    }
}
