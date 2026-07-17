import { describe, it, expect } from "vitest";
import {
  clauseAt,
  getCompletions,
  maskLiterals,
  parseTableRefs,
  schemaToPrefetch,
  statementAt,
  tablesToPrefetch,
  wordAt,
  type Catalog,
} from "./complete";

const col = (name: string, dbType: string, primaryKey = false) => ({
  name,
  dbType,
  nullable: !primaryKey,
  primaryKey,
  comment: null,
});

const cat: Catalog = {
  schemas: ["public", "analytics"],
  tables: [
    { schema: "public", name: "users", kind: "table" },
    { schema: "public", name: "orders", kind: "table" },
    { schema: "analytics", name: "daily_rollup", kind: "view" },
  ],
  columns: {
    "public.users": [col("id", "int8", true), col("email", "text"), col("created_at", "timestamptz")],
    "public.orders": [col("id", "int8", true), col("user_id", "int8"), col("total", "numeric")],
    "analytics.daily_rollup": [col("day", "date"), col("revenue", "numeric")],
  },
  searchPath: ["public"],
};

const labels = (sql: string, cursor = sql.length) => getCompletions(sql, cursor, cat).items.map((i) => i.label);

describe("maskLiterals", () => {
  it("blanks line comments but keeps length and newlines", () => {
    const src = "select 1 -- from users\nfrom orders";
    const m = maskLiterals(src);
    expect(m.length).toBe(src.length);
    expect(m).toContain("\n");
    expect(m).not.toContain("from users");
    expect(m).toContain("from orders");
  });

  it("blanks block comments", () => {
    const m = maskLiterals("select /* from users */ 1");
    expect(m).not.toContain("from users");
  });

  it("blanks string contents so keywords inside are ignored", () => {
    const m = maskLiterals("select 'from users' , x");
    expect(m).not.toContain("from users");
  });

  /* PostgreSQL has three things a C-style masker gets wrong. Each of these was
     a real misparse before, and each one misfed the destructive-statement
     guard and the editability check downstream. */
  describe("PostgreSQL literal forms", () => {
    it("masks a dollar-quoted body — function bodies are written this way", () => {
      const m = maskLiterals("select $$ from users $$, x");
      expect(m).not.toContain("from users");
      expect(m).toHaveLength("select $$ from users $$, x".length);
    });

    it("masks a tagged dollar-quote", () => {
      expect(maskLiterals("select $tag$ from users $tag$, x")).not.toContain("from users");
    });

    it("does not treat a $1 parameter as a dollar-quote", () => {
      // `$1 … $2` must not be read as a quote spanning the middle of the query,
      // or every parameterised statement masks its own body.
      const m = maskLiterals("update t set a=$1 where id=$2");
      expect(m).toContain("where");
    });

    it("survives an apostrophe inside a dollar-quoted body", () => {
      // The lone quote used to open a phantom string that swallowed the rest.
      const m = maskLiterals("select $$ it's here $$, keyword_after");
      expect(m).toContain("keyword_after");
    });

    it("does not split statements on a semicolon inside a dollar-quote", () => {
      expect(statementAt("select $$a;b$$ from t", 21).text).toBe("select $$a;b$$ from t");
    });

    it("nests block comments the way PostgreSQL does", () => {
      // C stops at the first close marker; PostgreSQL counts depth. Stopping
      // early leaks the comment's tail back into the scanned text.
      const m = maskLiterals("/* a /* b */ still_comment */ select 1");
      expect(m).not.toContain("still_comment");
      expect(m).toContain("select 1");
    });

    it("honours backslash escapes in an E'' string", () => {
      const m = maskLiterals("select e'\\' from users' , keyword_after");
      expect(m).not.toContain("from users");
      expect(m).toContain("keyword_after");
    });
  });
});

describe("wordAt", () => {
  it("finds the identifier prefix under the cursor", () => {
    expect(wordAt("select ema", 10)).toEqual({ word: "ema", from: 7, qualifier: null });
  });

  it("detects an alias qualifier", () => {
    const r = wordAt("select u.ema", 12);
    expect(r.word).toBe("ema");
    expect(r.qualifier).toBe("u");
  });

  it("handles an empty word right after a dot", () => {
    const r = wordAt("select u.", 9);
    expect(r.word).toBe("");
    expect(r.qualifier).toBe("u");
  });
});

describe("statementAt", () => {
  it("isolates the statement containing the cursor", () => {
    const sql = "select 1; select 2 from users";
    const s = statementAt(sql, sql.length);
    expect(s.text.trim()).toBe("select 2 from users");
  });

  it("ignores semicolons inside strings", () => {
    const sql = "select ';' , x from users";
    expect(statementAt(sql, sql.length).text).toContain("from users");
  });
});

describe("clauseAt", () => {
  it("knows we are in FROM", () => expect(clauseAt("select * from ", 14)).toBe("from"));
  it("knows we are in SELECT", () => expect(clauseAt("select ", 7)).toBe("select"));
  it("knows we are in WHERE", () => expect(clauseAt("select * from users where ", 26)).toBe("where"));
  it("normalises multiword clauses", () => expect(clauseAt("select * from t group by ", 25)).toBe("group by"));
  it("ignores keywords inside comments", () => {
    const sql = "select * from users -- where\n";
    expect(clauseAt(sql, sql.length)).toBe("from");
  });
});

describe("parseTableRefs", () => {
  it("picks up a plain table", () => {
    expect(parseTableRefs("select * from users")).toEqual([{ schema: null, name: "users", alias: null }]);
  });

  it("picks up schema-qualified names", () => {
    expect(parseTableRefs("select * from analytics.daily_rollup")).toEqual([
      { schema: "analytics", name: "daily_rollup", alias: null },
    ]);
  });

  it("picks up aliases with and without AS", () => {
    expect(parseTableRefs("select * from users u")).toEqual([{ schema: null, name: "users", alias: "u" }]);
    expect(parseTableRefs("select * from users as u")).toEqual([{ schema: null, name: "users", alias: "u" }]);
  });

  it("does not mistake a following keyword for an alias", () => {
    expect(parseTableRefs("select * from users where id = 1")).toEqual([
      { schema: null, name: "users", alias: null },
    ]);
    expect(parseTableRefs("select * from users join orders on 1=1")).toEqual([
      { schema: null, name: "users", alias: null },
      { schema: null, name: "orders", alias: null },
    ]);
  });

  it("handles joins with aliases", () => {
    expect(parseTableRefs("select * from users u join orders o on o.user_id = u.id")).toEqual([
      { schema: null, name: "users", alias: "u" },
      { schema: null, name: "orders", alias: "o" },
    ]);
  });

  it("handles UPDATE and INSERT INTO", () => {
    expect(parseTableRefs("update users set x = 1")).toEqual([{ schema: null, name: "users", alias: null }]);
    expect(parseTableRefs("insert into orders values (1)")).toEqual([
      { schema: null, name: "orders", alias: null },
    ]);
  });
});

describe("getCompletions — table position", () => {
  it("offers tables and schemas after FROM", () => {
    const l = labels("select * from ");
    expect(l).toContain("users");
    expect(l).toContain("orders");
    expect(l).toContain("analytics");
  });

  it("qualifies tables outside the search path", () => {
    const items = getCompletions("select * from daily", 19, cat).items;
    const dr = items.find((i) => i.label === "daily_rollup");
    expect(dr?.insert).toBe("analytics.daily_rollup");
  });

  it("filters by the typed prefix", () => {
    const l = labels("select * from us");
    expect(l[0]).toBe("users");
    expect(l).not.toContain("orders");
  });
});

describe("getCompletions — column position", () => {
  it("offers columns of the FROM table in SELECT", () => {
    const l = labels("select  from users", 7);
    expect(l).toContain("email");
    expect(l).toContain("created_at");
  });

  it("offers columns in WHERE", () => {
    const l = labels("select * from users where ");
    expect(l).toContain("email");
  });

  it("resolves alias-qualified columns", () => {
    const l = labels("select u. from users u", 9);
    expect(l).toEqual(expect.arrayContaining(["id", "email", "created_at"]));
    expect(l).not.toContain("total"); // orders column must not leak in
  });

  it("resolves the right table in a join", () => {
    const sql = "select o. from users u join orders o on o.user_id = u.id";
    const l = labels(sql, 9);
    expect(l).toEqual(expect.arrayContaining(["user_id", "total"]));
    expect(l).not.toContain("email");
  });

  it("offers schema-qualified table columns", () => {
    const l = labels("select d. from analytics.daily_rollup d", 9);
    expect(l).toEqual(expect.arrayContaining(["day", "revenue"]));
  });

  it("offers aliases as completions too", () => {
    const l = labels("select  from users u", 7);
    expect(l).toContain("u");
  });

  it("marks primary keys in the detail", () => {
    const items = getCompletions("select u. from users u", 9, cat).items;
    expect(items.find((i) => i.label === "id")?.detail).toContain("pk");
  });
});

describe("getCompletions — ranking", () => {
  // Regression: a prefix-matching schema must surface after FROM. Previously
  // label length was folded into the match score, so short keywords (`case`,
  // `cast`, `coalesce`) outranked `company_1_schema` and it fell off the list.
  it("surfaces a prefix-matching schema first after FROM", () => {
    const c: Catalog = { ...cat, schemas: ["company_1_schema", "public"], tables: [] };
    const l = getCompletions("select * from co", 16, c).items.map((i) => i.label);
    expect(l[0]).toBe("company_1_schema");
  });

  // Same regression, checked where keywords legitimately co-exist with columns.
  it("ranks a prefix-matching column above shorter prefix-matching keywords", () => {
    const c: Catalog = {
      ...cat,
      columns: { "public.users": [col("casing", "text")] },
      tables: [{ schema: "public", name: "users", kind: "table" }],
    };
    const l = getCompletions("select cas from users", 10, c).items.map((i) => i.label);
    expect(l[0]).toBe("casing"); // beats the shorter keywords `case` / `cast`
  });

  it("ranks a prefix-matching table above keywords in FROM", () => {
    const l = labels("select * from or");
    expect(l[0]).toBe("orders");
  });

  it("ranks columns above keywords in column position", () => {
    const l = labels("select em from users", 9);
    expect(l[0]).toBe("email");
  });

  it("puts an exact match first regardless of kind", () => {
    const l = labels("select * from users");
    expect(l[0]).toBe("users");
  });

  it("prefers prefix matches over substring matches", () => {
    const items = getCompletions("select * from user", 18, cat).items;
    expect(items[0].label).toBe("users");
  });

  it("still offers fuzzy subsequence matches, ranked last", () => {
    const l = labels("select * from urs"); // u-r-s subsequence of "users"
    expect(l).toContain("users");
  });
});

describe("getCompletions — keywords & functions", () => {
  it("offers keywords at statement start", () => expect(labels("sel", 3)).toContain("select"));

  it("suppresses keywords where only an identifier is legal (after FROM)", () => {
    const l = labels("select * from o");
    expect(l).not.toContain("or"); // `or` is a keyword and would exact-match
    expect(l).toContain("orders");
  });

  it("suppresses keywords after a qualifier dot", () => {
    const l = labels("select u. from users u", 9);
    expect(l).not.toContain("as");
  });
  it("offers functions in column position", () => {
    const items = getCompletions("select cou from users", 10, cat).items;
    expect(items.find((i) => i.label === "count")?.insert).toBe("count(");
  });
});

describe("getCompletions — replacement range", () => {
  it("replaces just the typed word", () => {
    const r = getCompletions("select * from us", 16, cat);
    expect(r.from).toBe(14);
    expect(r.to).toBe(16);
  });

  it("inserts at the cursor when no word is typed", () => {
    const r = getCompletions("select * from ", 14, cat);
    expect(r.from).toBe(14);
    expect(r.to).toBe(14);
  });
});

describe("schemaToPrefetch", () => {
  it("asks for a schema's objects right after `schema.`", () => {
    const sql = "select * from analytics.";
    expect(schemaToPrefetch(sql, sql.length, cat)).toBe("analytics");
  });

  it("returns null for an alias qualifier (that wants columns, not tables)", () => {
    const sql = "select u. from users u";
    expect(schemaToPrefetch(sql, 9, cat)).toBeNull();
  });

  it("returns null for an unknown qualifier", () => {
    const sql = "select * from nope.";
    expect(schemaToPrefetch(sql, sql.length, cat)).toBeNull();
  });

  it("returns null with no qualifier at all", () => {
    expect(schemaToPrefetch("select * from us", 16, cat)).toBeNull();
  });
});

describe("tablesToPrefetch", () => {
  it("defaults unqualified tables to the search path head", () => {
    expect(tablesToPrefetch("select * from users u", 21, ["public"])).toEqual([
      { schema: "public", name: "users" },
    ]);
  });

  it("keeps explicit schemas", () => {
    expect(tablesToPrefetch("select * from analytics.daily_rollup", 36, ["public"])).toEqual([
      { schema: "analytics", name: "daily_rollup" },
    ]);
  });
});

describe("qualifier resolution edge cases", () => {
  it("offers a schema's tables after `schema.`", () => {
    const sql = "select * from analytics.";
    const out = getCompletions(sql, sql.length, cat).items;
    expect(out.map((o) => o.label)).toContain("daily_rollup");
  });

  it("matches a schema qualifier case-insensitively", () => {
    const sql = "select * from ANALYTICS.";
    const out = getCompletions(sql, sql.length, cat).items;
    expect(out.map((o) => o.label)).toContain("daily_rollup");
  });

  it("offers nothing for an unknown qualifier rather than guessing", () => {
    const sql = "select nonsense. from users";
    const out = getCompletions(sql, 16, cat).items;
    expect(out).toEqual([]);
  });

  // columnsFor's fallback: the table parses fine but has no catalog entry, so
  // there are no columns to offer. It must return empty, not throw.
  it("survives a qualifier for a table the catalog has never heard of", () => {
    const sql = "select u. from unknown_table u";
    expect(() => getCompletions(sql, 9, cat)).not.toThrow();
    expect(getCompletions(sql, 9, cat).items).toEqual([]);
  });

  it("resolves an unqualified table through the search path", () => {
    const sql = "select u. from users u";
    const out = getCompletions(sql, 9, cat).items;
    expect(out.map((o) => o.label)).toContain("email");
  });

  it("finds a table outside the search path by scanning the other schemas", () => {
    // daily_rollup lives in analytics, which is not in searchPath — the
    // candidate list falls through to cat.schemas.
    const sql = "select d. from daily_rollup d";
    const out = getCompletions(sql, 9, cat).items;
    expect(out.map((o) => o.label)).toContain("revenue");
  });
});
