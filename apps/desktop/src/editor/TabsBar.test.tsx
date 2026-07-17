import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TabsBar from "./TabsBar";
// The hint tracks the keyboard; this test is about the button, not the glyph.
// Overlays.test.tsx is where the labels themselves are pinned per platform.
import { kbd } from "../lib/platform";

const tabs = [
  { name: "a.sql", sql: "select 1", dirty: false },
  { name: "b.sql", sql: "select 2", dirty: true },
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
