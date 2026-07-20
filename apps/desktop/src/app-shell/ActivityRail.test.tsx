import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ActivityRail from "./ActivityRail";

const base = {
  view: "explorer" as const,
  collapsed: false,
  connected: true,
  onView: vi.fn(),
  onMonitor: vi.fn(),
  onDiagram: vi.fn(),
  onPastePlan: vi.fn(),
  onSettings: vi.fn(),
};

const btn = (name: RegExp) => screen.getByRole("button", { name });

describe("ActivityRail", () => {
  it("marks the active view", () => {
    render(<ActivityRail {...base} />);
    expect(btn(/Explorer/)).toHaveClass("on");
    expect(btn(/Query history/)).not.toHaveClass("on");
  });

  it("marks history when that is the view", () => {
    render(<ActivityRail {...base} view="history" />);
    expect(btn(/Query history/)).toHaveClass("on");
  });

  it("shows no view as active while the sidebar is collapsed", () => {
    // The indicator claims "this panel is on screen" — it isn't.
    render(<ActivityRail {...base} collapsed />);
    expect(btn(/Explorer/)).not.toHaveClass("on");
  });

  it("switches view", async () => {
    const onView = vi.fn();
    render(<ActivityRail {...base} onView={onView} />);
    await userEvent.click(btn(/Query history/));
    expect(onView).toHaveBeenCalledWith("history");
  });

  it("opens the monitor and the diagram", async () => {
    const onMonitor = vi.fn();
    const onDiagram = vi.fn();
    render(<ActivityRail {...base} onMonitor={onMonitor} onDiagram={onDiagram} />);
    await userEvent.click(btn(/Server monitor/));
    await userEvent.click(btn(/ER diagram/));
    expect(onMonitor).toHaveBeenCalled();
    expect(onDiagram).toHaveBeenCalled();
  });

  it("disables the server-only tools when disconnected", () => {
    render(<ActivityRail {...base} connected={false} />);
    expect(btn(/Server monitor/)).toBeDisabled();
    expect(btn(/ER diagram/)).toBeDisabled();
  });

  it("keeps the view switches usable when disconnected", () => {
    // The explorer still renders cached metadata offline.
    render(<ActivityRail {...base} connected={false} />);
    expect(btn(/Explorer/)).toBeEnabled();
    expect(btn(/Query history/)).toBeEnabled();
  });

  it("opens settings whether or not there is a connection", async () => {
    const onSettings = vi.fn();
    render(<ActivityRail {...base} connected={false} onSettings={onSettings} />);
    await userEvent.click(btn(/Settings/));
    expect(onSettings).toHaveBeenCalled();
  });

  it("shows one indicator bar, on the active item only", () => {
    const { container } = render(<ActivityRail {...base} />);
    expect(container.querySelectorAll(".rail-ind")).toHaveLength(1);
  });

  it("shows no indicator when collapsed", () => {
    const { container } = render(<ActivityRail {...base} collapsed />);
    expect(container.querySelectorAll(".rail-ind")).toHaveLength(0);
  });
});

describe("ActivityRail — survives a re-render", () => {
  it("keeps the same buttons when the parent re-renders", () => {
    // The rail's buttons used to be a component declared inside the rail, so
    // every render produced a new component type and React replaced the whole
    // row. Nothing looked wrong — the icons are static — but the DOM nodes
    // were not the ones you had been interacting with.
    const { rerender } = render(<ActivityRail {...base} />);
    const before = btn(/Explorer/i);
    rerender(<ActivityRail {...base} connected={false} />);
    expect(btn(/Explorer/i)).toBe(before);
  });

  it("does not drop keyboard focus when the parent re-renders", () => {
    // App re-renders every second while a transaction is open, to tick the
    // timer. A remounted button loses focus, so a keyboard user was thrown
    // back to the top of the page once a second.
    render(<ActivityRail {...base} />);
    const history = btn(/Query history/i);
    history.focus();
    expect(history).toHaveFocus();
    render(<ActivityRail {...base} connected={false} />, {
      container: document.body.firstElementChild as HTMLElement,
    });
    expect(history).toHaveFocus();
  });

  it("offers the pasted-plan analyzer even with no connection", async () => {
    // The feature exists for plans from servers this app cannot reach, so
    // gating it on a live connection would defeat the point.
    const onPastePlan = vi.fn();
    render(<ActivityRail {...base} connected={false} onPastePlan={onPastePlan} />);
    const b = btn(/Analyze a pasted plan/);
    expect(b).toBeEnabled();
    await userEvent.click(b);
    expect(onPastePlan).toHaveBeenCalled();
  });

  it("still disables the tools that genuinely need a server", () => {
    render(<ActivityRail {...base} connected={false} />);
    expect(btn(/Server monitor/)).toBeDisabled();
    expect(btn(/ER diagram/)).toBeDisabled();
  });
});
