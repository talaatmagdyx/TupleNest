import { describe, expect, it } from "vitest";
import { cellExport, cellText, errText } from "./text";

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
