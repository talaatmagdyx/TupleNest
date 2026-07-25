import { describe, it, expect } from "vitest";
import {
  buildCreateTable,
  CsvStreamParser,
  buildInsert,
  coerceCell,
  inferType,
  inferTypes,
  normalizeColumnName,
  normalizeHeader,
  parseCsv,
} from "./csv";

describe("parseCsv", () => {
  it("parses a simple file", () => {
    const t = parseCsv("a,b\n1,2\n3,4\n");
    expect(t.header).toEqual(["a", "b"]);
    expect(t.rows).toEqual([["1", "2"], ["3", "4"]]);
  });

  it("handles a missing trailing newline", () => {
    expect(parseCsv("a,b\n1,2").rows).toEqual([["1", "2"]]);
  });

  it("handles CRLF", () => {
    expect(parseCsv("a,b\r\n1,2\r\n").rows).toEqual([["1", "2"]]);
  });

  it("strips a UTF-8 BOM from the first header", () => {
    expect(parseCsv("﻿a,b\n1,2\n").header).toEqual(["a", "b"]);
  });

  it("keeps quoted commas", () => {
    expect(parseCsv('a,b\n"x,y",2\n').rows).toEqual([["x,y", "2"]]);
  });

  it("unescapes doubled quotes", () => {
    expect(parseCsv('a\n"say ""hi"""\n').rows).toEqual([['say "hi"']]);
  });

  it("keeps newlines inside quotes", () => {
    expect(parseCsv('a,b\n"line1\nline2",2\n').rows).toEqual([["line1\nline2", "2"]]);
  });

  it("preserves an empty quoted field", () => {
    expect(parseCsv('a,b\n"",2\n').rows).toEqual([["", "2"]]);
  });

  it("supports tabs as a delimiter", () => {
    expect(parseCsv("a\tb\n1\t2\n", "\t").rows).toEqual([["1", "2"]]);
  });

  it("returns an empty table for empty input", () => {
    expect(parseCsv("")).toEqual({ header: [], rows: [] });
  });
});

describe("inferType", () => {
  it("detects integers", () => expect(inferType(["1", "2", "-3"])).toBe("int8"));
  it("detects decimals", () => expect(inferType(["1.5", "2", "-0.25"])).toBe("numeric"));
  it("detects scientific notation", () => expect(inferType(["1e5", "2.5E-3"])).toBe("numeric"));
  it("detects booleans", () => expect(inferType(["true", "false", "yes"])).toBe("boolean"));
  it("detects dates", () => expect(inferType(["2024-01-01", "2024-12-31"])).toBe("date"));
  it("detects timestamps", () => expect(inferType(["2024-01-01 10:00:00", "2024-06-01T12:30:00Z"])).toBe("timestamptz"));
  it("falls back to text on mixed input", () => expect(inferType(["1", "abc"])).toBe("text"));
  it("ignores blanks when inferring", () => expect(inferType(["1", "", "  ", "2"])).toBe("int8"));
  it("uses text for an all-blank column", () => expect(inferType(["", "  "])).toBe("text"));

  // 0/1 is ambiguous; an integer reading loses less than a boolean one.
  it("prefers int8 over boolean for a 0/1 column", () => expect(inferType(["0", "1", "1"])).toBe("int8"));

  it("does not overflow int8 on a huge number", () => {
    expect(inferType(["123456789012345678901234567890"])).toBe("numeric");
  });

  it("infers per column", () => {
    const t = parseCsv("n,s,b\n1,x,true\n2,y,false\n");
    expect(inferTypes(t)).toEqual(["int8", "text", "boolean"]);
  });
});

describe("normalizeColumnName", () => {
  const fresh = () => new Set<string>();

  it("snake_cases a messy header", () => {
    expect(normalizeColumnName("First Name!", fresh())).toBe("first_name");
  });

  it("prefixes a leading digit", () => expect(normalizeColumnName("2024", fresh())).toBe("c_2024"));

  it("falls back for an empty header", () => expect(normalizeColumnName("   ", fresh())).toBe("column"));

  it("dedupes collisions", () => {
    expect(normalizeHeader(["Name", "name", "NAME"])).toEqual(["name", "name_2", "name_3"]);
  });

  it("truncates to the Postgres identifier limit", () => {
    expect(normalizeColumnName("x".repeat(80), fresh())).toHaveLength(63);
  });

  it("strips leading/trailing separators", () => {
    expect(normalizeColumnName("  --weird--  ", fresh())).toBe("weird");
  });
});

describe("coerceCell", () => {
  it("maps an empty cell to NULL", () => expect(coerceCell("", "text")).toBeNull());
  it("maps a whitespace-only cell to NULL", () => expect(coerceCell("   ", "int8")).toBeNull());
  it("trims literals so Postgres can parse them", () => expect(coerceCell(" 42 ", "int8")).toBe("42"));
  it("preserves text spacing verbatim", () => expect(coerceCell("  hi  ", "text")).toBe("  hi  "));

  // Precision is the whole reason we bind text: 1e18 + small change cannot
  // survive an f64 round-trip, but the digits survive as text.
  it("keeps full precision of a big decimal", () => {
    const big = "12345678901234567890.12345678901234567890";
    expect(coerceCell(big, "numeric")).toBe(big);
  });

  it("passes bad input through so the server reports a real type error", () =>
    expect(coerceCell("abc", "int8")).toBe("abc"));
});

describe("buildCreateTable", () => {
  it("quotes identifiers and emits types", () => {
    const sql = buildCreateTable("public", "t", [
      { name: "id", type: "int8" },
      { name: "name", type: "text" },
    ]);
    expect(sql).toBe('CREATE TABLE "public"."t" (\n  "id" int8,\n  "name" text\n)');
  });

  it("escapes a quote in an identifier", () => {
    expect(buildCreateTable("public", 'ev"il', [{ name: "a", type: "text" }])).toContain('"ev""il"');
  });
});

describe("buildInsert", () => {
  const cols = [
    { name: "id", type: "int8" as const },
    { name: "name", type: "text" as const },
  ];

  // Values bind as text and are cast in SQL: tokio-postgres will not convert a
  // JS number to `numeric` or a string to `date`, so native binding fails.
  it("builds a multi-row parameterised insert with double casts", () => {
    const r = buildInsert("public", "t", cols, [
      ["1", "a"],
      ["2", "b"],
    ]);
    expect(r.sql).toBe(
      'INSERT INTO "public"."t" ("id", "name") VALUES ($1::text::int8, $2::text), ($3::text::int8, $4::text)'
    );
    expect(r.params).toEqual(["1", "a", "2", "b"]);
  });

  // Regression: a single `$1::int8` makes Postgres infer the parameter as int8
  // (verified: `PREPARE p AS SELECT $1::numeric` → parameter_types {numeric}),
  // so binding text fails. The ::text:: prefix pins it to text first.
  it("casts through text so the parameter is inferred as text", () => {
    const r = buildInsert(
      "public",
      "t",
      [
        { name: "d", type: "date" as const },
        { name: "n", type: "numeric" as const },
        { name: "b", type: "boolean" as const },
        { name: "ts", type: "timestamptz" as const },
      ],
      [["2024-01-01", "1.50", "true", "2024-01-01 10:00"]]
    );
    expect(r.sql).toContain("$1::text::date");
    expect(r.sql).toContain("$2::text::numeric");
    expect(r.sql).toContain("$3::text::boolean");
    expect(r.sql).toContain("$4::text::timestamptz");
    expect(r.params).toEqual(["2024-01-01", "1.50", "true", "2024-01-01 10:00"]);
  });

  it("does not double-cast a text column", () => {
    const r = buildInsert("public", "t", [{ name: "s", type: "text" as const }], [["x"]]);
    expect(r.sql).toContain("$1::text");
    expect(r.sql).not.toContain("::text::text");
  });

  it("never interpolates values", () => {
    const r = buildInsert("public", "t", cols, [["1", "'); drop table t; --"]]);
    expect(r.sql).not.toContain("drop table");
    expect(r.params[1]).toBe("'); drop table t; --");
  });

  it("binds missing cells as NULL", () => {
    const r = buildInsert("public", "t", cols, [["1"]]);
    expect(r.params).toEqual(["1", null]);
  });

  it("throws rather than emit an empty insert", () => {
    expect(() => buildInsert("public", "t", cols, [])).toThrow(/no rows/i);
  });
});

describe("CsvStreamParser — the same file, delivered in pieces", () => {
  /** Feed `text` one character at a time: the most hostile chunking possible,
   *  so every boundary case is exercised at once. */
  const byChar = (text: string, delimiter = ",") => {
    const p = new CsvStreamParser(delimiter);
    const rows: string[][] = [];
    for (const ch of text) rows.push(...p.push(ch));
    rows.push(...p.end());
    return rows;
  };

  /** Split at one specific index — for pinning a named boundary. */
  const splitAt = (text: string, at: number, delimiter = ",") => {
    const p = new CsvStreamParser(delimiter);
    const rows = [...p.push(text.slice(0, at)), ...p.push(text.slice(at))];
    rows.push(...p.end());
    return rows;
  };

  const SAMPLES = [
    "a,b\n1,2\n",
    "a,b\n1,2", // no trailing newline
    'name,note\n"Ann","said ""hi"""\n', // escaped quotes
    'a,b\n"multi\nline",2\n', // newline inside a quoted field
    'a,b\n"has,comma",2\n', // delimiter inside a quoted field
    "a,b\r\n1,2\r\n", // CRLF
    '﻿a,b\n1,2\n', // BOM
    'a,b\n"",2\n', // empty quoted field
    'a,b\n"trailing space ",2\n',
  ];

  it("gives the same answer as parsing the whole string, however it is chopped", () => {
    for (const text of SAMPLES) {
      const whole = parseCsv(text);
      const expected = [whole.header, ...whole.rows];
      expect(byChar(text), `char-by-char: ${JSON.stringify(text)}`).toEqual(expected);
      for (let at = 0; at <= text.length; at++) {
        expect(splitAt(text, at), `split at ${at}: ${JSON.stringify(text)}`).toEqual(expected);
      }
    }
  });

  it("keeps an escaped quote intact when the boundary falls between its two characters", () => {
    // The case the whole-string parser could never hit: chunk one ends on the
    // first `"` of a `""` pair, so the parser cannot yet know whether the
    // field closed or an escaped quote began.
    const text = 'a\n"x""y"\n';
    const at = text.indexOf('""') + 1;
    expect(splitAt(text, at)).toEqual([["a"], ['x"y']]);
  });

  it("holds back a row until the chunk that finishes it", () => {
    const p = new CsvStreamParser();
    expect(p.push("a,b\n1,")).toEqual([["a", "b"]]); // only the completed row
    expect(p.push("2\n")).toEqual([["1", "2"]]);
    expect(p.end()).toEqual([]);
  });

  it("emits the last row from end() when the file has no trailing newline", () => {
    const p = new CsvStreamParser();
    expect(p.push("a\n1")).toEqual([["a"]]);
    expect(p.end()).toEqual([["1"]]);
  });

  it("strips the BOM only once, not from every chunk", () => {
    const p = new CsvStreamParser();
    expect(p.push("﻿a,b\n")).toEqual([["a", "b"]]);
    // A BOM mid-file is a real character and must survive.
    expect(p.push("﻿x,y\n")).toEqual([["﻿x", "y"]]);
  });

  it("handles a quoted field spanning three chunks", () => {
    const p = new CsvStreamParser();
    expect(p.push('a\n"one ')).toEqual([["a"]]);
    expect(p.push("two ")).toEqual([]);
    expect(p.push('three"\n')).toEqual([["one two three"]]);
  });

  it("respects a non-comma delimiter across chunks", () => {
    const p = new CsvStreamParser(";");
    expect(p.push("a;b\n1;")).toEqual([["a", "b"]]);
    expect(p.push("2\n")).toEqual([["1", "2"]]);
  });
});
