import { describe, expect, it } from "vitest";
import { compareVersions, meetsUpdateFloor, MIN_UPDATE_VERSION } from "./version";

describe("compareVersions", () => {
  it("orders by numeric component", () => {
    expect(compareVersions("1.0.0", "1.0.1")).toBeLessThan(0);
    expect(compareVersions("1.2.0", "1.1.9")).toBeGreaterThan(0);
    expect(compareVersions("2.0.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("ignores a prerelease suffix for ordering", () => {
    // The numeric core orders releases; -beta.N is not part of the floor check.
    expect(compareVersions("0.1.0-beta.2", "0.1.0")).toBe(0);
    expect(compareVersions("0.2.0-beta.1", "0.1.0")).toBeGreaterThan(0);
  });

  it("treats missing components as zero", () => {
    expect(compareVersions("1", "1.0.0")).toBe(0);
    expect(compareVersions("1.1", "1.0.9")).toBeGreaterThan(0);
  });

  it("does not misread non-numeric junk as a high version", () => {
    expect(compareVersions("garbage", "0.1.0")).toBeLessThan(0);
  });
});

describe("meetsUpdateFloor", () => {
  it("accepts the floor and anything above it", () => {
    expect(meetsUpdateFloor(MIN_UPDATE_VERSION)).toBe(true);
    expect(meetsUpdateFloor("9.9.9")).toBe(true);
  });

  it("rejects an advertised downgrade below the floor", () => {
    expect(meetsUpdateFloor("0.0.9")).toBe(false);
  });
});
