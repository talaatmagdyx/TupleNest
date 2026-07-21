import { describe, expect, it } from "vitest";
import { detectPlanFormat, parseTextPlan, planCaveats, type TextPlanNode } from "./explain-text";
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

/* The cases below were all found by capturing the same queries as TEXT and as
   JSON from a live server and comparing the two parses. Each one is a place the
   text format says something FORMAT JSON says differently — and every one of
   them made the two disagree until it was handled. */
describe("parseTextPlan — speaks JSON's vocabulary, not the text format's", () => {
  it("treats a CTE Scan as a node, not as a CTE label", () => {
    // "CTE Scan on c" begins with the word CTE, but it is a plan node. Only a
    // bare label — no cost or actual tuple — introduces a container.
    const n = root(
      [
        "CTE Scan on c  (cost=4.71..4.83 rows=333 width=12) (actual time=15.521..15.702 rows=1000.00 loops=1)",
        "  CTE c",
        "    ->  Aggregate  (cost=4.35..4.36 rows=1000 width=12) (actual time=15.519..15.622 rows=1000.00 loops=1)",
      ].join("\n"),
    );
    expect(n["Node Type"]).toBe("CTE Scan");
    // JSON files the name under CTE Name; there is no relation here.
    expect(n["CTE Name"]).toBe("c");
    expect(n["Relation Name"]).toBeUndefined();
    expect((n.Plans ?? []).map((k) => k["Node Type"])).toEqual(["Aggregate"]);
  });

  it("attaches a SubPlan's body to the enclosing node, not to the preceding sibling", () => {
    // The body is indented past the label, so without treating the label as a
    // barrier it lands under whichever node came before it. That is not
    // cosmetic: the misplaced subtree takes its time with it and the bottleneck
    // badge ends up on the wrong node.
    const n = root(
      [
        "Bitmap Heap Scan on small  (cost=4.42..75466.35 rows=19 width=12) (actual time=5.308..93.982 rows=19.00 loops=1)",
        "  ->  Bitmap Index Scan on small_id_idx  (cost=0.00..4.42 rows=19 width=0) (actual time=0.004..0.004 rows=19.00 loops=1)",
        "        Index Cond: (id < 20)",
        "  SubPlan 1",
        "    ->  Aggregate  (cost=3971.50..3971.51 rows=1 width=8) (actual time=4.944..4.944 rows=1.00 loops=19)",
      ].join("\n"),
    );
    expect((n.Plans ?? []).map((k) => k["Node Type"])).toEqual(["Bitmap Index Scan", "Aggregate"]);
    // Negative control on the shape: the Aggregate must NOT be a grandchild.
    expect((n.Plans?.[0].Plans ?? []).length).toBe(0);
  });

  it("names the index of a Bitmap Index Scan as an index, not a relation", () => {
    const n = root("Bitmap Index Scan on ix  (cost=0.00..4.42 rows=19 width=0) (actual time=0.004..0.004 rows=19.00 loops=1)");
    expect(n["Index Name"]).toBe("ix");
    expect(n["Relation Name"]).toBeUndefined();
  });

  it("unpacks parallel and partial-mode prefixes into their own fields", () => {
    const n = root(
      [
        "Finalize GroupAggregate  (cost=1.00..2.00 rows=1 width=8) (actual time=1.000..1.000 rows=1.00 loops=1)",
        "  ->  Partial HashAggregate  (cost=1.00..2.00 rows=1 width=8) (actual time=1.000..1.000 rows=1.00 loops=2)",
        "        ->  Parallel Seq Scan on t  (cost=0.00..1.00 rows=1 width=4) (actual time=0.500..0.500 rows=1.00 loops=2)",
      ].join("\n"),
    );
    expect(n["Node Type"]).toBe("Aggregate");
    expect(n["Partial Mode"]).toBe("Finalize");
    expect(n["Strategy"]).toBe("Sorted");
    expect(n["Parallel Aware"]).toBe(false);

    const mid = n.Plans?.[0] as TextPlanNode;
    expect(mid["Node Type"]).toBe("Aggregate");
    expect(mid["Partial Mode"]).toBe("Partial");
    expect(mid["Strategy"]).toBe("Hashed");

    const leaf = mid.Plans?.[0] as TextPlanNode;
    expect(leaf["Node Type"]).toBe("Seq Scan");
    expect(leaf["Parallel Aware"]).toBe(true);
    expect(leaf["Relation Name"]).toBe("t");
  });

  it("splits the join type out of the node name", () => {
    const n = root("Hash Right Semi Join  (cost=1.00..2.00 rows=1 width=4) (actual time=1.000..1.000 rows=1.00 loops=1)");
    expect(n["Node Type"]).toBe("Hash Join");
    expect(n["Join Type"]).toBe("Right Semi");

    // An inner join prints no join word at all; JSON still names it.
    const inner = root("Hash Join  (cost=1.00..2.00 rows=1 width=4) (actual time=1.000..1.000 rows=1.00 loops=1)");
    expect(inner["Node Type"]).toBe("Hash Join");
    expect(inner["Join Type"]).toBe("Inner");
  });

  it("reports a write as ModifyTable with an operation", () => {
    const n = root("Insert on t  (cost=0.00..1.00 rows=0 width=0) (actual time=1.000..1.000 rows=0.00 loops=1)");
    expect(n["Node Type"]).toBe("ModifyTable");
    expect(n["Operation"]).toBe("Insert");
    expect(n["Relation Name"]).toBe("t");
  });

  it("separates the schema VERBOSE prepends to the relation", () => {
    const n = root("Seq Scan on public.t a  (cost=0.00..1.00 rows=1 width=4) (actual time=0.001..0.002 rows=1.00 loops=1)");
    expect(n["Schema"]).toBe("public");
    expect(n["Relation Name"]).toBe("t");
    expect(n["Alias"]).toBe("a");
  });

  it("files a spilling aggregate's batches where the analyzer looks for them", () => {
    // A Hash node and a HashAggregate report batches under different keys in
    // FORMAT JSON, and both mean "it spilled".
    const p = parsePlan(
      parseTextPlan(
        [
          "Aggregate  (cost=4.35..4.36 rows=1000 width=12) (actual time=15.519..15.622 rows=1000.00 loops=1)",
          "  Batches: 5  Memory Usage: 161kB  Disk Usage: 200kB",
          "Execution Time: 16.000 ms",
        ].join("\n"),
      ),
    );
    expect(p.nodes[0].flags).toContain("spill");
  });

  it("reads a filter that discarded nothing as zero, not as unknown", () => {
    // The text format prints the counter only when it is non-zero; JSON always
    // prints it. Without seeding, "kept everything" and "no ANALYZE" look alike.
    const n = root(
      [
        "Seq Scan on t  (cost=0.00..1.00 rows=1 width=4) (actual time=0.001..0.002 rows=1.00 loops=1)",
        "  Filter: (n > 1)",
      ].join("\n"),
    );
    expect(n["Rows Removed by Filter"]).toBe(0);

    // Negative control: with no ANALYZE there are no removal counts at all, so
    // seeding a zero would be inventing a measurement.
    const noAnalyze = root(["Seq Scan on t  (cost=0.00..1.00 rows=1 width=4)", "  Filter: (n > 1)"].join("\n"));
    expect(noAnalyze["Rows Removed by Filter"]).toBeUndefined();
  });
});

describe("parseTextPlan — a paste that is only part of a plan", () => {
  const FULL = [
    "Nested Loop  (cost=0.42..100.00 rows=10 width=8) (actual time=0.100..90.000 rows=10.00 loops=1)",
    "  ->  Seq Scan on a  (cost=0.00..10.00 rows=10 width=4) (actual time=0.010..1.000 rows=10.00 loops=1)",
    "  ->  Index Scan using ix on b  (cost=0.42..9.00 rows=1 width=4) (actual time=8.000..8.500 rows=1.00 loops=10)",
    "Execution Time: 90.500 ms",
  ].join("\n");

  it("does not adopt orphaned siblings into the first one", () => {
    // With the root cut away, the nodes that were under it are left level with
    // each other. Making the first their parent would invent a relationship the
    // paste never showed — and hand it their time.
    const headless = FULL.split("\n").slice(1).join("\n");
    const docs = parseTextPlan(headless);
    expect(docs).toHaveLength(2);
    expect(docs?.[0].Plan["Node Type"]).toBe("Seq Scan");
    expect(docs?.[1].Plan["Node Type"]).toBe("Index Scan");
    expect(docs?.[0].Plan.Plans).toBeUndefined();
  });

  it("reports a missing root, and says nothing about a whole plan", () => {
    expect(planCaveats(FULL.split("\n").slice(1).join("\n"))).toEqual(["missing-root"]);
    // Negative control: the complete plan must produce no caveat at all, or the
    // warning becomes noise everyone learns to ignore.
    expect(planCaveats(FULL)).toEqual([]);
  });

  it("reports a paste cut off in the middle of a line", () => {
    const cut = FULL.slice(0, FULL.indexOf("Index Scan") + 30);
    expect(planCaveats(cut)).toEqual(["cut-short"]);
    // Cut at a line boundary instead: the tree is short but nothing on screen
    // is wrong, and claiming otherwise would be guessing.
    expect(planCaveats(FULL.split("\n").slice(0, 2).join("\n"))).toEqual([]);
  });

  it("still parses the fragment, because a partial answer beats none", () => {
    const cut = FULL.slice(0, FULL.indexOf("Index Scan") + 30);
    const p = parsePlan(parseTextPlan(cut));
    expect(p.nodes.length).toBeGreaterThan(0);
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
