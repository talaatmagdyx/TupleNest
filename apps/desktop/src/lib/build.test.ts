import { describe, expect, it } from "vitest";
import { buildLabel } from "./build";

describe("buildLabel", () => {
  it("joins the commit and the build time", () => {
    expect(buildLabel("a1b2c3d", "2026-07-20 03:45")).toBe("a1b2c3d · 2026-07-20 03:45");
  });

  it("keeps the dirty marker, which is the whole point of showing it", () => {
    // A `+` means the bundle includes uncommitted work — so a bug reproduced
    // against it may not exist on any commit anyone else can check out.
    expect(buildLabel("a1b2c3d+", "2026-07-20 03:45")).toContain("a1b2c3d+");
  });

  it("shows whichever half it has", () => {
    expect(buildLabel("a1b2c3d", "")).toBe("a1b2c3d");
    expect(buildLabel("", "2026-07-20 03:45")).toBe("2026-07-20 03:45");
  });

  it("says nothing rather than 'unknown' when there is nothing to say", () => {
    // A checkout without git history, or a test run. An honest blank beats a
    // label that implies the build could not be identified.
    expect(buildLabel("", "")).toBe("");
  });
});
