import { describe, it, expect } from "vitest";
import {
  diffPlanTrees,
  generateMigration,
  migrationScript,
  comparePlans,
  diffSchemas,
  findUsages,
  renameIdentifier,
  summarizePlan,
  unknownTables,
} from "./intel";
import type { Catalog } from "./complete";

const col = (name: string, dbType: string, primaryKey = false, nullable = true) => ({
  name,
  dbType,
  nullable,
  primaryKey,
  comment: null,
});

describe("findUsages", () => {
  it("finds a standalone identifier", () => {
    const hits = findUsages("select * from users", "users");
    expect(hits).toHaveLength(1);
    expect(hits[0].start).toBe(14);
    expect(hits[0].line).toBe(1);
  });

  it("does not match inside a longer identifier", () => {
    expect(findUsages("select * from users_archive", "users")).toHaveLength(0);
    expect(findUsages("select * from archive_users", "users")).toHaveLength(0);
  });

  it("matches after a dot (schema/alias qualified)", () => {
    expect(findUsages("select * from public.users", "users")).toHaveLength(1);
  });

  it("is case-insensitive", () => {
    expect(findUsages("select * from USERS", "users")).toHaveLength(1);
  });

  it("ignores occurrences in comments", () => {
    expect(findUsages("select 1 -- from users\n", "users")).toHaveLength(0);
  });

  it("ignores occurrences in string literals", () => {
    expect(findUsages("select 'users' from orders", "users")).toHaveLength(0);
  });

  it("reports line numbers and previews", () => {
    const hits = findUsages("select 1\nfrom users\nwhere x", "users");
    expect(hits[0].line).toBe(2);
    expect(hits[0].preview).toBe("from users");
  });

  it("finds several occurrences", () => {
    expect(findUsages("select * from users u join users v on 1=1", "users")).toHaveLength(2);
  });

  it("returns nothing for an empty needle", () => expect(findUsages("select 1", "")).toEqual([]));
});

describe("renameIdentifier", () => {
  it("renames every standalone occurrence", () => {
    const r = renameIdentifier("select u.id from users u join users v on 1=1", "users", "people");
    expect(r.count).toBe(2);
    expect(r.sql).toBe("select u.id from people u join people v on 1=1");
  });

  it("leaves longer identifiers alone", () => {
    const r = renameIdentifier("select * from users_archive, users", "users", "people");
    expect(r.count).toBe(1);
    expect(r.sql).toBe("select * from users_archive, people");
  });

  it("leaves comments and strings alone", () => {
    const r = renameIdentifier("select 'users' from users -- users\n", "users", "people");
    expect(r.count).toBe(1);
    expect(r.sql).toBe("select 'users' from people -- users\n");
  });

  it("handles a rename to a longer name without corrupting later offsets", () => {
    const r = renameIdentifier("from users, users, users", "users", "much_longer_name");
    expect(r.count).toBe(3);
    expect(r.sql).toBe("from much_longer_name, much_longer_name, much_longer_name");
  });

  it("is a no-op when nothing matches", () => {
    expect(renameIdentifier("select 1", "users", "people")).toEqual({ sql: "select 1", count: 0 });
  });
});

describe("unknownTables", () => {
  const cat: Catalog = {
    schemas: ["public"],
    tables: [{ schema: "public", name: "users", kind: "table" }],
    columns: {},
    searchPath: ["public"],
  };

  it("flags a table the catalog has never heard of", () => {
    expect(unknownTables("select * from userz", cat)).toEqual(["userz"]);
  });

  it("says nothing about known tables", () => {
    expect(unknownTables("select * from users", cat)).toEqual([]);
  });

  it("does not repeat a name", () => {
    expect(unknownTables("select * from userz u join userz v on 1=1", cat)).toEqual(["userz"]);
  });
});

describe("diffSchemas", () => {
  const left = {
    users: [col("id", "int8", true, false), col("email", "text")],
    legacy: [col("x", "int4")],
  };
  const right = {
    users: [col("id", "int8", true, false), col("email", "varchar"), col("age", "int4")],
    fresh: [col("y", "int4")],
  };

  it("detects an added table", () => {
    expect(diffSchemas(left, right)).toContainEqual({ kind: "added", table: "fresh" });
  });

  it("detects a removed table", () => {
    expect(diffSchemas(left, right)).toContainEqual({ kind: "removed", table: "legacy" });
  });

  it("detects an added column", () => {
    const users = diffSchemas(left, right).find((d) => d.table === "users");
    expect(users?.kind).toBe("changed");
    if (users?.kind === "changed") {
      // `nullable` rides along so the migration can restore a NOT NULL.
      expect(users.columns).toContainEqual({ kind: "added", column: "age", type: "int4", nullable: true });
    }
  });

  it("detects a type change", () => {
    const users = diffSchemas(left, right).find((d) => d.table === "users");
    if (users?.kind === "changed") {
      expect(users.columns).toContainEqual({
        kind: "type-changed",
        column: "email",
        from: "text",
        to: "varchar",
      });
    }
  });

  it("detects a removed column", () => {
    const d = diffSchemas({ t: [col("a", "int4"), col("b", "int4")] }, { t: [col("a", "int4")] });
    expect(d[0]).toMatchObject({ kind: "changed", table: "t" });
    if (d[0].kind === "changed") {
      expect(d[0].columns).toContainEqual({ kind: "removed", column: "b", type: "int4" });
    }
  });

  it("detects nullability and pk changes", () => {
    const d = diffSchemas(
      { t: [col("a", "int4", false, true)] },
      { t: [col("a", "int4", true, false)] }
    );
    if (d[0].kind === "changed") {
      expect(d[0].columns).toContainEqual({ kind: "nullability-changed", column: "a", from: true, to: false });
      expect(d[0].columns).toContainEqual({ kind: "pk-changed", column: "a", from: false, to: true });
    }
  });

  it("reports nothing for identical schemas", () => {
    expect(diffSchemas(left, left)).toEqual([]);
  });
});

describe("summarizePlan", () => {
  const plan = {
    Plan: {
      "Node Type": "Nested Loop",
      "Total Cost": 120.5,
      "Actual Rows": 42,
      Plans: [
        { "Node Type": "Seq Scan", Plans: [] },
        { "Node Type": "Index Scan", Plans: [{ "Node Type": "Seq Scan" }] },
      ],
    },
    "Execution Time": 15.25,
  };

  it("totals cost, time and rows", () => {
    const s = summarizePlan(plan);
    expect(s.totalCost).toBe(120.5);
    expect(s.totalMs).toBe(15.25);
    expect(s.rows).toBe(42);
  });

  it("counts node types across the whole tree", () => {
    const s = summarizePlan(plan);
    expect(s.nodes["Seq Scan"]).toBe(2);
    expect(s.nodes["Index Scan"]).toBe(1);
    expect(s.nodes["Nested Loop"]).toBe(1);
  });

  it("tolerates a plan with no timing (plain EXPLAIN)", () => {
    const s = summarizePlan({ Plan: { "Node Type": "Seq Scan", "Total Cost": 5 } });
    expect(s.totalMs).toBeNull();
    expect(s.totalCost).toBe(5);
  });
});

describe("comparePlans", () => {
  const fast = summarizePlan({
    Plan: { "Node Type": "Index Scan", "Total Cost": 10 },
    "Execution Time": 5,
  });
  const slow = summarizePlan({
    Plan: { "Node Type": "Seq Scan", "Total Cost": 100 },
    "Execution Time": 20,
  });

  it("computes absolute deltas", () => {
    const d = comparePlans(fast, slow);
    expect(d.msDelta).toBe(15);
    expect(d.costDelta).toBe(90);
  });

  it("computes percentages", () => {
    const d = comparePlans(fast, slow);
    expect(d.msPercent).toBe(300);
    expect(d.costPercent).toBe(900);
  });

  it("flags a newly introduced seq scan", () => {
    expect(comparePlans(fast, slow).newSeqScan).toBe(true);
    expect(comparePlans(slow, fast).newSeqScan).toBe(false);
  });

  it("lists node count changes", () => {
    const d = comparePlans(fast, slow);
    expect(d.nodeChanges).toContainEqual({ node: "Seq Scan", from: 0, to: 1 });
    expect(d.nodeChanges).toContainEqual({ node: "Index Scan", from: 1, to: 0 });
  });

  it("reports an improvement as a negative delta", () => {
    const d = comparePlans(slow, fast);
    expect(d.msDelta).toBe(-15);
    expect(d.msPercent).toBe(-75);
  });

  it("handles missing timings", () => {
    const a = summarizePlan({ Plan: { "Node Type": "Seq Scan", "Total Cost": 5 } });
    expect(comparePlans(a, a).msDelta).toBeNull();
  });
});

describe("findUsages — unicode identifiers", () => {
  /*
   * The identifier class was `[A-Za-z0-9_$]`. PostgreSQL identifiers are
   * unicode, so `é` read as a word boundary and `id` matched *inside*
   * `café_id` — a spurious whole-word hit, which is exactly what the boundary
   * check exists to prevent. Rename would then have rewritten part of an
   * unrelated column.
   */
  it("does not match inside a name with a non-ASCII letter", () => {
    expect(findUsages("select café_id from t", "id")).toHaveLength(0);
  });

  it("finds a unicode identifier as a whole word", () => {
    const hits = findUsages("select café_id from t where café_id = 1", "café_id");
    expect(hits).toHaveLength(2);
  });

  it("still refuses a substring of a unicode name", () => {
    expect(findUsages("select naïve_flag from t", "naïve")).toHaveLength(0);
  });

  it("handles a name that is entirely non-ASCII", () => {
    expect(findUsages("select 数量 from t", "数量")).toHaveLength(1);
  });

  it("keeps ASCII behaviour unchanged", () => {
    expect(findUsages("select users_archive from t", "users")).toHaveLength(0);
    expect(findUsages("select users from users", "users")).toHaveLength(2);
  });
});

describe("generateMigration — DDL to read, not to run", () => {
  const gen = (l: Record<string, ReturnType<typeof col>[]>, r: Record<string, ReturnType<typeof col>[]>) =>
    generateMigration(diffSchemas(l, r), "public", r);

  it("adds a nullable column as a safe statement", () => {
    const s = gen({ t: [col("a", "int4")] }, { t: [col("a", "int4"), col("b", "text")] });
    expect(s).toHaveLength(1);
    expect(s[0].sql).toBe('ALTER TABLE "public"."t" ADD COLUMN "b" text;');
    expect(s[0].risk).toBe("safe");
  });

  it("comments out a dropped column and calls it destructive", () => {
    const s = gen({ t: [col("a", "int4"), col("b", "text")] }, { t: [col("a", "int4")] });
    expect(s[0].risk).toBe("destructive");
    // Every line commented: pasting the script whole must not drop anything.
    expect(s[0].sql.split("\n").every((l) => l.startsWith("-- "))).toBe(true);
    expect(s[0].sql).toContain('DROP COLUMN "b"');
  });

  it("comments out a dropped table", () => {
    const s = gen({ gone: [col("a", "int4")] }, {});
    expect(s[0].risk).toBe("destructive");
    expect(s[0].sql.startsWith("-- ")).toBe(true);
  });

  it("writes a new table out in full when the target columns are known", () => {
    const s = gen({}, { fresh: [col("id", "int8", true, false), col("name", "text")] });
    expect(s[0].sql).toContain('CREATE TABLE "public"."fresh"');
    expect(s[0].sql).toContain('"id" int8 NOT NULL');
    expect(s[0].sql).toContain('"name" text');
    // Not "safe": a column diff has no keys, defaults or indexes in it.
    expect(s[0].risk).toBe("review");
    expect(s[0].note).toMatch(/primary keys/i);
  });

  it("says so rather than inventing a definition it does not have", () => {
    const s = generateMigration(diffSchemas({}, { fresh: [col("a", "int4")] }), "public");
    expect(s[0].sql.startsWith("-- ")).toBe(true);
    expect(s[0].note).toMatch(/not loaded/i);
  });

  it("flags a type change as needing review, with the lock warning", () => {
    const s = gen({ t: [col("a", "text")] }, { t: [col("a", "int4")] });
    expect(s[0].risk).toBe("review");
    expect(s[0].sql).toBe('ALTER TABLE "public"."t" ALTER COLUMN "a" TYPE int4 USING "a"::int4;');
    expect(s[0].note).toMatch(/ACCESS EXCLUSIVE/);
  });

  it("treats relaxing NOT NULL as safe and adding it as review", () => {
    const relax = gen({ t: [col("a", "int4", false, false)] }, { t: [col("a", "int4", false, true)] });
    expect(relax[0].risk).toBe("safe");
    expect(relax[0].sql).toContain("DROP NOT NULL");

    const tighten = gen({ t: [col("a", "int4", false, true)] }, { t: [col("a", "int4", false, false)] });
    expect(tighten[0].risk).toBe("review");
    expect(tighten[0].sql).toContain("SET NOT NULL");
    expect(tighten[0].note).toMatch(/NULL/);
  });

  it("will not pretend to know a constraint name it was never given", () => {
    const s = gen({ t: [col("a", "int4", false, false)] }, { t: [col("a", "int4", true, false)] });
    expect(s[0].sql.startsWith("-- ")).toBe(true);
    expect(s[0].note).toMatch(/does not carry the name/i);
  });

  it("puts additive statements before removals", () => {
    const s = gen({ t: [col("a", "int4"), col("old", "text")] }, { t: [col("a", "int4"), col("new", "text")] });
    expect(s[0].sql).toContain("ADD COLUMN");
    expect(s[1].risk).toBe("destructive");
  });

  it("escapes a quote in an identifier", () => {
    const s = gen({ 'ev"il': [col("a", "int4")] }, { 'ev"il': [col("a", "int4"), col("b", "text")] });
    expect(s[0].sql).toContain('"ev""il"');
  });

  it("produces nothing for identical schemas", () => {
    expect(gen({ t: [col("a", "int4")] }, { t: [col("a", "int4")] })).toEqual([]);
  });
});

describe("migrationScript", () => {
  it("says plainly that nothing has been run", () => {
    const s = migrationScript([{ sql: "ALTER TABLE x ADD COLUMN y text;", risk: "safe", note: "n" }]);
    expect(s).toMatch(/Nothing here has been executed/);
    expect(s).toMatch(/Destructive statements are commented out/);
    expect(s).toContain("-- [safe] n");
  });

  it("has a distinct output for no differences", () => {
    expect(migrationScript([])).toBe("-- No differences.\n");
  });
});

describe("diffPlanTrees — which node actually changed", () => {
  /** A plan node. `ms` is `Actual Total Time`, the inclusive wall time. */
  const n = (type: string, ms: number, extra: Record<string, unknown> = {}, ...children: unknown[]) => ({
    "Node Type": type,
    "Actual Total Time": ms,
    ...extra,
    ...(children.length ? { Plans: children } : {}),
  });

  it("matches a tree against itself and calls nothing changed", () => {
    const p = n("Hash Join", 10, {}, n("Seq Scan", 6, { "Relation Name": "orders" }));
    const d = diffPlanTrees({ Plan: p }, { Plan: p });
    expect(d.map((x) => x.kind)).toEqual(["same", "same"]);
    expect(d[1].label).toBe("Seq Scan on orders");
  });

  it("names the node that got slower, not just the whole query", () => {
    const before = n("Hash Join", 10, {}, n("Seq Scan", 2, { "Relation Name": "orders" }));
    const after = n("Hash Join", 30, {}, n("Seq Scan", 22, { "Relation Name": "orders" }));
    const d = diffPlanTrees({ Plan: before }, { Plan: after });
    const scan = d.find((x) => x.label === "Seq Scan on orders")!;
    expect(scan.kind).toBe("slower");
    expect(scan.msDelta).toBe(20);
    expect(scan.msPercent).toBeCloseTo(1000);
  });

  it("reports a node that got faster", () => {
    const d = diffPlanTrees({ Plan: n("Sort", 50) }, { Plan: n("Sort", 5) });
    expect(d[0].kind).toBe("faster");
    expect(d[0].msDelta).toBe(-45);
  });

  it("ignores differences below the noise floor", () => {
    // 0.4 ms is under the millisecond floor even though it is a big percentage.
    expect(diffPlanTrees({ Plan: n("Sort", 0.1) }, { Plan: n("Sort", 0.5) })[0].kind).toBe("same");
    // 5% is over the millisecond floor but under the percentage one.
    expect(diffPlanTrees({ Plan: n("Sort", 100) }, { Plan: n("Sort", 105) })[0].kind).toBe("same");
  });

  it("calls out a scan that appeared and one that vanished", () => {
    const before = n("Hash Join", 10, {}, n("Index Scan", 1, { "Relation Name": "orders" }));
    const after = n("Hash Join", 10, {}, n("Seq Scan", 9, { "Relation Name": "orders" }));
    const d = diffPlanTrees({ Plan: before }, { Plan: after });
    expect(d.find((x) => x.label === "Index Scan on orders")!.kind).toBe("removed");
    expect(d.find((x) => x.label === "Seq Scan on orders")!.kind).toBe("added");
  });

  it("carries a removed subtree's children too", () => {
    const before = n("Gather", 10, {}, n("Hash Join", 8, {}, n("Seq Scan", 4, { "Relation Name": "a" })));
    const after = n("Gather", 10, {}, n("Index Scan", 1, { "Relation Name": "a" }));
    const d = diffPlanTrees({ Plan: before }, { Plan: after });
    expect(d.filter((x) => x.kind === "removed").map((x) => x.label)).toEqual(["Hash Join", "Seq Scan on a"]);
  });

  it("distinguishes two scans of different tables", () => {
    const before = n("Hash Join", 10, {}, n("Seq Scan", 2, { "Relation Name": "a" }), n("Seq Scan", 3, { "Relation Name": "b" }));
    const after = n("Hash Join", 10, {}, n("Seq Scan", 2, { "Relation Name": "a" }), n("Seq Scan", 30, { "Relation Name": "b" }));
    const d = diffPlanTrees({ Plan: before }, { Plan: after });
    expect(d.find((x) => x.label === "Seq Scan on a")!.kind).toBe("same");
    expect(d.find((x) => x.label === "Seq Scan on b")!.kind).toBe("slower");
    expect(d.every((x) => !x.ambiguous)).toBe(true);
  });

  it("flags a pairing it had to guess at rather than presenting it as fact", () => {
    // Two identical-looking siblings: position is the only thing separating
    // them, and position is not evidence.
    const before = n("Append", 10, {}, n("Seq Scan", 2, { "Relation Name": "part" }), n("Seq Scan", 3, { "Relation Name": "part" }));
    const after = n("Append", 10, {}, n("Seq Scan", 20, { "Relation Name": "part" }), n("Seq Scan", 3, { "Relation Name": "part" }));
    const d = diffPlanTrees({ Plan: before }, { Plan: after });
    const scans = d.filter((x) => x.label === "Seq Scan on part");
    expect(scans).toHaveLength(2);
    expect(scans.every((s) => s.ambiguous)).toBe(true);
  });

  it("does not mark unambiguous nodes as ambiguous", () => {
    const d = diffPlanTrees({ Plan: n("Sort", 5) }, { Plan: n("Sort", 5) });
    expect(d[0].ambiguous).toBe(false);
  });

  it("separates an index scan by which index it used", () => {
    const before = n("Index Scan", 5, { "Relation Name": "t", "Index Name": "t_a_idx" });
    const after = n("Index Scan", 5, { "Relation Name": "t", "Index Name": "t_b_idx" });
    const d = diffPlanTrees({ Plan: before }, { Plan: after });
    // A different index is a different access path, so this is a swap.
    expect(d.map((x) => x.kind).sort()).toEqual(["same"]);
    expect(d[0].label).toContain("t_a_idx");
  });

  it("falls back to estimated rows when the plan was not ANALYZEd", () => {
    const d = diffPlanTrees(
      { Plan: { "Node Type": "Seq Scan", "Plan Rows": 100, "Total Cost": 12 } },
      { Plan: { "Node Type": "Seq Scan", "Plan Rows": 900, "Total Cost": 80 } },
    );
    expect(d[0].rowsLeft).toBe(100);
    expect(d[0].rowsRight).toBe(900);
    expect(d[0].costLeft).toBe(12);
    expect(d[0].msDelta).toBeNull(); // no timings to compare
    expect(d[0].kind).toBe("same");
  });

  it("accepts a bare plan object as well as the { Plan } wrapper", () => {
    const d = diffPlanTrees(n("Sort", 1), n("Sort", 1));
    expect(d).toHaveLength(1);
  });
});
