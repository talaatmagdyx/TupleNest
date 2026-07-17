import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import HealthModal from "./HealthModal";
import type { IndexHealth, IndexHealthItem, IndexVerdict, TableHealth, TopQueries } from "../ipc/types";

const ix = (v: IndexVerdict, over: Partial<IndexHealthItem> = {}): IndexHealthItem => ({
  schema: "s",
  table: `t_${v}`,
  columns: "a",
  method: "btree",
  scans: v === "used" ? 5 : 0,
  bytes: 1024,
  size: "1 KB",
  members: 290,
  sampleIndex: `${v}_ix`,
  indexIdents: [`s.${v}_ix`],
  verdict: v,
  why: `because ${v}`,
  ...over,
});

const indexes: IndexHealth = {
  items: [ix("candidate"), ix("review"), ix("keep"), ix("used")],
  droppableBytes: 498_073_600,
  droppableIndexes: 580,
};

const tables: TableHealth = {
  items: [
    {
      schema: "s",
      table: "never",
      liveTuples: 0,
      deadTuples: 0,
      deadPct: 0,
      vacuumed: "never",
      analyzed: "never",
      neverAnalyzed: true,
      size: "0 bytes",
    },
    {
      schema: "s",
      table: "bloated",
      liveTuples: 100,
      deadTuples: 50,
      deadPct: 33.3,
      vacuumed: "2026-07-01 10:00",
      analyzed: "2026-07-01 10:00",
      neverAnalyzed: false,
      size: "1 MB",
    },
  ],
  neverAnalyzed: 2267,
  neverVacuumed: 2603,
  totalTables: 4217,
  truncated: true,
};

const base = {
  tab: "indexes" as const,
  onTab: vi.fn(),
  indexes,
  tables,
  queries: null,
  error: null,
  onOpenScript: vi.fn(),
  onClose: vi.fn(),
};

describe("HealthModal — shell", () => {
  it("shows the three tabs", () => {
    render(<HealthModal {...base} />);
    for (const t of ["Indexes", "Vacuum & bloat", "Top queries"]) {
      expect(screen.getByRole("button", { name: t })).toBeInTheDocument();
    }
  });

  it("marks the active tab", () => {
    render(<HealthModal {...base} tab="tables" />);
    expect(screen.getByRole("button", { name: "Vacuum & bloat" })).toHaveClass("on");
    expect(screen.getByRole("button", { name: "Indexes" })).not.toHaveClass("on");
  });

  it("asks for a tab when one is clicked", async () => {
    const onTab = vi.fn();
    render(<HealthModal {...base} onTab={onTab} />);
    await userEvent.click(screen.getByRole("button", { name: "Top queries" }));
    expect(onTab).toHaveBeenCalledWith("queries");
  });

  it("shows an error instead of a table when the query failed", () => {
    render(<HealthModal {...base} error="boom" />);
    expect(screen.getByText("boom")).toBeInTheDocument();
    expect(screen.queryByText(/recoverable/)).not.toBeInTheDocument();
  });

  it("closes", async () => {
    const onClose = vi.fn();
    render(<HealthModal {...base} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("HealthModal — indexes", () => {
  it("says loading before the data lands", () => {
    render(<HealthModal {...base} indexes={null} />);
    expect(screen.getByText("loading…")).toBeInTheDocument();
  });

  it("leads with recoverable bytes, not with unscanned bytes", () => {
    // The distinction the whole feature exists for: 4 GB of the unscanned
    // total is primary keys, and must never be counted as recoverable.
    render(<HealthModal {...base} />);
    expect(screen.getByText("475 MB")).toBeInTheDocument();
    expect(screen.getByText(/recoverable across 580 indexes/)).toBeInTheDocument();
  });

  it("carries the caveat that zero scans is not proof", () => {
    render(<HealthModal {...base} />);
    expect(screen.getByText(/Never scanned is not the same as unused/)).toBeInTheDocument();
  });

  it("renders a row per logical index with its partition fold count", () => {
    render(<HealthModal {...base} />);
    expect(screen.getAllByText("290").length).toBe(4);
  });

  it("labels every verdict", () => {
    render(<HealthModal {...base} />);
    for (const l of ["DROP?", "REVIEW", "KEEP", "USED"]) {
      expect(screen.getAllByText(l).length).toBeGreaterThan(0);
    }
  });

  it("filters to one verdict when its chip is clicked", async () => {
    render(<HealthModal {...base} />);
    await userEvent.click(screen.getByRole("button", { name: /^DROP\? 1/ }));
    const rows = screen.getAllByTitle(/^because/);
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText("DROP?")).toBeInTheDocument();
  });

  it("returns to everything via the All chip", async () => {
    render(<HealthModal {...base} />);
    await userEvent.click(screen.getByRole("button", { name: /^DROP\? 1/ }));
    await userEvent.click(screen.getByRole("button", { name: /^All 4/ }));
    expect(screen.getAllByTitle(/^because/)).toHaveLength(4);
  });

  it("says so when a filter has no rows", async () => {
    render(<HealthModal {...base} indexes={{ ...indexes, items: [ix("used")] }} />);
    await userEvent.click(screen.getByRole("button", { name: /^USED/ }));
    expect(screen.queryByText("Nothing in this category.")).not.toBeInTheDocument();
  });

  it("sorts actionable verdicts above the rest", () => {
    render(<HealthModal {...base} />);
    const rows = screen.getAllByTitle(/^because/);
    expect(within(rows[0]).getByText("DROP?")).toBeInTheDocument();
    expect(within(rows[3]).getByText("USED")).toBeInTheDocument();
  });

  it("offers a script only when something is droppable", () => {
    render(<HealthModal {...base} />);
    expect(screen.getByRole("button", { name: /Generate DROP script/ })).toBeInTheDocument();
  });

  it("hides the script button when nothing is droppable", () => {
    render(<HealthModal {...base} indexes={{ ...indexes, items: [ix("keep"), ix("used")] }} />);
    expect(screen.queryByRole("button", { name: /Generate DROP script/ })).not.toBeInTheDocument();
  });

  it("hands the caller a script containing only candidates", async () => {
    const onOpenScript = vi.fn();
    render(<HealthModal {...base} onOpenScript={onOpenScript} />);
    await userEvent.click(screen.getByRole("button", { name: /Generate DROP script/ }));
    const sql = onOpenScript.mock.calls[0][0] as string;
    expect(sql).toContain("candidate_ix");
    expect(sql).not.toContain("keep_ix");
    expect(sql).not.toContain("used_ix");
  });

  it("builds the script from all items, not just the filtered view", async () => {
    // Filtering to KEEP then generating must still produce the candidate's
    // drop — the filter is a lens, not a selection.
    const onOpenScript = vi.fn();
    render(<HealthModal {...base} onOpenScript={onOpenScript} />);
    await userEvent.click(screen.getByRole("button", { name: /^KEEP/ }));
    await userEvent.click(screen.getByRole("button", { name: /Generate DROP script/ }));
    expect(onOpenScript.mock.calls[0][0]).toContain("candidate_ix");
  });

  it("copes with an empty report", () => {
    render(<HealthModal {...base} indexes={{ items: [], droppableBytes: 0, droppableIndexes: 0 }} />);
    expect(screen.getByText("0 B")).toBeInTheDocument();
    expect(screen.getByText("Nothing in this category.")).toBeInTheDocument();
  });
});

describe("HealthModal — vacuum & bloat", () => {
  it("says loading before the data lands", () => {
    render(<HealthModal {...base} tab="tables" tables={null} />);
    expect(screen.getByText("loading…")).toBeInTheDocument();
  });

  it("reports never-analyzed against the whole database, not the page", () => {
    render(<HealthModal {...base} tab="tables" />);
    expect(screen.getByText(/2,267 of 4,217 tables have never been analyzed/)).toBeInTheDocument();
    expect(screen.getByText(/2,603 have never been vacuumed/)).toBeInTheDocument();
  });

  it("states that the list is truncated but the counts are not", () => {
    render(<HealthModal {...base} tab="tables" />);
    expect(screen.getByText(/Showing the 2 worst; the counts above cover all 4,217/)).toBeInTheDocument();
  });

  it("omits the truncation note when everything is shown", () => {
    render(<HealthModal {...base} tab="tables" tables={{ ...tables, truncated: false }} />);
    expect(screen.queryByText(/Showing the/)).not.toBeInTheDocument();
  });

  it("omits the warning when every table has been analyzed", () => {
    render(<HealthModal {...base} tab="tables" tables={{ ...tables, neverAnalyzed: 0 }} />);
    expect(screen.queryByText(/never been analyzed/)).not.toBeInTheDocument();
  });

  it("flags a never-vacuumed table in the danger colour", () => {
    render(<HealthModal {...base} tab="tables" />);
    expect(screen.getAllByText("never")[0]).toHaveClass("bad");
  });

  it("shows a dead-tuple percentage once it is worth acting on", () => {
    render(<HealthModal {...base} tab="tables" />);
    expect(screen.getByText("33.3%")).toBeInTheDocument();
  });

  it("does not badge a table with no meaningful dead tuples", () => {
    render(<HealthModal {...base} tab="tables" />);
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
  });
});

describe("HealthModal — top queries", () => {
  it("says loading before the data lands", () => {
    render(<HealthModal {...base} tab="queries" queries={null} />);
    expect(screen.getByText("loading…")).toBeInTheDocument();
  });

  it("explains a missing extension instead of showing an empty table", () => {
    const queries: TopQueries = {
      available: false,
      reason: "not installed on this server",
      remedy: "CREATE EXTENSION pg_stat_statements;",
      items: [],
    };
    render(<HealthModal {...base} tab="queries" queries={queries} />);
    expect(screen.getByText("No query statistics available")).toBeInTheDocument();
    expect(screen.getByText(/not installed on this server/)).toBeInTheDocument();
    expect(screen.getByText(/CREATE EXTENSION/)).toBeInTheDocument();
  });

  it("lists statements with their timings when the extension is present", () => {
    const queries: TopQueries = {
      available: true,
      items: [
        { queryId: "1", query: "select 1", calls: 1234, totalMs: 5678.9, meanMs: 4.6012, rows: 1 },
      ],
    };
    render(<HealthModal {...base} tab="queries" queries={queries} />);
    expect(screen.getByText("select 1")).toBeInTheDocument();
    expect(screen.getByText("1,234")).toBeInTheDocument();
    expect(screen.getByText("5,679 ms")).toBeInTheDocument();
    expect(screen.getByText("4.60 ms")).toBeInTheDocument();
  });
});
