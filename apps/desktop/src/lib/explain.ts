/** EXPLAIN option handling: build the statement, validate the combination,
 *  and export the resulting plan.
 *
 *  The dependency rules below were verified against a live PostgreSQL 18, not
 *  taken from memory — the server is the authority:
 *
 *      EXPLAIN (TIMING) SELECT 1        → ERROR: option TIMING requires ANALYZE
 *      EXPLAIN (WAL) SELECT 1           → ERROR: option WAL requires ANALYZE
 *      EXPLAIN (SERIALIZE) SELECT 1     → ERROR: option SERIALIZE requires ANALYZE
 *      EXPLAIN (ANALYZE, GENERIC_PLAN)  → ERROR: cannot be used together
 *      EXPLAIN (BUFFERS) SELECT 1       → ok (no ANALYZE needed on 13+)
 */

import { maskLiterals } from "./complete";
import { cellText, mdCell } from "./text";

export type ExplainFormat = "json" | "text" | "yaml" | "xml";

export type ExplainOptions = {
  analyze: boolean;
  verbose: boolean;
  costs: boolean;
  buffers: boolean;
  settings: boolean;
  wal: boolean;
  timing: boolean;
  summary: boolean;
  memory: boolean;
  serialize: boolean;
  genericPlan: boolean;
  format: ExplainFormat;
};

export const DEFAULT_EXPLAIN: ExplainOptions = {
  analyze: false,
  verbose: false,
  costs: true, // Postgres defaults COSTS on; the plan tree is useless without it
  buffers: true,
  settings: false,
  wal: false,
  timing: false,
  summary: false,
  memory: false,
  serialize: false,
  genericPlan: false,
  format: "json", // the UI parses JSON to draw the tree
};

/** Options that the server refuses unless ANALYZE is also set. */
export const NEEDS_ANALYZE = ["timing", "wal", "serialize"] as const;

export type OptionMeta = {
  key: keyof ExplainOptions;
  label: string;
  hint: string;
  /** Minimum server major version, when the option is not universally available. */
  since?: number;
};

export const OPTION_META: OptionMeta[] = [
  { key: "analyze", label: "ANALYZE", hint: "Actually run the query and report real timings" },
  { key: "buffers", label: "BUFFERS", hint: "Shared/local block hits, reads and writes" },
  { key: "verbose", label: "VERBOSE", hint: "Output columns, schema-qualified names" },
  { key: "costs", label: "COSTS", hint: "Estimated start-up and total cost" },
  { key: "timing", label: "TIMING", hint: "Per-node actual timings — needs ANALYZE" },
  { key: "wal", label: "WAL", hint: "WAL records generated — needs ANALYZE" },
  { key: "settings", label: "SETTINGS", hint: "Non-default planner settings in effect", since: 12 },
  { key: "memory", label: "MEMORY", hint: "Planner memory usage", since: 17 },
  { key: "serialize", label: "SERIALIZE", hint: "Cost of serialising output — needs ANALYZE", since: 17 },
  { key: "genericPlan", label: "GENERIC_PLAN", hint: "Plan for a parameterised query — cannot pair with ANALYZE", since: 16 },
];

/** Statements EXPLAIN ANALYZE would really execute, not merely plan. */
const MUTATING = /^\s*(insert|update|delete|merge|truncate|drop|alter|create|grant|revoke|reindex|vacuum|refresh)\b/i;

export function isMutating(sql: string): boolean {
  return MUTATING.test(maskLiterals(sql).trimStart());
}

export type Issue = { level: "error" | "warning"; message: string };

/** Everything wrong with this combination, before we bother the server. */
export function optionIssues(o: ExplainOptions, sql: string, serverMajor?: number): Issue[] {
  const out: Issue[] = [];

  for (const k of NEEDS_ANALYZE) {
    if (o[k] && !o.analyze) {
      out.push({ level: "error", message: `${k.toUpperCase()} requires ANALYZE.` });
    }
  }
  if (o.genericPlan && o.analyze) {
    out.push({ level: "error", message: "ANALYZE and GENERIC_PLAN cannot be used together." });
  }
  if (o.analyze && isMutating(sql)) {
    out.push({
      level: "warning",
      message: "ANALYZE executes the statement for real — this query modifies data.",
    });
  }
  if (serverMajor !== undefined) {
    for (const m of OPTION_META) {
      if (m.since && serverMajor < m.since && o[m.key]) {
        out.push({ level: "error", message: `${m.label} needs PostgreSQL ${m.since}+ (server is ${serverMajor}).` });
      }
    }
  }
  return out;
}

/** `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) <sql>` */
export function buildExplain(sql: string, o: ExplainOptions): string {
  const parts: string[] = [];
  if (o.analyze) parts.push("ANALYZE");
  if (o.verbose) parts.push("VERBOSE");
  // COSTS defaults to on; only worth emitting when switched off.
  if (!o.costs) parts.push("COSTS FALSE");
  if (o.settings) parts.push("SETTINGS");
  if (o.buffers) parts.push("BUFFERS");
  if (o.wal) parts.push("WAL");
  if (o.timing) parts.push("TIMING");
  if (o.summary) parts.push("SUMMARY");
  if (o.memory) parts.push("MEMORY");
  if (o.serialize) parts.push("SERIALIZE");
  if (o.genericPlan) parts.push("GENERIC_PLAN");
  parts.push(`FORMAT ${o.format.toUpperCase()}`);
  return `EXPLAIN (${parts.join(", ")}) ${sql.trim().replace(/;\s*$/, "")}`;
}

/** Short label for the modal chip: "EXPLAIN ANALYZE, BUFFERS". */
export function explainLabel(o: ExplainOptions): string {
  const on = OPTION_META.filter((m) => m.key !== "costs" && o[m.key]).map((m) => m.label);
  return on.length ? `EXPLAIN ${on.join(", ")}` : "EXPLAIN";
}

/* ------------------------------------------------------------------- parse */

/** A node of the server's FORMAT JSON plan. Postgres nests children under
 *  `Plans`; every other key is optional and version-dependent, so nothing here
 *  is assumed to exist. */
export type RawPlan = Record<string, unknown> & { Plans?: RawPlan[] };

/**
 * Reading a plan attribute.
 *
 * Every key here is `unknown` and version-dependent, and this file used to get
 * at them with `as number` / `as string[]` — assertions, not checks. On a
 * server that spells an attribute differently, or omits it, the cast is simply
 * wrong: `(n["Actual Rows"] as number).toLocaleString()` throws on a value that
 * was never there. These look instead, and say so when the answer is nothing.
 */
const attrNum = (n: RawPlan, key: string): number | null =>
  typeof n[key] === "number" ? n[key] : null;

const attrText = (n: RawPlan, key: string): string | null => {
  const v = n[key];
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.map((x) => cellText(x)).join(", ");
  return cellText(v);
};

/** A per-node call-out. Each is something a reader would otherwise have to
 *  spot by eye in a wall of plan text. */
export type NodeFlag =
  | "bottleneck"
  | "seq-scan"
  | "disk-sort"
  | "spill"
  | "misestimate"
  | "wasteful-filter"
  | "heavy-read"
  | "high-loops"
  | "never-executed";

/** Block counts for a node, as reported by BUFFERS.
 *
 *  PostgreSQL reports these cumulatively: a parent's counts include everything
 *  its children read. `selfRead` is the part this node read itself, which is
 *  the only number that identifies *which* node actually went to disk. */
export type NodeBuffers = {
  hit: number | null;
  read: number | null;
  dirtied: number | null;
  written: number | null;
  tempRead: number | null;
  tempWritten: number | null;
  selfRead: number | null;
};

/** A plan-level observation with a suggested next step. */
export type Insight = { level: "tip" | "warn" | "info"; text: string };

export type ParsedPlanNode = {
  kind: string;
  title: string;
  detail: string;
  /** Real measured time (inclusive of children). Null unless ANALYZE ran — an
   *  estimate is not a timing and must not be drawn as one. */
  ms: number | null;
  /** Share of the plan's total, for the bar. */
  pct: number;
  indent: number;
  /** The costliest sequential scan, when there is one worth pointing at.
   *  Kept for the index suggestion; the visual bottleneck is `flags`. */
  hot: boolean;
  /** Time spent *in this node itself* — inclusive minus the children, adjusted
   *  for loops. This, not inclusive time, is where a plan actually spends its
   *  time: a Nested Loop can show a large total that is entirely its child's.
   *  Null unless ANALYZE ran. */
  selfMs: number | null;
  /** Self-time as a share of execution time, for the "time spent here" bar. */
  selfPct: number;
  /** Estimated and actual row counts (per loop), when the server gave them. */
  rowsEst: number | null;
  rowsActual: number | null;
  /** How far the estimate missed, as a ratio ≥ 1, when it missed badly enough
   *  to matter. Null when the estimate was close or rows are absent. */
  misestimate: number | null;
  /** How many times the node ran. A large count on the inner side of a nested
   *  loop is a classic pathology that inclusive time alone hides. */
  loops: number | null;
  /** Rows the node read and threw away. A scan that discards nearly everything
   *  it reads is the clearest "this wants an index" signal in a plan. */
  rowsRemoved: number | null;
  /** Block counts from BUFFERS, when it was requested. */
  buffers: NodeBuffers | null;
  /** Call-outs worth a badge next to the node. */
  flags: NodeFlag[];
};

export type ParsedPlan = {
  nodes: ParsedPlanNode[];
  stats: { label: string; value: string }[];
  /** The single index hint, kept for backward compatibility. */
  suggestion: string | null;
  /** The richer, ordered set of observations shown under the plan. */
  insights: Insight[];
};

/** An estimate this many times off (in either direction) is worth flagging —
 *  below it, planner noise, above it, a reason a good plan wasn't chosen. */
const MISESTIMATE_RATIO = 10;
/** A node holding at least this share of execution self-time is the bottleneck.
 *  It must also account for at least BOTTLENECK_MIN_MS — on a query that
 *  finishes in microseconds, "busiest node, 0.0 ms" is noise, not a finding. */
const BOTTLENECK_PCT = 20;
const BOTTLENECK_MIN_MS = 1;
/** A filter that throws away at least this many rows, and at least this many
 *  times more than it keeps, is worth an index. */
const WASTEFUL_FILTER_ROWS = 1000;
const WASTEFUL_FILTER_RATIO = 10;
/** Blocks read from disk (8 kB each) before it is worth mentioning — 1000
 *  blocks is ~8 MB that did not come from cache. */
const HEAVY_READ_BLOCKS = 1000;
/** Loop counts above this are worth showing as a pathology in their own right. */
const HIGH_LOOPS = 10_000;
/** JIT costing more than this share of execution is usually not worth it. */
const JIT_PCT = 25;

/**
 * How many workers execute the children of this node concurrently.
 *
 * This is the correction that makes self-time honest on a parallel plan.
 * PostgreSQL reports `Actual Loops` on a node beneath a Gather as the number
 * of processes that ran it, and those processes run *at the same time*. So
 * `Actual Total Time × Actual Loops` there is CPU time summed across workers,
 * not wall-clock — which is how a leaf could otherwise be charged 29.7 ms of a
 * 21.4 ms query. Dividing by the worker count turns it back into wall time.
 *
 * Loops from a Nested Loop's inner side are the opposite case: those really do
 * run one after another, so they must stay multiplied. Only a Gather starts a
 * concurrent region, so only a Gather changes the divisor.
 */
function workersUnder(n: RawPlan, current: number): number {
  if (!/gather/i.test(attrText(n, "Node Type") ?? "")) return current;
  const launched = attrNum(n, "Workers Launched") ?? attrNum(n, "Workers Planned") ?? 0;
  // The leader participates too, so the concurrency is workers + 1.
  return Math.max(1, launched + 1);
}

/** Inclusive wall time for a node. `Actual Total Time` is per loop; loops that
 *  ran concurrently (parallel workers) are divided back out by `workers`. Null
 *  without ANALYZE, and for a node the executor never reached. */
function inclusiveMs(n: RawPlan, workers = 1): number | null {
  if (isNeverExecuted(n)) return null;
  const t = attrNum(n, "Actual Total Time");
  if (t === null) return null;
  const loops = attrNum(n, "Actual Loops");
  const raw = loops && loops > 0 ? loops : 1;
  const effective = workers > 1 ? Math.max(1, raw / workers) : raw;
  return t * effective;
}

/** A node the executor never reached — e.g. the far side of a short-circuited
 *  branch. PostgreSQL says so explicitly; showing a blank timing reads as a bug. */
function isNeverExecuted(n: RawPlan): boolean {
  if (n["Never Executed"] === true) return true;
  return attrNum(n, "Actual Loops") === 0;
}

/** BUFFERS block counts, or null when BUFFERS was not requested.
 *
 *  `selfRead` subtracts the children's reads, because PostgreSQL reports these
 *  cumulatively. Without it every ancestor of a scan inherits its block count
 *  and an Aggregate gets blamed for the disk reads its child actually did. */
function buffersOf(n: RawPlan): NodeBuffers | null {
  const read = attrNum(n, "Shared Read Blocks");
  let selfRead: number | null = null;
  if (read !== null) {
    let childRead = 0;
    for (const c of n.Plans ?? []) childRead += attrNum(c, "Shared Read Blocks") ?? 0;
    selfRead = Math.max(0, read - childRead);
  }
  const b: NodeBuffers = {
    hit: attrNum(n, "Shared Hit Blocks"),
    read,
    dirtied: attrNum(n, "Shared Dirtied Blocks"),
    written: attrNum(n, "Shared Written Blocks"),
    tempRead: attrNum(n, "Temp Read Blocks"),
    tempWritten: attrNum(n, "Temp Written Blocks"),
    selfRead,
  };
  return Object.values(b).some((v) => v !== null) ? b : null;
}

/** Ratio by which the row estimate missed, or null if it was close enough or
 *  the counts are absent. `+1` avoids dividing by zero and stops a 0-vs-1 row
 *  difference from reading as an infinite miss. */
function misestimateOf(est: number | null, act: number | null): number | null {
  if (est === null || act === null) return null;
  const e = est + 1;
  const a = act + 1;
  const r = a >= e ? a / e : e / a;
  return r >= MISESTIMATE_RATIO ? r : null;
}

/** A sort or hash that ran out of `work_mem` and went to disk. */
function isDiskSort(n: RawPlan): boolean {
  const method = attrText(n, "Sort Method");
  const space = attrText(n, "Sort Space Type");
  return (!!method && /disk|external/i.test(method)) || (!!space && /disk/i.test(space));
}
function isHashSpill(n: RawPlan): boolean {
  // A Hash node and a spilling HashAggregate are both "the hash didn't fit",
  // but the server files their batch counts under different keys — checking
  // only the first missed every aggregate that spilled, which is the case most
  // likely to be fixed by raising work_mem.
  return (attrNum(n, "Hash Batches") ?? 1) > 1 || (attrNum(n, "HashAgg Batches") ?? 1) > 1;
}

/**
 * Assemble the server's payload from the rows it came back in.
 *
 * FORMAT TEXT returns one row *per line* of the plan — 295 rows for a real
 * query against this database — so it has to be rejoined. Every other format
 * returns the whole document in a single cell.
 */
export function readPlanPayload(rows: unknown[][], format: ExplainFormat): string {
  if (format === "text") return rows.map((r) => (r[0] === null || r[0] === undefined ? "" : cellText(r[0]))).join("\n");
  const cell = rows[0]?.[0];
  return typeof cell === "string" ? cell : JSON.stringify(cell);
}

/** Fold a node's interesting attributes into one line, skipping what's absent. */
function nodeDetail(n: RawPlan): string {
  const actual = attrNum(n, "Actual Rows");
  const est = attrNum(n, "Plan Rows");
  const rows =
    actual !== null ? `rows ${actual.toLocaleString()}` : est !== null ? `est rows ${est.toLocaleString()}` : null;
  const idx = attrText(n, "Index Name");
  const filter = attrText(n, "Filter");
  const cond = attrText(n, "Hash Cond");
  const sort = attrText(n, "Sort Key");
  // Everything below is appended only when the server sent it, so a plan
  // without BUFFERS or a filter reads exactly as it did before.
  const removed = attrNum(n, "Rows Removed by Filter");
  const loops = attrNum(n, "Actual Loops");
  const b = buffersOf(n);
  const bufBits = b
    ? [
        b.hit ? `${b.hit.toLocaleString()} hit` : null,
        b.read ? `${b.read.toLocaleString()} read` : null,
        b.written ? `${b.written.toLocaleString()} written` : null,
      ].filter(Boolean)
    : [];
  const temp = b && (b.tempRead || b.tempWritten)
    ? `temp ${((b.tempRead ?? 0) + (b.tempWritten ?? 0)).toLocaleString()} blocks`
    : null;
  const space = attrNum(n, "Sort Space Used");
  const spaceType = attrText(n, "Sort Space Type");

  return [
    idx ? `index: ${idx}` : null,
    filter ? `filter: ${filter}` : null,
    cond ? `cond: ${cond}` : null,
    sort ? `sort key: ${sort}` : null,
    rows,
    removed ? `removed ${removed.toLocaleString()}` : null,
    loops !== null && loops > 1 ? `loops ${loops.toLocaleString()}` : null,
    bufBits.length ? `buffers: ${bufBits.join(", ")}` : null,
    temp,
    space !== null ? `${spaceType ? `${spaceType.toLowerCase()} ` : ""}${space.toLocaleString()} kB` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Flatten a FORMAT JSON plan into drawable rows.
 *
 * `Actual Total Time` is preferred over `Total Cost` throughout: with ANALYZE
 * the former is measured and the latter is a guess, and a bar drawn from a
 * guess next to one drawn from a measurement invites a false comparison. When
 * ANALYZE did not run there are no timings at all, so cost is the only metric
 * left and `ms` stays null so the UI can say so.
 *
 * Returns empty rather than throwing on a shape it doesn't recognise — a plan
 * we can't walk is a display problem, not a reason to lose the raw payload the
 * user can still read.
 */
export function parsePlan(parsed: unknown): ParsedPlan {
  const root = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, unknown> | null;
  const plan = root?.["Plan"] as RawPlan | undefined;
  if (!plan || typeof plan !== "object") return { nodes: [], stats: [], suggestion: null, insights: [] };

  // Guard the divisor: a plan with a zero total (a trivial statement, or COSTS
  // OFF with no ANALYZE) would otherwise make every pct NaN or Infinity.
  const rawTotal = (plan["Actual Total Time"] as number) ?? (plan["Total Cost"] as number) ?? 1;
  const total = rawTotal > 0 ? rawTotal : 1;

  // Self-time is measured against the whole plan's inclusive wall time. Fall
  // back to the reported Execution Time, then to 1 so the share never divides
  // by zero.
  const execTotal = inclusiveMs(plan) ?? attrNum(root as RawPlan, "Execution Time");
  const selfDenom = execTotal && execTotal > 0 ? execTotal : 1;

  const nodes: ParsedPlanNode[] = [];
  let hotIdx = 0;
  let hotVal = -1;

  const walk = (n: RawPlan, depth: number, workers: number) => {
    const ms = attrNum(n, "Actual Total Time");
    const metric = ms ?? attrNum(n, "Total Cost") ?? 0;
    const relation = attrText(n, "Relation Name");
    const rel = relation ? ` on ${relation}` : "";
    const nodeType = attrText(n, "Node Type") ?? "node";
    // Children of a Gather run concurrently; everything else inherits.
    const childWorkers = workersUnder(n, workers);

    // Self-time: this node's inclusive wall time minus its children's. A large
    // total on a Nested Loop or Gather is usually its child's; self-time is the
    // part that belongs to the node itself.
    const incl = inclusiveMs(n, workers);
    let selfMs: number | null = null;
    if (incl !== null) {
      let childIncl = 0;
      for (const c of n.Plans ?? []) childIncl += inclusiveMs(c, childWorkers) ?? 0;
      selfMs = Math.max(0, incl - childIncl);
    }
    const selfPct = selfMs !== null ? Math.min(100, (selfMs / selfDenom) * 100) : 0;

    const rowsEst = attrNum(n, "Plan Rows");
    const rowsActual = attrNum(n, "Actual Rows");
    const misestimate = misestimateOf(rowsEst, rowsActual);
    const loops = attrNum(n, "Actual Loops");
    const rowsRemoved = attrNum(n, "Rows Removed by Filter");
    const buffers = buffersOf(n);

    const flags: NodeFlag[] = [];
    if (isNeverExecuted(n)) flags.push("never-executed");
    if (nodeType.includes("Seq Scan")) flags.push("seq-scan");
    if (isDiskSort(n)) flags.push("disk-sort");
    if (isHashSpill(n)) flags.push("spill");
    // A filter that reads a lot and keeps almost none is the clearest index hint.
    if (
      rowsRemoved !== null &&
      rowsRemoved >= WASTEFUL_FILTER_ROWS &&
      rowsRemoved >= WASTEFUL_FILTER_RATIO * Math.max(1, rowsActual ?? 0)
    ) {
      flags.push("wasteful-filter");
    }
    // Self-read, not the cumulative count: only the node that actually went to
    // disk should carry the badge.
    if ((buffers?.selfRead ?? 0) >= HEAVY_READ_BLOCKS) flags.push("heavy-read");
    if ((loops ?? 0) >= HIGH_LOOPS) flags.push("high-loops");
    if (misestimate !== null) flags.push("misestimate");

    const i = nodes.length;
    nodes.push({
      kind: nodeType,
      title: `${nodeType}${rel}`,
      detail: nodeDetail(n),
      ms,
      pct: Math.min(100, (metric / total) * 100),
      indent: depth,
      hot: false,
      selfMs,
      selfPct,
      rowsEst,
      rowsActual,
      misestimate,
      loops,
      rowsRemoved,
      buffers,
      flags,
    });
    if ((n["Node Type"] as string)?.includes("Seq Scan") && metric > hotVal) {
      hotVal = metric;
      hotIdx = i;
    }
    (n.Plans ?? []).forEach((c) => walk(c, depth + 1, childWorkers));
  };
  walk(plan, 0, 1);

  // A lone Seq Scan is the whole plan — calling it the hot spot says nothing
  // and the suggestion that follows ("an index could avoid the full scan")
  // would be advice to index a table the user asked to read end to end.
  if (hotVal > 0 && nodes.length > 1) nodes[hotIdx].hot = true;

  // The bottleneck is the node with the most *self*-time, when that share is
  // meaningful and there is more than one node to choose between. Unlike the
  // Seq-Scan hot spot this can land on any node type — an Index Scan or Sort
  // that genuinely dominates is where the time goes, even if there is no index
  // to recommend.
  let botIdx = -1;
  let botVal = -1;
  if (nodes.length > 1) {
    nodes.forEach((n, i) => {
      if (n.selfMs !== null && n.selfMs > botVal && n.selfPct >= BOTTLENECK_PCT && n.selfMs >= BOTTLENECK_MIN_MS) {
        botVal = n.selfMs;
        botIdx = i;
      }
    });
    if (botIdx >= 0) nodes[botIdx].flags.unshift("bottleneck");
  }

  const stats: ParsedPlan["stats"] = [];
  if (root?.["Planning Time"] !== undefined) {
    stats.push({ label: "Planning time", value: `${(root["Planning Time"] as number).toFixed(2)} ms` });
  }
  if (root?.["Execution Time"] !== undefined) {
    stats.push({ label: "Execution time", value: `${(root["Execution Time"] as number).toFixed(1)} ms` });
  }
  // JIT and trigger time are reported outside the plan tree, so a query can
  // spend most of its wall clock somewhere no node accounts for.
  const jitMs = jitTotalMs(root);
  if (jitMs !== null) stats.push({ label: "JIT time", value: `${jitMs.toFixed(1)} ms` });
  const trigMs = triggerTotalMs(root);
  if (trigMs !== null) stats.push({ label: "Trigger time", value: `${trigMs.toFixed(1)} ms` });
  stats.push({ label: "Plan nodes", value: String(nodes.length) });

  const hot = nodes.find((n) => n.hot);
  const suggestion = hot
    ? `${hot.title} dominates this plan. An index matching its filter could avoid the full scan.`
    : null;

  const execMs = attrNum(root as RawPlan, "Execution Time") ?? execTotal;
  return { nodes, stats, suggestion, insights: buildInsights(nodes, hot ?? null, jitMs, trigMs, execMs) };
}

/** Total JIT compilation time, when the server compiled anything. */
function jitTotalMs(root: Record<string, unknown> | null): number | null {
  const jit = root?.["JIT"] as Record<string, unknown> | undefined;
  const timing = jit?.["Timing"] as Record<string, unknown> | undefined;
  const total = timing?.["Total"];
  return typeof total === "number" ? total : null;
}

/** Total time spent in triggers — invisible in the plan tree itself. */
function triggerTotalMs(root: Record<string, unknown> | null): number | null {
  const trig = root?.["Triggers"];
  if (!Array.isArray(trig) || trig.length === 0) return null;
  let sum = 0;
  let saw = false;
  for (const t of trig) {
    const time = (t as Record<string, unknown>)?.["Time"];
    if (typeof time === "number") {
      sum += time;
      saw = true;
    }
  }
  return saw ? sum : null;
}

/** Turn the flagged nodes into an ordered, de-duplicated list of observations.
 *  Ordering is deliberate: the bottleneck first (it's the reader's biggest
 *  lever), then resource spills, then a stale-statistics hint. */
function buildInsights(
  nodes: ParsedPlanNode[],
  hot: ParsedPlanNode | null,
  jitMs: number | null,
  triggerMs: number | null,
  execMs: number | null,
): Insight[] {
  const insights: Insight[] = [];

  const bottleneck = nodes.find((n) => n.flags.includes("bottleneck"));
  if (bottleneck) {
    const ms = bottleneck.selfMs !== null ? ` (${bottleneck.selfMs.toFixed(1)} ms)` : "";
    let text = `${bottleneck.title} is the busiest node — ${bottleneck.selfPct.toFixed(0)}% of execution time${ms}.`;
    if (bottleneck.flags.includes("seq-scan")) text += " An index matching its filter could avoid the full scan.";
    insights.push({ level: "tip", text });
  } else if (hot) {
    // No measured bottleneck (ANALYZE off), but a dominant Seq Scan by cost.
    insights.push({
      level: "tip",
      text: `${hot.title} dominates this plan. An index matching its filter could avoid the full scan.`,
    });
  }

  // The most actionable signal in a plan: read a lot, keep almost none.
  const wasteful = nodes
    .filter((n) => n.flags.includes("wasteful-filter"))
    .sort((a, b) => (b.rowsRemoved as number) - (a.rowsRemoved as number))[0];
  if (wasteful) {
    const removed = (wasteful.rowsRemoved as number).toLocaleString();
    const kept = (wasteful.rowsActual ?? 0).toLocaleString();
    insights.push({
      level: "tip",
      text: `${wasteful.title} discarded ${removed} rows to keep ${kept}. An index on its filter would avoid reading them.`,
    });
  }

  if (nodes.some((n) => n.flags.includes("disk-sort"))) {
    insights.push({ level: "warn", text: "A sort spilled to disk. Raising work_mem can keep it in memory." });
  }
  if (nodes.some((n) => n.flags.includes("spill"))) {
    insights.push({ level: "warn", text: "A hash step used multiple batches (spilled). Raising work_mem can reduce this." });
  }

  const heavy = nodes
    .filter((n) => n.flags.includes("heavy-read"))
    .sort((a, b) => (b.buffers?.selfRead ?? 0) - (a.buffers?.selfRead ?? 0))[0];
  if (heavy) {
    const blocks = (heavy.buffers?.selfRead ?? 0).toLocaleString();
    insights.push({
      level: "warn",
      text: `${heavy.title} read ${blocks} blocks from disk rather than cache — this query is I/O bound, not CPU bound.`,
    });
  }

  const loopy = nodes
    .filter((n) => n.flags.includes("high-loops"))
    .sort((a, b) => (b.loops as number) - (a.loops as number))[0];
  if (loopy) {
    insights.push({
      level: "warn",
      text: `${loopy.title} ran ${(loopy.loops as number).toLocaleString()} times. A hash or merge join may beat repeating it.`,
    });
  }

  const worst = nodes
    .filter((n) => n.misestimate !== null)
    .sort((a, b) => (b.misestimate as number) - (a.misestimate as number))[0];
  if (worst) {
    insights.push({
      level: "warn",
      text: `Row estimate is off by ${Math.round(worst.misestimate as number)}× at ${worst.title}; its statistics may be stale (try ANALYZE on its table).`,
    });
  }

  // Time the plan tree cannot account for, because it happens outside it.
  if (jitMs !== null && execMs && execMs > 0 && (jitMs / execMs) * 100 >= JIT_PCT) {
    insights.push({
      level: "warn",
      text: `JIT compilation took ${jitMs.toFixed(1)} ms of ${execMs.toFixed(1)} ms. For a short query, jit=off is often faster.`,
    });
  }
  if (triggerMs !== null && triggerMs > 0) {
    insights.push({
      level: "info",
      text: `Triggers accounted for ${triggerMs.toFixed(1)} ms, which the plan tree does not show.`,
    });
  }

  if (nodes.some((n) => n.flags.includes("never-executed"))) {
    insights.push({
      level: "info",
      text: "Some nodes were never executed — the executor short-circuited that branch.",
    });
  }

  return insights;
}

/* ------------------------------------------------------------------ export */

export type ExportablePlan = {
  sql: string;
  statement: string;
  options: ExplainOptions;
  /** Raw server payload, exactly as returned. */
  raw: string;
  nodes: { kind: string; title: string; detail: string; ms: number | null; pct: number; indent: number }[];
  stats: { label: string; value: string }[];
};

/** The raw plan, pretty-printed. This is what explain.depesz.com and pev2 eat. */
export function planToJson(p: ExportablePlan): string {
  try {
    return JSON.stringify(JSON.parse(p.raw), null, 2);
  } catch {
    return p.raw; // TEXT/YAML/XML formats aren't JSON — hand them back untouched
  }
}

/** Extension the raw payload should be saved under, given the server format. */
export function rawExtension(o: ExplainOptions): "json" | "txt" | "md" {
  return o.format === "json" ? "json" : "txt";
}

/** An indented, human-readable tree with the statement and stats as a header.
 *  For a non-JSON server format there are no parsed nodes to walk, so the raw
 *  payload (which already *is* the plan, e.g. FORMAT TEXT) is returned. */
export function planToText(p: ExportablePlan): string {
  if (p.options.format !== "json") return p.raw;
  const head = [
    `-- ${p.statement}`,
    ...p.stats.map((s) => `-- ${s.label}: ${s.value}`),
    "",
  ];
  const body = p.nodes.map((n) => {
    const pad = "  ".repeat(n.indent);
    const ms = n.ms !== null ? `  (${n.ms.toFixed(1)} ms, ${n.pct.toFixed(0)}%)` : "";
    const detail = n.detail ? `\n${pad}    ${n.detail}` : "";
    return `${pad}-> ${n.title}${ms}${detail}`;
  });
  return [...head, ...body].join("\n");
}

export function planToMarkdown(p: ExportablePlan): string {
  const lines = [
    "# Query plan",
    "",
    "```sql",
    p.sql.trim(),
    "```",
    "",
    `**Statement:** \`${p.statement}\``,
    "",
    "| Stat | Value |",
    "| --- | --- |",
    ...p.stats.map((s) => `| ${mdCell(s.label)} | ${mdCell(s.value)} |`),
    "",
    "| Node | Time | Share | Detail |",
    "| --- | --- | --- | --- |",
    ...p.nodes.map((n) => {
      const name = `${"&nbsp;".repeat(n.indent * 4)}${mdCell(n.title)}`;
      const ms = n.ms !== null ? `${n.ms.toFixed(1)} ms` : "—";
      const detail = mdCell(n.detail) || "—";
      return `| ${name} | ${ms} | ${n.pct.toFixed(0)}% | ${detail} |`;
    }),
  ];
  return lines.join("\n");
}

export function planFilename(title: string, kind: "json" | "txt" | "md"): string {
  // Trim the separators too: a title of "!!!" collapses to "_", which is
  // truthy and would sail past the fallback as a filename of just "_".
  const base =
    title
      .replace(/\.sql$/i, "")
      .replace(/[^a-z0-9_-]+/gi, "_")
      .replace(/^[_-]+|[_-]+$/g, "") || "plan";
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `${base}-plan-${stamp}.${kind}`;
}
