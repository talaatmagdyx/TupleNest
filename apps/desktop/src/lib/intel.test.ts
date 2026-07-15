import { describe, it, expect } from "vitest";
import {
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
      expect(users.columns).toContainEqual({ kind: "added", column: "age", type: "int4" });
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
