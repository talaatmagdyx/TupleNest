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

/** Whole type names only: a substring test counted `interval` (int…),
 *  `point` and `int4range` as numbers, right-aligning them and picking them as
 *  a chart's value column, which then drew nothing. */
const NUMERIC =
  /^(int2|int4|int8|smallint|integer|bigint|numeric|decimal|float4|float8|real|double precision|money|oid)(\(.*\))?$/i;

export function isNumericType(dbType: string): boolean {
  return NUMERIC.test(dbType.trim());
}

/**
 * Order two numeric cells exactly.
 *
 * Cells arrive as numbers, or as text where a number would lose precision:
 * `numeric` always, int8 past 2^53. Comparing those with `localeCompare`
 * sorted "100.00" before "20.00", and mixing numbers with strings made the
 * comparator inconsistent. This compares decimal strings digit by digit, so
 * nothing is rounded on the way, with NaN above +Infinity as PostgreSQL has it.
 */
export function compareNumeric(x: unknown, y: unknown): number {
  // Two plain numbers compare exactly as numbers (and floats like 1e+21,
  // whose text form the digit comparison below does not read).
  if (typeof x === "number" && typeof y === "number") return Math.sign(x - y);
  const rank = (s: string) => (s === "NaN" ? 2 : s === "Infinity" ? 1 : s === "-Infinity" ? -1 : 0);
  const a = String(x).trim();
  const b = String(y).trim();
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== 0 || rb !== 0) return ra - rb;
  const parse = (s: string) => {
    const neg = s.startsWith("-");
    const body = s.replace(/^[-+]/, "");
    const [i = "0", f = ""] = body.split(".");
    return { neg, int: i.replace(/^0+(?=\d)/, ""), frac: f.replace(/0+$/, "") };
  };
  const p = parse(a);
  const q = parse(b);
  const sign = (n: { neg: boolean; int: string; frac: string }) =>
    /^0*$/.test(n.int) && n.frac === "" ? 0 : n.neg ? -1 : 1;
  const sp = sign(p);
  const sq = sign(q);
  if (sp !== sq) return sp - sq;
  if (sp === 0) return 0;
  // Same sign: compare magnitudes — integer length, then digits, then the
  // fraction padded to the same length.
  let mag: number;
  if (p.int.length !== q.int.length) mag = p.int.length - q.int.length;
  else if (p.int !== q.int) mag = p.int < q.int ? -1 : 1;
  else {
    const len = Math.max(p.frac.length, q.frac.length);
    const fa = p.frac.padEnd(len, "0");
    const fb = q.frac.padEnd(len, "0");
    mag = fa < fb ? -1 : fa > fb ? 1 : 0;
  }
  return sp * Math.sign(mag);
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
