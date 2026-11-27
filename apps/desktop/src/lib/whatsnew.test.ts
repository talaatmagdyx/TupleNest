import { describe, expect, it } from "vitest";
import { notesFor, startupDialog } from "./whatsnew";
import pkg from "../../package.json";

describe("what's new", () => {
  it("has notes for the version being built", () => {
    // Bump the version without notes and the dialog silently says nothing.
    // Not every release needs notes, but this one does.
    expect(notesFor(pkg.version).length).toBeGreaterThan(0);
    expect(notesFor("0.0.0-none")).toEqual([]);
  });

  it("shows once after the version changes, and not on a first launch", () => {
    expect(startupDialog(pkg.version, "0.0.1")).toBe("news");
    expect(startupDialog(pkg.version, pkg.version)).toBeNull();
    expect(startupDialog(pkg.version, null)).toBeNull();
    expect(startupDialog("", "0.0.1")).toBeNull();
    expect(startupDialog("9.9.9", "0.0.1")).toBeNull();
  });
});
