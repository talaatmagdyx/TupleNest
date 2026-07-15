import { describe, it, expect } from "vitest";
import {
  DEFAULT_EXPLAIN,
  buildExplain,
  explainLabel,
  isMutating,
  optionIssues,
  planFilename,
  planToJson,
  planToMarkdown,
  planToText,
  type ExplainOptions,
  type ExportablePlan,
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
