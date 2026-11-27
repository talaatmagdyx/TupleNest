import { describe, expect, it } from "vitest";
import { analyzeEditability, buildDelete, buildUpdate } from "./dml";
import type { Catalog } from "./complete";
import { guardReason, maskBracketQuotes } from "./sql";

const col = (name: string, dbType: string, primaryKey = false, generated = false) => ({
  name,
  dbType,
  nullable: !primaryKey,
  primaryKey,
  comment: null,
  generated,
});

/* What the SQLite driver reports: `logs` has no declared key, so its rowid is
   the key (computed, so never offered for editing); `kv` is WITHOUT ROWID. */
const cat: Catalog = {
  engine: "sqlite",
  schemas: ["main"],
  tables: [
    { schema: "main", name: "users", kind: "table" },
    { schema: "main", name: "logs", kind: "table" },
    { schema: "main", name: "v", kind: "view" },
  ],
  columns: {
    "main.users": [col("id", "INTEGER", true), col("email", "TEXT"), col("meta", "JSON")],
    "main.logs": [col("rowid", "INTEGER", true, true), col("msg", "TEXT")],
    "main.v": [col("email", "TEXT")],
  },
  searchPath: ["main"],
};

const grid = (...cols: [string, string][]) => cols.map(([name, dbType]) => ({ name, dbType }));

describe("row editing on SQLite", () => {
  it("edits by the INTEGER PRIMARY KEY, in SQLite's dialect", () => {
    const e = analyzeEditability("select * from users", grid(["id", "INTEGER"], ["email", "TEXT"], ["meta", "JSON"]), cat);
    expect(e.editable).toBe(true);
    if (!e.editable) return;
    expect(e.target.engine).toBe("sqlite");
    const st = buildUpdate(e.target, [7], [
      { column: "email", value: "b@example.com", oldValue: "a@example.com" },
      { column: "meta", value: "{}", oldValue: null },
    ]);
    // No `::` casts, no `::jsonb`, no to_regclass: none of them is SQLite.
    expect(st.sql).not.toContain("::");
    expect(st.sql).not.toContain("to_regclass");
    expect(st.sql).toBe(
      `UPDATE "main"."users" SET "email" = $1, "meta" = $2 WHERE "id" = $3 AND "email" IS NOT DISTINCT FROM $4` +
        ` AND "meta" IS NOT DISTINCT FROM $5` +
        ` AND NOT EXISTS (SELECT 1 FROM temp.sqlite_schema WHERE type IN ('table', 'view') AND name = $6 COLLATE NOCASE)`,
    );
    expect(st.params).toEqual(["b@example.com", "{}", 7, "a@example.com", null, "users"]);
  });

  it("a table with no declared key is edited by its rowid, once the rowid is in the result", () => {
    const without = analyzeEditability("select * from logs", grid(["msg", "TEXT"]), cat);
    expect(without).toEqual({ editable: false, reason: "add the primary key (rowid) to the result to edit it" });

    const e = analyzeEditability("select rowid, * from logs", grid(["rowid", "INTEGER"], ["msg", "TEXT"]), cat);
    expect(e.editable).toBe(true);
    if (!e.editable) return;
    // The rowid identifies the row and is never itself writable.
    expect(e.target.writable).toEqual([false, true]);
    expect(buildDelete(e.target, [3])).toEqual({ sql: `DELETE FROM "main"."logs" WHERE "rowid" = $1`, params: [3] });
  });

  it("a view is not editable", () => {
    const e = analyzeEditability("select email from v", grid(["email", "TEXT"]), cat);
    expect(e.editable).toBe(false);
  });

  it("a qualified name needs no shadowing test", () => {
    const e = analyzeEditability("select * from main.users", grid(["id", "INTEGER"], ["email", "TEXT"]), cat);
    if (!e.editable) throw new Error("editable");
    expect(buildUpdate(e.target, [1], [{ column: "email", value: "x", oldValue: "y" }]).sql).not.toContain("temp.");
  });
});

describe("the guard reads SQLite's identifier quotes", () => {
  it("blanks [name] and `name` and keeps their length", () => {
    const masked = maskBracketQuotes("DELETE FROM [where] x `a b` y");
    expect(masked).toBe("DELETE FROM [     ] x `   ` y");
    expect(maskBracketQuotes("UPDATE t SET a[1] = 0 WHERE id = 1")).toContain("WHERE id = 1");
    // Unclosed: blanked to the end, which can only hide a WHERE.
    expect(maskBracketQuotes("x [unclosed where")).toBe(`x [${" ".repeat("unclosed where".length)}`);
  });

  it("stops SQLite's destructive spellings on a guarded connection", () => {
    for (const sql of [
      "DELETE FROM [where]",
      "DELETE FROM `where`",
      "UPDATE [t] SET [where] = 1",
      "DROP TABLE IF EXISTS logs",
      "ALTER TABLE t DROP COLUMN x",
      "VACUUM",
      "UPDATE OR REPLACE t SET x = 1",
      "DELETE FROM main.t",
    ]) {
      expect(guardReason(sql, "prod"), sql).not.toBeNull();
    }
    for (const sql of [
      "DELETE FROM [orders] WHERE [id] = 1",
      "UPDATE `t` SET x = 1 WHERE `id` = 2",
      "INSERT OR REPLACE INTO t VALUES (1)",
      "EXPLAIN QUERY PLAN DELETE FROM t",
    ]) {
      expect(guardReason(sql, "prod"), sql).toBeNull();
    }
  });
});
