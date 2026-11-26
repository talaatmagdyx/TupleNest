import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Menu, MenuGroup, TabList, tabPanelProps } from "./a11y";

type T = "a" | "b" | "c";
const TABS = [
  ["a", "Alpha"],
  ["b", "Beta"],
  ["c", "Gamma"],
] as const;

function Strip(p: { onSelect?: (t: T) => void }) {
  const [active, setActive] = useState<T>("a");
  return (
    <>
      <TabList
        label="Greek"
        idBase="g"
        tabs={TABS}
        active={active}
        onSelect={(t) => {
          setActive(t);
          p.onSelect?.(t);
        }}
      />
      <div {...tabPanelProps("g", active)}>panel {active}</div>
    </>
  );
}

describe("TabList", () => {
  it("is a named tablist whose selected tab controls the panel", () => {
    render(<Strip />);
    expect(screen.getByRole("tablist", { name: "Greek" })).toBeInTheDocument();
    const alpha = screen.getByRole("tab", { name: "Alpha" });
    expect(alpha).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Beta" })).toHaveAttribute("aria-selected", "false");
    const panel = screen.getByRole("tabpanel", { name: "Alpha" });
    expect(alpha).toHaveAttribute("aria-controls", panel.id);
  });

  it("keeps only the selected tab in the tab order", () => {
    render(<Strip />);
    expect(screen.getByRole("tab", { name: "Alpha" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tab", { name: "Gamma" })).toHaveAttribute("tabindex", "-1");
  });

  it("moves selection and focus with the arrows, wrapping at both ends", async () => {
    render(<Strip />);
    screen.getByRole("tab", { name: "Alpha" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Beta" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Beta" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Beta" })).toHaveTextContent("panel b");
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Alpha" })).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(screen.getByRole("tab", { name: "Gamma" })).toHaveFocus();
  });

  it("jumps to the ends with Home and End", async () => {
    render(<Strip />);
    screen.getByRole("tab", { name: "Alpha" }).focus();
    await userEvent.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "Gamma" })).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(screen.getByRole("tab", { name: "Alpha" })).toHaveFocus();
  });

  it("leaves other keys alone", async () => {
    const onSelect = vi.fn();
    render(<Strip onSelect={onSelect} />);
    screen.getByRole("tab", { name: "Alpha" }).focus();
    await userEvent.keyboard("x{ArrowDown}");
    expect(onSelect).not.toHaveBeenCalled();
  });
});

function MenuHost(p: { onPick?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Open
      </button>
      {open && (
        <Menu className="drop-menu" label="Things" onClose={() => setOpen(false)}>
          <MenuGroup id="g1" label="First">
            <button role="menuitem" onClick={() => { setOpen(false); p.onPick?.(); }}>
              One
            </button>
            <button role="menuitem" disabled>
              Off
            </button>
            <button role="menuitem">Two</button>
          </MenuGroup>
          <div role="separator" />
          <button role="menuitem">Three</button>
        </Menu>
      )}
    </>
  );
}

describe("Menu", () => {
  it("is a named menu with labelled groups, and focuses its first item on open", async () => {
    render(<MenuHost />);
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByRole("menu", { name: "Things" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "First" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "One" })).toHaveFocus();
  });

  it("moves through enabled items with the arrows, Home and End", async () => {
    render(<MenuHost />);
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    await userEvent.keyboard("{ArrowDown}");
    // "Off" is disabled, so it is skipped.
    expect(screen.getByRole("menuitem", { name: "Two" })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "One" })).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}");
    expect(screen.getByRole("menuitem", { name: "Three" })).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(screen.getByRole("menuitem", { name: "One" })).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(screen.getByRole("menuitem", { name: "Three" })).toHaveFocus();
    await userEvent.keyboard("a");
    expect(screen.getByRole("menuitem", { name: "Three" })).toHaveFocus();
  });

  it("closes on Escape without letting it reach an enclosing handler, and refocuses the opener", async () => {
    const outer = vi.fn();
    render(
      <div onKeyDown={outer}>
        <MenuHost />
      </div>
    );
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    outer.mockClear();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(outer).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Open" })).toHaveFocus();
  });

  it("hands focus back to the opener after an item is picked", async () => {
    const onPick = vi.fn();
    render(<MenuHost onPick={onPick} />);
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    await userEvent.keyboard("{Enter}");
    expect(onPick).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Open" })).toHaveFocus();
  });

  it("ignores arrows when it has no items", async () => {
    render(
      <Menu className="drop-menu" label="Empty" onClose={() => {}}>
        <div>nothing</div>
      </Menu>
    );
    const menu = screen.getByRole("menu", { name: "Empty" });
    menu.tabIndex = -1;
    menu.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(menu).toHaveFocus();
  });
});
