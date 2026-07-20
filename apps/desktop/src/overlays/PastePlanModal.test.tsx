import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PastePlanModal, { analyzePasted } from "./PastePlanModal";

/* Plans here are written by hand, not lifted from a real database — a plan
   carries table and index names, and those are not ours to commit. */

const TEXT_PLAN = [
  "Sort  (cost=92391.90..93141.90 rows=300000 width=85) (actual time=143.935..157.570 rows=300000.00 loops=1)",
  "  Sort Method: external merge  Disk: 27944kB",
  "  Buffers: shared hit=383 read=4295, temp read=13953 written=14714",
  "  ->  Seq Scan on t  (cost=0.00..7672.00 rows=300000 width=85) (actual time=0.055..24.336 rows=300000.00 loops=1)",
  "        Buffers: shared hit=377 read=4295",
  "Execution Time: 168.000 ms",
].join("\n");

const JSON_PLAN = JSON.stringify([
  {
    Plan: {
      "Node Type": "Sort",
      "Actual Total Time": 157.57,
      "Actual Loops": 1,
      "Sort Method": "external merge",
      Plans: [{ "Node Type": "Seq Scan", "Relation Name": "t", "Actual Total Time": 24.3, "Actual Loops": 1 }],
    },
    "Execution Time": 168,
  },
]);

describe("analyzePasted", () => {
  it("reads a text plan", () => {
    const r = analyzePasted(TEXT_PLAN);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.format).toBe("text");
    expect(r.plan.nodes).toHaveLength(2);
    expect(r.plan.nodes[0].flags).toContain("disk-sort");
  });

  it("reads a JSON plan", () => {
    const r = analyzePasted(JSON_PLAN);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.format).toBe("json");
    expect(r.plan.nodes).toHaveLength(2);
  });

  it("reports nothing pasted separately from nonsense", () => {
    expect(analyzePasted("   ").kind).toBe("empty");
    expect(analyzePasted("select * from t").kind).toBe("unreadable");
  });

  it("refuses a document it can read but that holds no plan", () => {
    // Valid JSON, no nodes: drawing an empty tree would imply we understood it.
    expect(analyzePasted('{"hello":"world"}').kind).toBe("unreadable");
  });

  it("does not throw on truncated JSON", () => {
    expect(analyzePasted('[{"Plan": {').kind).toBe("unreadable");
  });
});

describe("PastePlanModal", () => {
  const type = async (value: string) => {
    const user = userEvent.setup();
    render(<PastePlanModal onClose={vi.fn()} />);
    const box = screen.getByLabelText(/paste a query plan/i);
    // `paste` rather than `type`: a 6-line plan typed key-by-key is slow, and
    // pasting is what actually happens.
    await user.click(box);
    await user.paste(value);
    await user.click(screen.getByRole("button", { name: "Analyze" }));
    return user;
  };

  it("says nothing has been analysed until asked", () => {
    render(<PastePlanModal onClose={vi.fn()} />);
    expect(screen.queryByText(/BOTTLENECK/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Analyze" })).toBeDisabled();
  });

  it("draws a pasted text plan and names the format it read", async () => {
    await type(TEXT_PLAN);
    expect(screen.getByText(/read as TEXT/)).toBeInTheDocument();
    expect(screen.getByText("DISK SORT")).toBeInTheDocument();
    expect(screen.getByText(/spilled to disk/)).toBeInTheDocument();
  });

  it("draws a pasted JSON plan too", async () => {
    await type(JSON_PLAN);
    expect(screen.getByText(/read as JSON/)).toBeInTheDocument();
  });

  it("explains itself rather than drawing an empty tree", async () => {
    await type("select 1");
    expect(screen.getByText(/doesn't look like a PostgreSQL plan/i)).toBeInTheDocument();
  });

  it("promises the paste stays on the machine, because that is the point", () => {
    render(<PastePlanModal onClose={vi.fn()} />);
    expect(screen.getByText(/Nothing is sent anywhere/i)).toBeInTheDocument();
  });

  it("closes", async () => {
    const onClose = vi.fn();
    render(<PastePlanModal onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });
});
