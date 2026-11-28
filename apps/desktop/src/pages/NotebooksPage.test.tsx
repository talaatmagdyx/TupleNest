import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import NotebooksPage from "./NotebooksPage";
import type { PageContext } from "./context";
import type { ConnectionRecord } from "../ipc/types";
import type { Notebook } from "../lib/notebook";

const invokeMock = vi.mocked(invoke);

const PROFILE = { id: "p1", name: "orders-prod", engine: "postgres" } as ConnectionRecord;
const OTHER = { id: "p2", name: "analytics", engine: "postgres" } as ConnectionRecord;

const ctx = (over: Partial<PageContext> = {}): PageContext => ({
  live: true,
  engine: "postgres",
  env: "dev",
  liveProfile: PROFILE,
  saved: [PROFILE, OTHER],
  snippets: [],
  currentSql: "",
  toast: vi.fn(),
  back: vi.fn(),
  ...over,
});

const SAVED: Notebook = {
  id: "n1",
  name: "Refunds",
  connectionId: "p1",
  cells: [
    { id: "t", kind: "text", text: "# Why did refunds rise?\n<b>not bold</b>" },
    {
      id: "s",
      kind: "sql",
      sql: "select reason, n from r",
      result: {
        columns: [
          { name: "reason", dbType: "text" },
          { name: "n", dbType: "int4" },
        ],
        rows: [["late delivery", 412]],
        ranAt: "2026-11-27T10:00:00Z",
      },
    },
    { id: "c", kind: "chart", source: "s", chart: "bar" },
  ],
};

let handlers: Record<string, (a: Record<string, unknown>) => unknown>;
beforeEach(() => {
  handlers = {
    notebook_list: () => [{ id: "n1", name: "Refunds", connectionId: "p1", updatedAt: 1 }],
    notebook_get: () => structuredClone(SAVED),
    notebook_save: (a) => ({ id: (a.id as string) ?? "n-new", name: a.name, connectionId: a.connectionId, cells: a.cells }),
    notebook_delete: () => undefined,
    export_save: () => "/tmp/Refunds.md",
    pg_query: () => ({
      columns: [{ name: "n", dbType: "int4" }],
      rows: [[7]],
      truncated: false,
      rowsAffected: null,
    }),
  };
  invokeMock.mockReset();
  invokeMock.mockImplementation((async (cmd: string, args?: Record<string, unknown>) => {
    const h = handlers[cmd];
    if (!h) throw new Error(`no handler for ${cmd}`);
    return h(args ?? {});
  }) as never);
});

const calls = (cmd: string) => invokeMock.mock.calls.filter((c) => c[0] === cmd).map((c) => c[1] as Record<string, unknown>);

const openSaved = async (c = ctx()) => {
  const user = userEvent.setup();
  render(<NotebooksPage ctx={c} />);
  await user.selectOptions(await screen.findByRole("combobox", { name: "Open notebook" }), "n1");
  await screen.findByRole("heading", { name: "Refunds" });
  return user;
};

describe("NotebooksPage", () => {
  it("opens a notebook as it was saved, running nothing", async () => {
    await openSaved();
    expect(screen.getByRole("heading", { name: "Why did refunds rise?" })).toBeInTheDocument();
    // Raw HTML is text, not markup.
    expect(screen.getByText("<b>not bold</b>")).toBeInTheDocument();
    expect(screen.getAllByText("late delivery")).toHaveLength(2); // table and chart
    expect(calls("pg_query")).toHaveLength(0);
  });

  it("runs a SQL cell through the normal path, detached and capped at 200, and saves it", async () => {
    const user = await openSaved();
    await user.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() =>
      expect(calls("pg_query")).toEqual([{ sql: "select reason, n from r", detached: true, maxRows: 200 }]),
    );
    expect(await screen.findByText("7")).toBeInTheDocument();
    expect(screen.getByText("unsaved")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls("notebook_save")).toHaveLength(1));
    const sent = calls("notebook_save")[0];
    expect(sent.id).toBe("n1");
    expect((sent.cells as Notebook["cells"])[1]).toMatchObject({ result: { rows: [[7]] } });
    await waitFor(() => expect(screen.queryByText("unsaved")).not.toBeInTheDocument());
  });

  it("asks the guard first on staging, and runs only what was confirmed", async () => {
    const user = await openSaved(ctx({ env: "staging" }));
    await user.clear(screen.getByLabelText("SQL of cell 2"));
    await user.type(screen.getByLabelText("SQL of cell 2"), "update t set x = 1");
    await user.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Don't run it" }));
    expect(calls("pg_query")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Run" }));
    // Staging wants the name typed back for a write to every row (TN-034).
    await user.type(await screen.findByRole("textbox", { name: /Type t to confirm/i }), "t");
    await user.click(await screen.findByRole("button", { name: "Run anyway" }));
    await waitFor(() => expect(calls("pg_query")).toHaveLength(1));
  });

  it("keeps an error on the cell, and a statement with no rows says how many it changed", async () => {
    handlers.pg_query = () => Promise.reject('column "boom" does not exist');
    const user = await openSaved();
    await user.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByText('column "boom" does not exist')).toBeInTheDocument();
    expect(screen.getByText("Run the SQL cell to draw this chart.")).toBeInTheDocument();
    handlers.pg_query = () => ({ columns: [], rows: [], truncated: false, rowsAffected: 3 });
    await user.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByText("3 rows affected")).toBeInTheDocument();
  });

  it("does not run on another connection", async () => {
    await openSaved(ctx({ liveProfile: OTHER }));
    expect(screen.getByText("Connect to orders-prod to run cells.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
  });

  it("does not run without a session", async () => {
    await openSaved(ctx({ live: false, liveProfile: null }));
    expect(screen.getByText("Connect to a database to run cells.")).toBeInTheDocument();
  });

  it("builds a new notebook of text, SQL and chart cells", async () => {
    handlers.notebook_list = () => [];
    const user = userEvent.setup();
    render(<NotebooksPage ctx={ctx()} />);
    expect(await screen.findByText("No notebooks yet")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "New notebook" }));
    await user.type(screen.getByLabelText("Text of cell 1"), "Some **notes**");
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.getByText("notes").tagName).toBe("STRONG");
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText("Text of cell 1")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "+ SQL" }));
    await user.type(screen.getByLabelText("SQL of cell 2"), "select 1");
    await user.click(screen.getByRole("button", { name: "+ Chart" }));
    const chart = screen.getByRole("article", { name: "Cell 3, chart" });
    expect(within(chart).getByLabelText("Chart source")).toHaveDisplayValue(/SQL cell 1: select 1/);
    await user.selectOptions(within(chart).getByLabelText("Chart kind"), "number");
    await user.selectOptions(within(chart).getByLabelText("Chart source"), "");
    await user.click(screen.getByRole("button", { name: "+ Text" }));
    expect(screen.getByText("Empty text cell")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete cell 4" }));

    await user.selectOptions(screen.getByLabelText("Connection"), "p2");
    await user.click(screen.getByRole("button", { name: "Rename" }));
    const name = screen.getByLabelText("Notebook name");
    await user.clear(name);
    await user.type(name, "Ops checks{Enter}");
    expect(screen.getByRole("heading", { name: "Ops checks" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls("notebook_save")).toHaveLength(1));
    expect(calls("notebook_save")[0]).toMatchObject({ id: null, name: "Ops checks", connectionId: "p2" });
    expect((calls("notebook_save")[0].cells as unknown[]).length).toBe(3);
  });

  it("reports a save the store refuses", async () => {
    handlers.notebook_save = () => Promise.reject("a notebook needs a name");
    const c = ctx();
    const user = await openSaved(c);
    await user.click(screen.getByRole("button", { name: "Delete cell 1" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(c.toast).toHaveBeenCalledWith("Not saved: a notebook needs a name"));
  });

  it("exports Markdown through the save panel, and deletes", async () => {
    const c = ctx();
    const user = await openSaved(c);
    await user.click(screen.getByRole("button", { name: "Export Markdown" }));
    await waitFor(() => expect(c.toast).toHaveBeenCalledWith("Exported Refunds.md"));
    const sent = calls("export_save")[0];
    expect(sent.defaultName).toBe("Refunds.md");
    expect(sent.contents).toContain("```sql\nselect reason, n from r\n```");

    handlers.export_save = () => null;
    await user.click(screen.getByRole("button", { name: "Export Markdown" }));
    expect(c.toast).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(calls("notebook_delete")).toEqual([{ id: "n1" }]));
    expect(await screen.findByText("Open a notebook, or start one")).toBeInTheDocument();
  });

  it("deletes a notebook that was never saved without asking the store", async () => {
    handlers.notebook_list = () => [];
    const user = userEvent.setup();
    render(<NotebooksPage ctx={ctx()} />);
    await user.click(await screen.findByRole("button", { name: "New notebook" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(calls("notebook_delete")).toHaveLength(0);
  });

  it("says when the list cannot be read, and ignores a notebook that has gone", async () => {
    handlers.notebook_list = () => Promise.reject("locked");
    const c = ctx();
    render(<NotebooksPage ctx={c} />);
    await waitFor(() => expect(c.toast).toHaveBeenCalledWith("Notebooks did not load: locked"));
  });

  it("does nothing when the notebook picked has been deleted elsewhere", async () => {
    handlers.notebook_get = () => null;
    const user = userEvent.setup();
    render(<NotebooksPage ctx={ctx()} />);
    await user.selectOptions(await screen.findByRole("combobox", { name: "Open notebook" }), "n1");
    await waitFor(() => expect(calls("notebook_get")).toHaveLength(1));
    expect(screen.getByRole("heading", { name: "Notebooks" })).toBeInTheDocument();
  });
});
