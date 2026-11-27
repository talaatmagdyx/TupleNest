import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Grid, { columnMaxima, keepNear, numberOf, type GridColumn } from "./Grid";
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
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("pg_rows", { offset: 0, limit: 200, sort: null }));
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
  it("asks the backend for rows in the clicked column's order", async () => {
    render(<Grid {...base} />);
    await screen.findByText("ada@x.com");
    invokeMock.mockClear();
    await userEvent.click(screen.getByText("email"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("pg_rows", {
        offset: 0,
        limit: 200,
        sort: { column: 1, desc: false },
      }),
    );
  });

  it("never pulls more than a block into the page, however large the result", async () => {
    // Sorting used to fetch every row (up to 50,000) to sort them here.
    render(<Grid {...base} storedRows={100_000} />);
    await screen.findByText("ada@x.com");
    await userEvent.click(screen.getByText("email"));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("pg_rows", expect.objectContaining({ sort: { column: 1, desc: false } })));
    for (const [, args] of invokeMock.mock.calls) expect((args as { limit: number }).limit).toBeLessThanOrEqual(200);
  });

  it("drops a block that arrives in the old order after the sort changed", async () => {
    let release: (rows: unknown[][]) => void = () => {};
    invokeMock.mockReset();
    invokeMock.mockImplementationOnce(() => new Promise((r) => (release = r as typeof release)));
    invokeMock.mockResolvedValue([[9, "zed@x.com", null, true]]);
    render(<Grid {...base} />);
    await userEvent.click(screen.getByText("email"));
    await screen.findByText("zed@x.com");
    release(rows); // the unsorted first fetch, late
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText("ada@x.com")).toBeNull();
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
    oldValue: "before",
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
    // The old value is still there, but only as the struck-through "was".
    expect(screen.getByText("ada@x.com")).toHaveClass("g-was");
    expect(screen.getByText("alan@x.com")).not.toHaveClass("g-was");
  });

  it("shows the old value struck through, and reads it as what it was", async () => {
    const { container } = render(<Grid {...base} target={target} edits={[edit()]} onStage={vi.fn()} />);
    await screen.findByText("new@x.com");
    const cell = container.querySelector(".g-cell.staged") as HTMLElement;
    expect(cell).toHaveTextContent("new@x.com, was ada@x.com");
    expect(cell.querySelector(".g-was .sr-only")).toHaveTextContent(", was");
    // Only staged cells carry one.
    expect(container.querySelectorAll(".g-was")).toHaveLength(1);
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

  it("stages the edit when the editor loses focus", async () => {
    const onStage = vi.fn();
    render(<Grid {...base} target={target} edits={[]} onStage={onStage} />);
    await userEvent.dblClick(await screen.findByText("ada@x.com"));
    await userEvent.type(await screen.findByRole("textbox"), "m");
    await userEvent.click(screen.getByText("alan@x.com"));
    expect(onStage).toHaveBeenCalledWith(expect.objectContaining({ column: "email", value: "ada@x.comm" }));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("abandons an edit on Escape", async () => {
    const onStage = vi.fn();
    render(<Grid {...base} target={target} edits={[]} onStage={onStage} />);
    await userEvent.dblClick(await screen.findByText("ada@x.com"));
    await userEvent.type(await screen.findByRole("textbox"), "zzz{Escape}");
    expect(onStage).not.toHaveBeenCalled();
  });
});

describe("Grid — editing a json cell", () => {
  /** Open the payload cell for editing and return the input. */
  const openPayload = async (onStage: () => void) => {
    const user = userEvent.setup();
    render(<Grid {...base} target={target} onStage={onStage} />);
    await screen.findByText('{"a":1}');
    await user.dblClick(screen.getByText('{"a":1}'));
    return { user, input: document.querySelector("input.g-edit") as HTMLInputElement };
  };

  it("puts the json in the box, not [object Object]", async () => {
    const { input } = await openPayload(vi.fn());
    expect(input.value).toBe('{"a":1}');
  });

  it("stages nothing when the json is opened and closed unchanged", async () => {
    // The comparison used to be `String(value) === String(original)`, and for
    // an object the right-hand side is "[object Object]" — never equal to the
    // json in the box. So looking at a jsonb cell staged an UPDATE for it.
    const onStage = vi.fn();
    const { user } = await openPayload(onStage);
    await user.keyboard("{Enter}");
    expect(onStage).not.toHaveBeenCalled();
  });

  it("still stages a real change to the json", async () => {
    const onStage = vi.fn();
    const { user, input } = await openPayload(onStage);
    await user.clear(input);
    await user.type(input, '{{"a":2}');
    await user.keyboard("{Enter}");
    expect(onStage).toHaveBeenCalledTimes(1);
  });
});

describe("Grid — keyboard and screen readers", () => {
  /*
   * The grid was `div`s with onClick and nothing else. A keyboard user could
   * not select a cell, let alone edit one, and a screen reader got an
   * unlabelled pile of divs with no idea it was tabular. For a database IDE
   * the grid is the product, so this was the largest gap in the app.
   */
  const gridRows = async () => {
    render(<Grid {...base} />);
    await waitFor(() => expect(screen.getAllByRole("gridcell").length).toBeGreaterThan(0));
  };

  it("is a grid, and says how big it is", async () => {
    await gridRows();
    const g = screen.getByRole("grid");
    expect(g).toHaveAttribute("aria-rowcount", "2");
    expect(g).toHaveAttribute("aria-colcount", "4");
    expect(g).toHaveAccessibleName("Query results");
  });

  it("gives the columns header semantics and reports the sort", async () => {
    await gridRows();
    const heads = screen.getAllByRole("columnheader");
    // Row-number gutter, then one per column.
    expect(heads).toHaveLength(columns.length + 1);
    expect(heads[1]).toHaveAttribute("aria-sort", "none");
    await userEvent.click(heads[1]);
    expect(screen.getAllByRole("columnheader")[1]).toHaveAttribute("aria-sort", "ascending");
  });

  it("keeps a header's name and type inside its cell, with the full text as a title", async () => {
    await gridRows();
    const id = screen.getAllByRole("columnheader")[1];
    // "id int8" spilled into the next column as "id intcustomer_id".
    expect(id).toHaveAttribute("title", "id int8");
    expect(id).toHaveClass("num");
    const label = id.querySelector(".g-hlabel");
    expect(label).not.toBeNull();
    expect(label!.querySelector(".cn")).toHaveTextContent("id");
    expect(label!.querySelector(".ct")).toHaveTextContent("int8");
    // jsdom does no layout: hold the stylesheet to the clipping rules.
    const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
    expect(css).toMatch(/\.g-hcell \{ overflow: hidden; \}/);
    const rule = /\.g-hcell \.g-hlabel \{([^}]*)\}/.exec(css)?.[1] ?? "";
    for (const d of ["min-width: 0", "overflow: hidden", "text-overflow: ellipsis", "white-space: nowrap"]) {
      expect(rule).toContain(d);
    }
  });

  it("sorts from the keyboard as well as the mouse", async () => {
    await gridRows();
    const head = screen.getAllByRole("columnheader")[1];
    head.focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.getAllByRole("columnheader")[1]).toHaveAttribute("aria-sort", "ascending");
  });

  it("has exactly one tab stop, not one per cell", async () => {
    // A 100,000-row result would otherwise be 100,000 tab stops.
    await gridRows();
    await userEvent.click(screen.getAllByRole("gridcell")[0]);
    const tabbable = screen.getAllByRole("gridcell").filter((c) => c.getAttribute("tabindex") === "0");
    expect(tabbable).toHaveLength(1);
  });

  it("moves the selection with the arrow keys", async () => {
    await gridRows();
    await userEvent.click(screen.getAllByRole("gridcell")[0]);
    await userEvent.keyboard("{ArrowRight}");
    const sel = screen.getAllByRole("gridcell").filter((c) => c.getAttribute("aria-selected") === "true");
    expect(sel).toHaveLength(1);
    expect(sel[0]).toHaveTextContent("ada@x.com");
  });

  it("moves down a row", async () => {
    await gridRows();
    await userEvent.click(screen.getAllByRole("gridcell")[0]);
    await userEvent.keyboard("{ArrowDown}");
    const sel = screen.getAllByRole("gridcell").filter((c) => c.getAttribute("aria-selected") === "true");
    expect(sel[0]).toHaveTextContent("2");
  });

  it("stops at the edges rather than falling off", async () => {
    await gridRows();
    await userEvent.click(screen.getAllByRole("gridcell")[0]);
    await userEvent.keyboard("{ArrowUp}{ArrowLeft}");
    const sel = screen.getAllByRole("gridcell").filter((c) => c.getAttribute("aria-selected") === "true");
    expect(sel[0]).toHaveTextContent("1");
  });

  it("opens the editor on Enter, so editing is reachable without a mouse", async () => {
    // Double-click was the only way in.
    render(<Grid {...base} target={target} onStage={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByRole("gridcell").length).toBeGreaterThan(0));
    await userEvent.click(screen.getAllByRole("gridcell")[1]);
    await userEvent.keyboard("{Enter}");
    expect(screen.getByDisplayValue("ada@x.com")).toBeInTheDocument();
  });

  it("marks read-only cells as such", async () => {
    render(<Grid {...base} target={target} onStage={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByRole("gridcell").length).toBeGreaterThan(0));
    const cells = screen.getAllByRole("gridcell");
    // `id` is the primary key: not writable.
    expect(cells[0]).toHaveAttribute("aria-readonly", "true");
    expect(cells[1]).toHaveAttribute("aria-readonly", "false");
  });

  it("leaves the arrows alone while a cell editor is open", async () => {
    // They belong to the text field at that point.
    render(<Grid {...base} target={target} onStage={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByRole("gridcell").length).toBeGreaterThan(0));
    await userEvent.dblClick(screen.getAllByRole("gridcell")[1]);
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByDisplayValue("ada@x.com")).toBeInTheDocument();
  });
});

describe("Grid — block cache", () => {
  it("keeps only the blocks near the one just fetched", () => {
    const m: Record<number, string> = {};
    for (let b = 0; b < 50; b++) m[b] = `block ${b}`;
    const kept = keepNear(m, 30, 10);
    expect(Object.keys(kept).map(Number)).toEqual([...Array(21)].map((_, i) => 20 + i));
    expect(kept[30]).toBe("block 30");
  });
});

describe("Grid — wide results", () => {
  it("draws only the columns near the viewport, and follows the selection sideways", async () => {
    const wide: GridColumn[] = [...Array(60)].map((_, i) => ({ name: `c${i}`, dbType: "text" }));
    invokeMock.mockResolvedValue([wide.map((_, i) => `v${i}`)]);
    const { container } = render(<Grid {...base} columns={wide} storedRows={1} />);
    await screen.findByText("v0");
    // Every header, but a window of cells and one spacer for the rest.
    expect(screen.getAllByRole("columnheader")).toHaveLength(61);
    expect(screen.getAllByRole("gridcell").length).toBeLessThan(10);
    expect(screen.queryByText("v59")).toBeNull();
    expect(container.querySelectorAll(".g-row > div[aria-hidden]")).toHaveLength(1);

    const view = container.querySelector(".vgrid") as HTMLElement;
    view.scrollLeft = 150 * 50;
    fireEvent.scroll(view);
    expect(await screen.findByText("v50")).toBeInTheDocument();
    expect(screen.queryByText("v0")).toBeNull();
    expect(container.querySelectorAll(".g-row > div[aria-hidden]")).toHaveLength(2);

    // Arrowing left of the drawn window scrolls the view to the column.
    await userEvent.click(screen.getByText("v50"));
    view.scrollLeft = 150 * 52;
    await userEvent.keyboard("{ArrowLeft}");
    expect(view.scrollLeft).toBe(150 * 49);
  });
});

describe("Grid — wide results, right edge", () => {
  it("scrolls right to a column past the right edge", async () => {
    const wide: GridColumn[] = [...Array(60)].map((_, i) => ({ name: `c${i}`, dbType: "text" }));
    invokeMock.mockResolvedValue([wide.map((_, i) => `v${i}`)]);
    const { container } = render(<Grid {...base} columns={wide} storedRows={1} />);
    const view = container.querySelector(".vgrid") as HTMLElement;
    // jsdom lays nothing out: without a width there is no right edge to pass.
    Object.defineProperty(view, "clientWidth", { configurable: true, value: 56 + 300 });
    await userEvent.click(await screen.findByText("v0"));
    await userEvent.keyboard("{End}");
    // The last column's right edge (60 × 150) sits on the viewport's.
    expect(view.scrollLeft).toBe(150 * 60 - 300);
    // One column right is already in view: nothing to scroll.
    view.scrollLeft = 0;
    await userEvent.keyboard("{Home}{ArrowRight}");
    expect(view.scrollLeft).toBe(0);
  });
});

describe("Grid — the focus survives End on a wide result", () => {
  // End selected the last column before the window had scrolled to it: that
  // cell was not drawn, so the focus stayed on the old one, and the scroll
  // that followed unmounted it. Focus fell to <body> and the arrows did nothing.
  const wide: GridColumn[] = [...Array(60)].map((_, i) => ({ name: `c${i}`, dbType: "text" }));
  const selected = () => screen.getAllByRole("gridcell").find((c) => c.getAttribute("aria-selected") === "true");

  it("keeps the focus on the grid, on the selected cell, and the arrows still move it", async () => {
    invokeMock.mockResolvedValue([wide.map((_, i) => `v${i}`), wide.map((_, i) => `w${i}`)]);
    const user = userEvent.setup();
    const { container } = render(<Grid {...base} columns={wide} storedRows={2} />);
    const view = container.querySelector(".vgrid") as HTMLElement;
    Object.defineProperty(view, "clientWidth", { configurable: true, value: 56 + 300 });
    await user.click(await screen.findByText("v0"));

    await user.keyboard("{End}");
    // Drawn and focused at once, before the scroll has moved the window.
    const last = screen.getByText("v59");
    expect(document.activeElement).toBe(last);
    // And brought into view: its right edge on the viewport's.
    expect(view.scrollLeft).toBe(150 * 60 - 300);

    // The scroll lands and the window moves right; v0 is gone.
    fireEvent.scroll(view);
    await waitFor(() => expect(screen.queryByText("v0")).toBeNull());
    expect(document.activeElement).toBe(last);
    expect(view.contains(document.activeElement)).toBe(true);

    await user.keyboard("{ArrowLeft}");
    expect(selected()).toHaveTextContent("v58");
    expect(document.activeElement).toBe(screen.getByText("v58"));
    await user.keyboard("{ArrowDown}");
    expect(selected()).toHaveTextContent("w58");
    expect(document.activeElement).toBe(screen.getByText("w58"));
  });

  it("draws the selected cell only on its own row", async () => {
    invokeMock.mockResolvedValue([wide.map((_, i) => `v${i}`), wide.map((_, i) => `w${i}`)]);
    const user = userEvent.setup();
    const { container } = render(<Grid {...base} columns={wide} storedRows={2} />);
    const view = container.querySelector(".vgrid") as HTMLElement;
    Object.defineProperty(view, "clientWidth", { configurable: true, value: 56 + 300 });
    await user.click(await screen.findByText("v0"));
    await user.keyboard("{End}");
    expect(screen.getByText("v59")).toBeInTheDocument();
    expect(screen.queryByText("w59")).toBeNull();
  });

  it("keeps the selected row drawn when the view scrolls away from it", async () => {
    invokeMock.mockImplementation((_cmd, args) => {
      const { offset } = args as { offset: number };
      return Promise.resolve([...Array(200)].map((_, i) => [offset + i, `u${offset + i}@x.com`, null, true]));
    });
    const user = userEvent.setup();
    const { container } = render(<Grid {...base} storedRows={2000} />);
    const view = container.querySelector(".vgrid") as HTMLElement;
    await user.click(await screen.findByText("u0@x.com"));
    const cell = screen.getByText("u0@x.com");
    view.scrollTop = 24 * 150;
    fireEvent.scroll(view);
    await screen.findByText("u150@x.com");
    expect(document.activeElement).toBe(cell);
    await user.keyboard("{ArrowDown}");
    expect(selected()).toHaveTextContent("u1@x.com");
  });
});

describe("Grid — an open editor survives scrolling", () => {
  const scrollTo = (view: HTMLElement, top: number, left = 0) => {
    view.scrollTop = top;
    view.scrollLeft = left;
    fireEvent.scroll(view);
  };

  it("keeps the edited cell mounted when its column leaves the window", async () => {
    const wide: GridColumn[] = [...Array(60)].map((_, i) => ({ name: `c${i}`, dbType: "text" }));
    const wideTarget: EditTarget = { ...target, writable: wide.map((_, i) => i > 0) };
    invokeMock.mockResolvedValue([wide.map((_, i) => `v${i}`), wide.map((_, i) => `w${i}`)]);
    const user = userEvent.setup();
    const { container } = render(
      <Grid {...base} columns={wide} storedRows={2} target={wideTarget} onStage={vi.fn()} />,
    );
    await user.dblClick(await screen.findByText("v1"));
    const input = screen.getByRole("textbox");
    await user.type(input, "!");

    const view = container.querySelector(".vgrid") as HTMLElement;
    scrollTo(view, 0, 150 * 50);
    await screen.findByText("v50");
    // The same element, not a new one: the draft, the focus and the caret.
    expect(screen.getByRole("textbox")).toBe(input);
    expect(input).toHaveValue("v1!");
    expect(document.activeElement).toBe(input);
    // Only the edited row reaches back for it; the other keeps its window.
    expect(screen.queryByText("w2")).toBeNull();
    const cells = Array.from(container.querySelectorAll(".g-row")).map((r) => r.querySelectorAll(".g-cell").length);
    expect(cells[0]).toBeGreaterThan(cells[1]);

    // And the other way: an editor right of the window.
    await user.keyboard("{Escape}");
    await user.dblClick(screen.getByText("v50"));
    const right = screen.getByRole("textbox");
    scrollTo(view, 0, 0);
    await screen.findByText("w0");
    expect(screen.getByRole("textbox")).toBe(right);
    expect(document.activeElement).toBe(right);
  });

  it("keeps the edited row mounted, and its block cached, when the view scrolls far away", async () => {
    invokeMock.mockImplementation((_cmd, args) => {
      const { offset } = args as { offset: number };
      return Promise.resolve([...Array(200)].map((_, i) => [offset + i, `u${offset + i}@x.com`, null, true]));
    });
    const onStage = vi.fn();
    const user = userEvent.setup();
    const { container } = render(<Grid {...base} storedRows={2000} target={target} onStage={onStage} />);
    const view = container.querySelector(".vgrid") as HTMLElement;
    scrollTo(view, 24 * 300);
    await user.dblClick(await screen.findByText("u300@x.com"));
    const input = screen.getByRole("textbox");
    await user.clear(input);
    await user.type(input, "z@x.com");

    // Above the window: far enough that block 1 would have been dropped.
    scrollTo(view, 24 * 1500);
    await screen.findByText("u1500@x.com");
    expect(screen.getByRole("textbox")).toBe(input);
    expect(document.activeElement).toBe(input);
    // In place: 300 rows of space above it, then the gap down to the window.
    const kids = Array.from(view.children) as HTMLElement[];
    const at = kids.indexOf(input.closest(".g-row") as HTMLElement);
    expect(kids[at - 1].style.height).toBe(`${24 * 300}px`);
    expect(kids[at + 1].style.height).toBe(`${24 * (1500 - 12 - 301)}px`);

    // Below the window.
    scrollTo(view, 0);
    await screen.findByText("u0@x.com");
    expect(screen.getByRole("textbox")).toBe(input);
    expect(document.activeElement).toBe(input);

    // Still committable: the row's key is still to hand.
    await user.keyboard("{Enter}");
    expect(onStage).toHaveBeenCalledWith(
      expect.objectContaining({ pkValues: [300], column: "email", value: "z@x.com", oldValue: "u300@x.com" }),
    );
  });
});

describe("Grid — row memoization", () => {
  it("re-renders only the rows the selection left and entered", async () => {
    // A getter on a row's data counts how often that row is rendered.
    const data = [...Array(20)].map((_, i) => [i, `u${i}@x.com`, null, true]);
    const reads = { near: 0, far: 0 };
    Object.defineProperty(data[1], 3, { get: () => (reads.near++, true) });
    Object.defineProperty(data[10], 3, { get: () => (reads.far++, true) });
    invokeMock.mockResolvedValue(data);
    render(<Grid {...base} storedRows={20} />);
    await userEvent.click(await screen.findByText("u0@x.com"));
    reads.near = reads.far = 0;
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getAllByRole("row")[2]).toHaveClass("sel");
    expect(reads.near).toBeGreaterThan(0);
    expect(reads.far).toBe(0);
  });
});

describe("Grid — a page that fails to load", () => {
  it("stays usable, and the next change that needs the block fetches it again", async () => {
    // A failed fetch is not an unhandled rejection and not a stuck "pending"
    // block: the grid keeps its header, and sorting asks for the rows anew.
    invokeMock.mockReset();
    invokeMock.mockRejectedValueOnce("no result").mockResolvedValue(rows);
    render(<Grid {...base} />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("ada@x.com")).toBeNull();
    await userEvent.click(screen.getByText("email"));
    expect(await screen.findByText("ada@x.com")).toBeInTheDocument();
  });
});

// Audit TN-025: a block that failed to load was swallowed, and its rows
// stayed placeholders as if they were still on their way.
describe("Grid — a page of rows that cannot be loaded", () => {
  it("says so, with the reason", async () => {
    invokeMock.mockRejectedValue("result was dropped");
    render(<Grid {...base} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Some rows could not be loaded: result was dropped");
  });

  it("sits below the column headers, not over them", async () => {
    // Found in a built app: the bar was placed before the header and covered it.
    invokeMock.mockRejectedValue("gone");
    const { container } = render(<Grid {...base} />);
    const bar = await screen.findByRole("alert");
    const head = container.querySelector(".g-head")!;
    expect(head.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("email")).toBeInTheDocument();
  });

  it("loads them on Retry and takes the message away", async () => {
    invokeMock.mockRejectedValueOnce(new Error("temporary"));
    render(<Grid {...base} />);
    await screen.findByRole("alert");
    const before = invokeMock.mock.calls.length;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("ada@x.com")).toBeInTheDocument();
    expect(invokeMock.mock.calls.length).toBeGreaterThan(before);
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("does not keep asking by itself after a failure", async () => {
    invokeMock.mockRejectedValue(new Error("down"));
    render(<Grid {...base} />);
    await screen.findByRole("alert");
    const calls = invokeMock.mock.calls.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(invokeMock.mock.calls.length).toBe(calls);
  });

  it("shows nothing of the kind when rows load", async () => {
    render(<Grid {...base} />);
    await screen.findByText("ada@x.com");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});


describe("Grid — numeric columns", () => {
  const numCols: GridColumn[] = [
    { name: "name", dbType: "text" },
    { name: "revenue", dbType: "numeric" },
    { name: "qty", dbType: "int4" },
  ];
  const numRows = [
    ["a", "200.50", 4],
    ["b", "-401", 0],
    ["c", null, 2],
  ];

  it("reads numbers from what the backend sends", () => {
    expect(numberOf(3)).toBe(3);
    expect(numberOf("12.5")).toBe(12.5);
    expect(numberOf(BigInt(7))).toBe(7);
    expect(numberOf(null)).toBeNull();
    expect(numberOf("")).toBeNull();
    expect(numberOf("NaN")).toBeNull();
    expect(numberOf(Infinity)).toBeNull();
    expect(numberOf({})).toBeNull();
  });

  it("scales each numeric column by its largest loaded magnitude", () => {
    expect(columnMaxima(numCols, { 0: numRows })).toEqual([null, 401, 4]);
    // Nothing to scale against: no bars.
    expect(columnMaxima(numCols, {})).toEqual([null, null, null]);
    expect(columnMaxima(numCols, { 0: [["x", 0, null]] })).toEqual([null, null, null]);
  });

  it("right-aligns numeric cells and headers, and draws the bar as a background", async () => {
    invokeMock.mockResolvedValue(numRows);
    const { container } = render(<Grid {...base} columns={numCols} storedRows={numRows.length} />);
    await screen.findByText("-401");
    const heads = container.querySelectorAll(".g-hcell");
    expect(heads[0]).not.toHaveClass("num");
    expect(heads[1]).toHaveClass("num");
    const big = screen.getByText("-401");
    expect(big).toHaveClass("num", "bar");
    expect(big.style.getPropertyValue("--g-frac")).toBe("1");
    // Half of the largest, by magnitude.
    expect(screen.getByText("200.50").style.getPropertyValue("--g-frac")).toBe("0.5");
    // Nothing for a screen reader: the cell holds its text and nothing else.
    expect(big.childNodes).toHaveLength(1);
    // No bar for a zero or a text column.
    expect(screen.getByText("0")).not.toHaveClass("bar");
    expect(screen.getByText("a")).not.toHaveClass("num");
  });
});
