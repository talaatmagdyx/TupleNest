import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ExplainModal, { type PlanNode } from "./ExplainModal";
import { DEFAULT_EXPLAIN } from "../lib/explain";

const node = (over: Partial<PlanNode> = {}): PlanNode => ({
  kind: "Seq Scan",
  title: "on users",
  detail: "rows=1000 width=40",
  ms: 12.34,
  pct: 50,
  indent: 0,
  hot: false,
  ...over,
});

const base = {
  title: "untitled-1.sql",
  sql: "select * from users",
  options: { ...DEFAULT_EXPLAIN },
  serverMajor: 18,
  statement: "EXPLAIN (FORMAT JSON) select * from users",
  raw: "",
  stale: false,
  nodes: [node()],
  stats: [{ label: "Planning", value: "0.2 ms" }],
  suggestion: null,
  error: null,
  busy: false,
  onOptions: vi.fn(),
  onRerun: vi.fn(),
  onExport: vi.fn(),
  onCopy: vi.fn(),
  onClose: vi.fn(),
};

describe("ExplainModal — warnings", () => {
  it("warns that ANALYZE on a write really writes", () => {
    // EXPLAIN ANALYZE executes the statement. On a DELETE that is not a
    // preview, it is the deletion — the user has to be told before they run it.
    render(
      <ExplainModal
        {...base}
        sql="delete from users where id = 1"
        options={{ ...DEFAULT_EXPLAIN, analyze: true }}
      />,
    );
    expect(screen.getByText(/executes the statement for real/i)).toBeInTheDocument();
    expect(screen.getByText(/careful/i)).toBeInTheDocument();
  });

  it("says nothing of the sort for a SELECT", () => {
    render(<ExplainModal {...base} sql="select 1" options={{ ...DEFAULT_EXPLAIN, analyze: true }} />);
    expect(screen.queryByText(/executes the statement for real/i)).not.toBeInTheDocument();
  });
});

describe("ExplainModal — shell", () => {
  it("titles with the tab the plan came from", () => {
    render(<ExplainModal {...base} />);
    expect(screen.getByText("untitled-1.sql")).toBeInTheDocument();
  });

  it("shows the exact statement that was sent", () => {
    render(<ExplainModal {...base} />);
    expect(screen.getByText("EXPLAIN (FORMAT JSON) select * from users")).toBeInTheDocument();
  });

  it("says it is running rather than showing an empty plan", () => {
    render(<ExplainModal {...base} nodes={null} busy />);
    expect(screen.getByText("running EXPLAIN…")).toBeInTheDocument();
  });

  it("shows an error instead of a plan", () => {
    render(<ExplainModal {...base} nodes={null} error="syntax error at or near" />);
    expect(screen.getByText(/syntax error/)).toBeInTheDocument();
  });

  it("closes", async () => {
    const onClose = vi.fn();
    render(<ExplainModal {...base} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("ExplainModal — plan tree", () => {
  it("renders a node with its kind, title, detail and timing", () => {
    render(<ExplainModal {...base} />);
    // The kind is uppercased for the chip.
    expect(screen.getByText("SEQ SCAN")).toBeInTheDocument();
    expect(screen.getByText("on users")).toBeInTheDocument();
    expect(screen.getByText("rows=1000 width=40")).toBeInTheDocument();
    expect(screen.getByText("12.3 ms")).toBeInTheDocument();
  });

  it("omits the timing when the plan was not analyzed", () => {
    // Without ANALYZE there are no real times; showing 0 ms would be a lie.
    const { container } = render(<ExplainModal {...base} nodes={[node({ ms: null })]} />);
    expect(container.querySelector(".pn-cost")).toHaveTextContent("");
  });

  it("flags the hot node", () => {
    render(<ExplainModal {...base} nodes={[node({ hot: true })]} />);
    expect(screen.getByText("HOT")).toBeInTheDocument();
  });

  it("shows the stats panel", () => {
    render(<ExplainModal {...base} />);
    expect(screen.getByText("Planning")).toBeInTheDocument();
    expect(screen.getByText("0.2 ms")).toBeInTheDocument();
  });

  it("shows a suggestion when there is one", () => {
    render(<ExplainModal {...base} suggestion="Consider an index on users(email)" />);
    expect(screen.getByText(/Consider an index/)).toBeInTheDocument();
  });
});

describe("ExplainModal — richer plan", () => {
  it("shows self-time and the total when both are known", () => {
    render(<ExplainModal {...base} nodes={[node({ ms: 30, selfMs: 12, selfPct: 40 })]} />);
    expect(screen.getByText("self 12.0 ms")).toBeInTheDocument();
    expect(screen.getByText(/30.0 ms total/)).toBeInTheDocument();
  });

  it("falls back to inclusive time when self-time is absent", () => {
    render(<ExplainModal {...base} nodes={[node({ ms: 30 })]} />);
    expect(screen.getByText("30.0 ms")).toBeInTheDocument();
    expect(screen.queryByText(/self /)).not.toBeInTheDocument();
  });

  it("renders the call-out badges for a node's flags", () => {
    render(
      <ExplainModal
        {...base}
        nodes={[node({ flags: ["bottleneck", "disk-sort", "misestimate"], misestimate: 42 })]}
      />,
    );
    expect(screen.getByText("BOTTLENECK")).toBeInTheDocument();
    expect(screen.getByText("DISK SORT")).toBeInTheDocument();
    expect(screen.getByText("EST ×42 OFF")).toBeInTheDocument();
  });

  it("shows the insights list and hides the legacy suggestion when insights exist", () => {
    render(
      <ExplainModal
        {...base}
        suggestion="legacy single suggestion"
        insights={[
          { level: "tip", text: "Seq Scan on big is the busiest node." },
          { level: "warn", text: "A sort spilled to disk." },
        ]}
      />,
    );
    expect(screen.getByText(/busiest node/)).toBeInTheDocument();
    expect(screen.getByText(/spilled to disk/)).toBeInTheDocument();
    expect(screen.queryByText(/legacy single suggestion/)).not.toBeInTheDocument();
  });
});

describe("ExplainModal — options", () => {
  it("toggles an option through to the caller", async () => {
    const onOptions = vi.fn();
    render(<ExplainModal {...base} onOptions={onOptions} />);
    await userEvent.click(screen.getByRole("button", { name: /BUFFERS/i }));
    expect(onOptions).toHaveBeenCalled();
  });

  it("changes format", async () => {
    const onOptions = vi.fn();
    render(<ExplainModal {...base} onOptions={onOptions} />);
    await userEvent.selectOptions(screen.getByRole("combobox"), "text");
    expect(onOptions).toHaveBeenCalledWith(expect.objectContaining({ format: "text" }));
  });

  it("re-runs on demand", async () => {
    const onRerun = vi.fn();
    render(<ExplainModal {...base} onRerun={onRerun} />);
    await userEvent.click(screen.getByRole("button", { name: "Re-run" }));
    expect(onRerun).toHaveBeenCalled();
  });

  it("locks re-run while a plan is in flight", () => {
    render(<ExplainModal {...base} busy />);
    expect(screen.getByRole("button", { name: "Running…" })).toBeDisabled();
  });

  it("blocks re-run when the options cannot produce a plan", () => {
    // TIMING without ANALYZE is rejected by the server; better to say so than
    // to send it and surface a raw error.
    render(<ExplainModal {...base} options={{ ...base.options, analyze: false, timing: true }} />);
    expect(screen.getByRole("button", { name: "Re-run" })).toBeDisabled();
  });

  it("warns that the shown plan is from the previous options", () => {
    render(<ExplainModal {...base} stale />);
    expect(screen.getByText(/the plan below is from the previous run/)).toBeInTheDocument();
  });

  it("does not nag about staleness while it is already re-running", () => {
    render(<ExplainModal {...base} stale busy />);
    expect(screen.queryByText(/from the previous run/)).not.toBeInTheDocument();
  });
});

describe("ExplainModal — non-JSON formats", () => {
  // A tree can only be drawn from JSON. The others must still be readable
  // rather than showing an empty panel with a scolding message.
  const textPlan = { ...base, options: { ...base.options, format: "text" as const }, nodes: null, raw: "Seq Scan on users" };

  it("shows the server's own output verbatim", () => {
    render(<ExplainModal {...textPlan} />);
    expect(screen.getByText("Seq Scan on users")).toBeInTheDocument();
  });

  it("shows a placeholder rather than nothing when the raw payload is empty", () => {
    render(<ExplainModal {...textPlan} raw="" />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});

describe("ExplainModal — export", () => {
  it("keeps the menu shut until asked", () => {
    render(<ExplainModal {...base} />);
    expect(screen.queryByText("Save plan as")).not.toBeInTheDocument();
  });

  it("cannot export a plan that does not exist yet", () => {
    render(<ExplainModal {...base} nodes={null} />);
    expect(screen.getByRole("button", { name: /Export/i })).toBeDisabled();
  });

  it("can export the error, since that is worth keeping too", () => {
    render(<ExplainModal {...base} nodes={null} error="boom" />);
    expect(screen.getByRole("button", { name: /Export/i })).toBeEnabled();
  });

  /** The menu holds a "Save plan as" group and a "Copy to clipboard" group,
   *  each with a JSON/Text entry — so the label alone is ambiguous. Index
   *  within the menu instead. */
  const openMenu = async () => {
    const { container } = render(<ExplainModal {...base} onExport={base.onExport} />);
    await userEvent.click(screen.getByRole("button", { name: /Export/i }));
    return Array.from(container.querySelectorAll(".drop-menu button"));
  };

  it.each([
    [0, "json"],
    [1, "txt"],
    [2, "md"],
  ])("save entry %i exports as %s", async (i, kind) => {
    const onExport = vi.fn();
    const { container } = render(<ExplainModal {...base} onExport={onExport} />);
    await userEvent.click(screen.getByRole("button", { name: /Export/i }));
    await userEvent.click(container.querySelectorAll(".drop-menu button")[i]);
    expect(onExport).toHaveBeenCalledWith(kind);
  });

  it("closes the menu after picking", async () => {
    const btns = await openMenu();
    await userEvent.click(btns[0]);
    expect(screen.queryByText("Save plan as")).not.toBeInTheDocument();
  });

  it("copies rather than exports from the copy group", async () => {
    const onCopy = vi.fn();
    const onExport = vi.fn();
    const { container } = render(<ExplainModal {...base} onCopy={onCopy} onExport={onExport} />);
    await userEvent.click(screen.getByRole("button", { name: /Export/i }));
    // Entries 0-2 save; the copy group follows the divider.
    await userEvent.click(container.querySelectorAll(".drop-menu button")[3]);
    expect(onCopy).toHaveBeenCalled();
    expect(onExport).not.toHaveBeenCalled();
  });
});
