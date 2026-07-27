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
  /** `nullable` is the target's, so the migration can restore a NOT NULL the
   *  bare ADD COLUMN cannot carry. */
  | { kind: "added"; column: string; type: string; nullable: boolean }
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
      if (!lMap.has(c.name.toLowerCase()))
        cols.push({ kind: "added", column: c.name, type: c.dbType, nullable: c.nullable });
    }

    if (cols.length) out.push({ kind: "changed", table: t, columns: cols });
  }
  return out;
}

/* --------------------------------------------------------- migration script */

export type MigrationRisk = "safe" | "review" | "destructive";

export type MigrationStatement = {
  /** The statement. A destructive one is returned already commented out. */
  sql: string;
  risk: MigrationRisk;
  /** Why it carries that risk, in one line, for display beside it. */
  note: string;
};

const q = (id: string) => `"${id.replace(/"/g, '""')}"`;
const qt = (schema: string, table: string) => `${q(schema)}.${q(table)}`;

/** Comment a statement out so it cannot be run by pasting the script whole. */
const commented = (sql: string) => sql.split("\n").map((l) => `-- ${l}`).join("\n");

/**
 * Turn a schema diff into DDL a human can read, edit, and decide about.
 *
 * This deliberately does not execute anything, and never offers to. The whole
 * category of harm here is a statement that runs before someone has understood
 * it, so the output is text and only text.
 *
 * Three risk levels, and the distinction is the point:
 *
 *  - **safe** — additive and reversible: a new nullable column, a dropped NOT
 *    NULL constraint.
 *  - **review** — will run, but can fail or change data depending on what is
 *    already in the table: a type change, adding NOT NULL, adding a column
 *    declared NOT NULL without a default.
 *  - **destructive** — loses data if it succeeds. `DROP TABLE`, `DROP COLUMN`.
 *    These come back **commented out**, so pasting the whole script cannot
 *    execute them; you have to uncomment each one deliberately.
 *
 * Adds are emitted before drops so a script that is run top to bottom never
 * removes something a later statement needed.
 */
export function generateMigration(
  diffs: TableDiff[],
  /** The schema the statements are addressed to — the *left* side of the diff,
   *  since a diff of left→right describes what left is missing. Passing the
   *  right schema here produces DDL that re-adds columns it already has. */
  schema: string,
  /** Columns of the *target* schema, so a newly added table can be written out
   *  in full. Without it, a new table is reported but not defined — the diff
   *  alone does not carry its shape. */
  target?: Record<string, DbColumn[]>,
): MigrationStatement[] {
  const adds: MigrationStatement[] = [];
  const drops: MigrationStatement[] = [];

  for (const d of diffs) {
    if (d.kind === "added") {
      const cols = target?.[d.table];
      if (cols?.length) {
        const body = cols
          .map((c) => `  ${q(c.name)} ${c.dbType}${c.nullable ? "" : " NOT NULL"}`)
          .join(",\n");
        adds.push({
          sql: `CREATE TABLE ${qt(schema, d.table)} (\n${body}\n);`,
          risk: "review",
          note: "New table. Primary keys, defaults, indexes and constraints are not part of a column diff — add them before running.",
        });
      } else {
        adds.push({
          sql: commented(`CREATE TABLE ${qt(schema, d.table)} ( ... );`),
          risk: "review",
          note: "New table, but its columns were not loaded, so the definition cannot be written for you.",
        });
      }
      continue;
    }

    if (d.kind === "removed") {
      drops.push({
        sql: commented(`DROP TABLE ${qt(schema, d.table)};`),
        risk: "destructive",
        note: "Drops the table and everything in it. Commented out deliberately.",
      });
      continue;
    }

    for (const c of d.columns) {
      const t = qt(schema, d.table);
      switch (c.kind) {
        case "added":
          // Always added nullable first. `ADD COLUMN ... NOT NULL` in one step
          // fails outright on a table that already has rows, so the constraint
          // is a separate statement you run after backfilling.
          adds.push({
            sql: `ALTER TABLE ${t} ADD COLUMN ${q(c.column)} ${c.type};`,
            risk: "safe",
            note: "Adds a nullable column. Existing rows get NULL.",
          });
          if (!c.nullable) {
            adds.push({
              sql: `ALTER TABLE ${t} ALTER COLUMN ${q(c.column)} SET NOT NULL;`,
              risk: "review",
              note: "The column is NOT NULL in the target. This fails until every existing row has a value, so backfill first.",
            });
          }
          break;
        case "removed":
          drops.push({
            sql: commented(`ALTER TABLE ${t} DROP COLUMN ${q(c.column)};`),
            risk: "destructive",
            note: "Discards every value in that column. Commented out deliberately.",
          });
          break;
        case "type-changed":
          adds.push({
            sql: `ALTER TABLE ${t} ALTER COLUMN ${q(c.column)} TYPE ${c.to} USING ${q(c.column)}::${c.to};`,
            risk: "review",
            note: `${c.from} → ${c.to}. The cast can fail on existing rows, or silently lose precision; PostgreSQL rewrites the whole table and holds an ACCESS EXCLUSIVE lock while it does.`,
          });
          break;
        case "nullability-changed":
          adds.push(
            c.to
              ? {
                  sql: `ALTER TABLE ${t} ALTER COLUMN ${q(c.column)} DROP NOT NULL;`,
                  risk: "safe",
                  note: "Relaxes a constraint; cannot fail on existing data.",
                }
              : {
                  sql: `ALTER TABLE ${t} ALTER COLUMN ${q(c.column)} SET NOT NULL;`,
                  risk: "review",
                  note: "Fails if any existing row holds NULL in that column.",
                },
          );
          break;
        case "pk-changed":
          adds.push({
            sql: commented(
              c.to
                ? `ALTER TABLE ${t} ADD PRIMARY KEY (${q(c.column)});`
                : `ALTER TABLE ${t} DROP CONSTRAINT <name>;  -- the diff does not carry the constraint's name`,
            ),
            risk: "review",
            note: "Primary keys are named constraints and a column diff does not carry the name, so this is a sketch rather than a statement. Commented out.",
          });
          break;
      }
    }
  }

  return [...adds, ...drops];
}

/** The script as one pasteable block, with a header saying what it is not. */
export function migrationScript(statements: MigrationStatement[]): string {
  if (statements.length === 0) return "-- No differences.\n";
  const header = [
    "-- Generated from a schema comparison by TupleNest.",
    "-- Review every line before running any of it. Nothing here has been executed.",
    "-- Destructive statements are commented out on purpose; uncomment deliberately.",
    "",
  ];
  return [...header, ...statements.map((s) => `-- [${s.risk}] ${s.note}\n${s.sql}\n`)].join("\n");
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

/* ------------------------------------------------------- per-node plan diff */

export type NodeDiffKind = "same" | "slower" | "faster" | "added" | "removed";

export type PlanNodeDiff = {
  /** Indent level in the tree, for drawing. */
  depth: number;
  /** `Seq Scan on orders` — node type plus relation when there is one. */
  label: string;
  kind: NodeDiffKind;
  msLeft: number | null;
  msRight: number | null;
  msDelta: number | null;
  msPercent: number | null;
  costLeft: number | null;
  costRight: number | null;
  rowsLeft: number | null;
  rowsRight: number | null;
  /** True when this subtree could not be matched confidently — several
   *  siblings of the same shape, so which one is "the same node" is a guess.
   *  Shown rather than hidden: a wrong attribution reads exactly like a real
   *  regression, and that is the failure worth avoiding. */
  ambiguous: boolean;
};

/** A node is "changed" only past both floors: below them the difference is
 *  measurement noise, and flagging it trains people to ignore the flag. */
const DIFF_MIN_MS = 1;
const DIFF_MIN_PCT = 10;

const num = (n: RawPlan, k: string): number | null => {
  const v = n[k];
  return typeof v === "number" ? v : null;
};

/** What identifies a node for matching: its type and, when it has one, the
 *  relation it reads. Costs and timings are deliberately excluded — those are
 *  what we are trying to compare, so they cannot also decide identity. */
function nodeKey(n: RawPlan): string {
  const str = (k: string): string | null => {
    const v = n[k];
    return typeof v === "string" ? v : null;
  };
  const t = str("Node Type") ?? "node";
  const rel = str("Relation Name");
  const idx = str("Index Name");
  return rel ? `${t} on ${rel}${idx ? ` using ${idx}` : ""}` : t;
}

const kids = (n: RawPlan): RawPlan[] => (Array.isArray(n["Plans"]) ? (n["Plans"] as RawPlan[]) : []);

/**
 * Align two plan trees and report what changed at each node.
 *
 * Children are paired by `nodeKey` in order: the first unclaimed right-hand
 * child with the same key matches. Anything left over on one side is reported
 * as added or removed rather than force-matched to something it is not.
 *
 * The ambiguity this cannot resolve is two siblings with the *same* key — say
 * a join with two `Seq Scan on orders` children. Position is then the only
 * signal and it may be wrong, so those pairs are flagged `ambiguous` instead of
 * being presented with the same confidence as the rest. Guessing silently here
 * is how the bottleneck badge ended up on the wrong node in beta.5.
 */
export function diffPlanTrees(leftRoot: RawPlan, rightRoot: RawPlan): PlanNodeDiff[] {
  const out: PlanNodeDiff[] = [];

  const entry = (n: RawPlan, depth: number, kind: "added" | "removed"): void => {
    const ms = num(n, "Actual Total Time");
    const cost = num(n, "Total Cost");
    const rows = num(n, "Actual Rows") ?? num(n, "Plan Rows");
    out.push({
      depth,
      label: nodeKey(n),
      kind,
      msLeft: kind === "removed" ? ms : null,
      msRight: kind === "added" ? ms : null,
      msDelta: null,
      msPercent: null,
      costLeft: kind === "removed" ? cost : null,
      costRight: kind === "added" ? cost : null,
      rowsLeft: kind === "removed" ? rows : null,
      rowsRight: kind === "added" ? rows : null,
      ambiguous: false,
    });
    for (const c of kids(n)) entry(c, depth + 1, kind);
  };

  const walk = (a: RawPlan, b: RawPlan, depth: number, ambiguous: boolean): void => {
    const msLeft = num(a, "Actual Total Time");
    const msRight = num(b, "Actual Total Time");
    const msDelta = msLeft !== null && msRight !== null ? msRight - msLeft : null;
    const msPercent = msLeft !== null && msRight !== null && msLeft !== 0 ? ((msRight - msLeft) / msLeft) * 100 : null;

    let kind: NodeDiffKind = "same";
    if (msDelta !== null && msPercent !== null) {
      const big = Math.abs(msDelta) >= DIFF_MIN_MS && Math.abs(msPercent) >= DIFF_MIN_PCT;
      if (big) kind = msDelta > 0 ? "slower" : "faster";
    }

    out.push({
      depth,
      label: nodeKey(a),
      kind,
      msLeft,
      msRight,
      msDelta,
      msPercent,
      costLeft: num(a, "Total Cost"),
      costRight: num(b, "Total Cost"),
      rowsLeft: num(a, "Actual Rows") ?? num(a, "Plan Rows"),
      rowsRight: num(b, "Actual Rows") ?? num(b, "Plan Rows"),
      ambiguous,
    });

    // Pair children by key, first-unclaimed-wins, preserving order.
    const bKids = kids(b);
    const claimed = new Set<number>();
    for (const ac of kids(a)) {
      const key = nodeKey(ac);
      const matches = bKids.map((n, i) => ({ n, i })).filter(({ n, i }) => !claimed.has(i) && nodeKey(n) === key);
      if (matches.length === 0) {
        entry(ac, depth + 1, "removed");
        continue;
      }
      claimed.add(matches[0].i);
      // More than one candidate means position was the tie-breaker, which is
      // not evidence. Mark the whole subtree rather than the single node.
      const sameKeySiblings = kids(a).filter((s) => nodeKey(s) === key).length > 1;
      walk(ac, matches[0].n, depth + 1, ambiguous || sameKeySiblings);
    }
    bKids.forEach((bc, i) => {
      if (!claimed.has(i)) entry(bc, depth + 1, "added");
    });
  };

  const a = (leftRoot["Plan"] as RawPlan) ?? leftRoot;
  const b = (rightRoot["Plan"] as RawPlan) ?? rightRoot;
  walk(a, b, 0, false);
  return out;
}

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
