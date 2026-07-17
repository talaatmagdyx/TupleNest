import { describe, expect, it } from "vitest";
import {
  createPartitionSql,
  detachSql,
  dropPartitionSql,
  findGaps,
  parseRange,
} from "./partitions";
import type { PartitionRow } from "../ipc/types";

const p = (name: string, bounds: string): PartitionRow => ({
  name,
  bounds,
  size: "0 bytes",
  rows: 0,
  rowsKnown: true,
  isPartitioned: false,
  partitionCount: 0,
});

const q = (n: string, from: string, to: string) => p(n, `FOR VALUES FROM ('${from}') TO ('${to}')`);

describe("parseRange", () => {
  it("reads a quoted date range", () => {
    expect(parseRange(q("a", "2024-01-01", "2024-04-01"))).toEqual({
      name: "a",
      from: "'2024-01-01'",
      to: "'2024-04-01'",
      raw: "FOR VALUES FROM ('2024-01-01') TO ('2024-04-01')",
    });
  });

  it("declines LIST bounds", () => {
    expect(parseRange(p("x", "FOR VALUES IN ('email')"))).toBeNull();
  });

  it("declines DEFAULT", () => {
    expect(parseRange(p("d", "DEFAULT"))).toBeNull();
  });

  it("declines composite keys rather than guessing their order", () => {
    expect(parseRange(p("c", "FOR VALUES FROM ('a', 1) TO ('b', 2)"))).toBeNull();
  });
});

describe("findGaps", () => {
  it("finds nothing in a contiguous series", () => {
    expect(
      findGaps([
        q("q1", "2024-01-01", "2024-04-01"),
        q("q2", "2024-04-01", "2024-07-01"),
        q("q3", "2024-07-01", "2024-10-01"),
      ]),
    ).toEqual([]);
  });

  it("is order-independent", () => {
    expect(
      findGaps([q("q3", "2024-07-01", "2024-10-01"), q("q1", "2024-01-01", "2024-04-01")]),
    ).toEqual([{ after: "q1", before: "q3", from: "'2024-04-01'", to: "'2024-07-01'" }]);
  });

  it("reports the hole between two partitions", () => {
    const g = findGaps([q("q1", "2024-01-01", "2024-04-01"), q("q3", "2024-07-01", "2024-10-01")]);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ after: "q1", before: "q3" });
  });

  it("treats an exclusive upper bound as touching the next lower bound", () => {
    // The classic off-by-one: TO is exclusive, so TO === FROM is contiguous,
    // not an overlap and not a gap.
    expect(findGaps([q("a", "1", "10"), q("b", "10", "20")])).toEqual([]);
  });

  it("ignores unbounded ends", () => {
    expect(
      findGaps([
        p("lo", "FOR VALUES FROM (MINVALUE) TO ('2024-01-01')"),
        q("mid", "2024-01-01", "2024-04-01"),
      ]),
    ).toEqual([]);
  });

  it("ignores partitions it could not parse instead of inventing gaps", () => {
    expect(findGaps([p("d", "DEFAULT"), q("a", "2024-01-01", "2024-04-01")])).toEqual([]);
  });

  it("finds several holes", () => {
    expect(
      findGaps([q("a", "1", "2"), q("c", "3", "4"), q("e", "5", "6")]),
    ).toHaveLength(2);
  });
});

describe("sql generation", () => {
  it("fills a gap with the exact bounds that were missing", () => {
    const g = { after: "q1", before: "q3", from: "'2024-04-01'", to: "'2024-07-01'" };
    expect(createPartitionSql("s", "t", g, "y2024q2")).toContain(
      `FOR VALUES FROM ('2024-04-01') TO ('2024-07-01')`,
    );
    expect(createPartitionSql("s", "t", g, "y2024q2")).toContain(`"s"."t_y2024q2"`);
  });

  it("says out loud that dropping a partition destroys rows", () => {
    const sql = dropPartitionSql("s", "t_old", 3_000_000);
    expect(sql).toContain("DESTRUCTIVE");
    expect(sql).toContain("3,000,000 rows");
  });

  it("omits a row count it does not have, rather than claiming zero rows", () => {
    // reltuples is -1 on a never-analyzed partition; "0 rows" would read as
    // "safe to drop" when the truth is "nobody has counted".
    const sql = dropPartitionSql("s", "t_old", 0);
    expect(sql).toContain("DESTRUCTIVE");
    expect(sql).not.toContain("rows)");
  });

  it("quotes the identifiers it drops", () => {
    expect(dropPartitionSql("s", "t_old", 1)).toContain('DROP TABLE "s"."t_old";');
  });

  it("detaches rather than destroys, and says the data survives", () => {
    const sql = detachSql("s", "t_p1", "t");
    expect(sql).toContain('ALTER TABLE "s"."t" DETACH PARTITION "s"."t_p1" CONCURRENTLY;');
    expect(sql).toContain("Reversible");
    expect(sql).not.toContain("DROP");
  });

  it("warns that DETACH CONCURRENTLY cannot run in a transaction", () => {
    expect(detachSql("s", "p", "t")).toContain("inside a transaction block");
  });

  it("suggests detaching before dropping, since detach is the reversible one", () => {
    expect(dropPartitionSql("s", "p", 5)).toContain("Detach it first");
  });
});
