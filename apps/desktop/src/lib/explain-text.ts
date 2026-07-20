/**
 * Read PostgreSQL's *text* EXPLAIN output — the indented tree everyone copies
 * out of psql, a ticket, or a colleague's message.
 *
 * The output is the same shape the server's `FORMAT JSON` produces, so the
 * analyzer in `explain.ts` works on a pasted plan without knowing where it came
 * from. One analyzer, two front doors.
 *
 * Why bother when JSON exists: nobody has the JSON. What people actually have
 * is the text, and today the only way to get it analysed is to paste it into a
 * website — which means handing a third party your table names, index names,
 * filter conditions, and sometimes literal values from production. Parsing it
 * locally is the whole point.
 *
 * Every field is optional and version-dependent. Anything unrecognised is
 * ignored rather than guessed at, and a plan we cannot read returns null so the
 * caller can say so instead of rendering a confidently empty tree.
 */

export type TextPlanNode = Record<string, unknown> & { Plans?: TextPlanNode[] };
export type TextPlanRoot = Record<string, unknown> & { Plan: TextPlanNode };

/** A node line ends with the cost/actual tuples, or with "(never executed)". */
const COSTS_RE = /\(cost=([\d.]+)\.\.([\d.]+) rows=(\d+) width=(\d+)\)/;
/** `rows=` is a decimal from PostgreSQL 18 on (`rows=51.00`), an integer before. */
const ACTUAL_RE = /\(actual time=([\d.]+)\.\.([\d.]+) rows=([\d.]+) loops=(\d+)\)/;
/** TIMING OFF still reports rows and loops. */
const ACTUAL_NO_TIME_RE = /\(actual rows=([\d.]+) loops=(\d+)\)/;
const NEVER_RE = /\(never executed\)/;

/** Structural labels that own the `->` line beneath them. They are not nodes
 *  themselves; the child they introduce belongs to the enclosing node, which is
 *  where FORMAT JSON puts it too.
 *
 *  A real node can *begin* with one of these words — "CTE Scan on c" is a plan
 *  node, not a label — so the measurement tuple is what tells them apart. A
 *  label never carries one. */
const CONTAINER_RE = /^(CTE|SubPlan|InitPlan)\b/;
const MEASURED_RE = /\((?:cost=|actual|never executed)/;

/** Per-worker repeats of a parent's own attributes. Counting them would double
 *  every measurement they echo. */
const WORKER_RE = /^Worker\s+\d+:/;

/** Where the plan tree stops and the summary begins. */
const TRAILER_RE = /^(Planning|Planning Time|Execution Time|Trigger\s|JIT|Settings|Query Identifier)\b/;

const num = (s: string | undefined): number | null => {
  if (s === undefined) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** Aggregate strategies are part of the printed name in text but a separate
 *  field in FORMAT JSON. */
const AGG_STRATEGY: Record<string, string> = {
  HashAggregate: "Hashed",
  GroupAggregate: "Sorted",
  MixedAggregate: "Mixed",
  Aggregate: "Plain",
};

/** Likewise the join type: text prints "Hash Right Semi Join", JSON reports
 *  node type "Hash Join" with `Join Type: "Right Semi"`. */
const JOIN_RE = /^(Hash|Merge) (Left|Right|Full|Semi|Anti|Right Semi|Right Anti) Join$/;
const NESTED_RE = /^Nested Loop (Left|Right|Full|Semi|Anti|Right Semi|Right Anti)$/;

/** And the write operation: "Insert on t" is JSON's `ModifyTable` with
 *  `Operation: "Insert"`. */
const MODIFY_RE = /^(Insert|Update|Delete|Merge)$/;

/**
 * The text format packs several things into the node's printed name that
 * FORMAT JSON keeps in separate fields — whether the node is parallel-aware,
 * whether an aggregate is partial, which join type it is, which strategy an
 * aggregate uses. Unpacking them here is what makes a pasted text plan and the
 * same plan in JSON produce *identical* output rather than merely similar
 * output: the analyzer downstream only ever sees JSON's vocabulary.
 */
function normalizeNodeType(out: Record<string, unknown>): void {
  let type = (typeof out["Node Type"] === "string" ? out["Node Type"] : "").trim();

  // Prefixes, which stack: "Finalize GroupAggregate", "Parallel Hash Join".
  if (type.startsWith("Parallel ")) {
    out["Parallel Aware"] = true;
    type = type.slice("Parallel ".length);
  }
  for (const mode of ["Partial", "Finalize"]) {
    if (type.startsWith(`${mode} `)) {
      out["Partial Mode"] = mode;
      type = type.slice(mode.length + 1);
    }
  }
  if (out["Parallel Aware"] === undefined) out["Parallel Aware"] = false;

  const join = JOIN_RE.exec(type) ?? NESTED_RE.exec(type);
  if (join) {
    out["Join Type"] = join[2];
    type = join[1] === "Hash" || join[1] === "Merge" ? `${join[1]} Join` : "Nested Loop";
  } else if (type === "Hash Join" || type === "Merge Join" || type === "Nested Loop") {
    // An inner join prints no join word; JSON still names it.
    out["Join Type"] = "Inner";
  }

  const strategy = AGG_STRATEGY[type];
  if (strategy) {
    out["Strategy"] = strategy;
    type = "Aggregate";
  }

  if (MODIFY_RE.test(type)) {
    out["Operation"] = type;
    type = "ModifyTable";
  }

  // Several node types print "on <thing>" where the thing is not a table, and
  // FORMAT JSON files each under its own key.
  const notARelation: Record<string, string> = {
    "Bitmap Index Scan": "Index Name",
    "CTE Scan": "CTE Name",
    "Function Scan": "Function Name",
    "Named Tuplestore Scan": "Tuplestore Name",
  };
  const key = notARelation[type];
  if (key && out["Relation Name"] !== undefined) {
    out[key] = out["Relation Name"];
    delete out["Relation Name"];
    if (key !== "CTE Name") delete out["Alias"];
  }

  out["Node Type"] = type;
}

/** Split "Index Only Scan using ix on orders a" into its JSON-ish parts. */
function splitLabel(label: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let rest = label.trim();

  const using = / using (\S+)/.exec(rest);
  if (using) {
    out["Index Name"] = using[1];
    rest = rest.replace(using[0], "");
  }
  // " on relation alias" — the alias is optional and is dropped from the
  // relation, matching what FORMAT JSON reports.
  const on = / on (\S+)(?:\s+(\S+))?\s*$/.exec(rest);
  if (on) {
    // VERBOSE qualifies the relation — "on public.orders" — where FORMAT JSON
    // keeps the schema in its own field. Quoted identifiers can contain a dot,
    // so only an unquoted single dot is treated as a qualifier.
    const qualified = /^([^".]+)\.([^".]+)$/.exec(on[1]);
    if (qualified) {
      out["Schema"] = qualified[1];
      out["Relation Name"] = qualified[2];
    } else {
      out["Relation Name"] = on[1];
    }
    if (on[2]) out["Alias"] = on[2];
    rest = rest.replace(on[0], "");
  }
  out["Node Type"] = rest.trim();
  normalizeNodeType(out);
  return out;
}

/** `Buffers: shared hit=5 read=2 dirtied=1, temp read=9 written=8`
 *
 *  The text format prints only non-zero counters; FORMAT JSON prints them all.
 *  So the presence of a Buffers line means the others really are zero, and
 *  seeding them keeps a parsed text plan identical to the same plan in JSON —
 *  otherwise "read 0" and "read unknown" would be indistinguishable. */
function readBuffers(value: string, node: TextPlanNode): void {
  for (const pool of ["Shared", "Local"]) {
    for (const k of ["Hit", "Read", "Dirtied", "Written"]) node[`${pool} ${k} Blocks`] = 0;
  }
  node["Temp Read Blocks"] = 0;
  node["Temp Written Blocks"] = 0;

  // Sections are comma-separated and each names a pool followed by counters.
  for (const part of value.split(",")) {
    const m = /^\s*(shared|local|temp)\s+(.*)$/.exec(part);
    if (!m) continue;
    const pool = m[1];
    const prefix = pool === "shared" ? "Shared" : pool === "local" ? "Local" : "Temp";
    for (const kv of m[2].matchAll(/(hit|read|dirtied|written)=(\d+)/g)) {
      const key = kv[1][0].toUpperCase() + kv[1].slice(1); // hit → Hit
      node[`${prefix} ${key} Blocks`] = Number(kv[2]);
    }
  }
}

/** Attach one `Key: value` attribute line to the node it follows. */
function readAttribute(line: string, node: TextPlanNode): void {
  if (WORKER_RE.test(line)) return;

  const m = /^([^:]+):\s*(.*)$/.exec(line);
  if (!m) return;
  const key = m[1].trim();
  const value = m[2].trim();

  if (key === "Buffers") {
    readBuffers(value, node);
    return;
  }
  if (key === "Sort Method") {
    // "external merge  Disk: 27944kB" / "quicksort  Memory: 26kB"
    const space = /\s{2,}(Disk|Memory):\s*(\d+)kB/.exec(value);
    node["Sort Method"] = space ? value.slice(0, space.index).trim() : value;
    if (space) {
      node["Sort Space Type"] = space[1];
      node["Sort Space Used"] = Number(space[2]);
    }
    return;
  }
  if (key === "Buckets" || key === "Batches") {
    // "Buckets: 32768  Batches: 1  Memory Usage: 960kB" arrives as one line;
    // a HashAggregate reports only "Batches: 5  Memory Usage: 161kB  Disk
    // Usage: 200kB". Either way a batch count above one means it spilled — but
    // FORMAT JSON files the aggregate's count under a *different* key than the
    // hash node's, so each has to land where the analyzer looks for it.
    const batchKey = node["Node Type"] === "Aggregate" ? "HashAgg Batches" : "Hash Batches";
    for (const kv of `${key}: ${value}`.matchAll(/(Buckets|Batches|Memory Usage|Disk Usage):\s*(\d+)/g)) {
      if (kv[1] === "Buckets") node["Hash Buckets"] = Number(kv[2]);
      if (kv[1] === "Batches") node[batchKey] = Number(kv[2]);
      if (kv[1] === "Memory Usage") node["Peak Memory Usage"] = Number(kv[2]);
      if (kv[1] === "Disk Usage") node["Disk Usage"] = Number(kv[2]);
    }
    return;
  }
  if (key === "Workers Planned" || key === "Workers Launched" || key === "Rows Removed by Filter") {
    const n = num(value);
    if (n !== null) node[key] = n;
    return;
  }
  // Everything else is carried through as text: Filter, Index Cond, Hash Cond,
  // Sort Key, Group Key — the analyzer reads some, and the rest cost nothing.
  node[key] = value;
}

/** Parse the node header, or return null when the line is not a node. */
function readNodeLine(text: string): TextPlanNode | null {
  const never = NEVER_RE.test(text);
  const costs = COSTS_RE.exec(text);
  const actual = ACTUAL_RE.exec(text);
  const actualNoTime = actual ? null : ACTUAL_NO_TIME_RE.exec(text);
  if (!costs && !actual && !actualNoTime && !never) return null;

  // The label is whatever precedes the first parenthesised tuple.
  const firstParen = text.search(/\s\((?:cost=|actual|never executed)/);
  const label = firstParen >= 0 ? text.slice(0, firstParen) : text;
  const node: TextPlanNode = splitLabel(label);

  if (costs) {
    node["Startup Cost"] = Number(costs[1]);
    node["Total Cost"] = Number(costs[2]);
    node["Plan Rows"] = Number(costs[3]);
    node["Plan Width"] = Number(costs[4]);
  }
  if (actual) {
    node["Actual Startup Time"] = Number(actual[1]);
    node["Actual Total Time"] = Number(actual[2]);
    node["Actual Rows"] = Number(actual[3]);
    node["Actual Loops"] = Number(actual[4]);
  } else if (actualNoTime) {
    node["Actual Rows"] = Number(actualNoTime[1]);
    node["Actual Loops"] = Number(actualNoTime[2]);
  }
  if (never) {
    // FORMAT JSON reports a never-executed node with explicit zeros rather than
    // absent keys; matching that keeps the two parses interchangeable.
    node["Never Executed"] = true;
    node["Actual Loops"] = 0;
    node["Actual Startup Time"] = 0;
    node["Actual Total Time"] = 0;
    node["Actual Rows"] = 0;
  }
  return node;
}

/** `Trigger t_audit: time=1.809 calls=200` (optionally "for constraint ..."). */
function readTrigger(line: string): Record<string, unknown> | null {
  const m = /^Trigger\s+(.+?):\s*time=([\d.]+)\s+calls=(\d+)/.exec(line);
  if (!m) return null;
  return { "Trigger Name": m[1], Time: Number(m[2]), Calls: Number(m[3]) };
}

/** Buffer counters are per-node in FORMAT JSON but only printed in text when
 *  non-zero, so a node with nothing to report prints no `Buffers:` line at all
 *  — a Function Scan, or a branch that never ran. If any node in the plan
 *  reported buffers then BUFFERS was on for the whole plan, and silence means
 *  zero rather than unknown. */
function seedBuffers(root: TextPlanNode): void {
  const all: TextPlanNode[] = [];
  const walk = (n: TextPlanNode) => {
    all.push(n);
    for (const c of n.Plans ?? []) walk(c);
  };
  walk(root);
  if (!all.some((n) => n["Shared Hit Blocks"] !== undefined)) return;

  for (const n of all) {
    if (n["Shared Hit Blocks"] !== undefined) continue;
    for (const pool of ["Shared", "Local"]) {
      for (const k of ["Hit", "Read", "Dirtied", "Written"]) n[`${pool} ${k} Blocks`] = 0;
    }
    n["Temp Read Blocks"] = 0;
    n["Temp Written Blocks"] = 0;
  }
}

/** A node with a filter that discarded nothing prints no "Rows Removed by
 *  Filter" line, while FORMAT JSON prints a zero. Same reasoning as the buffer
 *  seeding above: with ANALYZE on, silence means none were removed, not that
 *  the number is unknown. */
function seedRowsRemoved(root: TextPlanNode): void {
  const pairs: [string, string][] = [
    ["Filter", "Rows Removed by Filter"],
    ["Join Filter", "Rows Removed by Join Filter"],
  ];
  const walk = (n: TextPlanNode) => {
    // No ANALYZE means no removal counts at all, in either format.
    if (n["Actual Loops"] !== undefined) {
      for (const [cond, count] of pairs) {
        if (n[cond] !== undefined && n[count] === undefined) n[count] = 0;
      }
    }
    for (const c of n.Plans ?? []) walk(c);
  };
  walk(root);
}

/**
 * Turn a text plan into the array FORMAT JSON would have produced.
 *
 * Returns null when there is no recognisable plan, so the caller can say "that
 * doesn't look like a plan" rather than draw an empty tree.
 */
export function parseTextPlan(input: string): TextPlanRoot[] | null {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");

  let root: TextPlanNode | null = null;
  const rootDoc: Record<string, unknown> = {};
  const triggers: Record<string, unknown>[] = [];
  // Nodes still open for children, with the column their own text starts at.
  const stack: { col: number; node: TextPlanNode }[] = [];
  let last: TextPlanNode | null = null;
  let inTrailer = false;

  for (const raw of lines) {
    if (!raw.trim()) continue;
    const indent = raw.length - raw.trimStart().length;
    const text = raw.trim();

    // Once the summary starts, nothing below belongs to a node.
    if (indent === 0 && TRAILER_RE.test(text)) inTrailer = true;

    if (inTrailer) {
      const plan = /^Planning Time:\s*([\d.]+)\s*ms/.exec(text);
      if (plan) rootDoc["Planning Time"] = Number(plan[1]);
      const exec = /^Execution Time:\s*([\d.]+)\s*ms/.exec(text);
      if (exec) rootDoc["Execution Time"] = Number(exec[1]);
      const trig = readTrigger(text);
      if (trig) triggers.push(trig);
      const jit = /^Timing:.*?Total\s+([\d.]+)\s*ms/.exec(text);
      if (jit) rootDoc["JIT"] = { Timing: { Total: Number(jit[1]) } };
      continue;
    }

    // A structural label — the child beneath it belongs to the enclosing node,
    // which is where FORMAT JSON puts it too.
    //
    // The label's children are indented past it, so left to itself the stack
    // would hang them off whichever node happened to precede it. Recording the
    // label's own column as a transparent barrier makes them attach to the node
    // that *encloses* the label instead — which is where JSON puts them, and
    // the difference is not cosmetic: a SubPlan hung off the wrong parent moves
    // its time to the wrong node and badges the wrong one as the bottleneck.
    if (CONTAINER_RE.test(text) && !text.startsWith("->") && !MEASURED_RE.test(text)) {
      while (stack.length && stack[stack.length - 1].col >= indent) stack.pop();
      const parent = stack.length ? stack[stack.length - 1].node : root;
      if (parent) stack.push({ col: indent, node: parent });
      continue;
    }

    const isChild = text.startsWith("->");
    const body = isChild ? text.replace(/^->\s*/, "") : text;
    // The column the node's own text begins at: after the "->  " marker for a
    // child, or the line's indent for the root.
    const col = isChild ? indent + (text.length - text.replace(/^->\s*/, "").length) : indent;

    const node = readNodeLine(body);
    if (!node) {
      if (last) readAttribute(text, last);
      continue;
    }

    if (!root) {
      root = node;
      stack.push({ col, node });
    } else {
      while (stack.length && stack[stack.length - 1].col >= col) stack.pop();
      const parent = stack.length ? stack[stack.length - 1].node : root;
      (parent.Plans ??= []).push(node);
      stack.push({ col, node });
    }
    last = node;
  }

  if (!root) return null;
  if (triggers.length) rootDoc["Triggers"] = triggers;
  seedBuffers(root);
  seedRowsRemoved(root);
  return [{ ...rootDoc, Plan: root }];
}

/** Does this look like a plan we can read, in either format? */
export function detectPlanFormat(input: string): "json" | "text" | null {
  const t = input.trim();
  if (!t) return null;
  if (t.startsWith("[") || t.startsWith("{")) {
    try {
      JSON.parse(t);
      return "json";
    } catch {
      return null; // looks like JSON but isn't; saying "text" would mislead
    }
  }
  return parseTextPlan(t) ? "text" : null;
}
