import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import HistoryPage, { matchesFilter } from "./HistoryPage";
import type { HistoryEntry } from "../ipc/types";

const NOW = new Date("2026-11-27T12:00:00");
const at = (d: Date) => Math.floor(d.getTime() / 1000);

const entry = (over: Partial<HistoryEntry>): HistoryEntry => ({
  id: "h",
  connectionKey: "ada@db:5432/shop",
  sqlText: "select 1",
  status: "success",
  errorText: null,
  rowsReturned: 1,
  rowsAffected: null,
  startedAt: at(new Date()),
  durationMs: 4,
  favorite: false,
  ...over,
});

const ITEMS: HistoryEntry[] = [
  entry({ id: "a", sqlText: "select * from orders\nwhere id = 1", rowsReturned: 3 }),
  entry({
    id: "b",
    sqlText: "update orders set paid = true",
    rowsAffected: 1,
    connectionKey: "bob@other:5432/x",
    actor: "MCP · Cursor",
  }),
  entry({ id: "c", sqlText: "selec 1", status: "error", errorText: "syntax error at or near \"selec\"" }),
  entry({ id: "d", sqlText: null, status: "cancelled", favorite: true }),
];

const base = {
  items: ITEMS,
  search: "",
  onSearch: vi.fn(),
  connectionPrefix: "ada@db:5432/",
  onClear: vi.fn(),
  onToggleFavorite: vi.fn(),
  onOpen: vi.fn(),
  onSave: vi.fn(),
  onClose: vi.fn(),
};

const list = () => screen.getByRole("list", { name: "Statements" });
const rows = () => within(list()).queryAllByRole("listitem");

describe("matchesFilter", () => {
  it("keeps everything for All", () => {
    expect(ITEMS.every((h) => matchesFilter(h, "all", null))).toBe(true);
  });

  it("matches this connection on its server and user", () => {
    expect(matchesFilter(ITEMS[0], "connection", "ada@db:5432/")).toBe(true);
    expect(matchesFilter(ITEMS[1], "connection", "ada@db:5432/")).toBe(false);
    // Disconnected: nothing is this connection.
    expect(matchesFilter(ITEMS[0], "connection", null)).toBe(false);
  });

  it("finds writes by their verb, and by a row count when the text was not kept", () => {
    expect(matchesFilter(ITEMS[0], "writes", null)).toBe(false);
    expect(matchesFilter(ITEMS[1], "writes", null)).toBe(true);
    expect(matchesFilter(entry({ sqlText: null, rowsAffected: 3 }), "writes", null)).toBe(true);
    expect(matchesFilter(entry({ sqlText: null, rowsAffected: null }), "writes", null)).toBe(false);
  });

  it("finds failures", () => {
    expect(ITEMS.filter((h) => matchesFilter(h, "failed", null)).map((h) => h.id)).toEqual(["c"]);
  });

  it("finds today's statements by the local calendar day", () => {
    expect(matchesFilter(entry({ startedAt: at(new Date("2026-11-27T00:05:00")) }), "today", null, NOW)).toBe(true);
    expect(matchesFilter(entry({ startedAt: at(new Date("2026-11-26T23:55:00")) }), "today", null, NOW)).toBe(false);
  });
});

describe("HistoryPage", () => {
  it("is a named region with a list of every statement", () => {
    render(<HistoryPage {...base} />);
    expect(screen.getByRole("region", { name: "Query history" })).toBeInTheDocument();
    expect(rows()).toHaveLength(4);
  });

  it("shows the first line of the statement, its meta and its status", () => {
    render(<HistoryPage {...base} />);
    const first = rows()[0];
    expect(within(first).getByText("select * from orders")).toBeInTheDocument();
    expect(within(first).getByText(/ada@db:5432\/shop · 3 rows · 4 ms/)).toBeInTheDocument();
    expect(within(first).getByText("OK")).toBeInTheDocument();
    expect(within(rows()[2]).getByText("Failed")).toBeInTheDocument();
    expect(within(rows()[3]).getByText("Cancelled")).toBeInTheDocument();
  });

  it("names the AI tool that sent a statement", () => {
    render(<HistoryPage {...base} />);
    expect(within(rows()[1]).getByText(/MCP · Cursor/)).toBeInTheDocument();
    expect(within(rows()[1]).getByText(/1 row\b/)).toBeInTheDocument();
  });

  it("says a production statement's text was not kept", () => {
    render(<HistoryPage {...base} />);
    expect(within(rows()[3]).getByText(/query text hidden — prod/)).toBeInTheDocument();
  });

  it("filters by chip, and marks the chip pressed", async () => {
    render(<HistoryPage {...base} />);
    await userEvent.click(screen.getByRole("button", { name: "Failed" }));
    expect(screen.getByRole("button", { name: "Failed" })).toHaveAttribute("aria-pressed", "true");
    expect(rows()).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Writes" }));
    expect(rows()).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "This connection" }));
    expect(rows()).toHaveLength(3);
    await userEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(rows()).toHaveLength(4);
    await userEvent.click(screen.getByRole("button", { name: "All" }));
    expect(rows()).toHaveLength(4);
  });

  it("cannot filter to this connection with no connection", () => {
    render(<HistoryPage {...base} connectionPrefix={null} />);
    expect(screen.getByRole("button", { name: "This connection" })).toBeDisabled();
  });

  it("says when a filter leaves nothing, and when there is nothing at all", async () => {
    const { rerender } = render(<HistoryPage {...base} items={[ITEMS[0]]} />);
    await userEvent.click(screen.getByRole("button", { name: "Failed" }));
    expect(screen.getByText("Nothing matches.")).toBeInTheDocument();
    rerender(<HistoryPage {...base} items={[]} />);
    expect(screen.getByText("No history yet.")).toBeInTheDocument();
    expect(screen.getByText(/Pick a statement/)).toBeInTheDocument();
  });

  it("reports typing in the search box", async () => {
    const onSearch = vi.fn();
    render(<HistoryPage {...base} onSearch={onSearch} />);
    await userEvent.type(screen.getByLabelText("Search history"), "o");
    expect(onSearch).toHaveBeenCalledWith("o");
  });

  it("shows the first statement in the pane until another is picked", async () => {
    render(<HistoryPage {...base} />);
    const pane = screen.getByRole("complementary", { name: "Selected statement" });
    expect(pane).toHaveTextContent("where id = 1");
    await userEvent.click(within(rows()[2]).getByRole("button", { name: /selec 1/ }));
    expect(within(pane).getByText(/syntax error/)).toBeInTheDocument();
    expect(within(rows()[2]).getByRole("button", { name: /selec 1/ })).toHaveAttribute("aria-current", "true");
  });

  it("says who sent the picked statement", async () => {
    render(<HistoryPage {...base} />);
    await userEvent.click(within(rows()[1]).getByRole("button", { name: /update orders/ }));
    const pane = screen.getByRole("complementary", { name: "Selected statement" });
    expect(within(pane).getByText("Sent by")).toBeInTheDocument();
  });

  it("opens the picked statement in the editor, and offers to save it", async () => {
    const onOpen = vi.fn();
    const onSave = vi.fn();
    render(<HistoryPage {...base} onOpen={onOpen} onSave={onSave} />);
    await userEvent.click(screen.getByRole("button", { name: "Open in editor" }));
    expect(onOpen).toHaveBeenCalledWith("select * from orders\nwhere id = 1");
    await userEvent.click(screen.getByRole("button", { name: "Save as query" }));
    expect(onSave).toHaveBeenCalledWith("select * from orders\nwhere id = 1");
  });

  it("offers no save where there is nowhere to save to", () => {
    render(<HistoryPage {...base} onSave={undefined} />);
    expect(screen.queryByRole("button", { name: "Save as query" })).not.toBeInTheDocument();
  });

  it("cannot open or save a statement whose text was not kept", async () => {
    render(<HistoryPage {...base} />);
    await userEvent.click(within(rows()[3]).getByRole("button", { name: /hidden/ }));
    expect(screen.getByText(/not kept for production/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open in editor" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save as query" })).toBeDisabled();
  });

  it("stars, and clears", async () => {
    const onToggleFavorite = vi.fn();
    const onClear = vi.fn();
    render(<HistoryPage {...base} onToggleFavorite={onToggleFavorite} onClear={onClear} />);
    expect(screen.getByTitle("Unfavorite")).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getAllByTitle("Favorite")[0]);
    expect(onToggleFavorite).toHaveBeenCalledWith(ITEMS[0]);
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onClear).toHaveBeenCalled();
  });

  it("goes back on Escape", () => {
    const onClose = vi.fn();
    render(<HistoryPage {...base} onClose={onClose} />);
    fireEvent.keyDown(screen.getByLabelText("Search history"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    fireEvent.keyDown(screen.getByLabelText("Search history"), { key: "a" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
