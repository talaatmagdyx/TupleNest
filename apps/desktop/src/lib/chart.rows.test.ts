import { describe, expect, it } from "vitest";
import { aggregateBars, cellNumber, chartData, linePath } from "./chart";

const cols = [
  { name: "status", dbType: "text" },
  { name: "n", dbType: "int8" },
];

describe("charts of rows in hand", () => {
  it("reads numbers and numeric text, and nothing else", () => {
    expect(cellNumber(3)).toBe(3);
    expect(cellNumber("12.5")).toBe(12.5);
    expect(cellNumber("9007199254740993")).toBe(9007199254740992);
    expect(cellNumber("")).toBeNull();
    expect(cellNumber("NaN")).toBeNull();
    expect(cellNumber(null)).toBeNull();
    expect(cellNumber({})).toBeNull();
  });

  it("sums per label, biggest first, by pg_chart's rules", () => {
    const rows = [
      ["a", 1],
      ["b", 5],
      ["a", 3],
      [null, 2],
      ["c", null],
    ];
    expect(aggregateBars(rows, { label: 0, value: 1 })).toEqual([
      { label: "b", v: 5 },
      { label: "a", v: 4 },
      { label: "null", v: 2 },
    ]);
    expect(aggregateBars(rows, { label: 0, value: 1 }, 1)).toEqual([{ label: "b", v: 5 }]);
  });

  it("draws bars, a line in row order, and a single number", () => {
    const rows = [
      ["mon", "2"],
      ["tue", 1],
    ];
    expect(chartData("bar", cols, rows)).toEqual({
      kind: "bar",
      title: "sum(n) by status",
      points: [
        { label: "mon", v: 2 },
        { label: "tue", v: 1 },
      ],
    });
    expect(chartData("line", cols, [...rows, ["wed", null]])).toEqual({
      kind: "line",
      title: "n by status",
      points: [
        { label: "mon", v: 2 },
        { label: "tue", v: 1 },
      ],
    });
    expect(chartData("number", cols, rows)).toEqual({ kind: "number", title: "n", value: 2 });
    // No numeric column: the first column, if it reads as a number.
    expect(chartData("number", [{ name: "x", dbType: "text" }], [["7"]])).toEqual({ kind: "number", title: "x", value: 7 });
  });

  it("has nothing to draw without the columns it needs", () => {
    expect(chartData("bar", [cols[0]], [["a"]])).toBeNull();
    expect(chartData("line", [cols[1]], [[1]])).toBeNull();
    expect(chartData("number", cols, [])).toBeNull();
    expect(chartData("number", [cols[0]], [["words"]])).toBeNull();
  });

  it("spans the box from the lowest value to the highest", () => {
    expect(
      linePath(
        [
          { label: "a", v: 0 },
          { label: "b", v: 10 },
          { label: "c", v: 5 },
        ],
        100,
        50,
      ),
    ).toBe("M0.0 50.0 L50.0 0.0 L100.0 25.0");
    // One point sits in the middle; a flat line does not divide by zero.
    expect(linePath([{ label: "a", v: 3 }], 100, 50)).toBe("M50.0 50.0");
  });
});
