import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import Grid, { type GridColumn } from "./Grid";
import type { CellEdit, EditTarget } from "../lib/dml";

const invokeMock = vi.mocked(invoke);

const columns: GridColumn[] = [
  { name: "id", dbType: "int8" },
  { name: "email", dbType: "text" },
  { name: "payload", dbType: "jsonb" },
  { name: "active", dbType: "bool" },
];

const rows = [
  [1, "ada@x.com", { a: 1 }, true],
  [2, "alan@x.com", null, false],
];

const target: EditTarget = {
  schema: "public",
  table: "users",
  pk: [{ name: "id", index: 0 }],
  writable: [false, true, true, true],
};

const base = {
  columns,
  storedRows: rows.length,
  epoch: 1,
  onInspect: vi.fn(),
  onCopyable: vi.fn(),
  onToast: vi.fn(),
};

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(rows);
});

/** jsdom reports clientHeight 0, so the grid would compute a zero-row window.
 *  Give it a viewport the way a real layout would. */
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return this.className?.includes?.("vgrid") ? 360 : 0;
    },
  });
});

describe("Grid — rendering", () => {
  it("renders the column headers", async () => {
    render(<Grid {...base} />);
    expect(screen.getByText("id")).toBeInTheDocument();
    expect(screen.getByText("email")).toBeInTheDocument();
  });

  it("shows each column's type in the header", () => {
    render(<Grid {...base} />);
    expect(screen.getByText("int8")).toBeInTheDocument();
    expect(screen.getByText("jsonb")).toBeInTheDocument();
  });

  it("fetches the first block and shows the rows", async () => {
    render(<Grid {...base} />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("pg_rows", { offset: 0, limit: 200 }));
    expect(await screen.findByText("ada@x.com")).toBeInTheDocument();
  });

  it("renders null as a marked null rather than an empty cell", async () => {
    const { container } = render(<Grid {...base} />);
    await screen.findByText("ada@x.com");
    const nulls = Array.from(container.querySelectorAll(".t-null")).map((e) => e.textContent);
    expect(nulls).toContain("null");
  });

  it("serialises a json cell rather than printing [object Object]", async () => {
    render(<Grid {...base} />);
    expect(await screen.findByText('{"a":1}')).toBeInTheDocument();
  });

  it("classes cells by type so numbers and times align", async () => {
    const { container } = render(<Grid {...base} />);
    await screen.findByText("ada@x.com");
    expect(container.querySelector(".t-num")).not.toBeNull();
    expect(container.querySelector(".t-json")).not.toBeNull();
    expect(container.querySelector(".t-true")).not.toBeNull();
  });

  it("asks for nothing when the result is empty", () => {
    render(<Grid {...base} storedRows={0} />);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("reports the visible window to the caller", async () => {
    const onVisible = vi.fn();
    render(<Grid {...base} onVisible={onVisible} />);
    await waitFor(() => expect(onVisible).toHaveBeenCalledWith(1, 2));
  });
});

describe("Grid — selection", () => {
  it("offers a clicked cell's text for copying", async () => {
    const onCopyable = vi.fn();
    render(<Grid {...base} onCopyable={onCopyable} />);
    await userEvent.click(await screen.findByText("ada@x.com"));
    expect(onCopyable).toHaveBeenLastCalledWith("ada@x.com");
  });

  it("marks the selected cell", async () => {
    const { container } = render(<Grid {...base} />);
    await userEvent.click(await screen.findByText("ada@x.com"));
    expect(container.querySelector(".g-cell.selcell")).not.toBeNull();
  });

  it("opens the inspector for a json cell rather than truncating it", async () => {
    const onInspect = vi.fn();
    render(<Grid {...base} onInspect={onInspect} />);
    await userEvent.dblClick(await screen.findByText('{"a":1}'));
    expect(onInspect).toHaveBeenCalledWith(expect.stringContaining('"a"'), "payload");
  });

  it("clears the selection when a new result arrives", async () => {
    const onCopyable = vi.fn();
    const { rerender } = render(<Grid {...base} onCopyable={onCopyable} />);
    await userEvent.click(await screen.findByText("ada@x.com"));
    onCopyable.mockClear();
    // A new epoch means a different result set — a stale ⌘C target would copy
    // a value that is no longer on screen.
    rerender(<Grid {...base} epoch={2} onCopyable={onCopyable} />);
    expect(onCopyable).toHaveBeenCalledWith(null);
  });
});

describe("Grid — sorting", () => {
  it("refuses past the cap rather than pulling millions of rows into memory", async () => {
    // Sorting reads every row into the page. On a result of this size that is
    // a hang, not a sort — so it says no and explains the limit.
    const onToast = vi.fn();
    render(<Grid {...base} storedRows={50_001} onToast={onToast} />);
    await screen.findByText("ada@x.com");
    invokeMock.mockClear();
    await userEvent.click(screen.getByText("email"));
    expect(onToast).toHaveBeenCalledWith(expect.stringContaining("50,000"));
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("sorts right up to the cap", async () => {
    // Exactly at the limit is allowed — it fetches (and says so) rather than
    // refusing.
    const onToast = vi.fn();
    render(<Grid {...base} storedRows={50_000} onToast={onToast} />);
    await screen.findByText("ada@x.com");
    invokeMock.mockClear();
    await userEvent.click(screen.getByText("email"));
    await waitFor(() => expect(invokeMock).toHaveBeenCalled());
    expect(onToast).not.toHaveBeenCalledWith(expect.stringContaining("available up to"));
  });

  it("pulls the rows into memory to sort them", async () => {
    render(<Grid {...base} />);
    await screen.findByText("ada@x.com");
    await userEvent.click(screen.getByText("email"));
    await waitFor(() => expect(invokeMock).toHaveBeenCalled());
  });

  it("cycles asc → desc → off", async () => {
    const { container } = render(<Grid {...base} />);
    await screen.findByText("ada@x.com");
    const head = screen.getByText("id").closest(".g-hcell")!;
    await userEvent.click(head);
    await waitFor(() => expect(container.querySelector(".g-hcell .arrow")).not.toBeNull());
    const dir1 = container.querySelector(".g-hcell .arrow")?.textContent;
    await userEvent.click(head);
    await waitFor(() =>
      expect(container.querySelector(".g-hcell .arrow")?.textContent).not.toBe(dir1),
    );
    await userEvent.click(head);
    await waitFor(() => expect(container.querySelector(".g-hcell .arrow")).toBeNull());
  });
});

describe("Grid — editing", () => {
  const edit = (over: Partial<CellEdit> = {}): CellEdit => ({
    rowKey: "[1]",
    pkValues: [1],
    column: "email",
    value: "new@x.com",
    ...over,
  });

  it("paints a staged value keyed by primary key, not by row position", async () => {
    // The bug this guards: sorting used to move the pending value onto
    // whatever row happened to land at that index.
    render(<Grid {...base} target={target} edits={[edit()]} onStage={vi.fn()} />);
    expect(await screen.findByText("new@x.com")).toBeInTheDocument();
    expect(screen.queryByText("ada@x.com")).not.toBeInTheDocument();
  });

  it("marks a staged cell as dirty", async () => {
    const { container } = render(<Grid {...base} target={target} edits={[edit()]} onStage={vi.fn()} />);
    await screen.findByText("new@x.com");
    // A staged cell is marked `staged`, and its title spells out the change.
    expect(container.querySelector(".g-cell.staged")).not.toBeNull();
    expect(screen.getByTitle(/ada@x\.com → new@x\.com \(pending\)/)).toBeInTheDocument();
  });

  it("leaves other rows alone", async () => {
    render(<Grid {...base} target={target} edits={[edit()]} onStage={vi.fn()} />);
    expect(await screen.findByText("alan@x.com")).toBeInTheDocument();
  });

  it("does not stage anything when the result is not editable", async () => {
    const onStage = vi.fn();
    render(<Grid {...base} onStage={onStage} />);
    await userEvent.dblClick(await screen.findByText("ada@x.com"));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("refuses to edit a primary-key column", async () => {
    // Rewriting the key would make the WHERE clause target a different row.
    const onStage = vi.fn();
    render(<Grid {...base} target={target} edits={[]} onStage={onStage} />);
    await userEvent.dblClick(await screen.findByText("1"));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("stages an edited value", async () => {
    const onStage = vi.fn();
    render(<Grid {...base} target={target} edits={[]} onStage={onStage} />);
    await userEvent.dblClick(await screen.findByText("ada@x.com"));
    const box = await screen.findByRole("textbox");
    await userEvent.clear(box);
    await userEvent.type(box, "z@x.com{Enter}");
    await waitFor(() =>
      expect(onStage).toHaveBeenCalledWith(expect.objectContaining({ column: "email", value: "z@x.com" })),
    );
  });

  it("abandons an edit on Escape", async () => {
    const onStage = vi.fn();
    render(<Grid {...base} target={target} edits={[]} onStage={onStage} />);
    await userEvent.dblClick(await screen.findByText("ada@x.com"));
    await userEvent.type(await screen.findByRole("textbox"), "zzz{Escape}");
    expect(onStage).not.toHaveBeenCalled();
  });
});
