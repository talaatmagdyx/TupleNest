import { describe, expect, it } from "vitest";
import { cellText, errText, mdCell, prettyJson } from "./text";

describe("cellText — a cell on screen", () => {
  it("shows a null rather than hiding it", () => {
    // A null and an empty string are different facts about the row.
    expect(cellText(null)).toBe("null");
    expect(cellText(undefined)).toBe("null");
    expect(cellText("")).toBe("");
  });

  it("renders json rather than [object Object]", () => {
    // This is what a jsonb column produced everywhere but the grid.
    expect(cellText({ a: 1 })).toBe('{"a":1}');
    expect(cellText([1, 2])).toBe("[1,2]");
  });

  it("passes scalars through", () => {
    expect(cellText("ada")).toBe("ada");
    expect(cellText(42)).toBe("42");
    expect(cellText(false)).toBe("false");
    expect(cellText(0)).toBe("0");
  });
});

describe("errText", () => {
  it("reads Tauri's bare string rejection", () => {
    // Tauri rejects with the command's `Err(String)`, not an Error.
    expect(errText("permission denied for table users")).toBe("permission denied for table users");
  });

  it("takes the message off an Error, without the class name", () => {
    // `String(new Error("x"))` is "Error: x"; the prefix is noise in a toast.
    expect(errText(new Error("disk full"))).toBe("disk full");
  });

  it("renders a structured rejection rather than [object Object]", () => {
    expect(errText({ code: "42501" })).toBe('{"code":"42501"}');
  });

  it("says what it got when it got nothing", () => {
    expect(errText(null)).toBe("null");
    expect(errText(undefined)).toBe("undefined");
  });

  it("handles a thrown non-object", () => {
    expect(errText(500)).toBe("500");
  });
});

describe("text — values Postgres does not produce", () => {
  // `unknown` allows a symbol or a function even though no cell is ever one.
  // `String(aSymbol)` throws, so the fallback exists to keep a stray value from
  // taking the grid down with it.
  it("names a symbol instead of throwing on it", () => {
    expect(cellText(Symbol("s"))).toBe("[object Symbol]");
  });

  it("names a function", () => {
    expect(cellText(() => null)).toBe("[object Function]");
  });

  it("names one thrown as an error, too", () => {
    expect(errText(Symbol("boom"))).toBe("[object Symbol]");
  });
});

describe("mdCell — one Markdown table cell", () => {
  it("escapes a pipe", () => {
    expect(mdCell("a|b")).toBe("a\\|b");
  });

  it("escapes EVERY pipe, not just the first", () => {
    expect(mdCell("a|b|c")).toBe("a\\|b\\|c");
  });

  it("escapes the backslash itself — the CodeQL case", () => {
    // Before the fix, a value ending in a backslash turned the pipe escape
    // into `\\|`: an escaped backslash followed by a LIVE pipe. The cell
    // split anyway; the sanitizer sanitized itself.
    expect(mdCell("a\\|b")).toBe("a\\\\\\|b");
    expect(mdCell("trailing\\")).toBe("trailing\\\\");
  });

  it("no input can produce a live (unescaped) pipe in the output", () => {
    // The property the alert is actually about, stated as a property. A pipe
    // is LIVE — still a cell separator — when the run of backslashes directly
    // before it has even length (zero included): pairs collapse to literal
    // backslashes and leave the pipe bare. This regex matches exactly that:
    // start-or-non-backslash, then zero or more backslash PAIRS, then `|`.
    const livePipe = /(?:^|[^\\])(?:\\\\)*\|/;
    for (const input of ["\\", "\\|", "|\\", "\\\\|", "a\\|b\\", "|", "||", "\\\\", "a\\\\|"]) {
      expect(mdCell(input)).not.toMatch(livePipe);
    }
    // And the regex itself can detect what it claims to — otherwise the loop
    // above proves nothing. (A live pipe, and an escaped one it must ignore.)
    expect("a|b").toMatch(livePipe);
    expect("a\\\\|b").toMatch(livePipe);
    expect("a\\|b").not.toMatch(livePipe);
  });

  it("turns newlines into <br> — no escape can save a raw newline in a row", () => {
    expect(mdCell("two\nlines")).toBe("two<br>lines");
    expect(mdCell("crlf\r\nline")).toBe("crlf<br>line");
  });

  it("leaves ordinary text alone", () => {
    expect(mdCell("plain text 123")).toBe("plain text 123");
  });
});

// Audit TN-019: the inspector showed `JSON.stringify(JSON.parse(text))`, a
// different document from the one in the database.
describe("prettyJson — re-indents, never rewrites", () => {
  const tokens = (s: string) => s.replace(/\s+(?=(?:[^"\\]|\\.|"(?:[^"\\]|\\.)*")*$)/g, "");

  it("lays an object out two spaces deep", () => {
    expect(prettyJson('{"a":1,"b":[true,null]}')).toBe('{\n  "a": 1,\n  "b": [\n    true,\n    null\n  ]\n}');
  });

  it("agrees with JSON.stringify where JSON.stringify changes nothing", () => {
    for (const v of [{ a: 1, b: { c: [1, 2, { d: "x" }] }, e: [] }, [], {}, [[]], "s", 0, null, [{}]]) {
      expect(prettyJson(JSON.stringify(v))).toBe(JSON.stringify(v, null, 2));
    }
  });

  it("keeps every digit of a number JavaScript cannot hold", () => {
    const out = prettyJson('{"n": 12345678901234567890123, "d": 1.10, "e": 1E400, "z": -0.0}');
    expect(out).toContain("12345678901234567890123");
    expect(out).toContain("1.10");
    expect(out).toContain("1E400");
    expect(out).toContain("-0.0");
  });

  it("keeps a duplicated key and the order the keys came in", () => {
    const out = prettyJson('{"b":1,"a":2,"a":3,"10":4,"9":5}');
    expect(out).toBe('{\n  "b": 1,\n  "a": 2,\n  "a": 3,\n  "10": 4,\n  "9": 5\n}');
  });

  it("does not touch the inside of a string", () => {
    const src = '{"k": "a, b: {c} [d] \\" \\\\", "s": "  spaces  \\n"}';
    const out = prettyJson(src);
    expect(out).toContain('"a, b: {c} [d] \\" \\\\"');
    expect(out).toContain('"  spaces  \\n"');
    expect(JSON.parse(out)).toEqual(JSON.parse(src));
  });

  it("drops only whitespace, whatever layout it was given", () => {
    const src = ' {\r\n\t"a" :  [ 1 ,2 ] ,\n"b":{ }  , "c" : [\n] } ';
    const out = prettyJson(src);
    expect(tokens(out)).toBe(tokens(src));
    expect(out).toBe('{\n  "a": [\n    1,\n    2\n  ],\n  "b": {},\n  "c": []\n}');
  });

  it("is stable when applied twice", () => {
    const once = prettyJson('{"a":[1,{"b":[]}],"c":"x"}');
    expect(prettyJson(once)).toBe(once);
  });

  it("returns text that is not JSON unchanged", () => {
    for (const s of ["not json at all", "{", '{"a":}', "", "{'a': 1}", "NaN"]) {
      expect(prettyJson(s)).toBe(s);
    }
  });
});

