import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import {
  coerceParam,
  ENV_COLORS,
  rowCountNote,
  envMeta,
  formatSQL,
  hasWriteVerb,
  looksLikeSelect,
  needsGuard,
  guardReason,
  firstKeyword,
  paramCount,
  tokenizeLines,
  toggleLineComment,
  indentSelection,
  newlineIndent,
  autoPair,
  deletePair,
  findMatches,
  replaceMatch,
  replaceAllMatches,
} from "./sql";

const invokeMock = vi.mocked(invoke);
beforeEach(() => invokeMock.mockReset());

describe("tokenizeLines", () => {
  /** Every highlighted span across every line, in order. */
  const cls = (sql: string) =>
    render(<>{tokenizeLines(sql).map((l, i) => <div key={i}>{l}</div>)}</>).container.querySelectorAll("span");

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
    render(<>{tokenizeLines("select foo from t")[0]}</>);
    expect(screen.getByText(/foo/)).toBeInTheDocument();
  });

  it("emits plain text when nothing matches", () => {
    const { container } = render(<>{tokenizeLines("zzz")[0]}</>);
    expect(container.querySelectorAll("span")).toHaveLength(0);
    expect(container.textContent).toBe("zzz");
  });

  it("returns one entry per line, so the numbers line up", () => {
    expect(tokenizeLines("select 1\nfrom t\n")).toHaveLength(3);
    expect(tokenizeLines("")).toHaveLength(1);
  });

  it("splits a token that spans a newline across both lines", () => {
    // A string literal may contain a newline. Tokenizing line by line would
    // end it at the break and highlight the rest of the file as a string.
    const out = tokenizeLines("select 'a\nb' from t");
    const first = render(<>{out[0]}</>).container;
    const second = render(<>{out[1]}</>).container;
    expect(first.querySelector(".tok-s")).toHaveTextContent("'a");
    expect(second.querySelector(".tok-s")).toHaveTextContent("b'");
  });

  it("keeps a blank line as an empty entry rather than dropping it", () => {
    const out = tokenizeLines("a\n\nb");
    expect(out).toHaveLength(3);
    expect(out[1]).toEqual([]);
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

describe("indentSelection", () => {
  it("inserts to the next tab stop from a bare caret", () => {
    expect(indentSelection("select", 0, 0)).toMatchObject({ sql: "  select", selectionStart: 2 });
    // Column 1 is one space short of the stop, so one space is what it gets —
    // not a blind two, which would leave the text off the grid.
    expect(indentSelection("select", 1, 1)).toMatchObject({ sql: "s elect", selectionStart: 2 });
  });

  it("shifts every line a selection touches", () => {
    const r = indentSelection("a\nb\nc", 0, 3);
    expect(r.sql).toBe("  a\n  b\nc");
  });

  it("shifts whole lines even when the selection is inside one line", () => {
    // Replacing a selection with a tab character is never what is wanted here.
    expect(indentSelection("select x", 2, 4).sql).toBe("  select x");
  });

  it("outdents by one level and stops at the margin", () => {
    expect(indentSelection("    a\n  b\nc", 0, 11, true).sql).toBe("  a\nb\nc");
  });

  it("treats a tab as one whole level when outdenting", () => {
    expect(indentSelection("\ta", 0, 2, true).sql).toBe("a");
  });

  it("leaves blank lines without trailing whitespace", () => {
    expect(indentSelection("a\n\nb", 0, 4).sql).toBe("  a\n\n  b");
  });

  it("keeps a selection that started at a line start anchored there", () => {
    const r = indentSelection("a\nb", 0, 3);
    expect(r.selectionStart).toBe(0);
    expect(r.sql.slice(r.selectionStart, r.selectionEnd)).toBe("  a\n  b");
  });

  it("does not include a line the selection merely ends at the start of", () => {
    expect(indentSelection("a\nb\nc", 0, 2).sql).toBe("  a\nb\nc");
  });
});

describe("newlineIndent", () => {
  it("carries the current line's indentation onto the next", () => {
    const r = newlineIndent("  select x", 10, 10);
    expect(r.sql).toBe("  select x\n  ");
    expect(r.selectionStart).toBe(13);
  });

  it("adds a level after an opening bracket", () => {
    expect(newlineIndent("  foo(", 6, 6).sql).toBe("  foo(\n    ");
  });

  it("pushes a waiting closer onto its own line", () => {
    const r = newlineIndent("foo()", 4, 4);
    expect(r.sql).toBe("foo(\n  \n)");
    // Caret on the middle line, inside the new level.
    expect(r.selectionStart).toBe(7);
  });

  it("ignores whitespace between the bracket and the caret", () => {
    expect(newlineIndent("foo(   ", 7, 7).sql).toBe("foo(   \n  ");
  });

  it("replaces a selection rather than leaving it behind", () => {
    expect(newlineIndent("ab", 0, 2).sql).toBe("\n");
  });
});

describe("autoPair", () => {
  it("wraps a selection", () => {
    const r = autoPair("select x", 7, 8, "'");
    expect(r?.sql).toBe("select 'x'");
    expect(r).toMatchObject({ selectionStart: 8, selectionEnd: 9 });
  });

  it("inserts both halves and sits between them", () => {
    expect(autoPair("count", 5, 5, "(")).toMatchObject({ sql: "count()", selectionStart: 6, selectionEnd: 6 });
  });

  it("steps over a closer that is already there instead of doubling it", () => {
    const r = autoPair("count()", 6, 6, ")");
    expect(r).toMatchObject({ sql: "count()", selectionStart: 7 });
  });

  it("leaves an apostrophe alone", () => {
    // `don't` must not become `don''t`.
    expect(autoPair("don", 3, 3, "'")).toBeNull();
  });

  it("does not split a word", () => {
    expect(autoPair("bar", 0, 0, "(")).toBeNull();
  });

  it("still opens a bracket after a word, which is a function call", () => {
    expect(autoPair("count", 5, 5, "(")).not.toBeNull();
  });

  it("says nothing about characters that are not pairs", () => {
    expect(autoPair("a", 1, 1, "x")).toBeNull();
  });
});

describe("deletePair", () => {
  it("removes both halves of an empty pair", () => {
    expect(deletePair("count()", 6, 6)).toMatchObject({ sql: "count", selectionStart: 5 });
  });

  it("leaves a pair with something in it alone", () => {
    expect(deletePair("count(x)", 7, 7)).toBeNull();
  });

  it("leaves an ordinary backspace alone", () => {
    expect(deletePair("abc", 3, 3)).toBeNull();
    expect(deletePair("abc", 0, 0)).toBeNull();
    expect(deletePair("()", 0, 2)).toBeNull();
  });
});

describe("needsGuard — bypasses the audit found", () => {
  const guarded = (sql: string) => needsGuard(sql, "prod");
  it("a WHERE in a CTE does not bound the DELETE after it", () => {
    expect(guarded("WITH d AS (DELETE FROM a WHERE false) DELETE FROM users")).toBe(true);
    expect(guarded("WITH d AS (DELETE FROM a) SELECT 1")).toBe(true);
  });
  it("a WHERE inside a subquery does not bound the outer statement", () => {
    expect(guarded("DELETE FROM t USING (SELECT id FROM x WHERE y) s")).toBe(true);
    expect(guarded("UPDATE t SET a = (SELECT b FROM c WHERE d)")).toBe(true);
  });
  it("still lets a bounded statement through, subquery or not", () => {
    expect(guarded("DELETE FROM t WHERE id IN (SELECT id FROM x WHERE y)")).toBe(false);
    expect(guarded("WITH d AS (DELETE FROM a WHERE id = 1) DELETE FROM b WHERE id = 2")).toBe(false);
  });
  it("asks before statements whose effect is not in the text", () => {
    for (const sql of ["DO $$ BEGIN DELETE FROM t; END $$", "CALL purge()", "MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE", "COPY t FROM '/tmp/x.csv'"]) {
      expect(guarded(sql)).toBe(true);
    }
  });
  it("does not cry wolf on upserts, row locks and COPY … TO", () => {
    expect(guarded("INSERT INTO t VALUES (1) ON CONFLICT (id) DO UPDATE SET a = 1")).toBe(false);
    expect(guarded("SELECT * FROM t WHERE id = 1 FOR UPDATE")).toBe(false);
    expect(guarded("SELECT * FROM t WHERE id = 1 FOR NO KEY UPDATE")).toBe(false);
    expect(guarded("COPY (SELECT * FROM t) TO STDOUT")).toBe(false);
    expect(guarded("COPY t TO STDOUT")).toBe(false);
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

// Audit TN-004. The formatter's patterns ran over the whole text, so Format
// followed by Run could write different data than was typed.
describe("formatSQL — only code is formatted", () => {
  it.each([
    ["a string full of keywords", "insert into notes(body) values ('made from scratch and love, order by mail')", "'made from scratch and love, order by mail'"],
    ["trailing spaces and a newline inside a string", "select 'line one   \nline two  ' as t", "'line one   \nline two  '"],
    ["a doubled quote", "select 'it''s from where and or' as t", "'it''s from where and or'"],
    ["an escape string", "select e'a\\' from b' as t", "e'a\\' from b'"],
    ["a dollar-quoted body", "select $$ select x from y where z $$ as t", "$$ select x from y where z $$"],
    ["a tagged dollar-quoted body", "select $q$ delete from t where a and b $q$", "$q$ delete from t where a and b $q$"],
    ["a quoted identifier that is a keyword", 'select "from", "order by" from t', '"from", "order by"'],
    ["a line comment", "select 1 -- pick from where it is, and then set\nfrom t", "-- pick from where it is, and then set"],
    ["a block comment", "select 1 /* from here\n   where   and there */ from t", "/* from here\n   where   and there */"],
    ["a nested block comment", "select /* a /* from */ where */ 1", "/* a /* from */ where */"],
  ])("leaves %s exactly as written", (_name, sql, kept) => {
    expect(formatSQL(sql)).toContain(kept);
  });

  it("still formats the code around them", () => {
    expect(formatSQL("select 'a from b' as x from t where y = 'c and d' and z = 1")).toBe(
      "SELECT 'a from b' AS x\nFROM t\nWHERE y = 'c and d'\n  AND z = 1",
    );
  });

  it("keeps the space between code and the string that follows it", () => {
    // The old end-of-line trim would have run at the end of every stretch.
    expect(formatSQL("select   'x'")).toBe("SELECT   'x'");
    expect(formatSQL("select 1 as  \"my col\"  from t")).toBe('SELECT 1 AS  "my col"\nFROM t');
  });

  it("does not turn a dollar tag into a keyword", () => {
    const sql = "select $end$ from where $end$ as t";
    expect(formatSQL(sql)).toContain("$end$ from where $end$");
  });

  it("copes with a string or comment that never closes", () => {
    expect(formatSQL("select 'never closed from where")).toBe("SELECT 'never closed from where");
    expect(formatSQL("select 1 /* open from")).toBe("SELECT 1 /* open from");
  });

  it("changes nothing a second time", () => {
    for (const sql of [
      "select a,b from t where c=1 and d=2 order by a",
      "insert into notes(body) values ('made from scratch and love, order by mail')",
      "select 1 -- from\nfrom t /* where */ where x = $$ and $$",
    ]) {
      const once = formatSQL(sql);
      expect(formatSQL(once)).toBe(once);
    }
  });

  it("never changes what a literal, comment or quoted name contains", () => {
    // Generated: every combination of a few code shapes around each protected
    // piece. What goes in protected must come out protected, byte for byte.
    const pieces = [
      "'from where and  or'",
      "'a\n  from b  '",
      "'it''s set'",
      '"order by"',
      "$$ union all select $$",
      "/* having limit */",
    ];
    const frames = [
      (p: string) => `select ${p} from t`,
      (p: string) => `select 1 from t where x = ${p} and y = 2`,
      (p: string) => `${p}\nselect 1`,
      (p: string) => `select 1   ${p}`,
      (p: string) => `update t set a = ${p} where b = ${p} returning ${p}`,
    ];
    for (const p of pieces) for (const f of frames) expect(formatSQL(f(p))).toContain(p);
  });
});

describe("hasWriteVerb", () => {
  it.each([
    "with gone as (delete from users returning id) select count(*) from gone",
    "WITH x AS (UPDATE t SET a = 1 RETURNING a) SELECT * FROM x",
    "with x as (insert into t values (1) returning a) select * from x",
    "with x as (merge into t using s on true when matched then delete) select 1",
    "select * into t2 from t",
    "select 1;\ndelete from t",
    "with x as (\n\tDELETE\nFROM t returning 1) select * from x",
    "select 1 /* harmless */ ; delete /* really */ from t",
    "with x as (insert into t values (1) on conflict do update set a = 2 returning a) select * from x",
  ])("sees the write in %s", (sql) => expect(hasWriteVerb(sql)).toBe(true));

  it.each([
    "select * from users",
    "select 'delete from users', $$update t set a = 1$$, $tag$insert into t$tag$",
    "select 1 -- delete from users\n",
    "select 1 /* update t /* nested */ insert into t */",
    'select "update", "insert", "delete", "into" from t',
    "select deleted, updated_at, inserted, merged_into, intox from t",
    "select * from t where id = 1 for update",
    "select * from t for no key update",
    "select e'it\\'s; delete from t' from t",
    "",
  ])("does not see one in %s", (sql) => expect(hasWriteVerb(sql)).toBe(false));
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
  // Audit TN-018: the value is the text; the server parses it for the
  // placeholder's type.
  it("maps empty and the word null to null", () => {
    expect(coerceParam("")).toBeNull();
    expect(coerceParam("  ")).toBeNull();
    expect(coerceParam("NULL")).toBeNull();
    expect(coerceParam(" null ")).toBeNull();
  });

  it("does not turn a zero-padded code into a number", () => {
    expect(coerceParam("007")).toBe("007");
    expect(coerceParam("02134")).toBe("02134");
  });

  it("keeps every digit of a number", () => {
    expect(coerceParam("9007199254740993")).toBe("9007199254740993");
    expect(coerceParam("0.1234567890123456789012345678901234567890")).toBe(
      "0.1234567890123456789012345678901234567890",
    );
    expect(coerceParam("1.50")).toBe("1.50");
    expect(coerceParam("42")).toBe("42");
    expect(coerceParam("-.5")).toBe("-.5");
  });

  it("does not decide that a word is a boolean", () => {
    // `where name = $1` with the value "true" is a search for that word.
    expect(coerceParam("true")).toBe("true");
    expect(coerceParam("FALSE")).toBe("FALSE");
  });

  it("keeps the text as typed, whitespace included", () => {
    expect(coerceParam(" hello ")).toBe(" hello ");
    expect(coerceParam("12abc")).toBe("12abc");
    expect(coerceParam("2024-01-15")).toBe("2024-01-15");
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

  it("reports rows lost to a format or clipboard cap, which set no flag", () => {
    // Markdown stops at 1000 and a clipboard copy at 10,000, neither of which
    // touches the store's truncated flag. Reading only the flag would call a
    // 1000-row slice of a 40,000-row result "1,000 rows".
    expect(rowCountNote(1000, res({ totalRows: 40_000, truncated: false }))).toBe(
      "1,000 of 40,000 rows (truncated)",
    );
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

