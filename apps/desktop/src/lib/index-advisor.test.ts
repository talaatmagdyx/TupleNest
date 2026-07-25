import { describe, it, expect } from "vitest";
import { extractPredicates, suggestIndexes, type IndexSuggestion } from "./index-advisor";

/** All plans below are hand-authored, not captured from a live database — the
 *  filter strings are written to exercise the parser's rules, not to mirror any
 *  real query. */

// A minimal Seq Scan node, the common case the advisor is built around.
function seqScan(relation: string, filter: string, extra: Record<string, unknown> = {}) {
  return {
    Plan: {
      "Node Type": "Seq Scan",
      "Relation Name": relation,
      Filter: filter,
      ...extra,
    },
  };
}

describe("extractPredicates — what a filter tests, and how", () => {
  it("reads a single equality", () => {
    expect(extractPredicates("(status = 'active'::text)")).toEqual([{ column: "status", kind: "eq" }]);
  });

  it("reads equality plus a range, in order", () => {
    const preds = extractPredicates("((status = 'active'::text) AND (created_at > '2024-01-01'::date))");
    expect(preds).toEqual([
      { column: "status", kind: "eq" },
      { column: "created_at", kind: "range" },
    ]);
  });

  it("treats each comparison operator as a range", () => {
    for (const op of [">", ">=", "<", "<="]) {
      expect(extractPredicates(`(age ${op} 18)`)).toEqual([{ column: "age", kind: "range" }]);
    }
  });

  it("reads = ANY(array) as an equality, not a column", () => {
    const preds = extractPredicates("(status = ANY ('{active,pending}'::text[]))");
    expect(preds).toEqual([{ column: "status", kind: "eq" }]);
  });

  it("keeps a range against a function value (now())", () => {
    expect(extractPredicates("(created_at > now())")).toEqual([{ column: "created_at", kind: "range" }]);
  });

  it("strips a table qualifier from the column", () => {
    expect(extractPredicates("(o.status = 'active'::text)")).toEqual([{ column: "status", kind: "eq" }]);
  });

  it("declines a filter containing OR (returns null)", () => {
    expect(extractPredicates("((status = 'a'::text) OR (status = 'b'::text))")).toBeNull();
  });

  it("is not fooled by 'or' inside a string literal", () => {
    // The literal 'a or b' must not read as a structural OR.
    expect(extractPredicates("(label = 'a or b'::text)")).toEqual([{ column: "label", kind: "eq" }]);
  });

  it("is not fooled by 'or' inside a column name", () => {
    expect(extractPredicates("(vendor = 'x'::text)")).toEqual([{ column: "vendor", kind: "eq" }]);
  });

  it("skips a predicate whose column is cast (needs an expression index)", () => {
    expect(extractPredicates("((created_at)::date = '2024-01-01'::date)")).toEqual([]);
  });

  it("skips a cast column but keeps a plain one beside it", () => {
    const preds = extractPredicates("(((created_at)::date = '2024-01-01'::date) AND (status = 'active'::text))");
    expect(preds).toEqual([{ column: "status", kind: "eq" }]);
  });

  it("skips a join predicate (column against column)", () => {
    expect(extractPredicates("(o.customer_id = c.id)")).toEqual([]);
  });

  it("skips an inequality — a btree cannot seek it", () => {
    expect(extractPredicates("(status <> 'closed'::text)")).toEqual([]);
  });

  it("collapses a BETWEEN-style pair into one range column", () => {
    const preds = extractPredicates("((amount >= 10) AND (amount <= 100))");
    expect(preds).toEqual([{ column: "amount", kind: "range" }]);
  });

  it("promotes a column tested both ways to equality", () => {
    // Contrived, but the rule is: an equality use of a column wins over a range.
    const preds = extractPredicates("((n > 1) AND (n = 5))");
    expect(preds).toEqual([{ column: "n", kind: "eq" }]);
  });
});

describe("suggestIndexes — the statement a plan implies", () => {
  const ddl = (s: IndexSuggestion[]) => s.map((x) => x.ddl);

  it("writes a single-column index for a Seq Scan with one equality", () => {
    const s = suggestIndexes(seqScan("orders", "(status = 'active'::text)"));
    expect(ddl(s)).toEqual(["CREATE INDEX ON orders (status);"]);
  });

  it("orders equality before range in a composite index", () => {
    const s = suggestIndexes(
      seqScan("orders", "((status = 'active'::text) AND (created_at > '2024-01-01'::date))"),
    );
    expect(ddl(s)).toEqual(["CREATE INDEX ON orders (status, created_at);"]);
  });

  it("qualifies the table with its schema when the plan carried one", () => {
    const s = suggestIndexes(seqScan("orders", "(status = 'active'::text)", { Schema: "sales" }));
    expect(ddl(s)).toEqual(["CREATE INDEX ON sales.orders (status);"]);
  });

  it("quotes an identifier that is not a plain lower-case name", () => {
    const s = suggestIndexes(seqScan("Orders", '("Order Status" = \'active\'::text)'));
    expect(ddl(s)).toEqual(['CREATE INDEX ON "Orders" ("Order Status");']);
  });

  it("carries a reason that names the discarded rows", () => {
    const s = suggestIndexes(seqScan("orders", "(status = 'active'::text)", { "Rows Removed by Filter": 50000 }));
    expect(s[0].reason).toContain("50,000");
  });

  it("says nothing for a Seq Scan whose filter is unindexable (pure OR)", () => {
    const s = suggestIndexes(seqScan("orders", "((a = 1) OR (b = 2))"));
    expect(s).toEqual([]);
  });

  it("says nothing when the filter is a bare join predicate", () => {
    const s = suggestIndexes(seqScan("orders", "(orders.customer_id = c.id)"));
    expect(s).toEqual([]);
  });

  it("gates an already-indexed scan on the volume its residual filter discards", () => {
    // An Index Scan with a small residual filter is left alone — its index is
    // probably fine and a second one is just write cost.
    const light = {
      Plan: {
        "Node Type": "Index Scan",
        "Relation Name": "orders",
        "Index Cond": "(id = 5)",
        Filter: "(status = 'active'::text)",
        "Rows Removed by Filter": 3,
      },
    };
    expect(suggestIndexes(light)).toEqual([]);

    // The same node, now discarding real volume, earns a suggestion.
    const heavy = {
      Plan: {
        "Node Type": "Index Scan",
        "Relation Name": "orders",
        "Index Cond": "(id = 5)",
        Filter: "(status = 'active'::text)",
        "Rows Removed by Filter": 40000,
      },
    };
    expect(ddl(suggestIndexes(heavy))).toEqual(["CREATE INDEX ON orders (status);"]);
  });

  it("suggests for a Bitmap Heap Scan's residual filter when it discards volume", () => {
    const plan = {
      Plan: {
        "Node Type": "Bitmap Heap Scan",
        "Relation Name": "events",
        "Recheck Cond": "(kind = 'click'::text)",
        Filter: "(country = 'US'::text)",
        "Rows Removed by Filter": 90000,
      },
    };
    expect(ddl(suggestIndexes(plan))).toEqual(["CREATE INDEX ON events (country);"]);
  });

  it("dedupes identical table+columns suggested by two different nodes", () => {
    const plan = {
      Plan: {
        "Node Type": "Nested Loop",
        Plans: [
          { "Node Type": "Seq Scan", "Relation Name": "orders", Filter: "(status = 'active'::text)" },
          { "Node Type": "Seq Scan", "Relation Name": "orders", Filter: "(status = 'active'::text)" },
        ],
      },
    };
    expect(ddl(suggestIndexes(plan))).toEqual(["CREATE INDEX ON orders (status);"]);
  });

  it("keeps distinct suggestions from different tables", () => {
    const plan = {
      Plan: {
        "Node Type": "Hash Join",
        Plans: [
          { "Node Type": "Seq Scan", "Relation Name": "orders", Filter: "(status = 'active'::text)" },
          { "Node Type": "Seq Scan", "Relation Name": "customers", Filter: "(country = 'US'::text)" },
        ],
      },
    };
    expect(ddl(suggestIndexes(plan))).toEqual([
      "CREATE INDEX ON orders (status);",
      "CREATE INDEX ON customers (country);",
    ]);
  });

  it("ignores a scan that has no filter at all", () => {
    const plan = { Plan: { "Node Type": "Seq Scan", "Relation Name": "orders" } };
    expect(suggestIndexes(plan)).toEqual([]);
  });

  it("returns nothing, without throwing, on an unrecognisable shape", () => {
    expect(suggestIndexes(null)).toEqual([]);
    expect(suggestIndexes({})).toEqual([]);
    expect(suggestIndexes([{ Plan: 42 }])).toEqual([]);
    expect(suggestIndexes("not a plan")).toEqual([]);
  });

  it("accepts the bare array form the server returns", () => {
    const s = suggestIndexes([{ Plan: { "Node Type": "Seq Scan", "Relation Name": "orders", Filter: "(status = 'active'::text)" } }]);
    expect(ddl(s)).toEqual(["CREATE INDEX ON orders (status);"]);
  });
});
