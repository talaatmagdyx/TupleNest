import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TabsBar, { QUERY_PANEL_ID, queryTabId } from "./TabsBar";
// The hint tracks the keyboard; this test is about the button, not the glyph.
// Overlays.test.tsx is where the labels themselves are pinned per platform.
import { kbd } from "../lib/platform";

const tabs = [
  { id: "t1", name: "a.sql", sql: "select 1", dirty: false },
  { id: "t2", name: "b.sql", sql: "select 2", dirty: true },
];

const base = { tabs, active: 0, onSelect: vi.fn(), onClose: vi.fn(), onNew: vi.fn() };

describe("TabsBar", () => {
  it("renders a tab per query", () => {
    render(<TabsBar {...base} />);
    expect(screen.getByText("a.sql")).toBeInTheDocument();
    expect(screen.getByText("b.sql")).toBeInTheDocument();
  });

  it("marks the active tab", () => {
    const { container } = render(<TabsBar {...base} />);
    const qtabs = container.querySelectorAll(".qtab");
    expect(qtabs[0]).toHaveClass("on");
    expect(qtabs[1]).not.toHaveClass("on");
  });

  it("dots a tab with unsaved changes, and only that one", () => {
    const { container } = render(<TabsBar {...base} />);
    expect(container.querySelectorAll(".dirty")).toHaveLength(1);
  });

  it("selects on click", async () => {
    const onSelect = vi.fn();
    render(<TabsBar {...base} onSelect={onSelect} />);
    await userEvent.click(screen.getByText("b.sql"));
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it("closes via the x without also selecting the tab", async () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();
    render(<TabsBar {...base} onClose={onClose} onSelect={onSelect} />);
    await userEvent.click(screen.getAllByTitle("Close")[1]);
    expect(onClose).toHaveBeenCalledWith(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("closes on a middle click, as every editor does", async () => {
    const onClose = vi.fn();
    render(<TabsBar {...base} onClose={onClose} />);
    await userEvent.pointer({ keys: "[MouseMiddle]", target: screen.getByText("b.sql") });
    expect(onClose).toHaveBeenCalledWith(1);
  });

  it("opens a new tab", async () => {
    const onNew = vi.fn();
    render(<TabsBar {...base} onNew={onNew} />);
    await userEvent.click(screen.getByTitle(`New tab (${kbd("mod", "T")})`));
    expect(onNew).toHaveBeenCalled();
  });

  it("renders nothing but the plus when there are no tabs", () => {
    const { container } = render(<TabsBar {...base} tabs={[]} />);
    expect(container.querySelectorAll(".qtab")).toHaveLength(0);
    expect(screen.getByTitle(`New tab (${kbd("mod", "T")})`)).toBeInTheDocument();
  });
});

describe("TabsBar — tab semantics", () => {
  it("is a tablist of tabs, the active one selected and controlling the query panel", () => {
    render(<TabsBar {...base} />);
    expect(screen.getByRole("tablist", { name: "Query tabs" })).toBeInTheDocument();
    const a = screen.getByRole("tab", { name: "a.sql" });
    expect(a).toHaveAttribute("aria-selected", "true");
    expect(a).toHaveAttribute("aria-controls", QUERY_PANEL_ID);
    expect(a).toHaveAttribute("id", queryTabId(tabs[0]));
    expect(screen.getByRole("tab", { name: /b\.sql/ })).toHaveAttribute("aria-selected", "false");
  });

  it("says a tab has unsaved changes in words, and keeps the close glyph out of its name", () => {
    render(<TabsBar {...base} />);
    expect(screen.getByRole("tab", { name: "b.sql, unsaved changes" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "a.sql" })).toBeInTheDocument();
  });

  it("leaves the new-tab button outside the tablist, with a name", () => {
    render(<TabsBar {...base} />);
    const list = screen.getByRole("tablist");
    expect(list).not.toContainElement(screen.getByRole("button", { name: "New tab" }));
  });

  it("selects the next and previous tab with the arrows", async () => {
    const onSelect = vi.fn();
    render(<TabsBar {...base} onSelect={onSelect} />);
    screen.getByRole("tab", { name: "a.sql" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onSelect).toHaveBeenLastCalledWith(1);
    // Focus followed to b.sql, so Left comes back to a.sql.
    expect(screen.getByRole("tab", { name: /b\.sql/ })).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(onSelect).toHaveBeenLastCalledWith(0);
  });

  it("closes the focused tab with Delete", async () => {
    const onClose = vi.fn();
    render(<TabsBar {...base} onClose={onClose} />);
    screen.getByRole("tab", { name: "a.sql" }).focus();
    await userEvent.keyboard("{Delete}");
    expect(onClose).toHaveBeenCalledWith(0);
  });

  it("ignores other keys", async () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();
    render(<TabsBar {...base} onClose={onClose} onSelect={onSelect} />);
    screen.getByRole("tab", { name: "a.sql" }).focus();
    await userEvent.keyboard("q");
    expect(onClose).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
