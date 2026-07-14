//! SQLite-backed metadata cache (Phase 1, E1.3).
//!
//! Stores explorer payloads per connection so the tree renders instantly on
//! reconnect and stays browsable offline. Contents are a disposable cache:
//! wiping the file loses nothing but a refresh.
//!
//! Keying: `connection_key` is an app-chosen stable identifier
//! (e.g. `user@host:port/db`), never containing secrets.

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum CacheError {
    #[error("cache database error: {0}")]
    Db(#[from] rusqlite::Error),
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS metadata_objects (
  connection_key TEXT NOT NULL,
  object_type    TEXT NOT NULL,   -- 'schema' | 'object' | 'columns'
  schema_name    TEXT NOT NULL DEFAULT '',
  object_name    TEXT NOT NULL,
  payload_json   TEXT NOT NULL,
  fetched_at     INTEGER NOT NULL,
  PRIMARY KEY (connection_key, object_type, schema_name, object_name)
);
CREATE INDEX IF NOT EXISTS idx_meta_search
  ON metadata_objects(connection_key, object_name);
"#;

/// A cached entry: name plus the JSON payload stored for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachedEntry {
    pub name: String,
    pub payload_json: String,
    pub fetched_at: i64,
}

pub struct MetadataCache {
    conn: Connection,
}

impl MetadataCache {
    pub fn open(path: &Path) -> Result<Self, CacheError> {
        Self::init(Connection::open(path)?)
    }

    pub fn open_in_memory() -> Result<Self, CacheError> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self, CacheError> {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self { conn })
    }

    /// Atomically replaces the full entry list for one (type, schema) scope.
    /// Objects dropped on the server disappear from the cache here.
    pub fn replace_list(
        &mut self,
        connection_key: &str,
        object_type: &str,
        schema_name: &str,
        entries: &[(String, String)],
    ) -> Result<(), CacheError> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "DELETE FROM metadata_objects
             WHERE connection_key = ?1 AND object_type = ?2 AND schema_name = ?3",
            params![connection_key, object_type, schema_name],
        )?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO metadata_objects
                   (connection_key, object_type, schema_name, object_name,
                    payload_json, fetched_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, unixepoch())",
            )?;
            for (name, payload) in entries {
                stmt.execute(params![
                    connection_key,
                    object_type,
                    schema_name,
                    name,
                    payload
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Upserts a single entry (used for per-table column payloads).
    pub fn put(
        &self,
        connection_key: &str,
        object_type: &str,
        schema_name: &str,
        object_name: &str,
        payload_json: &str,
    ) -> Result<(), CacheError> {
        self.conn.execute(
            "INSERT INTO metadata_objects
               (connection_key, object_type, schema_name, object_name,
                payload_json, fetched_at)
             VALUES (?1, ?2, ?3, ?4, ?5, unixepoch())
             ON CONFLICT(connection_key, object_type, schema_name, object_name)
             DO UPDATE SET payload_json = ?5, fetched_at = unixepoch()",
            params![
                connection_key,
                object_type,
                schema_name,
                object_name,
                payload_json
            ],
        )?;
        Ok(())
    }

    pub fn get(
        &self,
        connection_key: &str,
        object_type: &str,
        schema_name: &str,
        object_name: &str,
    ) -> Result<Option<CachedEntry>, CacheError> {
        let row = self
            .conn
            .query_row(
                "SELECT object_name, payload_json, fetched_at FROM metadata_objects
                 WHERE connection_key = ?1 AND object_type = ?2
                   AND schema_name = ?3 AND object_name = ?4",
                params![connection_key, object_type, schema_name, object_name],
                |r| {
                    Ok(CachedEntry {
                        name: r.get(0)?,
                        payload_json: r.get(1)?,
                        fetched_at: r.get(2)?,
                    })
                },
            )
            .optional()?;
        Ok(row)
    }

    pub fn list(
        &self,
        connection_key: &str,
        object_type: &str,
        schema_name: &str,
    ) -> Result<Vec<CachedEntry>, CacheError> {
        let mut stmt = self.conn.prepare(
            "SELECT object_name, payload_json, fetched_at FROM metadata_objects
             WHERE connection_key = ?1 AND object_type = ?2 AND schema_name = ?3
             ORDER BY object_name",
        )?;
        let rows = stmt
            .query_map(params![connection_key, object_type, schema_name], |r| {
                Ok(CachedEntry {
                    name: r.get(0)?,
                    payload_json: r.get(1)?,
                    fetched_at: r.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Case-insensitive substring search over object names (explorer search).
    pub fn search(
        &self,
        connection_key: &str,
        pattern: &str,
        limit: usize,
    ) -> Result<Vec<(String, String, String)>, CacheError> {
        let like = format!("%{}%", pattern.replace('%', "\\%").replace('_', "\\_"));
        let mut stmt = self.conn.prepare(
            "SELECT object_type, schema_name, object_name FROM metadata_objects
             WHERE connection_key = ?1 AND object_name LIKE ?2 ESCAPE '\\'
             ORDER BY object_name LIMIT ?3",
        )?;
        let rows = stmt
            .query_map(params![connection_key, like, limit as i64], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Drops everything cached for one connection (manual refresh / delete).
    pub fn invalidate(&self, connection_key: &str) -> Result<(), CacheError> {
        self.conn.execute(
            "DELETE FROM metadata_objects WHERE connection_key = ?1",
            params![connection_key],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "talaat@localhost:5432/postgres";

    fn entries(names: &[&str]) -> Vec<(String, String)> {
        names
            .iter()
            .map(|n| (n.to_string(), format!("{{\"name\":\"{n}\"}}")))
            .collect()
    }

    #[test]
    fn replace_list_roundtrip_and_stale_removal() {
        let mut cache = MetadataCache::open_in_memory().unwrap();
        cache
            .replace_list(KEY, "object", "public", &entries(&["users", "orders"]))
            .unwrap();
        let listed = cache.list(KEY, "object", "public").unwrap();
        assert_eq!(
            listed.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(),
            vec!["orders", "users"]
        );

        // `orders` dropped server-side; replace removes it.
        cache
            .replace_list(KEY, "object", "public", &entries(&["users", "invoices"]))
            .unwrap();
        let names: Vec<_> = cache
            .list(KEY, "object", "public")
            .unwrap()
            .into_iter()
            .map(|e| e.name)
            .collect();
        assert_eq!(names, vec!["invoices", "users"]);
    }

    #[test]
    fn scopes_are_isolated_by_connection_type_and_schema() {
        let mut cache = MetadataCache::open_in_memory().unwrap();
        cache
            .replace_list(KEY, "object", "public", &entries(&["a"]))
            .unwrap();
        cache
            .replace_list(KEY, "object", "audit", &entries(&["b"]))
            .unwrap();
        cache
            .replace_list("other@db", "object", "public", &entries(&["c"]))
            .unwrap();

        assert_eq!(cache.list(KEY, "object", "public").unwrap().len(), 1);
        assert_eq!(cache.list(KEY, "object", "audit").unwrap().len(), 1);
        assert_eq!(cache.list("other@db", "object", "public").unwrap().len(), 1);
        assert!(cache.list(KEY, "schema", "").unwrap().is_empty());
    }

    #[test]
    fn put_get_upserts_column_payloads() {
        let cache = MetadataCache::open_in_memory().unwrap();
        cache
            .put(KEY, "columns", "public", "users", "{\"columns\":[1]}")
            .unwrap();
        cache
            .put(KEY, "columns", "public", "users", "{\"columns\":[1,2]}")
            .unwrap();
        let entry = cache
            .get(KEY, "columns", "public", "users")
            .unwrap()
            .unwrap();
        assert_eq!(entry.payload_json, "{\"columns\":[1,2]}");
        assert!(cache
            .get(KEY, "columns", "public", "ghost")
            .unwrap()
            .is_none());
    }

    #[test]
    fn search_matches_substring_case_insensitive_and_invalidate_clears() {
        let mut cache = MetadataCache::open_in_memory().unwrap();
        cache
            .replace_list(
                KEY,
                "object",
                "public",
                &entries(&["Users", "user_events", "orders"]),
            )
            .unwrap();
        let hits = cache.search(KEY, "user", 10).unwrap();
        assert_eq!(
            hits.len(),
            2,
            "LIKE is case-insensitive for ASCII: {hits:?}"
        );

        cache.invalidate(KEY).unwrap();
        assert!(cache.list(KEY, "object", "public").unwrap().is_empty());
    }
}
