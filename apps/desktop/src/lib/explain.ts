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

export type ParsedPlanNode = {
  kind: string;
  title: string;
  detail: string;
  /** Real measured time. Null unless ANALYZE ran — an estimate is not a timing
   *  and must not be drawn as one. */
  ms: number | null;
  /** Share of the plan's total, for the bar. */
  pct: number;
  indent: number;
  /** The costliest sequential scan, when there is one worth pointing at. */
  hot: boolean;
};

export type ParsedPlan = {
  nodes: ParsedPlanNode[];
  stats: { label: string; value: string }[];
  suggestion: string | null;
};

/**
 * Assemble the server's payload from the rows it came back in.
 *
 * FORMAT TEXT returns one row *per line* of the plan — 295 rows for a real
 * query against this database — so it has to be rejoined. Every other format
 * returns the whole document in a single cell.
 */
export function readPlanPayload(rows: unknown[][], format: ExplainFormat): string {
  if (format === "text") return rows.map((r) => String(r[0] ?? "")).join("\n");
  const cell = rows[0]?.[0];
  return typeof cell === "string" ? cell : JSON.stringify(cell);
}

/** Fold a node's interesting attributes into one line, skipping what's absent. */
function nodeDetail(n: RawPlan): string {
  const rows =
    n["Actual Rows"] !== undefined
      ? `rows ${(n["Actual Rows"] as number).toLocaleString()}`
      : n["Plan Rows"] !== undefined
        ? `est rows ${(n["Plan Rows"] as number).toLocaleString()}`
        : null;
  return [
    n["Index Name"] ? `index: ${n["Index Name"]}` : null,
    n["Filter"] ? `filter: ${n["Filter"]}` : null,
    n["Hash Cond"] ? `cond: ${n["Hash Cond"]}` : null,
    n["Sort Key"] ? `sort key: ${(n["Sort Key"] as string[]).join(", ")}` : null,
    rows,
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
  if (!plan || typeof plan !== "object") return { nodes: [], stats: [], suggestion: null };

  // Guard the divisor: a plan with a zero total (a trivial statement, or COSTS
  // OFF with no ANALYZE) would otherwise make every pct NaN or Infinity.
  const rawTotal = (plan["Actual Total Time"] as number) ?? (plan["Total Cost"] as number) ?? 1;
  const total = rawTotal > 0 ? rawTotal : 1;

  const nodes: ParsedPlanNode[] = [];
  let hotIdx = 0;
  let hotVal = -1;

  const walk = (n: RawPlan, depth: number) => {
    const ms = (n["Actual Total Time"] as number) ?? null;
    const metric = ms ?? ((n["Total Cost"] as number) ?? 0);
    const rel = n["Relation Name"] ? ` on ${n["Relation Name"]}` : "";
    const i = nodes.length;
    nodes.push({
      kind: String(n["Node Type"] ?? "node"),
      title: `${n["Node Type"] ?? "node"}${rel}`,
      detail: nodeDetail(n),
      ms,
      pct: Math.min(100, (metric / total) * 100),
      indent: depth,
      hot: false,
    });
    if ((n["Node Type"] as string)?.includes("Seq Scan") && metric > hotVal) {
      hotVal = metric;
      hotIdx = i;
    }
    (n.Plans ?? []).forEach((c) => walk(c, depth + 1));
  };
  walk(plan, 0);

  // A lone Seq Scan is the whole plan — calling it the hot spot says nothing
  // and the suggestion that follows ("an index could avoid the full scan")
  // would be advice to index a table the user asked to read end to end.
  if (hotVal > 0 && nodes.length > 1) nodes[hotIdx].hot = true;

  const stats: ParsedPlan["stats"] = [];
  if (root?.["Planning Time"] !== undefined) {
    stats.push({ label: "Planning time", value: `${(root["Planning Time"] as number).toFixed(2)} ms` });
  }
  if (root?.["Execution Time"] !== undefined) {
    stats.push({ label: "Execution time", value: `${(root["Execution Time"] as number).toFixed(1)} ms` });
  }
  stats.push({ label: "Plan nodes", value: String(nodes.length) });

  const hot = nodes.find((n) => n.hot);
  return {
    nodes,
    stats,
    suggestion: hot
      ? `${hot.title} dominates this plan. An index matching its filter could avoid the full scan.`
      : null,
  };
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
    ...p.stats.map((s) => `| ${s.label} | ${s.value} |`),
    "",
    "| Node | Time | Share | Detail |",
    "| --- | --- | --- | --- |",
    ...p.nodes.map((n) => {
      const name = `${"&nbsp;".repeat(n.indent * 4)}${n.title}`;
      const ms = n.ms !== null ? `${n.ms.toFixed(1)} ms` : "—";
      const detail = n.detail.replace(/\|/g, "\\|") || "—";
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
