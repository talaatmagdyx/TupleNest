/**
 * Turning a result grid into a bar chart.
 *
 * The chart is a convenience, not an analysis tool: it picks the first
 * text-ish column to group by and the first numeric column to sum. That guess
 * is wrong often enough that the title always states what it did, so nobody
 * has to infer which columns were used.
 */

import { cellText } from "./text";

export type ChartColumn ={ name: string; dbType: string };
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

/* ------------------------------------------------ dashboards and notebooks
 *
 * A pinned chart or a notebook cell has its rows in hand (at most a thousand,
 * from a detached run), so it is drawn from them here rather than by the
 * backend's `pg_chart`, which reads the grid's stored result.
 */

export type ChartKind = "bar" | "line" | "number";

export const CHART_KINDS: { kind: ChartKind; label: string }[] = [
  { kind: "bar", label: "Bar" },
  { kind: "line", label: "Line" },
  { kind: "number", label: "Single number" },
];

/** A cell as a number, or null: numbers, and numeric text (numeric and int8
 *  past 2^53 arrive as strings). NaN and the infinities are not plotted. */
export function cellNumber(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** A label cell as text, by the grid's rule: null shown as "null". */
const labelOf = cellText;

/** Sum of the value column per label, biggest first, at most `max` bars —
 *  the rules of `pg_chart`: NULL values skipped, NULL labels kept as "null". */
export function aggregateBars(
  rows: unknown[][],
  pick: { label: number; value: number },
  max = MAX_BARS,
): ChartDatum[] {
  const sums = new Map<string, number>();
  for (const row of rows) {
    const v = cellNumber(row[pick.value]);
    if (v === null) continue;
    const label = labelOf(row[pick.label]);
    sums.set(label, (sums.get(label) ?? 0) + v);
  }
  return [...sums.entries()]
    .map(([label, v]) => ({ label, v }))
    .sort((a, b) => b.v - a.v)
    .slice(0, max);
}

export type ChartData =
  | { kind: "bar" | "line"; title: string; points: ChartDatum[] }
  | { kind: "number"; title: string; value: number };

/**
 * What to draw for `kind`, or null with nothing drawable.
 *
 * - bar: `aggregateBars` over the first text and first numeric column.
 * - line: one point per row, in the query's order (order it by time), with the
 *   first numeric column as the value and the first other column as its label.
 * - number: the first numeric cell of the first row.
 */
export function chartData(kind: ChartKind, columns: ChartColumn[], rows: unknown[][]): ChartData | null {
  if (kind === "number") {
    const value = columns.findIndex((c) => isNumericType(c.dbType));
    const at = value >= 0 ? value : 0;
    const n = rows.length > 0 ? cellNumber(rows[0][at]) : null;
    return n === null ? null : { kind, title: columns[at].name, value: n };
  }
  const pick = pickChartColumns(columns);
  if (!pick) return null;
  if (kind === "bar") return { kind, title: chartTitle(columns, pick), points: aggregateBars(rows, pick) };
  const points: ChartDatum[] = [];
  for (const row of rows) {
    const v = cellNumber(row[pick.value]);
    if (v !== null) points.push({ label: labelOf(row[pick.label]), v });
  }
  return { kind, title: `${columns[pick.value].name} by ${columns[pick.label].name}`, points };
}

/** The SVG path of a line chart in a `width` × `height` box: the lowest
 *  value on the bottom edge, the highest on the top. */
export function linePath(points: ChartDatum[], width: number, height: number): string {
  const vs = points.map((p) => p.v);
  const lo = Math.min(...vs);
  const span = Math.max(...vs) - lo || 1;
  const step = points.length > 1 ? width / (points.length - 1) : 0;
  return points
    .map((p, i) => {
      const x = points.length > 1 ? i * step : width / 2;
      const y = height - ((p.v - lo) / span) * height;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
}
