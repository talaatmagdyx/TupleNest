import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SearchModal from "./SearchModal";
import type { SearchResults } from "../ipc/types";

const results: SearchResults = {
  items: [
    { schema: "public", name: "users", kind: "table", column: "" },
    { schema: "public", name: "users", kind: "column", column: "user_id" },
    { schema: "app", name: "v_users", kind: "view", column: "" },
  ],
  truncated: false,
};

const base = {
  results,
  busy: false,
  error: null,
  onSearch: vi.fn(),
  onPick: vi.fn(),
  onClose: vi.fn(),
};

describe("SearchModal", () => {
  it("focuses the box so you can type immediately", () => {
    render(<SearchModal {...base} results={null} />);
    expect(screen.getByPlaceholderText(/Table, view, sequence/)).toHaveFocus();
  });

  it("reports each keystroke to the caller", async () => {
    const onSearch = vi.fn();
    render(<SearchModal {...base} onSearch={onSearch} results={null} />);
    await userEvent.type(screen.getByRole("textbox"), "usr");
    expect(onSearch).toHaveBeenLastCalledWith("usr");
  });

  it("shows a busy note while searching", () => {
    render(<SearchModal {...base} busy results={null} />);
    expect(screen.getByText("searching…")).toBeInTheDocument();
  });

  it("shows an error instead of results", () => {
    render(<SearchModal {...base} error="failed" results={null} />);
    expect(screen.getByText("failed")).toBeInTheDocument();
  });

  it("lists object hits and column hits differently", () => {
    render(<SearchModal {...base} />);
    expect(screen.getByText("users")).toBeInTheDocument();
    expect(screen.getByText("user_id")).toBeInTheDocument();
    expect(screen.getAllByText("column").length).toBeGreaterThan(0);
  });

  it("says nothing matched, but only once something was typed", async () => {
    const { rerender } = render(<SearchModal {...base} results={{ items: [], truncated: false }} />);
    expect(screen.queryByText("No matches.")).not.toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox"), "zzz");
    rerender(<SearchModal {...base} results={{ items: [], truncated: false }} />);
    expect(screen.getByText("No matches.")).toBeInTheDocument();
  });

  it("says when the list was cut short", () => {
    render(<SearchModal {...base} results={{ ...results, truncated: true }} />);
    expect(screen.getByText(/Showing the first 3/)).toBeInTheDocument();
  });

  it("explains that partitions are hidden once you search", async () => {
    render(<SearchModal {...base} />);
    await userEvent.type(screen.getByRole("textbox"), "u");
    expect(screen.getByText(/Partitions are hidden/)).toBeInTheDocument();
  });

  it("picks a hit on click", async () => {
    const onPick = vi.fn();
    render(<SearchModal {...base} onPick={onPick} />);
    await userEvent.click(screen.getByText("v_users"));
    expect(onPick).toHaveBeenCalledWith(results.items[2]);
  });

  it("picks the selected hit on Enter", async () => {
    const onPick = vi.fn();
    render(<SearchModal {...base} onPick={onPick} />);
    await userEvent.keyboard("{Enter}");
    expect(onPick).toHaveBeenCalledWith(results.items[0]);
  });

  it("moves the selection with the arrow keys", async () => {
    const onPick = vi.fn();
    render(<SearchModal {...base} onPick={onPick} />);
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(onPick).toHaveBeenCalledWith(results.items[2]);
  });

  it("stops at the last hit rather than wrapping", async () => {
    const onPick = vi.fn();
    render(<SearchModal {...base} onPick={onPick} />);
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{Enter}");
    expect(onPick).toHaveBeenCalledWith(results.items[2]);
  });

  it("stops at the first hit going up", async () => {
    const onPick = vi.fn();
    render(<SearchModal {...base} onPick={onPick} />);
    await userEvent.keyboard("{ArrowDown}{ArrowUp}{ArrowUp}{Enter}");
    expect(onPick).toHaveBeenCalledWith(results.items[0]);
  });

  it("does nothing on Enter when there is nothing to pick", async () => {
    const onPick = vi.fn();
    render(<SearchModal {...base} onPick={onPick} results={null} />);
    await userEvent.keyboard("{Enter}");
    expect(onPick).not.toHaveBeenCalled();
  });

  it("follows the mouse", async () => {
    const onPick = vi.fn();
    render(<SearchModal {...base} onPick={onPick} />);
    await userEvent.hover(screen.getByText("v_users"));
    await userEvent.keyboard("{Enter}");
    expect(onPick).toHaveBeenCalledWith(results.items[2]);
  });

  it("resets the selection when new results arrive", async () => {
    // Otherwise Enter fires on whatever index the previous, longer result set
    // happened to leave behind.
    const onPick = vi.fn();
    const { rerender } = render(<SearchModal {...base} onPick={onPick} />);
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    rerender(
      <SearchModal {...base} onPick={onPick} results={{ items: [results.items[0]], truncated: false }} />,
    );
    await userEvent.keyboard("{Enter}");
    expect(onPick).toHaveBeenCalledWith(results.items[0]);
  });

  it("closes", async () => {
    const onClose = vi.fn();
    render(<SearchModal {...base} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });
});
