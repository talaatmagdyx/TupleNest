import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import {
  coerceParam,
  ENV_COLORS,
  rowCountNote,
  envMeta,
  fetchAllRows,
  formatSQL,
  looksLikeSelect,
  needsGuard,
  guardReason,
  firstKeyword,
  paramCount,
  toCSV,
  toJSONExport,
  toMarkdown,
  tokenizeSQL,
  toggleLineComment,
  findMatches,
  replaceMatch,
  replaceAllMatches,
} from "./sql";

const invokeMock = vi.mocked(invoke);
beforeEach(() => invokeMock.mockReset());

const cols = [{ name: "id" }, { name: "name" }];

describe("tokenizeSQL", () => {
  const cls = (sql: string) =>
    render(<>{tokenizeSQL(sql)}</>).container.querySelectorAll("span");

  it("marks keywords", () => {
    const spans = cls("select 1");
    expect(spans[0]).toHaveClass("tok-k");
    expect(spans[0]).toHaveTextContent("select");
  });

  it("marks comments", () => {
    expect(cls("-- hi")[0]).toHaveClass("tok-c");
  });

  it("marks strings, including an escaped quote", () => {
    const spans = cls("'it''s'");
    expect(spans[0]).toHaveClass("tok-s");
    expect(spans[0]).toHaveTextContent("it''s");
  });

  it("marks numbers, integer and decimal", () => {
    expect(cls("1")[0]).toHaveClass("tok-n");
    expect(cls("1.5")[0]).toHaveClass("tok-n");
  });

  it("keeps the text between tokens", () => {
    render(<>{tokenizeSQL("select foo from t")}</>);
    expect(screen.getByText(/foo/)).toBeInTheDocument();
  });

  it("emits plain text when nothing matches", () => {
    const { container } = render(<>{tokenizeSQL("zzz")}</>);
    expect(container.querySelectorAll("span")).toHaveLength(0);
    expect(container.textContent).toBe("zzz\n");
  });

  it("terminates every line with a newline so rows align with the gutter", () => {
    const { container } = render(<>{tokenizeSQL("select")}</>);
    expect(container.textContent?.endsWith("\n")).toBe(true);
  });

  it("handles an empty string", () => {
    const { container } = render(<>{tokenizeSQL("")}</>);
    expect(container.textContent).toBe("\n");
  });

  it("is case-insensitive on keywords", () => {
    expect(cls("SELECT")[0]).toHaveClass("tok-k");
  });

  it("does not leak lastIndex between calls", () => {
    // The module-level regex is `g`; reusing it directly would make the second
    // call start mid-string and silently drop the first token.
    expect(cls("select 1")).toHaveLength(2);
    expect(cls("select 1")).toHaveLength(2);
  });
});

describe("fetchAllRows", () => {
  it("returns nothing when there are no rows", async () => {
    expect(await fetchAllRows(0)).toEqual([]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("pages in 1000-row windows", async () => {
    invokeMock.mockResolvedValueOnce([[1]]).mockResolvedValueOnce([[2]]);
    await fetchAllRows(2000);
    expect(invokeMock).toHaveBeenNthCalledWith(1, "pg_rows", { offset: 0, limit: 1000 });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "pg_rows", { offset: 1000, limit: 1000 });
  });

  it("concatenates the pages in order", async () => {
    invokeMock.mockResolvedValueOnce([[1], [2]]).mockResolvedValueOnce([[3]]);
    expect(await fetchAllRows(2000)).toEqual([[1], [2], [3]]);
  });

  it("stops early on a short page rather than looping to the stated total", async () => {
    invokeMock.mockResolvedValueOnce([]);
    expect(await fetchAllRows(50_000)).toEqual([]);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("honours the cap so a huge result cannot exhaust memory", async () => {
    invokeMock.mockResolvedValue([[1]]);
    await fetchAllRows(10_000_000, 2000);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });
});

describe("toCSV", () => {
  it("writes a header and rows", () => {
    expect(toCSV(cols, [[1, "a"]])).toBe("id,name\n1,a");
  });

  it("quotes commas, quotes and newlines", () => {
    expect(toCSV([{ name: "a" }], [["x,y"]])).toContain('"x,y"');
    expect(toCSV([{ name: "a" }], [['say "hi"']])).toContain('"say ""hi"""');
    expect(toCSV([{ name: "a" }], [["l1\nl2"]])).toContain('"l1\nl2"');
  });

  it("quotes a header that needs it", () => {
    expect(toCSV([{ name: "a,b" }], [])).toBe('"a,b"');
  });

  describe("spreadsheet formula injection (FILE-01)", () => {
    const payloads = [
      '=HYPERLINK("http://evil","x")',
      "=cmd|'/c calc'!A1",
      "+SUM(1)",
      "-2+3",
      "@SUM(A1)",
      "\ttabbed",
      "\rcarriage",
    ];

    it("neutralizes every formula-leading value by default", () => {
      for (const p of payloads) {
        const out = toCSV([{ name: "c" }], [[p]]);
        const cell = out.split("\n")[1];
        // The value is prefixed with ' so a spreadsheet reads it as text. It may
        // then also be RFC-4180 quoted (e.g. the comma/tab cases).
        expect(cell.startsWith("'") || cell.startsWith('"\'')).toBe(true);
      }
    });

    it("neutralizes formula-leading COLUMN NAMES too", () => {
      expect(toCSV([{ name: "=danger" }], [])).toBe("'=danger");
    });

    it("leaves ordinary values, incl. negative numbers written as numbers, unquoted", () => {
      // A real negative numeric arrives as a JS number, stringified to "-5" —
      // still formula-leading as text, so it IS neutralized. Documenting the
      // trade-off: safety wins over pristine minus signs; raw mode is the escape.
      expect(toCSV([{ name: "c" }], [["hello"]]).split("\n")[1]).toBe("hello");
      expect(toCSV([{ name: "c" }], [[-5]]).split("\n")[1]).toBe("'-5");
    });

    it("raw mode preserves the exact bytes (opt-out)", () => {
      expect(toCSV([{ name: "c" }], [["=BAD()"]], "raw").split("\n")[1]).toBe("=BAD()");
    });

    it("neutralizes THEN quotes, so a comma-bearing formula is both safe and valid", () => {
      // =A1,B1 : leading = must be neutralized AND the comma must be quoted.
      const cell = toCSV([{ name: "c" }], [["=A1,B1"]]).split("\n")[1];
      expect(cell).toBe("\"'=A1,B1\"");
    });
  });

  it("renders null and undefined as empty, not as the word null", () => {
    expect(toCSV(cols, [[null, undefined]])).toBe("id,name\n,");
  });

  it("serialises objects as JSON", () => {
    expect(toCSV([{ name: "j" }], [[{ a: 1 }]])).toBe('j\n"{""a"":1}"');
  });
});

describe("toJSONExport", () => {
  it("maps columns onto keys", () => {
    expect(JSON.parse(toJSONExport(cols, [[1, "a"]]))).toEqual([{ id: 1, name: "a" }]);
  });

  it("uses null for a missing cell", () => {
    expect(JSON.parse(toJSONExport(cols, [[1]]))).toEqual([{ id: 1, name: null }]);
  });

  it("emits an empty array for no rows", () => {
    expect(toJSONExport(cols, [])).toBe("[]");
  });
});

describe("toMarkdown", () => {
  it("writes a header and separator", () => {
    expect(toMarkdown(cols, [[1, "a"]])).toBe("| id | name |\n| --- | --- |\n| 1 | a |");
  });

  it("escapes pipes so one cell cannot forge a column", () => {
    expect(toMarkdown([{ name: "a" }], [["x|y"]])).toContain("x\\|y");
  });

  it("truncates at 1000 rows", () => {
    const rows = Array.from({ length: 1200 }, (_, i) => [i]);
    expect(toMarkdown([{ name: "n" }], rows).split("\n")).toHaveLength(1002);
  });
});

describe("needsGuard", () => {
  it("fires on prod UPDATE/DELETE with no WHERE", () => {
    expect(needsGuard("update t set a=1", "prod")).toBe(true);
    expect(needsGuard("delete from t", "prod")).toBe(true);
  });

  it("stays quiet when a WHERE is present", () => {
    expect(needsGuard("update t set a=1 where id=2", "prod")).toBe(false);
  });

  it("guards staging as well as prod — that is where prod restores get rehearsed", () => {
    expect(needsGuard("delete from t", "staging")).toBe(true);
  });

  it("stays quiet where nothing is at stake", () => {
    for (const env of ["dev", "test", null]) {
      expect(needsGuard("delete from t", env)).toBe(false);
    }
  });

  it("ignores leading whitespace and case", () => {
    expect(needsGuard("   DELETE FROM t", "prod")).toBe(true);
  });

  it("does not fire on a SELECT", () => {
    expect(needsGuard("select * from t", "prod")).toBe(false);
  });

  /*
   * Every case below defeated the previous implementation, which tested the raw
   * text: `\bwhere\b` matched inside a comment or a string, and `^\s*` did not
   * skip a leading comment. Each one is a false *negative* — the dangerous
   * statement ran with no warning — which is the only direction that matters.
   */
  describe("adversarial corpus — each of these once slipped through", () => {
    const mustGuard: [string, string][] = [
      ["commented-out WHERE", "DELETE FROM users -- where"],
      ["block-commented WHERE", "DELETE FROM users /* where */"],
      ["WHERE inside a string literal", "UPDATE t SET a='where'"],
      ["WHERE inside a dollar-quoted string", "UPDATE t SET a=$$where$$"],
      ["WHERE inside a tagged dollar-quote", "UPDATE t SET a=$x$where$x$"],
      ["leading line comment hiding the verb", "-- audit\nDELETE FROM users"],
      ["leading block comment hiding the verb", "/*x*/DELETE FROM users"],
      ["CTE-led DELETE", "WITH x AS (SELECT 1) DELETE FROM users"],
      ["CTE-led UPDATE", "WITH x AS (SELECT 1) UPDATE users SET a=1"],
      ["TRUNCATE", "TRUNCATE users"],
      ["DROP TABLE", "DROP TABLE users"],
      ["ALTER TABLE", "ALTER TABLE users DROP COLUMN a"],
      ["GRANT", "GRANT ALL ON users TO public"],
    ];
    for (const [name, sql] of mustGuard) {
      it(`guards: ${name}`, () => {
        expect(needsGuard(sql, "prod")).toBe(true);
      });
    }

    // The mirror image: a real WHERE must still be recognised through the same
    // masking, or the guard cries wolf and gets clicked through on reflex.
    const mustNotGuard: [string, string][] = [
      ["real WHERE after a comment", "UPDATE t SET a=1 -- note\nWHERE id=1"],
      ["real WHERE with a string containing 'where'", "UPDATE t SET a='where' WHERE id=1"],
      ["real WHERE after a block comment", "DELETE FROM t /* note */ WHERE id=1"],
      ["SELECT with no WHERE", "SELECT * FROM t"],
      ["INSERT", "INSERT INTO t VALUES (1)"],
      ["CTE-led SELECT", "WITH x AS (SELECT 1) SELECT * FROM x"],
    ];
    for (const [name, sql] of mustNotGuard) {
      it(`allows: ${name}`, () => {
        expect(needsGuard(sql, "prod")).toBe(false);
      });
    }
  });

  it("explains itself, so the dialog can say why", () => {
    expect(guardReason("delete from t", "prod")).toEqual({
      verb: "DELETE",
      why: expect.stringContaining("every row"),
    });
    expect(guardReason("drop table t", "prod")).toEqual({
      verb: "DROP",
      why: expect.stringContaining("database objects"),
    });
    expect(guardReason("select 1", "prod")).toBeNull();
  });
});

describe("firstKeyword", () => {
  it("sees past comments to the real verb", () => {
    expect(firstKeyword("-- x\n/* y */ delete from t")).toBe("delete");
  });

  it("is null for a statement with no keyword", () => {
    expect(firstKeyword("   -- just a comment")).toBeNull();
  });
});

describe("formatSQL", () => {
  it("uppercases keywords", () => {
    expect(formatSQL("select a from t")).toContain("SELECT");
  });

  it("breaks before major clauses", () => {
    expect(formatSQL("select a from t where b=1")).toBe("SELECT a\nFROM t\nWHERE b=1");
  });

  it("indents AND/OR under their clause", () => {
    expect(formatSQL("select a from t where b=1 and c=2")).toContain("\n  AND c=2");
  });

  it("trims trailing whitespace on every line", () => {
    expect(formatSQL("select a   \nfrom t")).not.toMatch(/[ \t]\n/);
  });

  it("leaves an empty string empty", () => {
    expect(formatSQL("")).toBe("");
  });
});

describe("looksLikeSelect", () => {
  it.each(["select 1", "  WITH x as (select 1) select * from x", "values (1)", "table t"])(
    "accepts %s",
    (s) => expect(looksLikeSelect(s)).toBe(true),
  );

  it.each(["insert into t values (1)", "update t set a=1", "delete from t", ""])(
    "rejects %s",
    (s) => expect(looksLikeSelect(s)).toBe(false),
  );
});

describe("paramCount", () => {
  it("counts nothing when there are no placeholders", () => {
    expect(paramCount("select 1")).toBe(0);
  });

  it("returns the highest placeholder, not the count", () => {
    // $1 unused but $3 present → the backend still needs three params.
    expect(paramCount("select $3, $2")).toBe(3);
  });

  it("ignores a $n inside a string literal", () => {
    expect(paramCount("select 'costs $5'")).toBe(0);
  });

  it("ignores a $n inside a comment", () => {
    expect(paramCount("select 1 -- $9")).toBe(0);
  });

  it("handles multi-digit placeholders", () => {
    expect(paramCount("select $12")).toBe(12);
  });
});

describe("coerceParam", () => {
  it("maps empty and the word null to null", () => {
    expect(coerceParam("")).toBeNull();
    expect(coerceParam("  ")).toBeNull();
    expect(coerceParam("NULL")).toBeNull();
  });

  it("maps booleans", () => {
    expect(coerceParam("true")).toBe(true);
    expect(coerceParam("FALSE")).toBe(false);
  });

  it("maps integers and decimals, including negatives", () => {
    expect(coerceParam("42")).toBe(42);
    expect(coerceParam("-42")).toBe(-42);
    expect(coerceParam("1.5")).toBe(1.5);
    expect(coerceParam("-.5")).toBe(-0.5);
  });

  it("keeps anything else as the raw text, whitespace included", () => {
    expect(coerceParam(" hello ")).toBe(" hello ");
    expect(coerceParam("12abc")).toBe("12abc");
  });
});

describe("envMeta", () => {
  it("returns the colours for a known env", () => {
    expect(envMeta("prod")).toBe(ENV_COLORS.prod);
  });

  it("falls back to dev for null, undefined and unknown", () => {
    expect(envMeta(null)).toBe(ENV_COLORS.dev);
    expect(envMeta(undefined)).toBe(ENV_COLORS.dev);
    expect(envMeta("nonsense")).toBe(ENV_COLORS.dev);
  });
});

describe("rowCountNote", () => {
  const res = (over: { totalRows?: number; truncated?: boolean } = {}) => ({
    totalRows: 2,
    truncated: false,
    ...over,
  });

  it("states the count for a complete result", () => {
    expect(rowCountNote(2, res())).toBe("2 rows");
  });

  it("says what is missing when the result was truncated", () => {
    // The file on disk has no banner. If the count does not say it, nothing
    // does, and a 100k-row export of a 4M-row query reads as the whole answer.
    expect(rowCountNote(100_000, res({ totalRows: 4_213_662, truncated: true }))).toBe(
      "100,000 of 4,213,662 rows (truncated)",
    );
  });

  it("groups the digits, because 4213662 is unreadable", () => {
    expect(rowCountNote(1234, res({ totalRows: 1234 }))).toBe("1,234 rows");
  });

  it("does not cry truncation when everything was written anyway", () => {
    // The flag can be set while the export still got every row — claiming a
    // loss that did not happen sends people looking for missing data.
    expect(rowCountNote(50, res({ totalRows: 50, truncated: true }))).toBe("50 rows");
  });
});

describe("toggleLineComment", () => {
  /** Render the result with the selection marked, so a test failure shows
   *  where the caret ended up rather than only what the text became. */
  const show = (r: { sql: string; selectionStart: number; selectionEnd: number }) =>
    r.sql.slice(0, r.selectionStart) + "[" + r.sql.slice(r.selectionStart, r.selectionEnd) + "]" + r.sql.slice(r.selectionEnd);

  it("comments the line the caret sits on", () => {
    const r = toggleLineComment("select 1", 3, 3);
    expect(r.sql).toBe("-- select 1");
  });

  it("uncomments it again — pressing twice returns the original", () => {
    const once = toggleLineComment("select 1", 3, 3);
    const twice = toggleLineComment(once.sql, once.selectionStart, once.selectionEnd);
    expect(twice.sql).toBe("select 1");
  });

  it("comments every line the selection touches", () => {
    const sql = "select a\nfrom t\nwhere x";
    const r = toggleLineComment(sql, 0, sql.length);
    expect(r.sql).toBe("-- select a\n-- from t\n-- where x");
  });

  it("comments at the shallowest indent so the block keeps its shape", () => {
    const sql = "select a\n  from t\n    where x";
    const r = toggleLineComment(sql, 0, sql.length);
    expect(r.sql).toBe("-- select a\n--   from t\n--     where x");
  });

  it("comments a half-commented block rather than uncommenting part of it", () => {
    // Pressing twice from here must give back exactly this, which only works
    // if the first press commits to one direction for the whole range.
    const sql = "-- select a\nfrom t";
    const r = toggleLineComment(sql, 0, sql.length);
    expect(r.sql).toBe("-- -- select a\n-- from t");
    const back = toggleLineComment(r.sql, r.selectionStart, r.selectionEnd);
    expect(back.sql).toBe(sql);
  });

  it("leaves blank lines blank instead of indenting them", () => {
    const sql = "select a\n\nfrom t";
    expect(toggleLineComment(sql, 0, sql.length).sql).toBe("-- select a\n\n-- from t");
  });

  it("does not swallow the line below when a whole line is selected", () => {
    // Dragging across one line ends the selection at the start of the next.
    const sql = "select a\nfrom t";
    const r = toggleLineComment(sql, 0, 9);
    expect(r.sql).toBe("-- select a\nfrom t");
  });

  it("keeps the selection over the same text", () => {
    const r = toggleLineComment("select a\nfrom t", 0, 15);
    expect(show(r)).toBe("[-- select a\n-- from t]");
  });

  it("removes only one comment marker per press", () => {
    expect(toggleLineComment("-- -- x", 0, 7).sql).toBe("-- x");
  });

  it("handles a comment with no space after the dashes", () => {
    expect(toggleLineComment("--select 1", 0, 10).sql).toBe("select 1");
  });
});

describe("toggleLineComment — where the selection ends up", () => {
  const show = (r: { sql: string; selectionStart: number; selectionEnd: number }) =>
    r.sql.slice(0, r.selectionStart) + "[" + r.sql.slice(r.selectionStart, r.selectionEnd) + "]" + r.sql.slice(r.selectionEnd);

  it("keeps a mid-line selection on the same characters", () => {
    // "a" in "select a" — the marker goes in front, so the offset moves with it.
    const r = toggleLineComment("select a", 7, 8);
    expect(show(r)).toBe("-- select [a]");
  });

  it("leaves a caret inside the text it was in", () => {
    const r = toggleLineComment("select a", 7, 7);
    expect(show(r)).toBe("-- select []a");
  });
});

describe("findMatches", () => {
  it("finds every occurrence", () => {
    expect(findMatches("a b a b a", "a")).toEqual([
      { start: 0, end: 1 },
      { start: 4, end: 5 },
      { start: 8, end: 9 },
    ]);
  });

  it("ignores case by default and respects it when asked", () => {
    expect(findMatches("Select select SELECT", "select")).toHaveLength(3);
    expect(findMatches("Select select SELECT", "select", true)).toHaveLength(1);
  });

  it("treats the needle as literal text, not a pattern", () => {
    // Every one of these is regex syntax; all of them are ordinary SQL.
    expect(findMatches("count(*)", "(*)")).toEqual([{ start: 5, end: 8 }]);
    expect(findMatches("a.b", ".")).toEqual([{ start: 1, end: 2 }]);
    expect(findMatches("$1 = $2", "$1")).toEqual([{ start: 0, end: 2 }]);
  });

  it("returns nothing for an empty needle rather than a match per character", () => {
    expect(findMatches("select 1", "")).toEqual([]);
  });

  it("does not return overlapping matches", () => {
    expect(findMatches("aaa", "aa")).toEqual([{ start: 0, end: 2 }]);
  });
});

describe("replaceMatch / replaceAllMatches", () => {
  it("replaces one and selects what it wrote", () => {
    const r = replaceMatch("select a from t", { start: 7, end: 8 }, "b");
    expect(r.sql).toBe("select b from t");
    expect(r.sql.slice(r.selectionStart, r.selectionEnd)).toBe("b");
  });

  it("replaces all, including when the replacement is shorter", () => {
    // The right-to-left pass matters here: left to right, the second match's
    // offsets would be stale by the length difference.
    expect(replaceAllMatches("aaa bbb aaa", "aaa", "x")).toBe("x bbb x");
    expect(replaceAllMatches("x y x", "x", "longer")).toBe("longer y longer");
  });

  it("replaces case-insensitively but writes the replacement as given", () => {
    expect(replaceAllMatches("Select SELECT", "select", "pick")).toBe("pick pick");
  });

  it("leaves the text alone when nothing matches", () => {
    expect(replaceAllMatches("select 1", "zzz", "x")).toBe("select 1");
  });
});
