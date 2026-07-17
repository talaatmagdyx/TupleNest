import { cellText } from "./text";
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

/** Rows read for a chart. Past this it stops being a preview. */
export const MAX_CHART_ROWS = 50_000;

const NUMERIC = /int|numeric|float|double|real|money/;

export function isNumericType(dbType: string): boolean {
  return NUMERIC.test(dbType);
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

/**
 * Sum the value column per label, biggest first.
 *
 * NULL values are skipped, matching SQL's SUM. They cannot be passed through
 * `Number()` on the way: `Number(null)` is 0 and `Number.isFinite(0)` is true,
 * so a group whose every row is NULL would survive as a bar sitting at zero —
 * claiming a measurement of nothing where SUM would have said NULL.
 *
 * NULL *labels* are kept, as "null". Rows missing the grouping key are a real
 * group, and dropping them quietly changes every total shown.
 */
export function aggregateChart(rows: unknown[][], label: number, value: number, max = MAX_BARS): ChartDatum[] {
  const agg = new Map<string, number>();
  for (const r of rows) {
    const raw = r[value];
    if (raw === null || raw === undefined) continue;
    const v = Number(raw);
    if (!Number.isFinite(v)) continue;
    const k = cellText(r[label]);
    agg.set(k, (agg.get(k) ?? 0) + v);
  }
  return [...agg.entries()]
    .map(([l, v]) => ({ label: l, v }))
    .sort((a, b) => b.v - a.v)
    .slice(0, max);
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
export function chartSubtitle(rowCount: number, totalRows?: number): string {
  const of = totalRows !== undefined && totalRows > rowCount ? ` of ${totalRows.toLocaleString()}` : "";
  return `aggregated from ${rowCount.toLocaleString()}${of} rows · bar`;
}
