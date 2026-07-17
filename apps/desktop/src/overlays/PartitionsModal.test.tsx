import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PartitionsModal from "./PartitionsModal";
import type { PartitionOverview, PartitionRow } from "../ipc/types";

const p = (name: string, bounds: string, over: Partial<PartitionRow> = {}): PartitionRow => ({
  name,
  bounds,
  size: "1 MB",
  rows: 100,
  rowsKnown: true,
  isPartitioned: false,
  partitionCount: 0,
  ...over,
});

const range = (n: string, from: string, to: string, o: Partial<PartitionRow> = {}) =>
  p(n, `FOR VALUES FROM ('${from}') TO ('${to}')`, o);

const listOverview: PartitionOverview = {
  partitioned: true,
  strategy: "LIST",
  partitionKey: "LIST (channel)",
  items: [p("t_email", "FOR VALUES IN ('email')", { isPartitioned: true, partitionCount: 29 })],
};

const rangeOverview: PartitionOverview = {
  partitioned: true,
  strategy: "RANGE",
  partitionKey: "RANGE (created_at)",
  items: [range("q1", "2024-01-01", "2024-04-01"), range("q3", "2024-07-01", "2024-10-01")],
};

const base = {
  schema: "s",
  table: "t",
  data: listOverview,
  error: null,
  onOpenScript: vi.fn(),
  onClose: vi.fn(),
};

describe("PartitionsModal", () => {
  it("says loading before the data lands", () => {
    render(<PartitionsModal {...base} data={null} />);
    expect(screen.getByText("loading…")).toBeInTheDocument();
  });

  it("shows an error rather than a table when the query failed", () => {
    render(<PartitionsModal {...base} error="nope" data={null} />);
    expect(screen.getByText("nope")).toBeInTheDocument();
  });

  it("says plainly when a table is not partitioned", () => {
    render(
      <PartitionsModal
        {...base}
        data={{ partitioned: false, strategy: "", partitionKey: "", items: [] }}
      />,
    );
    expect(screen.getByText("Not partitioned")).toBeInTheDocument();
  });

  it("heads with the direct count and the partition key", () => {
    render(<PartitionsModal {...base} />);
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText(/LIST \(channel\)/)).toBeInTheDocument();
  });

  it("shows each partition's bounds and size", () => {
    render(<PartitionsModal {...base} />);
    expect(screen.getByText("FOR VALUES IN ('email')")).toBeInTheDocument();
    expect(screen.getByText("1 MB")).toBeInTheDocument();
  });

  it("badges a sub-partitioned child with its own count", () => {
    render(<PartitionsModal {...base} />);
    expect(screen.getByTitle("29 sub-partitions")).toHaveTextContent("29");
  });

  it("shows a dash rather than zero when the row count is unknown", () => {
    // reltuples is -1 until analyze runs; "0" would read as "empty".
    render(
      <PartitionsModal
        {...base}
        data={{ ...listOverview, items: [p("x", "FOR VALUES IN ('a')", { rowsKnown: false })] }}
      />,
    );
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("states that nothing on the screen executes DDL", () => {
    render(<PartitionsModal {...base} />);
    expect(screen.getByText(/Nothing on this screen executes DDL/)).toBeInTheDocument();
  });

  it("closes", async () => {
    const onClose = vi.fn();
    render(<PartitionsModal {...base} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("PartitionsModal — actions open scripts, never run them", () => {
  it("offers detach as a reversible script", async () => {
    const onOpenScript = vi.fn();
    render(<PartitionsModal {...base} onOpenScript={onOpenScript} />);
    await userEvent.click(screen.getByRole("button", { name: /Detach/ }));
    const [name, sql] = onOpenScript.mock.calls[0];
    expect(name).toBe("detach-partition.sql");
    expect(sql).toContain("DETACH PARTITION");
    expect(sql).not.toContain("DROP");
  });

  it("offers drop as a script that names the destruction", async () => {
    const onOpenScript = vi.fn();
    render(<PartitionsModal {...base} onOpenScript={onOpenScript} />);
    await userEvent.click(screen.getByRole("button", { name: /Drop/ }));
    const [name, sql] = onOpenScript.mock.calls[0];
    expect(name).toBe("drop-partition.sql");
    expect(sql).toContain("DESTRUCTIVE");
    expect(sql).toContain('DROP TABLE "s"."t_email";');
  });
});

describe("PartitionsModal — range gaps", () => {
  it("warns about a hole in the series", () => {
    render(<PartitionsModal {...base} data={rangeOverview} />);
    expect(screen.getByText(/1 gap in the range series/)).toBeInTheDocument();
  });

  it("says the comparison is textual rather than presenting it as proof", () => {
    render(<PartitionsModal {...base} data={rangeOverview} />);
    expect(screen.getByText(/compared as text/)).toBeInTheDocument();
  });

  it("names the missing range and its neighbours", () => {
    render(<PartitionsModal {...base} data={rangeOverview} />);
    const gapRow = screen.getByText(/'2024-04-01' → '2024-07-01'/).closest(".gap-row")!;
    // q1/q3 also appear in the partition list below, so scope to the gap row.
    expect(within(gapRow as HTMLElement).getByText("q1")).toBeInTheDocument();
    expect(within(gapRow as HTMLElement).getByText("q3")).toBeInTheDocument();
  });

  it("fills a gap with the exact bounds that were missing", async () => {
    const onOpenScript = vi.fn();
    render(<PartitionsModal {...base} data={rangeOverview} onOpenScript={onOpenScript} />);
    await userEvent.click(screen.getByRole("button", { name: /Fill/ }));
    const [name, sql] = onOpenScript.mock.calls[0];
    expect(name).toBe("create-partition.sql");
    expect(sql).toContain("FOR VALUES FROM ('2024-04-01') TO ('2024-07-01')");
  });

  it("says nothing about gaps in a contiguous series", () => {
    render(
      <PartitionsModal
        {...base}
        data={{
          ...rangeOverview,
          items: [range("q1", "2024-01-01", "2024-04-01"), range("q2", "2024-04-01", "2024-07-01")],
        }}
      />,
    );
    expect(screen.queryByText(/gap/)).not.toBeInTheDocument();
  });

  it("does not look for gaps in a LIST-partitioned table", () => {
    // LIST has no ordering, so "between" is meaningless.
    render(<PartitionsModal {...base} />);
    expect(screen.queryByText(/gap/)).not.toBeInTheDocument();
  });

  it("pluralises correctly for several gaps", () => {
    render(
      <PartitionsModal
        {...base}
        data={{
          ...rangeOverview,
          items: [range("a", "1", "2"), range("c", "3", "4"), range("e", "5", "6")],
        }}
      />,
    );
    expect(screen.getByText(/2 gaps in the range series/)).toBeInTheDocument();
  });
});
