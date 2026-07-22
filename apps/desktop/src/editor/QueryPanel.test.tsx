import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import QueryPanel from "./QueryPanel";
import type { QueryResult } from "../ipc/types";

const invokeMock = vi.mocked(invoke);
beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue([]);
});

const result = (over: Partial<QueryResult> = {}): QueryResult =>
  ({
    columns: [{ name: "id", dbType: "int8" }],
    storedRows: 2,
    totalRows: 2,
    rowsAffected: null,
    elapsedMs: 12,
    truncated: false,
    ...over,
  }) as QueryResult;

const base = {
  sql: "select 1",
  onSqlChange: vi.fn(),
  connected: true,
  running: false,
  inTx: false,
  editorH: 200,
  onSplitStart: vi.fn(),
  status: null,
  result: result(),
  lastError: null,
  queryEpoch: 1,
  resultTab: "results" as const,
  onResultTab: vi.fn(),
  onRun: vi.fn(),
  onCancel: vi.fn(),
  onBegin: vi.fn(),
  onCommit: vi.fn(),
  onRollback: vi.fn(),
  onExplain: vi.fn(),
  onFormat: vi.fn(),
  exportMenu: false,
  onToggleExport: vi.fn(),
  onExport: vi.fn(),
  csvSafe: true,
  onCsvSafe: vi.fn(),
  chart: null,
  onInspect: vi.fn(),
  onCopyable: vi.fn(),
  onToast: vi.fn(),
  onVisibleRows: vi.fn(),
  history: {
    items: [],
    search: "",
    onSearch: vi.fn(),
    onClear: vi.fn(),
    onToggleFavorite: vi.fn(),
    onLoad: vi.fn(),
  },
};

describe("QueryPanel — toolbar", () => {
  it("runs", async () => {
    const onRun = vi.fn();
    render(<QueryPanel {...base} onRun={onRun} />);
    await userEvent.click(screen.getByRole("button", { name: /Run/ }));
    expect(onRun).toHaveBeenCalled();
  });

  it("lets you write in the editor while disconnected", () => {
    // Drafting, ⌘F and ⌘/ are pre-connection work. The editor used to be
    // disabled until a connection was up, which put two shipped features out
    // of reach in exactly the state you would use them.
    render(<QueryPanel {...base} connected={false} />);
    const editor = screen.getByRole("textbox", { name: /sql editor/i });
    expect(editor).not.toBeDisabled();
  });

  it("cannot run while disconnected or already running", () => {
    const { rerender } = render(<QueryPanel {...base} connected={false} />);
    expect(screen.getByRole("button", { name: /Run/ })).toBeDisabled();
    rerender(<QueryPanel {...base} running />);
    expect(screen.getByRole("button", { name: /Run/ })).toBeDisabled();
  });

  it("cancels only while running", async () => {
    const onCancel = vi.fn();
    const { rerender } = render(<QueryPanel {...base} onCancel={onCancel} />);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    rerender(<QueryPanel {...base} running onCancel={onCancel} />);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("offers begin outside a transaction, commit and rollback inside one", async () => {
    const onBegin = vi.fn();
    const onCommit = vi.fn();
    const onRollback = vi.fn();
    const { rerender } = render(<QueryPanel {...base} onBegin={onBegin} />);
    await userEvent.click(screen.getByRole("button", { name: /Begin transaction/ }));
    expect(onBegin).toHaveBeenCalled();
    rerender(<QueryPanel {...base} inTx onCommit={onCommit} onRollback={onRollback} />);
    expect(screen.queryByRole("button", { name: /Begin transaction/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Commit/ }));
    await userEvent.click(screen.getByRole("button", { name: /Rollback/ }));
    expect(onCommit).toHaveBeenCalled();
    expect(onRollback).toHaveBeenCalled();
  });

  it("explains without passing the click event through as options", async () => {
    // `onClick={p.onExplain}` would hand a MouseEvent to a function that
    // expects ExplainOptions — the bug that made the button do nothing.
    const onExplain = vi.fn();
    render(<QueryPanel {...base} onExplain={onExplain} />);
    await userEvent.click(screen.getByRole("button", { name: "Explain" }));
    expect(onExplain).toHaveBeenCalledWith();
  });

  it("formats", async () => {
    const onFormat = vi.fn();
    render(<QueryPanel {...base} onFormat={onFormat} />);
    await userEvent.click(screen.getByTitle(/Format SQL/));
    expect(onFormat).toHaveBeenCalled();
  });
});

describe("QueryPanel — result meta", () => {
  it("says the query ran but matched nothing, rather than showing a blank grid", () => {
    // An empty grid looks like a failure. "0 rows" is a result.
    render(<QueryPanel {...base} result={result({ storedRows: 0, totalRows: 0 })} />);
    expect(screen.getByText("0 rows")).toBeInTheDocument();
    expect(screen.getByText(/ran fine but matched no rows/i)).toBeInTheDocument();
  });

  it("does not claim 0 rows when the run failed", () => {
    // The error is the explanation; "0 rows" beside it reads as a result.
    render(<QueryPanel {...base} result={result({ storedRows: 0, totalRows: 0 })} lastError="boom" />);
    expect(screen.queryByText("0 rows")).not.toBeInTheDocument();
  });

  it("reports rows and time", () => {
    render(<QueryPanel {...base} />);
    expect(screen.getByText(/2 rows · 12 ms/)).toBeInTheDocument();
  });

  it("says how much of a truncated result is in hand", () => {
    render(<QueryPanel {...base} result={result({ storedRows: 100, totalRows: 5000, truncated: true })} />);
    // Appears in the tab meta and again in the grid footer.
    expect(screen.getAllByText(/100 of 5,000 rows/).length).toBeGreaterThan(0);
  });

  it("reports rows affected for a write, which returns no columns", () => {
    render(<QueryPanel {...base} result={result({ columns: [], rowsAffected: 7 })} />);
    expect(screen.getByText(/7 rows affected · 12 ms/)).toBeInTheDocument();
  });

  it("says error rather than a row count when the query failed", () => {
    render(<QueryPanel {...base} lastError="boom" />);
    expect(screen.getByText("error")).toBeInTheDocument();
  });

  it("invites connecting when there is no session", () => {
    render(<QueryPanel {...base} connected={false} result={null} />);
    expect(screen.getByText("Not connected")).toBeInTheDocument();
  });
});

describe("QueryPanel — export", () => {
  it("cannot export a result with no columns", () => {
    render(<QueryPanel {...base} result={result({ columns: [] })} />);
    expect(screen.getByRole("button", { name: /Export/ })).toBeDisabled();
  });

  it("cannot export before there is a result", () => {
    render(<QueryPanel {...base} result={null} />);
    expect(screen.getByRole("button", { name: /Export/ })).toBeDisabled();
  });

  it("opens the menu", async () => {
    const onToggleExport = vi.fn();
    render(<QueryPanel {...base} onToggleExport={onToggleExport} />);
    await userEvent.click(screen.getByRole("button", { name: /Export/ }));
    expect(onToggleExport).toHaveBeenCalled();
  });

  it("exports the chosen format", async () => {
    const onExport = vi.fn();
    render(<QueryPanel {...base} exportMenu onExport={onExport} />);
    const menu = screen.getByText("Save result as").parentElement!;
    await userEvent.click(menu.querySelectorAll("button")[0]);
    expect(onExport).toHaveBeenCalled();
  });

  it("offers copy only when the caller supports it", () => {
    const { rerender } = render(<QueryPanel {...base} exportMenu />);
    expect(screen.queryByText("Copy to clipboard")).not.toBeInTheDocument();
    rerender(<QueryPanel {...base} exportMenu onCopyResult={vi.fn()} />);
    expect(screen.getByText("Copy to clipboard")).toBeInTheDocument();
  });
});

describe("QueryPanel — pending edits", () => {
  const edits = [{ rowKey: "[1]", pkValues: [1], column: "email", value: "x", oldValue: "before" }];
  const target = { schema: "public", table: "users", pk: [{ name: "id", index: 0 }], writable: [true] };

  it("stays out of the way when nothing is staged", () => {
    render(<QueryPanel {...base} editTarget={target} edits={[]} />);
    expect(screen.queryByRole("button", { name: /Review/ })).not.toBeInTheDocument();
  });

  it("offers review and discard once something is staged", async () => {
    const onReviewEdits = vi.fn();
    const onDiscardEdits = vi.fn();
    render(
      <QueryPanel
        {...base}
        editTarget={target}
        edits={edits}
        onReviewEdits={onReviewEdits}
        onDiscardEdits={onDiscardEdits}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Review/ }));
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(onReviewEdits).toHaveBeenCalled();
    expect(onDiscardEdits).toHaveBeenCalled();
  });

  it("explains why a result cannot be edited", () => {
    render(<QueryPanel {...base} editReason="more than one table is referenced" />);
    expect(screen.getByText(/more than one table is referenced/)).toBeInTheDocument();
  });
});

describe("QueryPanel — result tabs", () => {
  it("switches tab", async () => {
    const onResultTab = vi.fn();
    render(<QueryPanel {...base} onResultTab={onResultTab} />);
    await userEvent.click(screen.getByRole("button", { name: "Messages" }));
    expect(onResultTab).toHaveBeenCalledWith("messages");
  });

  it("marks the active tab", () => {
    render(<QueryPanel {...base} resultTab="history" />);
    expect(screen.getByRole("button", { name: "History" })).toHaveClass("on");
  });

  it("shows history on its tab", () => {
    render(<QueryPanel {...base} resultTab="history" />);
    expect(screen.getByPlaceholderText("Search history…")).toBeInTheDocument();
  });

  it("shows the error on the messages tab", () => {
    render(<QueryPanel {...base} resultTab="messages" lastError="syntax error" />);
    expect(screen.getByText(/syntax error/)).toBeInTheDocument();
  });

  it("draws a chart when there is one", () => {
    render(
      <QueryPanel
        {...base}
        resultTab="chart"
        chart={{ title: "Rows by day", sub: "last 7", data: [{ label: "mon", v: 3 }] }}
      />,
    );
    expect(screen.getByText("Rows by day")).toBeInTheDocument();
  });

  it("explains an unchartable result rather than drawing nothing", () => {
    render(<QueryPanel {...base} resultTab="chart" chart={null} />);
    expect(screen.queryByText("Rows by day")).not.toBeInTheDocument();
  });
});
