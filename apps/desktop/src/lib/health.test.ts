import { describe, expect, it } from "vitest";
import { dropScript, fmtBytes, recoverable, VERDICT_LABEL, VERDICT_ORDER } from "./health";
import type { IndexHealthItem, IndexVerdict } from "../ipc/types";

const ix = (v: IndexVerdict, over: Partial<IndexHealthItem> = {}): IndexHealthItem => ({
  schema: "s",
  table: "t",
  columns: "a, b",
  method: "btree",
  scans: v === "used" ? 10 : 0,
  bytes: 1024,
  size: "1 KB",
  members: 1,
  sampleIndex: `${v}_ix`,
  indexIdents: [`s.${v}_ix`],
  verdict: v,
  why: "",
  ...over,
});

describe("fmtBytes", () => {
  it("keeps small values in bytes", () => {
    expect(fmtBytes(0)).toBe("0 B");
    expect(fmtBytes(1023)).toBe("1023 B");
  });

  it("switches unit at each 1024 boundary", () => {
    expect(fmtBytes(1024)).toBe("1.0 KB");
    expect(fmtBytes(1024 ** 2)).toBe("1.0 MB");
    expect(fmtBytes(1024 ** 3)).toBe("1.0 GB");
    expect(fmtBytes(1024 ** 4)).toBe("1.0 TB");
  });

  it("stops at TB rather than inventing a unit", () => {
    expect(fmtBytes(1024 ** 5)).toBe("1024 TB");
  });

  it("drops the decimal once the number is big enough to not need it", () => {
    expect(fmtBytes(9.5 * 1024)).toBe("9.5 KB");
    expect(fmtBytes(10 * 1024)).toBe("10 KB");
  });
});

describe("verdict tables", () => {
  it("labels every verdict", () => {
    expect(VERDICT_LABEL).toEqual({ used: "USED", keep: "KEEP", review: "REVIEW", candidate: "DROP?" });
  });

  it("orders worst-first so the actionable rows are on top", () => {
    expect(VERDICT_ORDER).toEqual(["candidate", "review", "keep", "used"]);
  });
});

describe("recoverable", () => {
  it("is zero with nothing to recover", () => {
    expect(recoverable([])).toBe(0);
  });

  it("sums only candidates", () => {
    expect(
      recoverable([
        ix("candidate", { bytes: 100 }),
        ix("candidate", { bytes: 50 }),
        ix("keep", { bytes: 999 }),
        ix("used", { bytes: 999 }),
      ]),
    ).toBe(150);
  });

  it("excludes review — uniqueness may be load-bearing in ways scans don't show", () => {
    expect(recoverable([ix("review", { bytes: 4096 })])).toBe(0);
  });
});

describe("dropScript", () => {
  it("says so plainly when there is nothing to drop", () => {
    const s = dropScript([]);
    expect(s).toContain("No candidates");
    expect(s).not.toContain("DROP INDEX");
  });

  it("produces no DROP when every index is used or protected", () => {
    const s = dropScript([ix("used"), ix("keep"), ix("review")]);
    expect(s).not.toContain("DROP INDEX");
  });

  // The whole point of the feature. A regression here proposes destroying
  // a constraint, so it gets its own assertion per protected verdict.
  it.each(["used", "keep", "review"] as IndexVerdict[])(
    "never emits a DROP for a %s index, even alongside a candidate",
    (v) => {
      const s = dropScript([ix(v, { indexIdents: ["s.protected_ix"] }), ix("candidate")]);
      expect(s).not.toContain("protected_ix");
      expect(s).toContain("candidate_ix");
    },
  );

  it("emits one statement per physical index, not per logical group", () => {
    const s = dropScript([
      ix("candidate", { members: 3, indexIdents: ["s.p1", "s.p2", "s.p3"] }),
    ]);
    const drops = s.split("\n").filter((l) => l.startsWith("DROP INDEX"));
    expect(drops).toEqual([
      "DROP INDEX CONCURRENTLY IF EXISTS s.p1;",
      "DROP INDEX CONCURRENTLY IF EXISTS s.p2;",
      "DROP INDEX CONCURRENTLY IF EXISTS s.p3;",
    ]);
  });

  it("uses CONCURRENTLY and IF EXISTS on every statement", () => {
    const s = dropScript([ix("candidate", { indexIdents: ["s.a", "s.b"] })]);
    for (const line of s.split("\n").filter((l) => l.startsWith("DROP"))) {
      expect(line).toMatch(/^DROP INDEX CONCURRENTLY IF EXISTS .+;$/);
    }
  });

  it("warns that it cannot run in a transaction, and opens no transaction", () => {
    const s = dropScript([ix("candidate")]);
    expect(s).toContain("cannot run inside a transaction block");
    expect(s).not.toMatch(/\bBEGIN\b(?!\/COMMIT)/);
  });

  it("carries the caveat that zero scans is not proof", () => {
    expect(dropScript([ix("candidate")])).toContain("not the same as unused");
  });

  it("annotates each group with the evidence behind the verdict", () => {
    const s = dropScript([
      ix("candidate", { schema: "app", table: "orders", columns: "id", size: "42 MB", members: 7 }),
    ]);
    expect(s).toContain("-- app.orders (id) — 42 MB, 7 index(es), 0 scans");
  });

  it("passes identifiers through verbatim — quoting is Postgres's job", () => {
    // quote_ident already handled escaping server-side; re-quoting here would
    // produce ""weird"" and drop nothing.
    const s = dropScript([ix("candidate", { indexIdents: ['"Odd Schema"."ix-with-dash"'] })]);
    expect(s).toContain('DROP INDEX CONCURRENTLY IF EXISTS "Odd Schema"."ix-with-dash";');
  });

  it("handles a candidate whose identifier list is empty without emitting a broken DROP", () => {
    const s = dropScript([ix("candidate", { indexIdents: [] })]);
    expect(s).not.toMatch(/DROP INDEX CONCURRENTLY IF EXISTS ;/);
  });
});
