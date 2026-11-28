import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  About,
  Cheatsheet,
  ConnLost,
  DialogTitle,
  Guard,
  Inspector,
  ModalHead,
  NamePrompt,
  Overlay,
  Palette,
  ParamPrompt,
  Settings,
  TxPrompt,
  type PaletteItem,
} from "./Overlays";

/**
 * Every dialog is announced by the title already on screen. Before, only the
 * three modals that passed a hand-typed `label` had a name at all — the rest
 * were read out as "dialog" and nothing more.
 */
describe("dialog names", () => {
  it("names a ModalHead dialog by its title, through aria-labelledby", () => {
    render(<Settings theme="dark" onTheme={vi.fn()} onClose={vi.fn()} />);
    const dlg = screen.getByRole("dialog", { name: "Settings" });
    expect(dlg).toHaveAttribute("aria-modal", "true");
    const title = document.getElementById(dlg.getAttribute("aria-labelledby")!);
    expect(title).toHaveTextContent("Settings");
  });

  it.each([
    ["About TupleNest", () => <About version="1.0" os="macos" onClose={vi.fn()} />],
    ["Keyboard shortcuts", () => <Cheatsheet onClose={vi.fn()} />],
    ["Bind query parameters", () => <ParamPrompt count={1} values={[]} onChange={vi.fn()} onRun={vi.fn()} onCancel={vi.fn()} />],
    [
      "Name this snippet",
      () => (
        <NamePrompt title="Name this snippet" label="Name" value="" onChange={vi.fn()} onSave={vi.fn()} onCancel={vi.fn()} />
      ),
    ],
    ["JSONB payload", () => <Inspector text="{}" colName="payload" onClose={vi.fn()} />],
  ])("names %s", (name, el) => {
    render(el());
    expect(screen.getByRole("dialog", { name })).toBeInTheDocument();
  });

  it("gives each open dialog its own title id", () => {
    render(
      <>
        <Overlay onClose={vi.fn()}>
          <ModalHead title="First" onClose={vi.fn()} />
        </Overlay>
        <Overlay onClose={vi.fn()}>
          <DialogTitle>Second</DialogTitle>
        </Overlay>
      </>
    );
    const a = screen.getByRole("dialog", { name: "First" });
    const b = screen.getByRole("dialog", { name: "Second" });
    expect(a.getAttribute("aria-labelledby")).not.toBe(b.getAttribute("aria-labelledby"));
  });

  it("uses an explicit label, and no labelledby, when one is given", () => {
    render(
      <Overlay onClose={vi.fn()} label="Bare">
        <button>ok</button>
      </Overlay>
    );
    const dlg = screen.getByRole("dialog", { name: "Bare" });
    expect(dlg).not.toHaveAttribute("aria-labelledby");
  });

  it("can disable the close button while an operation must finish", () => {
    render(
      <Overlay onClose={vi.fn()}>
        <ModalHead title="Busy" onClose={vi.fn()} closeDisabled />
      </Overlay>
    );
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
  });
});

describe("confirmations are alertdialogs", () => {
  it("the open-transaction prompt", () => {
    render(<TxPrompt onCommit={vi.fn()} onRollback={vi.fn()} onStay={vi.fn()} />);
    const dlg = screen.getByRole("alertdialog", { name: "You have an open transaction" });
    expect(dlg).toHaveAttribute("aria-modal", "true");
  });

  it("the destructive-statement guard", () => {
    render(<Guard sql="delete from users" env="prod" onCancel={vi.fn()} onRun={vi.fn()} />);
    expect(screen.getByRole("alertdialog", { name: /^Confirm this DELETE on production$/i })).toBeInTheDocument();
  });

  it("the connection-lost notice", () => {
    render(<ConnLost detail="" onReconnect={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole("alertdialog", { name: "Connection lost" })).toBeInTheDocument();
  });
});

describe("Overlay focus trap", () => {
  it("does not count tabindex=-1 buttons as a stop, so Tab wraps from the real last one", () => {
    render(
      <Overlay onClose={vi.fn()} label="Trap">
        <input aria-label="first" />
        <button>last</button>
        <button tabIndex={-1}>parked</button>
      </Overlay>
    );
    const last = screen.getByRole("button", { name: "last" });
    last.focus();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab" });
    expect(screen.getByRole("textbox", { name: "first" })).toHaveFocus();
  });
});

describe("Palette as a combobox", () => {
  const items: PaletteItem[] = [
    { icon: "⛁", label: "Open connection", type: "Action", exec: vi.fn() },
    { icon: "T", label: "users", type: "Table", exec: vi.fn() },
  ];
  const base = { items, q: "", idx: 1, onQ: vi.fn(), onIdx: vi.fn(), onPick: vi.fn(), onClose: vi.fn() };

  it("is a named dialog", () => {
    render(<Palette {...base} />);
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
  });

  it("points the input at the highlighted option", () => {
    render(<Palette {...base} />);
    const input = screen.getByRole("combobox", { name: "Search commands and tables" });
    const list = screen.getByRole("listbox", { name: "Commands and tables" });
    expect(input).toHaveAttribute("aria-controls", list.id);
    const active = screen.getByRole("option", { name: /users/ });
    expect(active).toHaveAttribute("aria-selected", "true");
    expect(input).toHaveAttribute("aria-activedescendant", active.id);
    expect(screen.getByRole("option", { name: /Open connection/ })).toHaveAttribute("aria-selected", "false");
  });

  it("keeps the options out of the tab order", () => {
    render(<Palette {...base} />);
    for (const o of screen.getAllByRole("option")) expect(o).toHaveAttribute("tabindex", "-1");
  });

  it("has no active descendant when nothing matches", () => {
    render(<Palette {...base} q="zzz" />);
    expect(screen.getByRole("combobox")).not.toHaveAttribute("aria-activedescendant");
    expect(screen.getByRole("option", { name: "No matches" })).toHaveAttribute("aria-disabled", "true");
  });
});

describe("Settings theme switch", () => {
  it("says which theme is on", () => {
    render(<Settings theme="light" onTheme={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Light" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "false");
  });
});
