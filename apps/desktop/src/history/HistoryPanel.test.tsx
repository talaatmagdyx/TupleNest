import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import HistoryPanel from "./HistoryPanel";
import type { HistoryEntry } from "../ipc/types";

const h = (over: Partial<HistoryEntry> = {}): HistoryEntry =>
  ({
    id: 1,
    sqlText: "select 1",
    status: "success",
    rowsReturned: 5,
    rowsAffected: 0,
    durationMs: 12,
    startedAt: 1_700_000_000,
    errorText: null,
    favorite: false,
    ...over,
  }) as HistoryEntry;

const base = {
  items: [h()],
  search: "",
  onSearch: vi.fn(),
  onClear: vi.fn(),
  onToggleFavorite: vi.fn(),
  onLoad: vi.fn(),
};

describe("HistoryPanel", () => {
  it("says so when there is no history", () => {
    render(<HistoryPanel {...base} items={[]} />);
    expect(screen.getByText("No history yet.")).toBeInTheDocument();
  });

  it("reports typing in the search box", async () => {
    // Controlled input: `search` is owned by the caller, so each keystroke
    // reports only what was typed against the current value.
    const onSearch = vi.fn();
    render(<HistoryPanel {...base} onSearch={onSearch} search="se" />);
    await userEvent.type(screen.getByPlaceholderText("Search history…"), "l");
    expect(onSearch).toHaveBeenCalledWith("sel");
  });

  it("shows the caller's search text", () => {
    render(<HistoryPanel {...base} search="orders" />);
    expect(screen.getByPlaceholderText("Search history…")).toHaveValue("orders");
  });

  it("clears", async () => {
    const onClear = vi.fn();
    render(<HistoryPanel {...base} onClear={onClear} />);
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onClear).toHaveBeenCalled();
  });

  it("shows the SQL and its result summary", () => {
    render(<HistoryPanel {...base} />);
    expect(screen.getByText("select 1")).toBeInTheDocument();
    expect(screen.getByText(/5 rows · 12ms/)).toBeInTheDocument();
  });

  it("falls back to rows affected for a write", () => {
    render(<HistoryPanel {...base} items={[h({ rowsReturned: 0, rowsAffected: 3 })]} />);
    expect(screen.getByText(/3 rows/)).toBeInTheDocument();
  });

  it("shows zero rows rather than nothing when both are zero", () => {
    render(<HistoryPanel {...base} items={[h({ rowsReturned: 0, rowsAffected: 0 })]} />);
    expect(screen.getByText(/0 rows/)).toBeInTheDocument();
  });

  it("shows the status word instead of a row count when it failed", () => {
    render(<HistoryPanel {...base} items={[h({ status: "error", errorText: "syntax error" })]} />);
    expect(screen.getByText(/error · 12ms/)).toBeInTheDocument();
  });

  it.each([
    ["success", "✓"],
    ["error", "✕"],
    ["cancelled", "⊘"],
  ])("glyphs a %s run", (status, glyph) => {
    render(<HistoryPanel {...base} items={[h({ status: status as HistoryEntry["status"] })]} />);
    expect(screen.getByText(glyph)).toBeInTheDocument();
  });

  it("loads a query back into the editor when clicked", async () => {
    const onLoad = vi.fn();
    render(<HistoryPanel {...base} onLoad={onLoad} />);
    await userEvent.click(screen.getByText("select 1"));
    expect(onLoad).toHaveBeenCalledWith("select 1");
  });

  it("toggles a favourite", async () => {
    const onToggleFavorite = vi.fn();
    render(<HistoryPanel {...base} onToggleFavorite={onToggleFavorite} />);
    await userEvent.click(screen.getByTitle("Favorite"));
    expect(onToggleFavorite).toHaveBeenCalledWith(base.items[0]);
  });

  it("offers to unfavourite one that already is", () => {
    render(<HistoryPanel {...base} items={[h({ favorite: true })]} />);
    expect(screen.getByTitle("Unfavorite")).toBeInTheDocument();
  });

  it("shows an error's text as the row's tooltip", () => {
    render(<HistoryPanel {...base} items={[h({ status: "error", errorText: "boom" })]} />);
    expect(screen.getByTitle("boom")).toBeInTheDocument();
  });
});

describe("HistoryPanel — prod redaction", () => {
  // Prod SQL is never persisted. The row still exists so the timing and
  // outcome are visible; only the text is gone, and it must say so rather
  // than render an empty row that looks like a bug.
  const hidden = h({ sqlText: null });

  it("says the text is hidden rather than showing an empty row", () => {
    render(<HistoryPanel {...base} items={[hidden]} />);
    expect(screen.getByText("(query text hidden — prod)")).toBeInTheDocument();
  });

  it("uses a neutral glyph for a redacted row", () => {
    render(<HistoryPanel {...base} items={[hidden]} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("cannot load a query it does not have", async () => {
    const onLoad = vi.fn();
    render(<HistoryPanel {...base} items={[hidden]} onLoad={onLoad} />);
    await userEvent.click(screen.getByText("(query text hidden — prod)"));
    expect(onLoad).not.toHaveBeenCalled();
  });
});
