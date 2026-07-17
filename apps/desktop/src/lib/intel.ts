/** Phase 3 — SQL intelligence.
 *
 *  Static analysis over SQL text and schema metadata: find where an object is
 *  used, rename an alias safely, diff two schemas, and compare two EXPLAIN
 *  plans. Pure functions, unit tested — no React, no IPC.
 */

import type { DbColumn } from "../ipc/types";
import type { Catalog } from "./complete";
import { maskLiterals, parseTableRefs } from "./complete";

/* ------------------------------------------------------------------ usages */

export type Usage = {
  /** Character offset of the match in the original text. */
  start: number;
  end: number;
  /** 1-based line number, for display. */
  line: number;
  /** The whole line, trimmed, for a preview. */
  preview: string;
};

/**
 * A character that can appear inside an identifier.
 *
 * `\p{L}` and `\p{N}` rather than `A-Za-z0-9`: PostgreSQL identifiers are
 * unicode, and an ASCII-only class does not just miss them — it reports
 * *spurious* matches. In `café_id`, `é` looked like a boundary, so searching
 * for `id` found a whole-word match inside a longer name, which is the one
 * thing this check exists to prevent.
 *
 * The `u` flag is what makes the property escapes work.
 */
const IDENT_CH = /[\p{L}\p{N}_$]/u;

/** Every standalone occurrence of `name` in `sql`, ignoring comments, string
 *  literals, and substrings of longer identifiers (`users` must not match
 *  inside `users_archive`). Case-insensitive, as SQL identifiers are. */
export function findUsages(sql: string, name: string): Usage[] {
  if (!name) return [];
  const masked = maskLiterals(sql);
  const hay = masked.toLowerCase();
  const needle = name.toLowerCase();
  const out: Usage[] = [];

  let from = 0;
  for (;;) {
    const i = hay.indexOf(needle, from);
    if (i === -1) break;
    from = i + needle.length;

    const before = i > 0 ? masked[i - 1] : "";
    const after = i + needle.length < masked.length ? masked[i + needle.length] : "";
    // Reject substrings of a longer identifier, but allow a `.` before
    // (schema.table / alias.column are real usages).
    if (before && IDENT_CH.test(before)) continue;
    if (after && IDENT_CH.test(after)) continue;

    const lineStart = sql.lastIndexOf("\n", i - 1) + 1;
    let lineEnd = sql.indexOf("\n", i);
    if (lineEnd === -1) lineEnd = sql.length;
    const line = sql.slice(0, i).split("\n").length;

    out.push({ start: i, end: i + needle.length, line, preview: sql.slice(lineStart, lineEnd).trim() });
  }
  return out;
}

/** Rename every standalone occurrence. Returns the new text and the count.
 *  Applied right-to-left so earlier offsets stay valid. */
export function renameIdentifier(sql: string, from: string, to: string): { sql: string; count: number } {
  const hits = findUsages(sql, from);
  let out = sql;
  for (let i = hits.length - 1; i >= 0; i--) {
    out = out.slice(0, hits[i].start) + to + out.slice(hits[i].end);
  }
  return { sql: out, count: hits.length };
}

/** Tables the statement touches that the catalog doesn't know about — usually
 *  a typo or a missing search_path. */
export function unknownTables(sql: string, cat: Catalog): string[] {
  const known = new Set(cat.tables.map((t) => t.name.toLowerCase()));
  const out: string[] = [];
  for (const r of parseTableRefs(sql)) {
    if (!known.has(r.name.toLowerCase()) && !out.includes(r.name)) out.push(r.name);
  }
  return out;
}

/* -------------------------------------------------------------- schema diff */

export type ColumnDiff =
  | { kind: "added"; column: string; type: string }
  | { kind: "removed"; column: string; type: string }
  | { kind: "type-changed"; column: string; from: string; to: string }
  | { kind: "nullability-changed"; column: string; from: boolean; to: boolean }
  | { kind: "pk-changed"; column: string; from: boolean; to: boolean };

export type TableDiff =
  | { kind: "added"; table: string }
  | { kind: "removed"; table: string }
  | { kind: "changed"; table: string; columns: ColumnDiff[] };

/** Compare two schemas' column maps. Keys are bare table names. */
export function diffSchemas(
  left: Record<string, DbColumn[]>,
  right: Record<string, DbColumn[]>
): TableDiff[] {
  const out: TableDiff[] = [];
  const names = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();

  for (const t of names) {
    const l = left[t];
    const r = right[t];
    if (!l) {
      out.push({ kind: "added", table: t });
      continue;
    }
    if (!r) {
      out.push({ kind: "removed", table: t });
      continue;
    }

    const cols: ColumnDiff[] = [];
    const lMap = new Map(l.map((c) => [c.name.toLowerCase(), c]));
    const rMap = new Map(r.map((c) => [c.name.toLowerCase(), c]));

    for (const c of l) {
      const other = rMap.get(c.name.toLowerCase());
      if (!other) {
        cols.push({ kind: "removed", column: c.name, type: c.dbType });
        continue;
      }
      if (c.dbType !== other.dbType) {
        cols.push({ kind: "type-changed", column: c.name, from: c.dbType, to: other.dbType });
      }
      if (c.nullable !== other.nullable) {
        cols.push({ kind: "nullability-changed", column: c.name, from: c.nullable, to: other.nullable });
      }
      if (c.primaryKey !== other.primaryKey) {
        cols.push({ kind: "pk-changed", column: c.name, from: c.primaryKey, to: other.primaryKey });
      }
    }
    for (const c of r) {
      if (!lMap.has(c.name.toLowerCase())) cols.push({ kind: "added", column: c.name, type: c.dbType });
    }

    if (cols.length) out.push({ kind: "changed", table: t, columns: cols });
  }
  return out;
}

/* ---------------------------------------------------------- plan comparison */

export type PlanSummary = {
  /** Total estimated/actual cost or time, whichever the plan carries. */
  totalMs: number | null;
  totalCost: number | null;
  rows: number | null;
  /** Node type → occurrences, for spotting a seq scan that used to be an index scan. */
  nodes: Record<string, number>;
};

type RawPlan = Record<string, unknown>;

/** Walk a Postgres `EXPLAIN (FORMAT JSON)` tree into a comparable summary. */
export function summarizePlan(plan: RawPlan): PlanSummary {
  const nodes: Record<string, number> = {};
  let rows: number | null = null;

  const walk = (n: RawPlan) => {
    const t = n["Node Type"];
    if (typeof t === "string") nodes[t] = (nodes[t] ?? 0) + 1;
    if (rows === null) {
      const r = n["Actual Rows"] ?? n["Plan Rows"];
      if (typeof r === "number") rows = r;
    }
    const kids = n["Plans"];
    if (Array.isArray(kids)) for (const k of kids) walk(k as RawPlan);
  };

  const root = (plan["Plan"] as RawPlan) ?? plan;
  walk(root);

  const totalMs = typeof plan["Execution Time"] === "number" ? (plan["Execution Time"]) : null;
  const totalCost = typeof root["Total Cost"] === "number" ? (root["Total Cost"]) : null;

  return { totalMs, totalCost, rows, nodes };
}

export type PlanDelta = {
  /** Positive = `right` is slower/costlier than `left`. */
  msDelta: number | null;
  costDelta: number | null;
  /** Percentage change, positive = regression. */
  msPercent: number | null;
  costPercent: number | null;
  /** Node types that appear/disappear or change count. */
  nodeChanges: { node: string; from: number; to: number }[];
  /** A seq scan appearing where there wasn't one is the classic regression. */
  newSeqScan: boolean;
};

export function comparePlans(left: PlanSummary, right: PlanSummary): PlanDelta {
  const pct = (a: number | null, b: number | null) =>
    a === null || b === null || a === 0 ? null : ((b - a) / a) * 100;

  const names = [...new Set([...Object.keys(left.nodes), ...Object.keys(right.nodes)])].sort();
  const nodeChanges = names
    .map((node) => ({ node, from: left.nodes[node] ?? 0, to: right.nodes[node] ?? 0 }))
    .filter((c) => c.from !== c.to);

  const seq = (n: Record<string, number>) => n["Seq Scan"] ?? 0;

  return {
    msDelta: left.totalMs !== null && right.totalMs !== null ? right.totalMs - left.totalMs : null,
    costDelta: left.totalCost !== null && right.totalCost !== null ? right.totalCost - left.totalCost : null,
    msPercent: pct(left.totalMs, right.totalMs),
    costPercent: pct(left.totalCost, right.totalCost),
    nodeChanges,
    newSeqScan: seq(right.nodes) > seq(left.nodes),
  };
}
