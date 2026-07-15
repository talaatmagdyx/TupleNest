import { describe, it, expect } from "vitest";
import {
  analyzeEditability,
  buildDelete,
  buildStatements,
  buildUpdate,
  coerceValue,
  previewSql,
  qualifiedName,
  quoteIdent,
  rowKey,
  type EditTarget,
} from "./dml";
import type { Catalog } from "./complete";

const col = (name: string, dbType: string, primaryKey = false) => ({
  name,
  dbType,
  nullable: !primaryKey,
  primaryKey,
  comment: null,
});

const cat: Catalog = {
  schemas: ["public", "analytics"],
  tables: [
    { schema: "public", name: "users", kind: "table" },
    { schema: "public", name: "logs", kind: "table" },
    { schema: "public", name: "combo", kind: "table" },
    { schema: "analytics", name: "daily_rollup", kind: "view" },
  ],
  columns: {
    "public.users": [col("id", "int8", true), col("email", "text"), col("age", "int4"), col("active", "bool")],
    "public.logs": [col("message", "text"), col("at", "timestamptz")], // no PK
    "public.combo": [col("a", "int4", true), col("b", "int4", true), col("note", "text")], // composite PK
    "analytics.daily_rollup": [col("day", "date", true), col("revenue", "numeric")],
  },
  searchPath: ["public"],
};

const gcols = (...names: string[]) =>
  names.map((n) => {
    const all = [...cat.columns["public.users"], ...cat.columns["public.combo"], ...cat.columns["public.logs"]];
    const f = all.find((c) => c.name === n);
    return { name: n, dbType: f?.dbType ?? "text" };
  });

const target: EditTarget = {
  schema: "public",
  table: "users",
  pk: [{ name: "id", index: 0 }],
  writable: [false, true, true, true],
};

describe("quoteIdent", () => {
  it("double-quotes plain identifiers", () => expect(quoteIdent("email")).toBe('"email"'));

  it("escapes embedded double quotes (injection via identifier)", () => {
    expect(quoteIdent('ev"il')).toBe('"ev""il"');
  });

  it("neutralises an identifier carrying SQL", () => {
    const q = quoteIdent('x"; drop table users; --');
    expect(q).toBe('"x""; drop table users; --"');
    expect(q.startsWith('"')).toBe(true);
    expect(q.endsWith('"')).toBe(true);
  });

  it("qualifies schema and table", () => expect(qualifiedName("public", "users")).toBe('"public"."users"'));
});

describe("coerceValue", () => {
  it("keeps digits as text in a text column", () => expect(coerceValue("123", "text")).toBe("123"));
  it("converts digits in an int column", () => expect(coerceValue("123", "int4")).toBe(123));
  it("converts decimals in a numeric column", () => expect(coerceValue("1.5", "numeric")).toBe(1.5));
  it("passes non-numeric text through for the server to reject", () =>
    expect(coerceValue("abc", "int4")).toBe("abc"));
  it("maps empty and 'null' to NULL", () => {
    expect(coerceValue("", "text")).toBeNull();
    expect(coerceValue("null", "text")).toBeNull();
    expect(coerceValue("NULL", "int4")).toBeNull();
  });
  it("parses booleans loosely", () => {
    expect(coerceValue("true", "bool")).toBe(true);
    expect(coerceValue("f", "boolean")).toBe(false);
    expect(coerceValue("1", "bool")).toBe(true);
  });
  it("leaves timestamps as text", () =>
    expect(coerceValue("2024-01-01 10:00", "timestamptz")).toBe("2024-01-01 10:00"));
});

describe("analyzeEditability — allowed", () => {
  it("accepts a single-table select including the pk", () => {
    const r = analyzeEditability("select id, email from users", gcols("id", "email"), cat);
    expect(r.editable).toBe(true);
    if (r.editable) {
      expect(r.target.table).toBe("users");
      expect(r.target.schema).toBe("public");
      expect(r.target.pk).toEqual([{ name: "id", index: 0 }]);
    }
  });

  it("marks the pk column non-writable and others writable", () => {
    const r = analyzeEditability("select id, email from users", gcols("id", "email"), cat);
    if (!r.editable) throw new Error(r.reason);
    expect(r.target.writable).toEqual([false, true]);
  });

  it("handles a composite primary key", () => {
    const r = analyzeEditability("select a, b, note from combo", gcols("a", "b", "note"), cat);
    if (!r.editable) throw new Error(r.reason);
    expect(r.target.pk).toEqual([
      { name: "a", index: 0 },
      { name: "b", index: 1 },
    ]);
    expect(r.target.writable).toEqual([false, false, true]);
  });

  it("finds the pk wherever it sits in the select list", () => {
    const r = analyzeEditability("select email, id from users", gcols("email", "id"), cat);
    if (!r.editable) throw new Error(r.reason);
    expect(r.target.pk).toEqual([{ name: "id", index: 1 }]);
  });

  it("accepts an aliased table", () => {
    expect(analyzeEditability("select u.id, u.email from users u", gcols("id", "email"), cat).editable).toBe(true);
  });

  it("marks a computed column non-writable", () => {
    const cols = [...gcols("id", "email"), { name: "upper_email", dbType: "text" }];
    const r = analyzeEditability("select id, email, upper(email) as upper_email from users", cols, cat);
    if (!r.editable) throw new Error(r.reason);
    expect(r.target.writable).toEqual([false, true, false]);
  });
});

describe("analyzeEditability — refused", () => {
  const reason = (sql: string, cols = gcols("id", "email")) => {
    const r = analyzeEditability(sql, cols, cat);
    return r.editable ? null : r.reason;
  };

  it("refuses without a catalog", () => {
    const r = analyzeEditability("select id from users", gcols("id"), undefined);
    expect(r.editable).toBe(false);
  });

  it("refuses joins", () => expect(reason("select id, email from users u join logs l on 1=1")).toMatch(/join/i));
  it("refuses group by", () => expect(reason("select id, email from users group by id, email")).toMatch(/group/i));
  it("refuses distinct", () => expect(reason("select distinct id, email from users")).toMatch(/DISTINCT/i));
  it("refuses union", () => expect(reason("select id, email from users union select id, email from users")).toMatch(/combine/i));
  it("refuses CTEs", () => expect(reason("with x as (select 1) select id, email from users")).toMatch(/CTE/i));
  it("refuses non-select statements", () =>
    expect(reason("update users set email = 'x'")).toMatch(/only SELECT/i));

  it("refuses a table with no primary key", () => {
    expect(reason("select message, at from logs", gcols("message", "at"))).toMatch(/no primary key/i);
  });

  it("refuses a view", () => {
    const r = analyzeEditability("select day, revenue from analytics.daily_rollup", [
      { name: "day", dbType: "date" },
      { name: "revenue", dbType: "numeric" },
    ], cat);
    expect(r.editable).toBe(false);
    if (!r.editable) expect(r.reason).toMatch(/view/i);
  });

  it("refuses when the pk is not in the result", () => {
    expect(reason("select email from users", gcols("email"))).toMatch(/primary key/i);
  });

  it("refuses duplicate column names", () => {
    expect(reason("select id, id from users", [
      { name: "id", dbType: "int8" },
      { name: "id", dbType: "int8" },
    ])).toMatch(/duplicate/i);
  });

  it("refuses when the table's columns are not loaded", () => {
    const bare: Catalog = { ...cat, columns: {} };
    const r = analyzeEditability("select id, email from users", gcols("id", "email"), bare);
    expect(r.editable).toBe(false);
    if (!r.editable) expect(r.reason).toMatch(/not loaded/i);
  });
});

describe("buildUpdate", () => {
  it("builds a parameterised update", () => {
    const st = buildUpdate(target, [7], [{ column: "email", value: "a@b.c" }]);
    expect(st.sql).toBe('UPDATE "public"."users" SET "email" = $1 WHERE "id" = $2');
    expect(st.params).toEqual(["a@b.c", 7]);
  });

  it("sets several columns in one statement", () => {
    const st = buildUpdate(target, [7], [
      { column: "email", value: "a@b.c" },
      { column: "age", value: 30 },
    ]);
    expect(st.sql).toBe('UPDATE "public"."users" SET "email" = $1, "age" = $2 WHERE "id" = $3');
    expect(st.params).toEqual(["a@b.c", 30, 7]);
  });

  it("ANDs a composite key", () => {
    const t: EditTarget = {
      schema: "public",
      table: "combo",
      pk: [{ name: "a", index: 0 }, { name: "b", index: 1 }],
      writable: [false, false, true],
    };
    const st = buildUpdate(t, [1, 2], [{ column: "note", value: "hi" }]);
    expect(st.sql).toBe('UPDATE "public"."combo" SET "note" = $1 WHERE "a" = $2 AND "b" = $3');
    expect(st.params).toEqual(["hi", 1, 2]);
  });

  it("always emits a WHERE clause", () => {
    const st = buildUpdate(target, [1], [{ column: "email", value: "x" }]);
    expect(st.sql).toMatch(/\bWHERE\b/);
  });

  it("never interpolates values into the SQL text", () => {
    const st = buildUpdate(target, [1], [{ column: "email", value: "'; drop table users; --" }]);
    expect(st.sql).not.toContain("drop table");
    expect(st.params[0]).toBe("'; drop table users; --");
  });

  it("passes NULL through as a bound param", () => {
    const st = buildUpdate(target, [1], [{ column: "email", value: null }]);
    expect(st.sql).toBe('UPDATE "public"."users" SET "email" = $1 WHERE "id" = $2');
    expect(st.params).toEqual([null, 1]);
  });

  it("throws rather than emit an unbounded update", () => {
    expect(() => buildUpdate(target, [1], [])).toThrow(/no columns/i);
  });

  it("throws on a key arity mismatch", () => {
    expect(() => buildUpdate(target, [1, 2], [{ column: "email", value: "x" }])).toThrow(/mismatch/i);
  });
});

describe("buildDelete", () => {
  it("builds a keyed delete", () => {
    const st = buildDelete(target, [9]);
    expect(st.sql).toBe('DELETE FROM "public"."users" WHERE "id" = $1');
    expect(st.params).toEqual([9]);
  });

  it("throws on a key arity mismatch", () => expect(() => buildDelete(target, [])).toThrow(/mismatch/i));
});

describe("rowKey", () => {
  it("is stable for the same key values", () => expect(rowKey([1])).toBe(rowKey([1])));
  it("distinguishes different keys", () => expect(rowKey([1])).not.toBe(rowKey([2])));
  it("supports composite keys", () => expect(rowKey([1, 2])).not.toBe(rowKey([2, 1])));
  it("distinguishes a number from its string form", () => expect(rowKey([1])).not.toBe(rowKey(["1"])));
});

describe("buildStatements", () => {
  it("emits one UPDATE per row, merging that row's cells", () => {
    const sts = buildStatements(target, [
      { rowKey: rowKey([10]), pkValues: [10], column: "email", value: "a" },
      { rowKey: rowKey([10]), pkValues: [10], column: "age", value: 5 },
      { rowKey: rowKey([11]), pkValues: [11], column: "email", value: "b" },
    ]);
    expect(sts).toHaveLength(2);
    expect(sts[0].sql).toBe('UPDATE "public"."users" SET "email" = $1, "age" = $2 WHERE "id" = $3');
    expect(sts[0].params).toEqual(["a", 5, 10]);
    expect(sts[1].params).toEqual(["b", 11]);
  });

  // Regression: edits were once keyed by row index. Re-sorting the grid then
  // moved a pending value onto whatever row happened to land at that index —
  // the UPDATE still hit the right row, but the UI showed the change against
  // the wrong one.
  it("keys rows by primary key, not by position", () => {
    const sts = buildStatements(target, [
      { rowKey: rowKey([1]), pkValues: [1], column: "age", value: 37 },
      { rowKey: rowKey([2]), pkValues: [2], column: "age", value: 99 },
    ]);
    expect(sts).toHaveLength(2);
    const forAda = sts.find((s) => s.params[1] === 1);
    expect(forAda?.params).toEqual([37, 1]); // ada's 37 stays with ada
  });

  it("merges two edits to the same row even when staged far apart", () => {
    const sts = buildStatements(target, [
      { rowKey: rowKey([5]), pkValues: [5], column: "email", value: "x" },
      { rowKey: rowKey([9]), pkValues: [9], column: "email", value: "y" },
      { rowKey: rowKey([5]), pkValues: [5], column: "age", value: 1 },
    ]);
    expect(sts).toHaveLength(2);
    expect(sts[0].params).toEqual(["x", 1, 5]);
  });

  it("returns nothing for no edits", () => expect(buildStatements(target, [])).toEqual([]));
});

describe("previewSql", () => {
  it("substitutes literals for display", () => {
    const st = buildUpdate(target, [7], [{ column: "email", value: "a@b.c" }]);
    expect(previewSql(st)).toBe(`UPDATE "public"."users" SET "email" = 'a@b.c' WHERE "id" = 7`);
  });

  it("renders NULL and booleans unquoted", () => {
    const st = buildUpdate(target, [1], [
      { column: "email", value: null },
      { column: "active", value: true },
    ]);
    expect(previewSql(st)).toContain(`"email" = NULL`);
    expect(previewSql(st)).toContain(`"active" = true`);
  });

  it("escapes quotes in the preview", () => {
    const st = buildUpdate(target, [1], [{ column: "email", value: "o'brien" }]);
    expect(previewSql(st)).toContain(`'o''brien'`);
  });
});
