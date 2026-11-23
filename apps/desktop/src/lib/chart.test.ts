import { describe, expect, it } from "vitest";
import {
  MAX_BARS,
  aggregateChart,
  chartSubtitle,
  chartTitle,
  compareNumeric,
  isNumericType,
  pickChartColumns,
  type ChartColumn,
} from "./chart";

const col = (name: string, dbType: string): ChartColumn => ({ name, dbType });

describe("isNumericType", () => {
  it.each(["int4", "int8", "bigint", "numeric", "float8", "double precision", "real", "money"])(
    "counts %s as numeric",
    (t) => expect(isNumericType(t)).toBe(true),
  );

  it.each(["text", "varchar", "date", "timestamptz", "bool", "uuid", "jsonb"])("counts %s as not numeric", (t) =>
    expect(isNumericType(t)).toBe(false),
  );
});

describe("pickChartColumns", () => {
  it("groups by the first text column and sums the first numeric one", () => {
    const cols = [col("id", "int4"), col("status", "text"), col("amount", "numeric")];
    expect(pickChartColumns(cols)).toEqual({ label: 1, value: 0 });
  });

  it("has nothing to chart without a numeric column", () => {
    expect(pickChartColumns([col("a", "text"), col("b", "varchar")])).toBeNull();
  });

  it("has nothing to chart without a label column", () => {
    expect(pickChartColumns([col("a", "int4"), col("b", "numeric")])).toBeNull();
  });

  it("has nothing to chart with no columns", () => {
    expect(pickChartColumns([])).toBeNull();
  });
});

describe("aggregateChart", () => {
  it("sums the value per label", () => {
    const rows = [
      ["paid", 10],
      ["open", 3],
      ["paid", 5],
    ];
    expect(aggregateChart(rows, 0, 1)).toEqual([
      { label: "paid", v: 15 },
      { label: "open", v: 3 },
    ]);
  });

  it("sorts biggest first", () => {
    const rows = [
      ["a", 1],
      ["b", 9],
      ["c", 5],
    ];
    expect(aggregateChart(rows, 0, 1).map((d) => d.label)).toEqual(["b", "c", "a"]);
  });

  it("keeps only the top bars", () => {
    const rows = Array.from({ length: 30 }, (_, i) => [`g${i}`, i]);
    const out = aggregateChart(rows, 0, 1);
    expect(out).toHaveLength(MAX_BARS);
    expect(out[0]).toEqual({ label: "g29", v: 29 });
  });

  it("respects an explicit cap", () => {
    const rows = Array.from({ length: 5 }, (_, i) => [`g${i}`, i]);
    expect(aggregateChart(rows, 0, 1, 2)).toHaveLength(2);
  });

  it("keeps a null label as its own group", () => {
    // Rows missing the key are a real group. Dropping them quietly changes
    // every total the chart appears to show.
    const rows = [
      [null, 4],
      ["a", 1],
    ];
    expect(aggregateChart(rows, 0, 1)).toEqual([
      { label: "null", v: 4 },
      { label: "a", v: 1 },
    ]);
  });

  it("groups null and undefined labels together", () => {
    expect(aggregateChart([[null, 1], [undefined, 2]], 0, 1)).toEqual([{ label: "null", v: 3 }]);
  });

  it("skips a null value rather than counting it as zero", () => {
    // Number(null) is 0. Adding it invents a measurement of zero for a row
    // that has none — the bar appears, and the average it implies is wrong.
    const rows = [
      ["a", null],
      ["b", 5],
    ];
    expect(aggregateChart(rows, 0, 1)).toEqual([{ label: "b", v: 5 }]);
  });

  it.each([[undefined], ["not a number"], [NaN], [Infinity]])("skips a %s value", (v) => {
    expect(aggregateChart([["a", v]], 0, 1)).toEqual([]);
  });

  it("still charts a label whose other rows are numeric", () => {
    const rows = [
      ["a", null],
      ["a", 7],
    ];
    expect(aggregateChart(rows, 0, 1)).toEqual([{ label: "a", v: 7 }]);
  });

  it("reads a numeric string, which is how the driver sends numeric", () => {
    // pg numeric arrives as a string to keep precision. Refusing it would
    // leave the most chartable column type unchartable.
    expect(aggregateChart([["a", "12.5"]], 0, 1)).toEqual([{ label: "a", v: 12.5 }]);
  });

  it("has nothing to show for no rows", () => {
    expect(aggregateChart([], 0, 1)).toEqual([]);
  });

  it("distinguishes labels that only differ once stringified", () => {
    expect(aggregateChart([[1, 1], ["1", 2]], 0, 1)).toEqual([{ label: "1", v: 3 }]);
  });
});

describe("chart labels", () => {
  it("states which columns it used", () => {
    // The column pick is a guess. The title is what makes it checkable.
    const cols = [col("status", "text"), col("amount", "numeric")];
    expect(chartTitle(cols, { label: 0, value: 1 })).toBe("sum(amount) by status");
  });

  it("states how many rows went in", () => {
    expect(chartSubtitle(12345)).toBe("aggregated from 12,345 rows · bar");
  });

  it("says when the bars are a sample of a bigger result", () => {
    // 50,000 of 4,213,662 rows can have a completely different shape from the
    // whole. Nothing else on the chart says it is partial.
    expect(chartSubtitle(50_000, 4_213_662)).toBe("aggregated from 50,000 of 4,213,662 rows · bar");
  });

  it("says nothing extra when it charted everything", () => {
    expect(chartSubtitle(12, 12)).toBe("aggregated from 12 rows · bar");
  });
});

describe("isNumericType — whole type names only", () => {
  it.each(["interval", "point", "int4range", "_int4", "tinterval"])("does not count %s as numeric", (t) =>
    expect(isNumericType(t)).toBe(false),
  );
  it("counts a modified numeric", () => expect(isNumericType("numeric(12,2)")).toBe(true));
});

describe("compareNumeric — exact, whatever the cell's JSON type", () => {
  const sorted = (xs: unknown[]) => [...xs].sort(compareNumeric);
  it("orders decimals numerically, not as text", () => {
    expect(sorted(["100.00", "20.00", "9.50", "-3", "0"])).toEqual(["-3", "0", "9.50", "20.00", "100.00"]);
  });
  it("orders bigints past 2^53 exactly, mixed with numbers", () => {
    expect(sorted(["9007199254740993", 5, "-9007199254740993", 95, "9007199254740992"])).toEqual([
      "-9007199254740993",
      5,
      95,
      "9007199254740992",
      "9007199254740993",
    ]);
  });
  it("treats equal values as equal and puts NaN above Infinity", () => {
    expect(compareNumeric("1.50", 1.5)).toBe(0);
    expect(compareNumeric("-0", "0")).toBe(0);
    expect(sorted(["NaN", "Infinity", "-Infinity", "1"])).toEqual(["-Infinity", "1", "Infinity", "NaN"]);
    expect(compareNumeric("-2.5", "-2.25")).toBeLessThan(0);
    expect(compareNumeric(1e21, 5)).toBeGreaterThan(0);
    // Same integer part: the fraction decides, padded to equal length.
    expect(compareNumeric("1.25", "1.3")).toBeLessThan(0);
    expect(compareNumeric("1.30", "1.3")).toBe(0);
    expect(compareNumeric("12", "9")).toBeGreaterThan(0);
    expect(compareNumeric("-12", "-9")).toBeLessThan(0);
  });
});
