import { describe, expect, it } from "vitest";
import { detectPlanFormat, parseTextPlan, type TextPlanNode } from "./explain-text";
import { parsePlan } from "./explain";

/* Every plan here is written by hand against the documented text format, not
   copied from anyone's database — a plan carries table names, index names and
   filter conditions, and those are not ours to check in. The shapes were
   confirmed against a live PostgreSQL 18 during development. */

const root = (text: string): TextPlanNode => {
  const r = parseTextPlan(text);
  if (!r) throw new Error("expected a parseable plan");
  return r[0].Plan;
};
const doc = (text: string) => {
  const r = parseTextPlan(text);
  if (!r) throw new Error("expected a parseable plan");
  return r[0];
};

describe("parseTextPlan — shape", () => {
  it("reads a single node with both tuples", () => {
    const n = root("Seq Scan on t  (cost=0.00..10.50 rows=42 width=8) (actual time=0.010..1.250 rows=40.00 loops=1)");
    expect(n["Node Type"]).toBe("Seq Scan");
    expect(n["Relation Name"]).toBe("t");
    expect(n["Total Cost"]).toBe(10.5);
    expect(n["Plan Rows"]).toBe(42);
    expect(n["Actual Total Time"]).toBe(1.25);
    expect(n["Actual Rows"]).toBe(40);
    expect(n["Actual Loops"]).toBe(1);
  });

  it("nests children by the column their text starts at", () => {
    const n = root(
      [
        "Hash Join  (cost=1.00..9.00 rows=1 width=4) (actual time=0.100..3.000 rows=5.00 loops=1)",
        "  ->  Seq Scan on a  (cost=0.00..4.00 rows=1 width=4) (actual time=0.010..1.000 rows=5.00 loops=1)",
        "  ->  Hash  (cost=0.00..1.00 rows=1 width=4) (actual time=0.050..0.050 rows=1.00 loops=1)",
        "        ->  Seq Scan on b  (cost=0.00..1.00 rows=1 width=4) (actual time=0.005..0.010 rows=1.00 loops=1)",
      ].join("\n"),
    );
    expect(n["Node Type"]).toBe("Hash Join");
    const kids = n.Plans ?? [];
    expect(kids.map((k) => k["Node Type"])).toEqual(["Seq Scan", "Hash"]);
    expect(kids[1].Plans?.[0]["Relation Name"]).toBe("b");
  });

  it("splits an index scan into node, index and relation, dropping the alias", () => {
    // The alias is not part of the relation name in FORMAT JSON either.
    const n = root("Index Only Scan using ix_t_id on t alias_a  (cost=0.42..8.44 rows=1 width=4) (actual time=0.001..0.002 rows=1.00 loops=1)");
    expect(n["Node Type"]).toBe("Index Only Scan");
    expect(n["Index Name"]).toBe("ix_t_id");
    expect(n["Relation Name"]).toBe("t");
    expect(n["Alias"]).toBe("alias_a");
  });

  it("returns null for something that is not a plan", () => {
    expect(parseTextPlan("")).toBeNull();
    expect(parseTextPlan("select * from t")).toBeNull();
    expect(parseTextPlan("hello world")).toBeNull();
  });
});

describe("parseTextPlan — measurements", () => {
  it("accepts the decimal row counts PostgreSQL 18 emits", () => {
    // Older servers print `rows=51`; 18 prints `rows=51.00`. Both must read.
    const older = root("Seq Scan on t  (cost=0.00..1.00 rows=1 width=4) (actual time=0.001..0.002 rows=51 loops=1)");
    const newer = root("Seq Scan on t  (cost=0.00..1.00 rows=1 width=4) (actual time=0.001..0.002 rows=51.00 loops=1)");
    expect(older["Actual Rows"]).toBe(51);
    expect(newer["Actual Rows"]).toBe(51);
  });

  it("reads a plan with TIMING OFF, which still reports rows and loops", () => {
    const n = root("Seq Scan on t  (cost=0.00..1.00 rows=1 width=4) (actual rows=7.00 loops=3)");
    expect(n["Actual Rows"]).toBe(7);
    expect(n["Actual Loops"]).toBe(3);
    expect(n["Actual Total Time"]).toBeUndefined();
  });

  it("reads a plan with no ANALYZE at all", () => {
    const n = root("Seq Scan on t  (cost=0.00..10.00 rows=5 width=4)");
    expect(n["Total Cost"]).toBe(10);
    expect(n["Actual Total Time"]).toBeUndefined();
  });

  it("marks a never-executed branch with the zeros FORMAT JSON reports", () => {
    const n = root(
      [
        "Nested Loop  (cost=0.84..12.89 rows=1 width=4) (actual time=0.002..0.002 rows=0.00 loops=1)",
        "  ->  Seq Scan on a  (cost=0.42..4.44 rows=1 width=4) (actual time=0.001..0.002 rows=0.00 loops=1)",
        "  ->  Index Scan using ix on b  (cost=0.42..8.44 rows=1 width=4) (never executed)",
      ].join("\n"),
    );
    const skipped = (n.Plans ?? [])[1];
    expect(skipped["Never Executed"]).toBe(true);
    expect(skipped["Actual Loops"]).toBe(0);
    expect(skipped["Actual Total Time"]).toBe(0);
  });
});

describe("parseTextPlan — attributes", () => {
  it("reads shared and temp buffers", () => {
    const n = root(
      [
        "Sort  (cost=1.00..2.00 rows=1 width=4) (actual time=1.000..2.000 rows=1.00 loops=1)",
        "  Buffers: shared hit=383 read=4295 dirtied=2 written=1, temp read=13953 written=14714",
      ].join("\n"),
    );
    expect(n["Shared Hit Blocks"]).toBe(383);
    expect(n["Shared Read Blocks"]).toBe(4295);
    expect(n["Shared Dirtied Blocks"]).toBe(2);
    expect(n["Shared Written Blocks"]).toBe(1);
    expect(n["Temp Read Blocks"]).toBe(13953);
    expect(n["Temp Written Blocks"]).toBe(14714);
  });

  it("treats a missing counter as zero, because text omits what JSON prints", () => {
    const n = root(
      [
        "Sort  (cost=1.00..2.00 rows=1 width=4) (actual time=1.000..2.000 rows=1.00 loops=1)",
        "  Buffers: shared hit=7",
      ].join("\n"),
    );
    expect(n["Shared Read Blocks"]).toBe(0);
    expect(n["Temp Written Blocks"]).toBe(0);
  });

  it("seeds zero buffers on nodes that printed no Buffers line at all", () => {
    // A Function Scan touches nothing, so the text prints nothing — but the
    // same plan in JSON reports zeros, and the two must agree.
    const n = root(
      [
        "Insert on t  (cost=0.00..2.00 rows=0 width=0) (actual time=0.205..0.208 rows=0.00 loops=1)",
        "  Buffers: shared hit=199",
        "  ->  Function Scan on generate_series g  (cost=0.00..2.00 rows=200 width=4) (actual time=0.011..0.017 rows=200.00 loops=1)",
      ].join("\n"),
    );
    expect((n.Plans ?? [])[0]["Shared Hit Blocks"]).toBe(0);
  });

  it("leaves buffers absent entirely when BUFFERS was never requested", () => {
    const n = root("Seq Scan on t  (cost=0.00..1.00 rows=1 width=4) (actual time=0.001..0.002 rows=1.00 loops=1)");
    expect(n["Shared Hit Blocks"]).toBeUndefined();
  });

  it("splits a disk sort from an in-memory one", () => {
    const disk = root(
      [
        "Sort  (cost=1.00..2.00 rows=1 width=4) (actual time=1.000..2.000 rows=1.00 loops=1)",
        "  Sort Method: external merge  Disk: 27944kB",
      ].join("\n"),
    );
    expect(disk["Sort Method"]).toBe("external merge");
    expect(disk["Sort Space Type"]).toBe("Disk");
    expect(disk["Sort Space Used"]).toBe(27944);

    const mem = root(
      [
        "Sort  (cost=1.00..2.00 rows=1 width=4) (actual time=1.000..2.000 rows=1.00 loops=1)",
        "  Sort Method: quicksort  Memory: 26kB",
      ].join("\n"),
    );
    expect(mem["Sort Method"]).toBe("quicksort");
    expect(mem["Sort Space Type"]).toBe("Memory");
  });

  it("reads hash buckets, batches and peak memory from one line", () => {
    const n = root(
      [
        "Hash  (cost=1.00..2.00 rows=1 width=4) (actual time=1.000..2.000 rows=1.00 loops=1)",
        "  Buckets: 32768  Batches: 4  Memory Usage: 960kB",
      ].join("\n"),
    );
    expect(n["Hash Buckets"]).toBe(32768);
    expect(n["Hash Batches"]).toBe(4);
    expect(n["Peak Memory Usage"]).toBe(960);
  });

  it("reads rows removed by a filter", () => {
    const n = root(
      [
        "Seq Scan on t  (cost=0.00..1.00 rows=1 width=4) (actual time=0.001..0.002 rows=12.00 loops=1)",
        "  Filter: (x > 5)",
        "  Rows Removed by Filter: 2999988",
      ].join("\n"),
    );
    expect(n["Rows Removed by Filter"]).toBe(2999988);
    expect(n["Filter"]).toBe("(x > 5)");
  });

  it("reads the worker counts a parallel plan depends on", () => {
    const n = root(
      [
        "Gather Merge  (cost=1.00..2.00 rows=1 width=4) (actual time=1.000..2.000 rows=1.00 loops=1)",
        "  Workers Planned: 2",
        "  Workers Launched: 2",
      ].join("\n"),
    );
    expect(n["Workers Planned"]).toBe(2);
    expect(n["Workers Launched"]).toBe(2);
  });

  it("ignores per-worker echoes of the parent's own attributes", () => {
    // Counting these would double every measurement they repeat.
    const n = root(
      [
        "Sort  (cost=1.00..2.00 rows=1 width=4) (actual time=1.000..2.000 rows=1.00 loops=3)",
        "  Sort Method: quicksort  Memory: 26kB",
        "  Worker 0:  Sort Method: quicksort  Memory: 99kB",
        "  Worker 1:  Sort Method: quicksort  Memory: 98kB",
      ].join("\n"),
    );
    expect(n["Sort Method"]).toBe("quicksort");
    expect(n.Plans).toBeUndefined();
  });
});

describe("parseTextPlan — containers and trailers", () => {
  it("hangs a CTE's plan off the node that owns it, as JSON does", () => {
    const n = root(
      [
        "Aggregate  (cost=12.62..12.63 rows=1 width=8) (actual time=0.020..0.021 rows=1.00 loops=1)",
        "  CTE x",
        "    ->  Seq Scan on t  (cost=0.42..10.26 rows=105 width=4) (actual time=0.004..0.007 rows=99.00 loops=1)",
        "  ->  CTE Scan on x  (cost=0.00..2.10 rows=105 width=0) (actual time=0.005..0.014 rows=99.00 loops=1)",
      ].join("\n"),
    );
    expect((n.Plans ?? []).map((k) => k["Node Type"])).toEqual(["Seq Scan", "CTE Scan"]);
  });

  it("does the same for SubPlan and InitPlan", () => {
    const n = root(
      [
        "Seq Scan on t  (cost=0.00..1.00 rows=1 width=4) (actual time=0.001..0.002 rows=1.00 loops=1)",
        "  InitPlan 1 (returns $0)",
        "    ->  Aggregate  (cost=0.00..1.00 rows=1 width=8) (actual time=0.001..0.001 rows=1.00 loops=1)",
        "  SubPlan 2",
        "    ->  Index Scan using ix on u  (cost=0.00..1.00 rows=1 width=4) (actual time=0.001..0.001 rows=1.00 loops=1)",
      ].join("\n"),
    );
    expect((n.Plans ?? []).map((k) => k["Node Type"])).toEqual(["Aggregate", "Index Scan"]);
  });

  it("reads planning and execution time", () => {
    const d = doc(
      [
        "Seq Scan on t  (cost=0.00..1.00 rows=1 width=4) (actual time=0.001..0.002 rows=1.00 loops=1)",
        "Planning Time: 2.393 ms",
        "Execution Time: 16.693 ms",
      ].join("\n"),
    );
    expect(d["Planning Time"]).toBe(2.393);
    expect(d["Execution Time"]).toBe(16.693);
  });

  it("does not mistake the Planning buffers block for a node's attributes", () => {
    // `Planning:` is followed by an indented Buffers line that belongs to the
    // planner, not to the last node in the tree.
    const d = doc(
      [
        "Seq Scan on t  (cost=0.00..1.00 rows=1 width=4) (actual time=0.001..0.002 rows=1.00 loops=1)",
        "  Buffers: shared hit=5",
        "Planning:",
        "  Buffers: shared hit=92 read=4",
        "Planning Time: 2.393 ms",
      ].join("\n"),
    );
    expect((d.Plan as TextPlanNode)["Shared Hit Blocks"]).toBe(5);
  });

  it("reads triggers, which sit outside the plan tree", () => {
    const d = doc(
      [
        "Insert on t  (cost=0.00..2.00 rows=0 width=0) (actual time=0.205..0.208 rows=0.00 loops=1)",
        "Planning Time: 0.049 ms",
        "Trigger t_audit: time=1.809 calls=200",
        "Execution Time: 2.053 ms",
      ].join("\n"),
    );
    expect(d["Triggers"]).toEqual([{ "Trigger Name": "t_audit", Time: 1.809, Calls: 200 }]);
  });

  it("reads JIT total time", () => {
    const d = doc(
      [
        "Aggregate  (cost=0.00..1.00 rows=1 width=8) (actual time=1.000..1.000 rows=1.00 loops=1)",
        "JIT:",
        "  Functions: 4",
        "  Timing: Generation 0.5 ms, Inlining 1.0 ms, Optimization 3.0 ms, Emission 3.5 ms, Total 8.0 ms",
        "Execution Time: 20.000 ms",
      ].join("\n"),
    );
    expect(d["JIT"]).toEqual({ Timing: { Total: 8 } });
  });

  it("survives Windows line endings", () => {
    const n = root("Seq Scan on t  (cost=0.00..1.00 rows=1 width=4) (actual time=0.001..0.002 rows=1.00 loops=1)\r\n  Buffers: shared hit=5\r\n");
    expect(n["Shared Hit Blocks"]).toBe(5);
  });
});

describe("parseTextPlan — feeds the analyzer unchanged", () => {
  it("produces flags and insights from a pasted text plan", () => {
    const parsed = parseTextPlan(
      [
        "Sort  (cost=92391.90..93141.90 rows=300000 width=85) (actual time=143.935..157.570 rows=300000.00 loops=1)",
        "  Sort Key: pad, id",
        "  Sort Method: external merge  Disk: 27944kB",
        "  Buffers: shared hit=383 read=4295, temp read=13953 written=14714",
        "  ->  Seq Scan on t  (cost=0.00..7672.00 rows=300000 width=85) (actual time=0.055..24.336 rows=300000.00 loops=1)",
        "        Buffers: shared hit=377 read=4295",
        "Planning Time: 1.319 ms",
        "Execution Time: 168.000 ms",
      ].join("\n"),
    );
    const p = parsePlan(parsed);
    expect(p.nodes).toHaveLength(2);
    expect(p.nodes[0].flags).toContain("bottleneck");
    expect(p.nodes[0].flags).toContain("disk-sort");
    expect(p.insights.some((i) => /spilled to disk/.test(i.text))).toBe(true);
    expect(p.stats).toContainEqual({ label: "Execution time", value: "168.0 ms" });
  });

  it("divides parallel workers back out, exactly as the JSON path does", () => {
    const parsed = parseTextPlan(
      [
        "Gather Merge  (cost=1.00..2.00 rows=1 width=4) (actual time=21.100..21.100 rows=1.00 loops=1)",
        "  Workers Launched: 2",
        "  ->  Seq Scan on t  (cost=0.00..1.00 rows=1 width=4) (actual time=9.900..9.900 rows=1.00 loops=3)",
        "Execution Time: 21.400 ms",
      ].join("\n"),
    );
    const p = parsePlan(parsed);
    // 9.9 ms across 3 concurrent workers is 9.9 ms of wall clock, not 29.7.
    expect(p.nodes[1].selfMs).toBeCloseTo(9.9, 5);
    expect(p.nodes[1].selfPct).toBeLessThan(100);
  });
});

describe("detectPlanFormat", () => {
  it("recognises JSON", () => {
    expect(detectPlanFormat('[{"Plan":{"Node Type":"Seq Scan"}}]')).toBe("json");
    expect(detectPlanFormat('  {"Plan":{}}  ')).toBe("json");
  });

  it("recognises text", () => {
    expect(detectPlanFormat("Seq Scan on t  (cost=0.00..1.00 rows=1 width=4)")).toBe("text");
  });

  it("says nothing rather than guessing", () => {
    expect(detectPlanFormat("")).toBeNull();
    expect(detectPlanFormat("select 1")).toBeNull();
    // Looks like JSON, isn't. Calling it text would produce a confusing error.
    expect(detectPlanFormat('[{"Plan": ')).toBeNull();
  });
});
