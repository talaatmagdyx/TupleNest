import { describe, expect, it } from "vitest";
import { classify, diffLines, isSqlBlock, splitAnswer } from "./answer";

describe("splitAnswer", () => {
  it("separates prose from fenced blocks", () => {
    const s = splitAnswer("Here you go:\n```sql\nselect 1;\n```\nThat reads one row.");
    expect(s).toEqual([
      { kind: "text", text: "Here you go:" },
      { kind: "code", lang: "sql", code: "select 1;" },
      { kind: "text", text: "That reads one row." },
    ]);
  });

  it("shows an unclosed block as code while it streams", () => {
    expect(splitAnswer("Try:\n```sql\nselect a,\n  b")).toEqual([
      { kind: "text", text: "Try:" },
      { kind: "code", lang: "sql", code: "select a,\n  b" },
    ]);
  });

  it("returns nothing for an empty answer and plain text alone", () => {
    expect(splitAnswer("")).toEqual([]);
    expect(splitAnswer("just words")).toEqual([{ kind: "text", text: "just words" }]);
  });
});

describe("isSqlBlock", () => {
  it("takes sql-tagged blocks and untagged statements, not shell", () => {
    expect(isSqlBlock({ lang: "sql", code: "x" })).toBe(true);
    expect(isSqlBlock({ lang: "postgresql", code: "x" })).toBe(true);
    expect(isSqlBlock({ lang: "pgsql", code: "x" })).toBe(true);
    expect(isSqlBlock({ lang: "", code: "SELECT 1" })).toBe(true);
    expect(isSqlBlock({ lang: "", code: "ollama pull llama3.2" })).toBe(false);
    expect(isSqlBlock({ lang: "", code: "" })).toBe(false);
    expect(isSqlBlock({ lang: "bash", code: "select" })).toBe(false);
  });
});

describe("classify", () => {
  it("calls a plain query read-only", () => {
    const c = classify("select * from orders", "prod");
    expect(c.kind).toBe("read");
    expect(c.label).toBe("Read-only");
    expect(c.note).toMatch(/Nothing runs until you press Run/);
  });

  it("treats EXPLAIN without ANALYZE and SHOW as reads", () => {
    expect(classify("explain select 1", null).kind).toBe("read");
    expect(classify("show work_mem", null).kind).toBe("read");
    expect(classify("explain analyze delete from t", null).kind).toBe("write");
  });

  it("calls a CTE that deletes a write, not a read", () => {
    expect(classify("with d as (delete from t returning *) select * from d", null).kind).toBe("write");
  });

  it("separates schema changes from row writes", () => {
    expect(classify("create index on orders (created_at)", null)).toMatchObject({ kind: "schema", label: "Changes the schema" });
    expect(classify("update t set a = 1 where id = 2", null)).toMatchObject({ kind: "write", label: "Writes data" });
  });

  it("says a guarded write still asks on PROD", () => {
    const c = classify("delete from users", "prod");
    expect(c.note).toMatch(/On PROD it still asks before it runs/);
    expect(classify("delete from users", "dev").note).toBe("This is a write. Nothing runs until you press Run.");
    expect(classify("drop table x", "staging").note).toMatch(/STAGING/);
  });
});

describe("diffLines", () => {
  it("marks the changed line only", () => {
    expect(diffLines("select\n  sum(o.totl)\nfrom o", "select\n  sum(o.total)\nfrom o")).toEqual([
      { op: "same", text: "select" },
      { op: "del", text: "  sum(o.totl)" },
      { op: "add", text: "  sum(o.total)" },
      { op: "same", text: "from o" },
    ]);
  });

  it("handles additions and removals at the ends", () => {
    expect(diffLines("a", "a\nb")).toEqual([
      { op: "same", text: "a" },
      { op: "add", text: "b" },
    ]);
    expect(diffLines("a\nb", "b")).toEqual([
      { op: "del", text: "a" },
      { op: "same", text: "b" },
    ]);
    expect(diffLines("a\nb\nc", "a")).toEqual([
      { op: "same", text: "a" },
      { op: "del", text: "b" },
      { op: "del", text: "c" },
    ]);
  });

  it("falls back to replace-all on huge inputs", () => {
    const big = Array.from({ length: 600 }, (_, i) => `l${i}`).join("\n");
    const out = diffLines(big, big + "\nx");
    expect(out.filter((d) => d.op === "del")).toHaveLength(600);
    expect(out.filter((d) => d.op === "add")).toHaveLength(601);
  });
});
