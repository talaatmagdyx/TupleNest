import { describe, expect, it } from "vitest";
import { rowCountNote } from "./sql";

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
