import { describe, expect, it } from "vitest";
import {
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

