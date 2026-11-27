//! The explorer's metadata requests, answered from `sqlite_schema` and the
//! table-valued pragmas. Payload shapes are the PostgreSQL driver's, so the
//! UI renders them without knowing which engine it is talking to.
//!
//! Every name is bound as a parameter. The one place an identifier has to be
//! spliced (`"<schema>".sqlite_schema`) is checked against the open schemas
//! first and quoted.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use tuplenest_driver_api::{DriverError, ErrorCategory, MetadataRequest};

use crate::error::normalize;

type Res<T> = Result<T, Box<DriverError>>;

/// `main` and every attached database, in attach order. `temp` is left out:
/// it is per-connection scratch, not part of the file.
pub fn schemas(conn: &Connection) -> Res<Vec<String>> {
    let mut stmt = conn
        .prepare("SELECT name FROM pragma_database_list WHERE name <> 'temp' ORDER BY seq")
        .map_err(normalize)?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(normalize)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(normalize)?;
    Ok(rows)
}

fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// `"<schema>"`, once it is known to be an open schema.
fn schema_ident(conn: &Connection, schema: &str) -> Res<String> {
    let open: bool = conn
        .query_row(
            "SELECT EXISTS (SELECT 1 FROM pragma_database_list WHERE name = ?1)",
            [schema],
            |r| r.get(0),
        )
        .map_err(normalize)?;
    if !open {
        return Err(DriverError::new(
            ErrorCategory::SchemaMissing,
            format!("No database named {schema} is open on this connection"),
        )
        .into());
    }
    Ok(quote_ident(schema))
}

/// One table's `pragma_table_list` row: (type, without_rowid, strict).
fn table_kind(conn: &Connection, schema: &str, name: &str) -> Res<Option<(String, bool, bool)>> {
    conn.query_row(
        "SELECT type, wr, strict FROM pragma_table_list WHERE schema = ?1 AND name = ?2",
        params![schema, name],
        |r| {
            Ok((
                r.get(0)?,
                r.get::<_, i64>(1)? != 0,
                r.get::<_, i64>(2)? != 0,
            ))
        },
    )
    .optional()
    .map_err(normalize)
}

fn object_sql(conn: &Connection, schema: &str, name: &str) -> Res<Option<String>> {
    let ident = schema_ident(conn, schema)?;
    conn.query_row(
        &format!("SELECT sql FROM {ident}.sqlite_schema WHERE name = ?1"),
        [name],
        |r| r.get::<_, Option<String>>(0),
    )
    .optional()
    .map(Option::flatten)
    .map_err(normalize)
}

fn list_objects(conn: &Connection, schema: &str) -> Res<Value> {
    let mut stmt = conn
        .prepare(
            "SELECT name, type FROM pragma_table_list
             WHERE schema = ?1 AND type IN ('table', 'view', 'virtual')
               AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
             ORDER BY name",
        )
        .map_err(normalize)?;
    let rows = stmt
        .query_map([schema], |r| {
            let kind: String = r.get(1)?;
            Ok(json!({
                "name": r.get::<_, String>(0)?,
                "kind": if kind == "view" { "view" } else { "table" },
                "comment": Value::Null,
                "isPartitioned": false,
                "partitionCount": 0,
            }))
        })
        .map_err(normalize)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(normalize)?;
    Ok(Value::Array(rows))
}

/// The name a rowid table's implicit key answers to in a query: `rowid`,
/// unless a real column took that name (then `_rowid_`, then `oid`).
fn rowid_alias(columns: &[Value]) -> Option<&'static str> {
    ["rowid", "_rowid_", "oid"].into_iter().find(|alias| {
        !columns.iter().any(|c| {
            c["name"]
                .as_str()
                .is_some_and(|n| n.eq_ignore_ascii_case(alias))
        })
    })
}

fn describe(conn: &Connection, schema: &str, name: &str) -> Res<Value> {
    let mut stmt = conn
        .prepare(
            "SELECT name, type, \"notnull\", pk, hidden
             FROM pragma_table_xinfo(?1, ?2) WHERE hidden <> 1 ORDER BY cid",
        )
        .map_err(normalize)?;
    let mut columns: Vec<Value> = stmt
        .query_map(params![name, schema], |r| {
            Ok(json!({
                "name": r.get::<_, String>(0)?,
                "dbType": r.get::<_, String>(1)?,
                "nullable": r.get::<_, i64>(2)? == 0,
                "primaryKey": r.get::<_, i64>(3)? > 0,
                "comment": Value::Null,
                // 2 and 3: VIRTUAL and STORED generated columns. SQLite
                // refuses an UPDATE of either, so neither is offered.
                "generated": r.get::<_, i64>(4)? >= 2,
            }))
        })
        .map_err(normalize)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(normalize)?;
    if columns.is_empty() {
        return Err(DriverError::new(
            ErrorCategory::Configuration,
            format!("Relation {schema}.{name} not found"),
        )
        .into());
    }
    /*
     * A rowid table with no declared key still has one: its rowid. Reported
     * as a key column the server computes, so the grid can edit rows of
     * `SELECT rowid, * FROM t` by it (and says to add it otherwise), and
     * never offers the rowid itself for editing. A WITHOUT ROWID table
     * always has a declared PRIMARY KEY, and a view has neither.
     */
    let has_key = columns.iter().any(|c| c["primaryKey"] == true);
    if let Some(("table", false, _)) = table_kind(conn, schema, name)?
        .as_ref()
        .map(|(t, wr, s)| (t.as_str(), *wr, *s))
    {
        if !has_key {
            if let Some(alias) = rowid_alias(&columns) {
                columns.insert(
                    0,
                    json!({
                        "name": alias,
                        "dbType": "INTEGER",
                        "nullable": false,
                        "primaryKey": true,
                        "comment": "implicit rowid",
                        "generated": true,
                    }),
                );
            }
        }
    }
    let indexes = index_rows(conn, schema, name)?
        .into_iter()
        .map(|i| json!({"name": i["name"], "def": i["definition"]}))
        .collect::<Vec<_>>();
    Ok(json!({
        "columns": columns,
        "indexes": indexes,
        "rowsEstimate": Value::Null,
        "totalSize": Value::Null,
        "comment": Value::Null,
    }))
}

fn index_rows(conn: &Connection, schema: &str, table: &str) -> Res<Vec<Value>> {
    let mut stmt = conn
        .prepare(
            "SELECT name, \"unique\", origin FROM pragma_index_list(?1, ?2) ORDER BY origin = 'pk' DESC, name",
        )
        .map_err(normalize)?;
    let found: Vec<(String, bool, String)> = stmt
        .query_map(params![table, schema], |r| {
            Ok((r.get(0)?, r.get::<_, i64>(1)? != 0, r.get(2)?))
        })
        .map_err(normalize)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(normalize)?;
    let mut out = Vec::with_capacity(found.len());
    for (name, unique, origin) in found {
        // An automatic index (for a PRIMARY KEY or UNIQUE clause) has no SQL
        // of its own: say what made it.
        let definition =
            object_sql(conn, schema, &name)?.unwrap_or_else(|| match origin.as_str() {
                "pk" => format!("PRIMARY KEY of {table} (automatic)"),
                "u" => format!("UNIQUE constraint of {table} (automatic)"),
                _ => format!("index on {table}"),
            });
        out.push(json!({
            "name": name,
            "definition": definition,
            "isUnique": unique,
            "isPrimary": origin == "pk",
            // Size and usage counters are PostgreSQL statistics SQLite does
            // not keep; null rather than a zero that reads as "never used".
            "bytes": Value::Null,
            "scans": Value::Null,
            "isValid": true,
        }));
    }
    Ok(out)
}

fn foreign_keys(
    conn: &Connection,
    schema: &str,
    table: &str,
) -> Res<Vec<(i64, String, String, String)>> {
    let mut stmt = conn
        .prepare(
            "SELECT id, \"table\", \"from\", \"to\" FROM pragma_foreign_key_list(?1, ?2) ORDER BY id, seq",
        )
        .map_err(normalize)?;
    let rows = stmt
        .query_map(params![table, schema], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get::<_, Option<String>>(3)?.unwrap_or_default(),
            ))
        })
        .map_err(normalize)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(normalize)?;
    Ok(rows)
}

fn constraints(conn: &Connection, schema: &str, table: &str) -> Res<Value> {
    let mut out = Vec::new();
    let pk: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT name FROM pragma_table_info(?1, ?2) WHERE pk > 0 ORDER BY pk")
            .map_err(normalize)?;
        let rows = stmt
            .query_map(params![table, schema], |r| r.get(0))
            .map_err(normalize)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(normalize)?;
        rows
    };
    if !pk.is_empty() {
        out.push(json!({
            "name": format!("{table}_pkey"),
            "kind": "primary key",
            "definition": format!("PRIMARY KEY ({})", pk.join(", ")),
            "isValid": true,
        }));
    }
    let fks = foreign_keys(conn, schema, table)?;
    let mut ids: Vec<i64> = fks.iter().map(|f| f.0).collect();
    ids.dedup();
    for id in ids {
        let parts: Vec<_> = fks.iter().filter(|f| f.0 == id).collect();
        let from: Vec<&str> = parts.iter().map(|f| f.2.as_str()).collect();
        let to: Vec<&str> = parts.iter().map(|f| f.3.as_str()).collect();
        out.push(json!({
            "name": format!("{table}_fk_{id}"),
            "kind": "foreign key",
            "definition": format!(
                "FOREIGN KEY ({}) REFERENCES {}({})",
                from.join(", "),
                parts[0].1,
                to.join(", ")
            ),
            "isValid": true,
        }));
    }
    for idx in index_rows(conn, schema, table)? {
        if idx["isUnique"] == true && idx["isPrimary"] != true {
            out.push(json!({
                "name": idx["name"],
                "kind": "unique",
                "definition": idx["definition"],
                "isValid": true,
            }));
        }
    }
    Ok(Value::Array(out))
}

fn table_names(conn: &Connection, schema: &str) -> Res<Vec<String>> {
    let mut stmt = conn
        .prepare(
            "SELECT name FROM pragma_table_list WHERE schema = ?1 AND type = 'table'
               AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
        )
        .map_err(normalize)?;
    let rows = stmt
        .query_map([schema], |r| r.get(0))
        .map_err(normalize)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(normalize)?;
    Ok(rows)
}

fn relationships(conn: &Connection, schema: &str) -> Res<Value> {
    let mut out = Vec::new();
    for table in table_names(conn, schema)? {
        let fks = foreign_keys(conn, schema, &table)?;
        let mut seen = Vec::new();
        for (id, target, _, _) in fks {
            if seen.contains(&id) {
                continue;
            }
            seen.push(id);
            out.push(json!({"name": format!("{table}_fk_{id}"), "from": table, "to": target}));
        }
    }
    Ok(Value::Array(out))
}

fn search(conn: &Connection, term: &str, limit: i64) -> Res<Value> {
    let pat = format!(
        "%{}%",
        term.replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    );
    let mut items = Vec::new();
    for schema in schemas(conn)? {
        let mut stmt = conn
            .prepare(
                "SELECT t.name, CASE t.type WHEN 'view' THEN 'view' ELSE 'table' END, NULL
                 FROM pragma_table_list t
                 WHERE t.schema = ?1 AND t.type IN ('table','view','virtual')
                   AND t.name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
                   AND t.name LIKE ?2 ESCAPE '\\'
                 UNION ALL
                 SELECT t.name, 'column', c.name
                 FROM pragma_table_list t, pragma_table_info(t.name, t.schema) c
                 WHERE t.schema = ?1 AND t.type IN ('table','view')
                   AND t.name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
                   AND c.name LIKE ?2 ESCAPE '\\'
                 ORDER BY 2, 1 LIMIT ?3",
            )
            .map_err(normalize)?;
        let rows = stmt
            .query_map(params![schema, pat, limit], |r| {
                Ok(json!({
                    "schema": schema,
                    "name": r.get::<_, String>(0)?,
                    "kind": r.get::<_, String>(1)?,
                    "column": r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                }))
            })
            .map_err(normalize)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(normalize)?;
        items.extend(rows);
    }
    let truncated = items.len() as i64 >= limit;
    items.truncate(limit.max(0) as usize);
    Ok(json!({ "items": items, "truncated": truncated }))
}

fn details(conn: &Connection, schema: &str, name: &str, kind: &str) -> Res<Value> {
    let sql = object_sql(conn, schema, name)?;
    let mut about = vec![("Database", schema.to_string())];
    if let Some((t, wr, strict)) = table_kind(conn, schema, name)? {
        about.push(("Type", t));
        if wr {
            about.push(("Storage", "WITHOUT ROWID".into()));
        }
        if strict {
            about.push(("Typing", "STRICT".into()));
        }
    }
    let rows = |pairs: Vec<(&str, String)>| {
        pairs
            .into_iter()
            .filter(|(_, v)| !v.is_empty())
            .map(|(k, v)| json!({"k": k, "v": v}))
            .collect::<Vec<_>>()
    };
    let mut sections = vec![json!({"label": "About", "rows": rows(about)})];
    if let Some(sql) = sql {
        sections.push(json!({"label": "Definition", "rows": rows(vec![("SQL", sql)])}));
    }
    Ok(json!({ "title": name, "kind": kind, "sections": sections }))
}

/// Not something SQLite has: say so, rather than answer with an empty panel
/// that reads as "nothing to report". The app hides these for SQLite.
fn unsupported(what: &str) -> Box<DriverError> {
    DriverError::new(
        ErrorCategory::Unsupported,
        format!("{what} is a PostgreSQL feature; SQLite has no equivalent"),
    )
    .into()
}

pub fn answer(conn: &Connection, path: &str, request: MetadataRequest) -> Res<Value> {
    Ok(match request {
        MetadataRequest::ServerInfo => {
            let version: String = conn
                .query_row("SELECT sqlite_version()", [], |r| r.get(0))
                .map_err(normalize)?;
            json!({ "version": format!("SQLite {version}"), "database": path })
        }
        MetadataRequest::ListSchemas => json!(schemas(conn)?),
        MetadataRequest::ListObjects { schema } => list_objects(conn, &schema)?,
        MetadataRequest::DescribeObject { schema, name } => describe(conn, &schema, &name)?,
        MetadataRequest::ListIndexes { schema, table } => {
            Value::Array(index_rows(conn, &schema, &table)?)
        }
        MetadataRequest::ListConstraints { schema, table } => constraints(conn, &schema, &table)?,
        MetadataRequest::Relationships { schema } => relationships(conn, &schema)?,
        MetadataRequest::ObjectDetails {
            schema,
            name,
            object_kind,
        } => details(conn, &schema, &name, &object_kind)?,
        MetadataRequest::SearchObjects { term, limit } => search(conn, &term, limit)?,
        // SQLite has no partitions, user-defined types or stored routines:
        // the honest answer is an empty list.
        MetadataRequest::ListPartitions { .. }
        | MetadataRequest::ListTypes { .. }
        | MetadataRequest::ListRoutines { .. } => json!([]),
        MetadataRequest::ServerActivity => return Err(unsupported("The server monitor")),
        MetadataRequest::IndexHealth { .. } | MetadataRequest::TableHealth { .. } => {
            return Err(unsupported("Health statistics (pg_stat)"))
        }
        MetadataRequest::TopQueries { .. } => return Err(unsupported("pg_stat_statements")),
        MetadataRequest::PartitionOverview { .. } => return Err(unsupported("Partitioning")),
    })
}
