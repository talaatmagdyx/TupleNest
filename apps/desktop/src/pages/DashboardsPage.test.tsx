import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import DashboardsPage, { type Dashboard } from "./DashboardsPage";
import type { PageContext } from "./context";
import type { ConnectionRecord } from "../ipc/types";

const invokeMock = vi.mocked(invoke);

const PROFILE = { id: "p1", name: "orders-prod", engine: "postgres" } as ConnectionRecord;
const OTHER = { id: "p2", name: "analytics", engine: "postgres" } as ConnectionRecord;

const ctx = (over: Partial<PageContext> = {}): PageContext => ({
  live: true,
  engine: "postgres",
  env: "dev",
  liveProfile: PROFILE,
  saved: [PROFILE, OTHER],
  snippets: [{ id: "s1", name: "Orders by status", body: "select status, count(*)::int from orders group by 1", tags: null }],
  currentSql: "select 1 as n",
  toast: vi.fn(),
  back: vi.fn(),
  ...over,
});

const board = (over: Partial<Dashboard> = {}): Dashboard => ({
  id: "d1",
  name: "Sales overview",
  connectionId: "p1",
  refreshSecs: 0,
  charts: [
    { id: "c1", dashboardId: "d1", title: "Orders by status", kind: "bar", sqlText: "select s, n from t", position: 0 },
    { id: "c2", dashboardId: "d1", title: "Revenue", kind: "number", sqlText: "select 42 as total", position: 1 },
  ],
  ...over,
});

let boards: Dashboard[];
let handlers: Record<string, (a: Record<string, unknown>) => unknown>;

beforeEach(() => {
  boards = [board()];
  handlers = {
    // A fresh copy each time, as IPC gives.
    dashboard_list: () => structuredClone(boards),
    dashboard_save: (a) => {
      const id = (a.id as string | null) ?? "d-new";
      const found = boards.find((b) => b.id === id);
      if (found) Object.assign(found, { name: a.name, refreshSecs: a.refreshSecs });
      else boards.push({ id, name: a.name as string, connectionId: a.connectionId as string, refreshSecs: 0, charts: [] });
      return id;
    },
    dashboard_delete: (a) => {
      boards = boards.filter((b) => b.id !== a.id);
    },
    dashboard_chart_add: () => undefined,
    dashboard_chart_delete: (a) => {
      boards[0].charts = boards[0].charts.filter((c) => c.id !== a.id);
    },
    pg_query_read: (a) =>
      (a.sql as string).includes("42")
        ? { columns: [{ name: "total", dbType: "int4" }], rows: [[42]] }
        : {
            columns: [
              { name: "s", dbType: "text" },
              { name: "n", dbType: "int4" },
            ],
            rows: [
              ["shipped", 3],
              ["waiting", 1],
            ],
          },
  };
  invokeMock.mockReset();
  invokeMock.mockImplementation((async (cmd: string, args?: Record<string, unknown>) => {
    const h = handlers[cmd];
    if (!h) throw new Error(`no handler for ${cmd}`);
    return h(args ?? {});
  }) as never);
});

const calls = (cmd: string) => invokeMock.mock.calls.filter((c) => c[0] === cmd).map((c) => c[1] as Record<string, unknown>);

describe("DashboardsPage", () => {
  it("runs each chart's saved query read-only, capped, and draws it", async () => {
    render(<DashboardsPage ctx={ctx()} />);
    expect(await screen.findByRole("heading", { name: "Sales overview" })).toBeInTheDocument();
    expect(await screen.findByText("shipped")).toBeInTheDocument();
    expect(await screen.findByText("42")).toBeInTheDocument();
    expect(calls("pg_query_read")).toEqual([
      { sql: "select s, n from t", maxRows: 1000 },
      { sql: "select 42 as total", maxRows: 1000 },
    ]);
    expect(screen.getByText(/2 charts · orders-prod/)).toBeInTheDocument();
  });

  it("does not run on another connection, and says which one it needs", async () => {
    render(<DashboardsPage ctx={ctx({ liveProfile: OTHER })} />);
    expect(await screen.findByText(/runs on orders-prod/)).toBeInTheDocument();
    expect(calls("pg_query_read")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Refresh now" })).toBeDisabled();
  });

  it("does not run without a session", async () => {
    render(<DashboardsPage ctx={ctx({ live: false, liveProfile: null })} />);
    expect(await screen.findByText(/Connect to a database/)).toBeInTheDocument();
    expect(calls("pg_query_read")).toHaveLength(0);
  });

  it("shows a refused or failed run on its chart", async () => {
    handlers.pg_query_read = () => Promise.reject("Not run: only a query that reads can be charted.");
    render(<DashboardsPage ctx={ctx()} />);
    expect(await screen.findAllByText(/only a query that reads/)).toHaveLength(2);
  });

  it("re-runs on the refresh interval and on Refresh now", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      boards = [board({ refreshSecs: 60, charts: [board().charts[1]] })];
      render(<DashboardsPage ctx={ctx()} />);
      await screen.findByText("42");
      expect(calls("pg_query_read")).toHaveLength(1);
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      await waitFor(() => expect(calls("pg_query_read")).toHaveLength(2));
      act(() => screen.getByRole("button", { name: "Refresh now" }).click());
      await waitFor(() => expect(calls("pg_query_read")).toHaveLength(3));
    } finally {
      vi.useRealTimers();
    }
  });

  it("changes the refresh interval through the store", async () => {
    const user = userEvent.setup();
    render(<DashboardsPage ctx={ctx()} />);
    await user.selectOptions(await screen.findByRole("combobox", { name: "Refresh" }), "300");
    await waitFor(() =>
      expect(calls("dashboard_save")).toContainEqual({ id: "d1", name: "Sales overview", connectionId: "p1", refreshSecs: 300 }),
    );
  });

  it("creates a dashboard on the live connection, renames and deletes one", async () => {
    const user = userEvent.setup();
    render(<DashboardsPage ctx={ctx()} />);
    await user.click(await screen.findByRole("button", { name: "New dashboard" }));
    await user.type(screen.getByLabelText("New dashboard"), "Ops");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(calls("dashboard_save")[0]).toEqual({ id: null, name: "Ops", connectionId: "p1", refreshSecs: 0 });
    expect(await screen.findByRole("heading", { name: "Ops" })).toBeInTheDocument();
    expect(screen.getByText(/No charts yet/)).toBeInTheDocument();

    // Two dashboards: a picker appears.
    await user.selectOptions(screen.getByRole("combobox", { name: "Dashboard" }), "d1");
    expect(await screen.findByRole("heading", { name: "Sales overview" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Rename" }));
    const input = screen.getByLabelText("Rename dashboard");
    await user.clear(input);
    await user.type(input, "Sales");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("heading", { name: "Sales" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(calls("dashboard_delete")).toEqual([{ id: "d1" }]));
    expect(await screen.findByRole("heading", { name: "Ops" })).toBeInTheDocument();
  });

  it("cancels naming without saving", async () => {
    const user = userEvent.setup();
    render(<DashboardsPage ctx={ctx()} />);
    await user.click(await screen.findByRole("button", { name: "New dashboard" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("New dashboard")).not.toBeInTheDocument();
    expect(calls("dashboard_save")).toHaveLength(0);
  });

  it("explains an empty list, and reports a store that will not save", async () => {
    boards = [];
    handlers.dashboard_save = () => Promise.reject("a dashboard needs a name");
    const c = ctx();
    const user = userEvent.setup();
    render(<DashboardsPage ctx={c} />);
    expect(await screen.findByText("No dashboards yet")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "New dashboard" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(c.toast).toHaveBeenCalledWith("a dashboard needs a name"));
  });

  it("says when the list cannot be read", async () => {
    handlers.dashboard_list = () => Promise.reject("store lock poisoned");
    const c = ctx();
    render(<DashboardsPage ctx={c} />);
    await waitFor(() => expect(c.toast).toHaveBeenCalledWith("Dashboards did not load: store lock poisoned"));
    expect(screen.getByText("No dashboards yet")).toBeInTheDocument();
  });

  it("removes a chart", async () => {
    const user = userEvent.setup();
    render(<DashboardsPage ctx={ctx()} />);
    await user.click(await screen.findByRole("button", { name: "Remove Revenue" }));
    await waitFor(() => expect(calls("dashboard_chart_delete")).toEqual([{ id: "c2" }]));
    await waitFor(() => expect(screen.queryByRole("article", { name: "Revenue" })).not.toBeInTheDocument());
  });

  it("pins a saved query, and shows the backend's refusal of a write", async () => {
    const user = userEvent.setup();
    render(<DashboardsPage ctx={ctx()} />);
    await user.click(await screen.findByRole("button", { name: "Add chart" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByLabelText("Title")).toHaveValue("Orders by status");
    await user.click(within(dialog).getByRole("radio", { name: "Line" }));
    await user.click(within(dialog).getByRole("button", { name: "Pin chart" }));
    expect(calls("dashboard_chart_add")).toEqual([
      { dashboardId: "d1", title: "Orders by status", kind: "line", sql: "select status, count(*)::int from orders group by 1" },
    ]);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    handlers.dashboard_chart_add = () => Promise.reject("Not pinned: DELETE is not a query that only reads.");
    await user.click(screen.getByRole("button", { name: "Add chart" }));
    await user.selectOptions(screen.getByLabelText("Saved query"), "__editor__");
    expect(screen.getByLabelText("Title")).toHaveValue("");
    expect(screen.getByText("select 1 as n")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Pin chart" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Not pinned");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
