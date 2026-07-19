import { describe, it, expect } from "vitest";
import {
  DEFAULT_EXPLAIN,
  buildExplain,
  explainLabel,
  isMutating,
  optionIssues,
  parsePlan,
  planFilename,
  planToJson,
  planToMarkdown,
  planToText,
  rawExtension,
  readPlanPayload,
  type ExplainOptions,
  type ExportablePlan,
  type RawPlan,
} from "./explain";

const opts = (o: Partial<ExplainOptions> = {}): ExplainOptions => ({ ...DEFAULT_EXPLAIN, ...o });

describe("buildExplain", () => {
  it("builds the default statement", () => {
    expect(buildExplain("select 1", opts())).toBe("EXPLAIN (BUFFERS, FORMAT JSON) select 1");
  });

  it("adds ANALYZE first", () => {
    expect(buildExplain("select 1", opts({ analyze: true }))).toBe(
      "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) select 1"
    );
  });

  it("emits COSTS only when switched off (Postgres defaults it on)", () => {
    expect(buildExplain("select 1", opts({ costs: true }))).not.toContain("COSTS");
    expect(buildExplain("select 1", opts({ costs: false }))).toContain("COSTS FALSE");
  });

  it("orders every option and the format last", () => {
    const sql = buildExplain(
      "select 1",
      opts({ analyze: true, verbose: true, settings: true, wal: true, timing: true, summary: true, memory: true, serialize: true })
    );
    expect(sql).toBe(
      "EXPLAIN (ANALYZE, VERBOSE, SETTINGS, BUFFERS, WAL, TIMING, SUMMARY, MEMORY, SERIALIZE, FORMAT JSON) select 1"
    );
  });

  it("honours the format", () => {
    expect(buildExplain("select 1", opts({ format: "text" }))).toContain("FORMAT TEXT");
    expect(buildExplain("select 1", opts({ format: "yaml" }))).toContain("FORMAT YAML");
  });

  it("strips a trailing semicolon — EXPLAIN (…) select 1; is a syntax error", () => {
    expect(buildExplain("select 1;", opts())).toBe("EXPLAIN (BUFFERS, FORMAT JSON) select 1");
    expect(buildExplain("select 1;  \n", opts())).toBe("EXPLAIN (BUFFERS, FORMAT JSON) select 1");
  });

  it("keeps semicolons inside the statement body", () => {
    expect(buildExplain("select ';'", opts())).toContain("select ';'");
  });
});

describe("isMutating", () => {
  it.each([
    ["insert into t values (1)", true],
    ["UPDATE t SET a = 1", true],
    ["delete from t", true],
    ["merge into t using s on true", true],
    ["truncate t", true],
    ["drop table t", true],
    ["create table t (a int)", true],
    ["refresh materialized view mv", true],
    ["select * from t", false],
    ["  \n select 1", false],
    ["with x as (select 1) select * from x", false],
  ])("%s → %s", (sql, expected) => expect(isMutating(sql)).toBe(expected));

  it("is not fooled by the word update inside a string", () => {
    expect(isMutating("select 'update me' from t")).toBe(false);
  });

  it("is not fooled by a leading comment", () => {
    expect(isMutating("-- delete this later\nselect 1")).toBe(false);
  });
});

// Every rule here was confirmed against a live PostgreSQL 18.
describe("optionIssues — server rules", () => {
  const err = (o: Partial<ExplainOptions>, sql = "select 1") =>
    optionIssues(opts(o), sql).filter((i) => i.level === "error").map((i) => i.message);

  it("TIMING requires ANALYZE", () => {
    expect(err({ timing: true })).toEqual(["TIMING requires ANALYZE."]);
    expect(err({ timing: true, analyze: true })).toEqual([]);
  });

  it("WAL requires ANALYZE", () => {
    expect(err({ wal: true })).toEqual(["WAL requires ANALYZE."]);
    expect(err({ wal: true, analyze: true })).toEqual([]);
  });

  it("SERIALIZE requires ANALYZE", () => {
    expect(err({ serialize: true })).toEqual(["SERIALIZE requires ANALYZE."]);
  });

  it("BUFFERS does not require ANALYZE", () => {
    expect(err({ buffers: true })).toEqual([]);
  });

  it("ANALYZE and GENERIC_PLAN are mutually exclusive", () => {
    expect(err({ analyze: true, genericPlan: true })).toEqual([
      "ANALYZE and GENERIC_PLAN cannot be used together.",
    ]);
  });

  it("reports several problems at once", () => {
    expect(err({ timing: true, wal: true })).toHaveLength(2);
  });

  it("is happy with the defaults", () => expect(err({})).toEqual([]));
});

describe("optionIssues — safety", () => {
  it("warns that ANALYZE really executes a destructive statement", () => {
    const w = optionIssues(opts({ analyze: true }), "delete from users");
    expect(w).toHaveLength(1);
    expect(w[0].level).toBe("warning");
    expect(w[0].message).toMatch(/executes the statement for real/i);
  });

  it("does not warn for a plain select", () => {
    expect(optionIssues(opts({ analyze: true }), "select * from users")).toEqual([]);
  });

  it("does not warn when ANALYZE is off", () => {
    expect(optionIssues(opts({ analyze: false }), "delete from users")).toEqual([]);
  });
});

describe("optionIssues — server version", () => {
  it("rejects MEMORY below 17", () => {
    expect(optionIssues(opts({ memory: true }), "select 1", 16)[0].message).toMatch(/MEMORY needs PostgreSQL 17/);
  });

  it("accepts MEMORY on 18", () => {
    expect(optionIssues(opts({ memory: true }), "select 1", 18)).toEqual([]);
  });

  it("rejects SETTINGS below 12", () => {
    expect(optionIssues(opts({ settings: true }), "select 1", 11)[0].message).toMatch(/SETTINGS needs PostgreSQL 12/);
  });

  it("says nothing when the version is unknown", () => {
    expect(optionIssues(opts({ memory: true }), "select 1", undefined)).toEqual([]);
  });
});

describe("explainLabel", () => {
  it("names the plain case", () => expect(explainLabel(opts({ buffers: false }))).toBe("EXPLAIN"));
  it("lists the enabled options", () =>
    expect(explainLabel(opts({ analyze: true }))).toBe("EXPLAIN ANALYZE, BUFFERS"));
  it("ignores COSTS, which is on by default", () =>
    expect(explainLabel(opts({ buffers: false, costs: true }))).toBe("EXPLAIN"));
});

const plan: ExportablePlan = {
  sql: "select * from users",
  statement: "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) select * from users",
  options: opts({ analyze: true }),
  raw: '[{"Plan":{"Node Type":"Seq Scan","Total Cost":10}}]',
  nodes: [
    { kind: "Seq Scan", title: "Seq Scan on users", detail: "rows=100", ms: 12.5, pct: 100, indent: 0 },
    { kind: "Sort", title: "Sort", detail: "key: id", ms: 2, pct: 16, indent: 1 },
  ],
  stats: [{ label: "Execution time", value: "12.5 ms" }],
};

describe("planToJson", () => {
  it("pretty-prints the raw plan", () => {
    const out = planToJson(plan);
    expect(out).toContain('"Node Type": "Seq Scan"');
    expect(out.split("\n").length).toBeGreaterThan(1);
  });

  it("passes non-JSON formats through untouched", () => {
    expect(planToJson({ ...plan, raw: "Seq Scan on users  (cost=0.00..10.00)" })).toBe(
      "Seq Scan on users  (cost=0.00..10.00)"
    );
  });
});

describe("planToText — non-JSON formats", () => {
  // FORMAT TEXT already *is* the plan; there are no parsed nodes to walk.
  it("returns the raw payload verbatim for FORMAT TEXT", () => {
    const raw = "Seq Scan on users  (cost=0.00..10.00 rows=1)\n  Filter: (id = 1)";
    const out = planToText({ ...plan, options: opts({ format: "text" }), raw, nodes: [] });
    expect(out).toBe(raw);
  });

  it("returns raw YAML verbatim", () => {
    const raw = "- Plan:\n    Node Type: \"Seq Scan\"";
    expect(planToText({ ...plan, options: opts({ format: "yaml" }), raw, nodes: [] })).toBe(raw);
  });
});

describe("rawExtension", () => {
  it("uses .json only for the JSON format", () => {
    expect(rawExtension(opts({ format: "json" }))).toBe("json");
    expect(rawExtension(opts({ format: "text" }))).toBe("txt");
    expect(rawExtension(opts({ format: "yaml" }))).toBe("txt");
    expect(rawExtension(opts({ format: "xml" }))).toBe("txt");
  });
});

describe("planToText", () => {
  it("indents the tree and includes timings", () => {
    const out = planToText(plan);
    expect(out).toContain("-> Seq Scan on users  (12.5 ms, 100%)");
    expect(out).toContain("  -> Sort  (2.0 ms, 16%)");
  });

  it("puts the statement and stats in the header", () => {
    const out = planToText(plan);
    expect(out).toContain("-- EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) select * from users");
    expect(out).toContain("-- Execution time: 12.5 ms");
  });

  it("omits timings for a plan without ANALYZE", () => {
    const out = planToText({ ...plan, nodes: [{ ...plan.nodes[0], ms: null }] });
    expect(out).not.toContain("ms,");
  });
});

describe("planToMarkdown", () => {
  it("renders the query, stats and node tables", () => {
    const out = planToMarkdown(plan);
    expect(out).toContain("```sql\nselect * from users\n```");
    expect(out).toContain("| Execution time | 12.5 ms |");
    expect(out).toContain("Seq Scan on users");
  });

  it("escapes pipes so they cannot break the table", () => {
    const out = planToMarkdown({ ...plan, nodes: [{ ...plan.nodes[0], detail: "a | b" }] });
    expect(out).toContain("a \\| b");
  });
});

describe("planFilename", () => {
  it("builds a timestamped name", () => {
    expect(planFilename("report.sql", "json")).toMatch(/^report-plan-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.json$/);
  });

  it("sanitises the title", () => {
    expect(planFilename("my query!.sql", "txt")).toMatch(/^my_query-plan-/);
  });

  it("falls back when the title is unusable", () => {
    expect(planFilename("!!!", "md")).toMatch(/^plan-plan-/);
  });
});

describe("readPlanPayload", () => {
  it("rejoins FORMAT TEXT, which arrives one row per line", () => {
    // A real plan here is 295 rows. Taking rows[0] would keep one line of it.
    const rows = [["Seq Scan on t"], ["  Filter: (x = 1)"], ["Planning Time: 0.1 ms"]];
    expect(readPlanPayload(rows, "text")).toBe("Seq Scan on t\n  Filter: (x = 1)\nPlanning Time: 0.1 ms");
  });

  it("keeps a null line rather than printing 'null' or dropping it", () => {
    expect(readPlanPayload([["a"], [null], ["b"]], "text")).toBe("a\n\nb");
  });

  it("takes the single cell for the document formats", () => {
    expect(readPlanPayload([["<explain/>"]], "xml")).toBe("<explain/>");
    expect(readPlanPayload([["- Plan: x"]], "yaml")).toBe("- Plan: x");
  });

  it("serialises a JSON cell the driver already parsed", () => {
    // pg can hand back json as a value, not a string, depending on the column.
    expect(readPlanPayload([[{ Plan: { "Node Type": "Seq Scan" } }]], "json")).toBe(
      '{"Plan":{"Node Type":"Seq Scan"}}',
    );
  });
});

describe("parsePlan", () => {
  const leaf = (over: Partial<RawPlan> = {}): RawPlan => ({
    "Node Type": "Seq Scan",
    "Relation Name": "users",
    "Total Cost": 100,
    ...over,
  });
  const root = (plan: RawPlan, over: Record<string, unknown> = {}) => ({ Plan: plan, ...over });

  it("walks a single node", () => {
    const p = parsePlan([root(leaf())]);
    expect(p.nodes).toHaveLength(1);
    expect(p.nodes[0]).toMatchObject({ kind: "Seq Scan", title: "Seq Scan on users", indent: 0 });
  });

  it("accepts the root bare as well as wrapped in an array", () => {
    // FORMAT JSON gives [{...}]; a driver that unwrapped it should still work.
    expect(parsePlan(root(leaf())).nodes).toHaveLength(1);
  });

  it("indents children by depth", () => {
    const tree = root({
      "Node Type": "Hash Join",
      "Total Cost": 200,
      Plans: [leaf(), { "Node Type": "Hash", "Total Cost": 50, Plans: [leaf({ "Relation Name": "orders" })] }],
    });
    const p = parsePlan([tree]);
    expect(p.nodes.map((n) => [n.title, n.indent])).toEqual([
      ["Hash Join", 0],
      ["Seq Scan on users", 1],
      ["Hash", 1],
      ["Seq Scan on orders", 2],
    ]);
  });

  it("reports real timings as ms and leaves estimates null", () => {
    // The distinction is the point: a cost is not a millisecond, and drawing
    // one as the other invents a measurement that was never taken.
    const analyzed = parsePlan([root(leaf({ "Actual Total Time": 12.5 }))]);
    expect(analyzed.nodes[0].ms).toBe(12.5);
    expect(parsePlan([root(leaf())]).nodes[0].ms).toBeNull();
  });

  it("shares are a percentage of the root's total", () => {
    const tree = root({
      "Node Type": "Hash Join",
      "Actual Total Time": 100,
      Plans: [leaf({ "Actual Total Time": 25 })],
    });
    const p = parsePlan([tree]);
    expect(p.nodes[0].pct).toBe(100);
    expect(p.nodes[1].pct).toBe(25);
  });

  it("caps a share at 100 rather than drawing a bar past the edge", () => {
    // Parallel workers can report a child time above the parent's wall clock.
    const tree = root({ "Node Type": "Gather", "Actual Total Time": 10, Plans: [leaf({ "Actual Total Time": 40 })] });
    expect(parsePlan([tree]).nodes[1].pct).toBe(100);
  });

  it("survives a zero total without producing NaN", () => {
    // COSTS OFF with no ANALYZE leaves nothing to divide by.
    const p = parsePlan([root({ "Node Type": "Result" })]);
    expect(p.nodes[0].pct).toBe(0);
    expect(Number.isNaN(p.nodes[0].pct)).toBe(false);
  });

  it("marks the costliest Seq Scan as the hot spot", () => {
    const tree = root({
      "Node Type": "Hash Join",
      "Actual Total Time": 100,
      Plans: [leaf({ "Actual Total Time": 5 }), leaf({ "Relation Name": "big", "Actual Total Time": 80 })],
    });
    const p = parsePlan([tree]);
    expect(p.nodes.filter((n) => n.hot).map((n) => n.title)).toEqual(["Seq Scan on big"]);
    expect(p.suggestion).toContain("Seq Scan on big");
  });

  it("does not blame an index scan", () => {
    const tree = root({
      "Node Type": "Limit",
      "Actual Total Time": 100,
      Plans: [{ "Node Type": "Index Scan", "Relation Name": "users", "Actual Total Time": 99 }],
    });
    const p = parsePlan([tree]);
    expect(p.nodes.some((n) => n.hot)).toBe(false);
    expect(p.suggestion).toBeNull();
  });

  it("says nothing about a plan that is only a Seq Scan", () => {
    // "An index could avoid the full scan" is not advice on `select * from t`
    // — the user asked to read the table end to end.
    const p = parsePlan([root(leaf({ "Actual Total Time": 9 }))]);
    expect(p.nodes[0].hot).toBe(false);
    expect(p.suggestion).toBeNull();
  });

  it("collects the node's attributes into the detail line", () => {
    const p = parsePlan([
      root(
        leaf({
          "Node Type": "Index Scan",
          "Index Name": "users_pkey",
          Filter: "(id = 1)",
          "Sort Key": ["created_at"],
          "Actual Rows": 1234,
        }),
      ),
    ]);
    expect(p.nodes[0].detail).toBe("index: users_pkey · filter: (id = 1) · sort key: created_at · rows 1,234");
  });

  it("labels estimated rows as estimated", () => {
    expect(parsePlan([root(leaf({ "Plan Rows": 5000 }))]).nodes[0].detail).toBe("est rows 5,000");
  });

  it("prefers actual rows over the estimate when both are there", () => {
    expect(parsePlan([root(leaf({ "Plan Rows": 1, "Actual Rows": 900 }))]).nodes[0].detail).toBe("rows 900");
  });

  it("omits what the server didn't send", () => {
    expect(parsePlan([root(leaf())]).nodes[0].detail).toBe("");
  });

  it("reports the times the server gave and always the node count", () => {
    const p = parsePlan([root(leaf(), { "Planning Time": 0.123, "Execution Time": 45.67 })]);
    expect(p.stats).toEqual([
      { label: "Planning time", value: "0.12 ms" },
      { label: "Execution time", value: "45.7 ms" },
      { label: "Plan nodes", value: "1" },
    ]);
  });

  it("omits timings that weren't measured", () => {
    // Without ANALYZE there is no execution time; a "0.0 ms" would be a lie.
    expect(parsePlan([root(leaf())]).stats).toEqual([{ label: "Plan nodes", value: "1" }]);
  });

  it.each([[null], [undefined], [{}], [{ Plan: null }], [[]], ["not a plan"]])(
    "returns empty for %s rather than throwing away the raw payload",
    (input) => {
      // The modal still shows `raw`. A shape we can't walk is a drawing
      // problem, not a reason to lose what the server actually said.
      const p = parsePlan(input);
      expect(p.nodes).toEqual([]);
      expect(p.suggestion).toBeNull();
      expect(p.insights).toEqual([]);
    },
  );
});

describe("parsePlan — self-time", () => {
  const root = (plan: RawPlan, over: Record<string, unknown> = {}) => ({ Plan: plan, ...over });

  it("charges a node only for the time not spent in its children", () => {
    // A Nested Loop's total is mostly its child's; the loop itself is cheap.
    const p = parsePlan([
      root({
        "Node Type": "Nested Loop",
        "Actual Total Time": 100,
        Plans: [
          { "Node Type": "Index Scan", "Relation Name": "a", "Actual Total Time": 90 },
          { "Node Type": "Seq Scan", "Relation Name": "b", "Actual Total Time": 5 },
        ],
      }),
    ]);
    expect(p.nodes.map((n) => n.selfMs)).toEqual([5, 90, 5]);
  });

  it("multiplies per-loop time by the loop count", () => {
    // Postgres reports Actual Total Time per loop; 2 ms across 10 loops is 20 ms.
    const p = parsePlan([
      root({
        "Node Type": "Nested Loop",
        "Actual Total Time": 50,
        Plans: [{ "Node Type": "Index Scan", "Relation Name": "a", "Actual Total Time": 2, "Actual Loops": 10 }],
      }),
    ]);
    // loop self = 50 - (2*10) = 30; inner self = 2*10 = 20.
    expect(p.nodes.map((n) => n.selfMs)).toEqual([30, 20]);
  });

  it("leaves self-time null without ANALYZE — an estimate is not a measurement", () => {
    const p = parsePlan([root({ "Node Type": "Seq Scan", "Relation Name": "t", "Total Cost": 10 })]);
    expect(p.nodes[0].selfMs).toBeNull();
    expect(p.nodes[0].selfPct).toBe(0);
  });
});

describe("parsePlan — bottleneck", () => {
  const root = (plan: RawPlan) => ({ Plan: plan });

  it("flags the node holding the most self-time, whatever its type", () => {
    const p = parsePlan([
      root({
        "Node Type": "Limit",
        "Actual Total Time": 100,
        Plans: [{ "Node Type": "Index Scan", "Relation Name": "u", "Actual Total Time": 99 }],
      }),
    ]);
    const bn = p.nodes.find((n) => n.flags.includes("bottleneck"));
    expect(bn?.title).toBe("Index Scan on u");
    // An index scan is where the time goes, but there is no index to suggest.
    expect(p.insights[0].text).toMatch(/busiest node/);
    expect(p.insights[0].text).not.toMatch(/index matching/);
  });

  it("appends index advice when the bottleneck is a Seq Scan", () => {
    const p = parsePlan([
      root({
        "Node Type": "Aggregate",
        "Actual Total Time": 100,
        Plans: [{ "Node Type": "Seq Scan", "Relation Name": "big", "Actual Total Time": 92 }],
      }),
    ]);
    const bn = p.nodes.find((n) => n.flags.includes("bottleneck"));
    expect(bn?.title).toBe("Seq Scan on big");
    expect(p.insights[0].text).toMatch(/index matching its filter/);
  });

  it("does not crown a bottleneck below the threshold (negative control)", () => {
    // Five children at 18% each: real work, but no single dominant node.
    const p = parsePlan([
      root({
        "Node Type": "Append",
        "Actual Total Time": 100,
        Plans: [1, 2, 3, 4, 5].map((i) => ({
          "Node Type": "Seq Scan",
          "Relation Name": `p${i}`,
          "Actual Total Time": 18,
        })),
      }),
    ]);
    expect(p.nodes.some((n) => n.flags.includes("bottleneck"))).toBe(false);
    expect(p.insights.some((i) => /busiest node/.test(i.text))).toBe(false);
  });

  it("does not crown a bottleneck on a single-node plan", () => {
    const p = parsePlan([root({ "Node Type": "Seq Scan", "Relation Name": "t", "Actual Total Time": 9 })]);
    expect(p.nodes[0].flags.includes("bottleneck")).toBe(false);
  });
});

describe("parsePlan — resource call-outs", () => {
  const root = (plan: RawPlan) => ({ Plan: plan });

  it("flags a sort that spilled to disk, and not one that stayed in memory", () => {
    const disk = parsePlan([
      root({ "Node Type": "Sort", "Actual Total Time": 30, "Sort Method": "external merge  Disk: 2048kB" }),
    ]);
    expect(disk.nodes[0].flags).toContain("disk-sort");
    expect(disk.insights.some((i) => /spilled to disk/.test(i.text))).toBe(true);

    const mem = parsePlan([
      root({ "Node Type": "Sort", "Actual Total Time": 30, "Sort Method": "quicksort  Memory: 25kB" }),
    ]);
    expect(mem.nodes[0].flags).not.toContain("disk-sort");
  });

  it("flags a hash that spilled to multiple batches, and not a single-batch one", () => {
    const spill = parsePlan([root({ "Node Type": "Hash", "Actual Total Time": 5, "Hash Batches": 4 })]);
    expect(spill.nodes[0].flags).toContain("spill");
    const one = parsePlan([root({ "Node Type": "Hash", "Actual Total Time": 5, "Hash Batches": 1 })]);
    expect(one.nodes[0].flags).not.toContain("spill");
  });

  it("flags a wildly wrong row estimate, and not a close one", () => {
    const off = parsePlan([root({ "Node Type": "Seq Scan", "Relation Name": "t", "Plan Rows": 1, "Actual Rows": 10000 })]);
    expect(off.nodes[0].flags).toContain("misestimate");
    expect(off.nodes[0].misestimate).toBeGreaterThan(10);
    expect(off.insights.some((i) => /estimate is off/.test(i.text))).toBe(true);

    const close = parsePlan([root({ "Node Type": "Seq Scan", "Relation Name": "t", "Plan Rows": 100, "Actual Rows": 120 })]);
    expect(close.nodes[0].flags).not.toContain("misestimate");
    expect(close.nodes[0].misestimate).toBeNull();
  });

  it("orders insights: bottleneck first, then spills, then stale statistics", () => {
    const p = parsePlan([
      root({
        "Node Type": "Sort",
        "Actual Total Time": 100,
        "Sort Method": "external merge  Disk: 4096kB",
        Plans: [{ "Node Type": "Seq Scan", "Relation Name": "big", "Actual Total Time": 80, "Plan Rows": 1, "Actual Rows": 5000 }],
      }),
    ]);
    expect(p.insights.map((i) => i.level)).toEqual(["tip", "warn", "warn"]);
    expect(p.insights[0].text).toMatch(/busiest node/);
    expect(p.insights[1].text).toMatch(/spilled to disk/);
    expect(p.insights[2].text).toMatch(/estimate is off/);
  });
});
