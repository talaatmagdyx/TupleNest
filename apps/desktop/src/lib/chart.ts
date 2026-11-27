/**
 * Turning a result grid into a bar chart.
 *
 * The chart is a convenience, not an analysis tool: it picks the first
 * text-ish column to group by and the first numeric column to sum. That guess
 * is wrong often enough that the title always states what it did, so nobody
 * has to infer which columns were used.
 */

export type ChartColumn = { name: string; dbType: string };
export type ChartDatum = { label: string; v: number };

/** Bars beyond this are unreadable at panel width; the rest are dropped. */
export const MAX_BARS = 12;

/** Whole type names only: a substring test counted `interval` (int…),
 *  `point` and `int4range` as numbers, right-aligning them and picking them as
 *  a chart's value column, which then drew nothing. */
const NUMERIC =
  /^(int2|int4|int8|smallint|integer|bigint|numeric|decimal|float4|float8|real|double precision|money|oid)(\(.*\))?$/i;

export function isNumericType(dbType: string): boolean {
  return NUMERIC.test(dbType.trim());
}

/**
 * Which columns to chart: first non-numeric to group by, first numeric to sum.
 *
 * Null when the result has no such pair — a chart of one against itself, or of
 * nothing, is not worth drawing and the panel says so instead.
 */
export function pickChartColumns(columns: ChartColumn[]): { label: number; value: number } | null {
  const label = columns.findIndex((c) => !isNumericType(c.dbType));
  const value = columns.findIndex((c) => isNumericType(c.dbType));
  if (label < 0 || value < 0) return null;
  return { label, value };
}

/** "sum(amount) by status" — the chart always states what it charted. */
export function chartTitle(columns: ChartColumn[], pick: { label: number; value: number }): string {
  return `sum(${columns[pick.value].name}) by ${columns[pick.label].name}`;
}

/**
 * What the bars were computed from.
 *
 * The row count is not decoration. A chart built from the first 50,000 rows of
 * a 4,213,662-row result is a chart of a *sample* — the shape can be wildly
 * different from the whole — and nothing else on screen says so. When rows
 * were left out, the subtitle says how many.
 */
export function chartSubtitle(rowCount: number, totalRows?: number, totalKnown = true): string {
  // A total the backend stopped counting at is a lower bound: the bars are a
  // sample even when they used every row that was read.
  if (!totalKnown && totalRows !== undefined) {
    return `aggregated from ${rowCount.toLocaleString()} of ${totalRows.toLocaleString()}+ rows (stopped at the limit) · bar`;
  }
  const of = totalRows !== undefined && totalRows > rowCount ? ` of ${totalRows.toLocaleString()}` : "";
  return `aggregated from ${rowCount.toLocaleString()}${of} rows · bar`;
}
