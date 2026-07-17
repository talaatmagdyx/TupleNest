import { describe, expect, it } from "vitest";
import { cellExport, cellText, errText, mdCell } from "./text";

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

describe("cellExport — a cell in a file", () => {
  it("writes a null as an empty field", () => {
    // The convention every spreadsheet expects; "null" would import as text.
    expect(cellExport(null)).toBe("");
    expect(cellExport(undefined)).toBe("");
  });

  it("renders json the same way the screen does", () => {
    expect(cellExport({ a: 1 })).toBe('{"a":1}');
  });

  it("passes scalars through", () => {
    expect(cellExport(42)).toBe("42");
    expect(cellExport("ada")).toBe("ada");
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
    expect(cellExport(() => null)).toBe("[object Function]");
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
