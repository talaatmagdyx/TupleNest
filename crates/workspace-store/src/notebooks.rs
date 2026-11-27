//! SQL notebooks (schema v11): a document of cells — text, SQL, chart.
//!
//! The cells are one JSON document per notebook; the page owns their shape.
//! The store holds it to three rules: it is an array of objects with a known
//! `kind`, there are not too many of them, and a SQL cell's kept result has at
//! most [`RESULT_ROWS`] rows — the rest are dropped here and the cell is
//! marked `truncated`, whatever the page sent.

use rusqlite::{params, OptionalExtension};

use crate::{Store, StoreError};

/// `IF NOT EXISTS`, per the note above V5 in lib.rs.
pub(crate) const MIGRATION_V11: &str = r#"
CREATE TABLE IF NOT EXISTS notebooks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  connection_id TEXT REFERENCES connections(id) ON DELETE SET NULL,
  cells_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
"#;

/// Rows a SQL cell keeps from its last run.
pub const RESULT_ROWS: usize = 200;

/// Cells one notebook holds at most.
pub const MAX_CELLS: usize = 200;

/// A notebook in the list: no cells.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookSummary {
    pub id: String,
    pub name: String,
    pub connection_id: Option<String>,
    /// Unix seconds.
    pub updated_at: i64,
}

/// A whole notebook.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookRecord {
    pub id: String,
    pub name: String,
    pub connection_id: Option<String>,
    pub cells: serde_json::Value,
}

/// The cells as they will be stored, or why not.
fn checked_cells(mut cells: serde_json::Value) -> Result<serde_json::Value, StoreError> {
    let list = cells
        .as_array_mut()
        .ok_or_else(|| StoreError::Refused("a notebook's cells are a list".into()))?;
    if list.len() > MAX_CELLS {
        return Err(StoreError::Refused(format!(
            "a notebook holds at most {MAX_CELLS} cells"
        )));
    }
    for cell in list.iter_mut() {
        let kind = cell.get("kind").and_then(|k| k.as_str());
        if !matches!(kind, Some("text" | "sql" | "chart")) {
            return Err(StoreError::Refused("a cell is text, SQL or a chart".into()));
        }
        let Some(rows) = cell
            .get_mut("result")
            .and_then(|r| r.get_mut("rows"))
            .and_then(|r| r.as_array_mut())
        else {
            continue;
        };
        if rows.len() > RESULT_ROWS {
            rows.truncate(RESULT_ROWS);
            cell["result"]["truncated"] = serde_json::Value::Bool(true);
        }
    }
    Ok(cells)
}

impl Store {
    /// Every notebook, most recently changed first.
    pub fn notebook_list(&self) -> Result<Vec<NotebookSummary>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, connection_id, updated_at FROM notebooks
             ORDER BY updated_at DESC, name COLLATE NOCASE",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(NotebookSummary {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    connection_id: r.get(2)?,
                    updated_at: r.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn notebook_get(&self, id: &str) -> Result<Option<NotebookRecord>, StoreError> {
        let row: Option<(String, String, Option<String>, String)> = self
            .conn
            .query_row(
                "SELECT id, name, connection_id, cells_json FROM notebooks WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        row.map(|(id, name, connection_id, cells)| {
            Ok(NotebookRecord {
                id,
                name,
                connection_id,
                cells: serde_json::from_str(&cells)?,
            })
        })
        .transpose()
    }

    /// Create or replace a notebook. Returns it as stored (results capped).
    pub fn notebook_save(&self, nb: &NotebookRecord) -> Result<NotebookRecord, StoreError> {
        let name = nb.name.trim();
        if name.is_empty() {
            return Err(StoreError::Refused("a notebook needs a name".into()));
        }
        let cells = checked_cells(nb.cells.clone())?;
        self.conn.execute(
            "INSERT INTO notebooks (id, name, connection_id, cells_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, unixepoch(), unixepoch())
             ON CONFLICT(id) DO UPDATE SET name = ?2, connection_id = ?3, cells_json = ?4,
               updated_at = unixepoch()",
            params![
                nb.id,
                name,
                nb.connection_id,
                serde_json::to_string(&cells)?
            ],
        )?;
        Ok(NotebookRecord {
            name: name.to_string(),
            cells,
            ..nb.clone()
        })
    }

    pub fn notebook_delete(&self, id: &str) -> Result<(), StoreError> {
        self.conn
            .execute("DELETE FROM notebooks WHERE id = ?1", params![id])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn nb(id: &str, cells: serde_json::Value) -> NotebookRecord {
        NotebookRecord {
            id: id.into(),
            name: format!("notebook {id}"),
            connection_id: None,
            cells,
        }
    }

    #[test]
    fn notebooks_round_trip() {
        let store = Store::open_in_memory().unwrap();
        let cells = json!([
            {"id": "a", "kind": "text", "text": "# Refunds"},
            {"id": "b", "kind": "sql", "sql": "select 1",
             "result": {"columns": [{"name": "n", "dbType": "int4"}], "rows": [[1]]}},
            {"id": "c", "kind": "chart", "source": "b", "chart": "bar"}
        ]);
        store.notebook_save(&nb("n1", cells.clone())).unwrap();
        let got = store.notebook_get("n1").unwrap().unwrap();
        assert_eq!(got.cells, cells);
        assert_eq!(got.name, "notebook n1");

        store.notebook_save(&nb("n2", json!([]))).unwrap();
        assert_eq!(store.notebook_list().unwrap().len(), 2);
        store.notebook_delete("n1").unwrap();
        assert!(store.notebook_get("n1").unwrap().is_none());
        assert_eq!(store.notebook_list().unwrap()[0].id, "n2");
    }

    #[test]
    fn a_sql_cell_keeps_at_most_200_rows() {
        let store = Store::open_in_memory().unwrap();
        let rows: Vec<_> = (0..500).map(|i| json!([i])).collect();
        let saved = store
            .notebook_save(&nb(
                "n1",
                json!([{"id": "b", "kind": "sql", "sql": "select generate_series(1,500)",
                        "result": {"columns": [], "rows": rows}}]),
            ))
            .unwrap();
        assert_eq!(
            saved.cells[0]["result"]["rows"].as_array().unwrap().len(),
            200
        );
        assert_eq!(saved.cells[0]["result"]["truncated"], json!(true));
        let got = store.notebook_get("n1").unwrap().unwrap();
        assert_eq!(got.cells, saved.cells);
    }

    #[test]
    fn refuses_what_is_not_a_notebook() {
        let store = Store::open_in_memory().unwrap();
        assert!(store
            .notebook_save(&nb("n1", json!({"kind": "text"})))
            .is_err());
        assert!(store
            .notebook_save(&nb("n1", json!([{"kind": "html"}])))
            .is_err());
        assert!(store.notebook_save(&nb("n1", json!([{}]))).is_err());
        let mut unnamed = nb("n1", json!([]));
        unnamed.name = " ".into();
        assert!(store.notebook_save(&unnamed).is_err());
        let many: Vec<_> = (0..=MAX_CELLS).map(|_| json!({"kind": "text"})).collect();
        assert!(store.notebook_save(&nb("n1", json!(many))).is_err());
        assert!(store.notebook_list().unwrap().is_empty());
    }

    #[test]
    fn upgrades_a_v10_database() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("v10.db");
        {
            let store = Store::open(&path).unwrap();
            store.dashboard_save("d1", "Sales", None, 0).unwrap();
            store
                .conn
                .execute_batch(
                    "DROP TABLE notebooks; UPDATE meta SET value = '10' WHERE key = 'schema_version';",
                )
                .unwrap();
        }
        let store = Store::open(&path).unwrap();
        assert_eq!(store.dashboard_list().unwrap().len(), 1);
        store.notebook_save(&nb("n1", json!([]))).unwrap();
    }
}
