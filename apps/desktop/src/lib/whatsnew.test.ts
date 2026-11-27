import { describe, expect, it } from "vitest";
import { notesFor, startupDialog } from "./whatsnew";
import pkg from "../../package.json";

const V = pkg.version;

describe("what's new and the tour", () => {
  it("has notes for the version being built", () => {
    // Bump the version without notes and the dialog silently says nothing.
    // Not every release needs notes, but this one does.
    expect(notesFor(V).length).toBeGreaterThan(0);
    expect(notesFor("0.0.0-none")).toEqual([]);
  });

  it("shows the tour on a first launch only", () => {
    expect(startupDialog(V, { tourDone: false, version: null, hasProfiles: false })).toBe("tour");
    expect(startupDialog(V, { tourDone: true, version: null, hasProfiles: false })).toBeNull();
    // Upgrading from a build before the tour: connections, so not new.
    expect(startupDialog(V, { tourDone: false, version: null, hasProfiles: true })).toBe("news");
  });

  it("shows what's new once after the version changes", () => {
    expect(startupDialog(V, { tourDone: true, version: "0.0.1", hasProfiles: false })).toBe("news");
    expect(startupDialog(V, { tourDone: true, version: V, hasProfiles: true })).toBeNull();
    expect(startupDialog("9.9.9", { tourDone: true, version: "0.0.1", hasProfiles: true })).toBeNull();
    expect(startupDialog("", { tourDone: false, version: null, hasProfiles: false })).toBeNull();
  });
});
