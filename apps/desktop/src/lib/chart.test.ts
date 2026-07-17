import { describe, expect, it } from "vitest";
import {
  MAX_BARS,
  aggregateChart,
  chartSubtitle,
  chartTitle,
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
