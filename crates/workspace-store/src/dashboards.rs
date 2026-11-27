//! Dashboards (schema v9): named pages of charts, each chart a saved query
//! that is re-run when the page opens.
//!
//! The store keeps what to run and how to draw it — never a result. Whether a
//! chart's SQL only reads is decided by the app before it pins one, and again
//! every time it runs (`pg_query_read`); the store does not parse SQL.

use rusqlite::{params, OptionalExtension};

use crate::{Store, StoreError};

/// `IF NOT EXISTS`, per the note above V5 in lib.rs. A chart goes with its
/// dashboard; a dashboard outlives the profile it was made on (it just stops
/// naming one).
pub(crate) const MIGRATION_V9: &str = r#"
CREATE TABLE IF NOT EXISTS dashboards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  connection_id TEXT REFERENCES connections(id) ON DELETE SET NULL,
  refresh_secs INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS dashboard_charts (
  id TEXT PRIMARY KEY,
  dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('bar','line','number')),
  sql_text TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dashboard_charts ON dashboard_charts(dashboard_id, position);
"#;

/// The refresh intervals on offer, in seconds: off, 1, 5 and 15 minutes.
pub const REFRESH_CHOICES: [u32; 4] = [0, 60, 300, 900];

/// Charts one dashboard holds at most. Each re-runs a query on open, one
/// after another on the single session.
pub const MAX_CHARTS: usize = 24;

/// One pinned chart.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardChart {
    pub id: String,
    pub dashboard_id: String,
    pub title: String,
    /// "bar" | "line" | "number"
    pub kind: String,
    pub sql_text: String,
    pub position: i64,
}

/// A dashboard and its charts, in order.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardRecord {
    pub id: String,
    pub name: String,
    pub connection_id: Option<String>,
    pub refresh_secs: u32,
    #[serde(default)]
    pub charts: Vec<DashboardChart>,
}

impl Store {
    /// Every dashboard, by name, each with its charts in position order.
    pub fn dashboard_list(&self) -> Result<Vec<DashboardRecord>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, connection_id, refresh_secs FROM dashboards
             ORDER BY name COLLATE NOCASE, created_at",
        )?;
        let mut boards = stmt
            .query_map([], |r| {
                Ok(DashboardRecord {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    connection_id: r.get(2)?,
                    refresh_secs: r.get::<_, i64>(3)?.max(0) as u32,
                    charts: Vec::new(),
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        for b in &mut boards {
            b.charts = self.dashboard_charts(&b.id)?;
        }
        Ok(boards)
    }

    fn dashboard_charts(&self, dashboard_id: &str) -> Result<Vec<DashboardChart>, StoreError> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT id, dashboard_id, title, kind, sql_text, position FROM dashboard_charts
             WHERE dashboard_id = ?1 ORDER BY position, created_at",
        )?;
        let rows = stmt
            .query_map(params![dashboard_id], |r| {
                Ok(DashboardChart {
                    id: r.get(0)?,
                    dashboard_id: r.get(1)?,
                    title: r.get(2)?,
                    kind: r.get(3)?,
                    sql_text: r.get(4)?,
                    position: r.get(5)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Create or rename a dashboard, or change its connection or refresh.
    /// Its charts are untouched.
    pub fn dashboard_save(
        &self,
        id: &str,
        name: &str,
        connection_id: Option<&str>,
        refresh_secs: u32,
    ) -> Result<(), StoreError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(StoreError::Refused("a dashboard needs a name".into()));
        }
        if !REFRESH_CHOICES.contains(&refresh_secs) {
            return Err(StoreError::Refused(
                "refresh is off, or every 1, 5 or 15 minutes".into(),
            ));
        }
        self.conn.execute(
            "INSERT INTO dashboards (id, name, connection_id, refresh_secs, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, unixepoch(), unixepoch())
             ON CONFLICT(id) DO UPDATE SET name = ?2, connection_id = ?3, refresh_secs = ?4,
               updated_at = unixepoch()",
            params![id, name, connection_id, refresh_secs as i64],
        )?;
        Ok(())
    }

    /// Deletes the dashboard and its charts.
    pub fn dashboard_delete(&self, id: &str) -> Result<(), StoreError> {
        self.conn
            .execute("DELETE FROM dashboards WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Pins a chart at the end of its dashboard. `chart.position` is ignored.
    pub fn dashboard_chart_add(
        &self,
        chart: &DashboardChart,
    ) -> Result<DashboardChart, StoreError> {
        if !matches!(chart.kind.as_str(), "bar" | "line" | "number") {
            return Err(StoreError::Refused(
                "a chart is a bar, a line or a single number".into(),
            ));
        }
        if chart.sql_text.trim().is_empty() {
            return Err(StoreError::Refused("a chart needs a query".into()));
        }
        let count: Option<i64> = self
            .conn
            .query_row(
                "SELECT (SELECT count(*) FROM dashboard_charts WHERE dashboard_id = ?1)
                 FROM dashboards WHERE id = ?1",
                params![chart.dashboard_id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(count) = count else {
            return Err(StoreError::Refused("no dashboard with that id".into()));
        };
        if count as usize >= MAX_CHARTS {
            return Err(StoreError::Refused(format!(
                "a dashboard holds at most {MAX_CHARTS} charts"
            )));
        }
        let position: i64 = self.conn.query_row(
            "SELECT coalesce(max(position) + 1, 0) FROM dashboard_charts WHERE dashboard_id = ?1",
            params![chart.dashboard_id],
            |r| r.get(0),
        )?;
        let title = if chart.title.trim().is_empty() {
            "Untitled chart"
        } else {
            chart.title.trim()
        };
        self.conn.execute(
            "INSERT INTO dashboard_charts (id, dashboard_id, title, kind, sql_text, position, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, unixepoch())",
            params![
                chart.id,
                chart.dashboard_id,
                title,
                chart.kind,
                chart.sql_text,
                position
            ],
        )?;
        Ok(DashboardChart {
            title: title.to_string(),
            position,
            ..chart.clone()
        })
    }

    pub fn dashboard_chart_delete(&self, id: &str) -> Result<(), StoreError> {
        self.conn
            .execute("DELETE FROM dashboard_charts WHERE id = ?1", params![id])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chart(id: &str, board: &str, kind: &str) -> DashboardChart {
        DashboardChart {
            id: id.into(),
            dashboard_id: board.into(),
            title: format!("chart {id}"),
            kind: kind.into(),
            sql_text: "select status, count(*) from orders group by 1".into(),
            position: 99,
        }
    }

    #[test]
    fn dashboards_round_trip_with_charts_in_order() {
        let store = Store::open_in_memory().unwrap();
        store.dashboard_save("d1", "Sales", None, 300).unwrap();
        store.dashboard_save("d2", "alerts", None, 0).unwrap();
        let a = store
            .dashboard_chart_add(&chart("c1", "d1", "bar"))
            .unwrap();
        let b = store
            .dashboard_chart_add(&chart("c2", "d1", "line"))
            .unwrap();
        store
            .dashboard_chart_add(&chart("c3", "d1", "number"))
            .unwrap();
        assert_eq!((a.position, b.position), (0, 1), "appended, not as asked");

        let all = store.dashboard_list().unwrap();
        assert_eq!(
            all.iter().map(|d| d.name.as_str()).collect::<Vec<_>>(),
            vec!["alerts", "Sales"]
        );
        let sales = &all[1];
        assert_eq!(sales.refresh_secs, 300);
        assert_eq!(
            sales
                .charts
                .iter()
                .map(|c| c.id.as_str())
                .collect::<Vec<_>>(),
            vec!["c1", "c2", "c3"]
        );

        // Renaming keeps the charts.
        store
            .dashboard_save("d1", "Sales overview", None, 60)
            .unwrap();
        let sales = store
            .dashboard_list()
            .unwrap()
            .into_iter()
            .find(|d| d.id == "d1")
            .unwrap();
        assert_eq!(sales.name, "Sales overview");
        assert_eq!(sales.charts.len(), 3);

        store.dashboard_chart_delete("c2").unwrap();
        store.dashboard_delete("d2").unwrap();
        let all = store.dashboard_list().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].charts.len(), 2);
    }

    #[test]
    fn deleting_a_dashboard_deletes_its_charts() {
        let store = Store::open_in_memory().unwrap();
        store.dashboard_save("d1", "Sales", None, 0).unwrap();
        store
            .dashboard_chart_add(&chart("c1", "d1", "bar"))
            .unwrap();
        store.dashboard_delete("d1").unwrap();
        let left: i64 = store
            .conn
            .query_row("SELECT count(*) FROM dashboard_charts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0);
    }

    #[test]
    fn refuses_what_the_page_cannot_draw() {
        let store = Store::open_in_memory().unwrap();
        assert!(store.dashboard_save("d1", "  ", None, 0).is_err());
        assert!(store.dashboard_save("d1", "Sales", None, 120).is_err());
        store.dashboard_save("d1", "Sales", None, 900).unwrap();
        assert!(store
            .dashboard_chart_add(&chart("c1", "d1", "pie"))
            .is_err());
        assert!(store
            .dashboard_chart_add(&chart("c1", "nope", "bar"))
            .is_err());
        let mut empty = chart("c1", "d1", "bar");
        empty.sql_text = "  ".into();
        assert!(store.dashboard_chart_add(&empty).is_err());
        for i in 0..MAX_CHARTS {
            store
                .dashboard_chart_add(&chart(&format!("c{i}"), "d1", "bar"))
                .unwrap();
        }
        assert!(store
            .dashboard_chart_add(&chart("extra", "d1", "bar"))
            .is_err());
    }

    #[test]
    fn a_dashboard_outlives_its_profile() {
        let store = Store::open_in_memory().unwrap();
        store
            .conn
            .execute(
                "INSERT INTO connections (id, name, host, port, database, username)
                 VALUES ('p1', 'prod', 'h', 5432, 'db', 'u')",
                [],
            )
            .unwrap();
        store.dashboard_save("d1", "Sales", Some("p1"), 0).unwrap();
        store.connection_delete("p1").unwrap();
        let all = store.dashboard_list().unwrap();
        assert_eq!(all[0].connection_id, None);
    }

    /// A v8 database (the MCP release) gets the tables and keeps its rows.
    #[test]
    fn upgrades_a_v8_database() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("v8.db");
        {
            let store = Store::open(&path).unwrap();
            store.setting_set("theme", &"dark").unwrap();
            store
                .conn
                .execute_batch(
                    "DROP TABLE dashboard_charts; DROP TABLE dashboards;
                     UPDATE meta SET value = '8' WHERE key = 'schema_version';",
                )
                .unwrap();
        }
        let store = Store::open(&path).unwrap();
        assert_eq!(
            store.setting_get::<String>("theme").unwrap().unwrap(),
            "dark"
        );
        store.dashboard_save("d1", "Sales", None, 0).unwrap();
        assert_eq!(store.dashboard_list().unwrap().len(), 1);
    }
}
