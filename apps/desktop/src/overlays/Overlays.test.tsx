import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ABOUT_LINKS,
  About,
  Cheatsheet,
  ConnLost,
  Guard,
  Inspector,
  ModalHead,
  Overlay,
  Palette,
  ParamPrompt,
  Settings,
  TxPrompt,
  UpdateToast,
  type PaletteItem,
} from "./Overlays";

describe("Overlay", () => {
  it("closes when the backdrop is clicked", async () => {
    const onClose = vi.fn();
    const { container } = render(
      <Overlay onClose={onClose}>
        <div>body</div>
      </Overlay>,
    );
    await userEvent.click(container.querySelector(".overlay")!);
    expect(onClose).toHaveBeenCalled();
  });

  it("does not close when the content itself is clicked", async () => {
    // Clicking inside a dialog must not dismiss it — the classic bug.
    const onClose = vi.fn();
    render(
      <Overlay onClose={onClose}>
        <div>body</div>
      </Overlay>,
    );
    await userEvent.click(screen.getByText("body"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("centres when asked", () => {
    const { container } = render(
      <Overlay onClose={vi.fn()} center>
        <div />
      </Overlay>,
    );
    expect(container.querySelector(".overlay")).toHaveClass("center");
  });
});

describe("Overlay — dialog semantics", () => {
  /*
   * This was a plain div with a click handler. A screen reader was told
   * nothing: no role, no aria-modal, so the modal was announced as some
   * buttons in the page and the background stayed readable as though nothing
   * had opened. Tab walked straight out of it into the page behind, and
   * dismissing it dropped focus at the top of the document.
   *
   * Fixing it once here fixes all 28 overlays.
   */
  it("announces itself as a modal dialog", () => {
    render(
      <Overlay onClose={vi.fn()} label="Settings">
        <button>inside</button>
      </Overlay>,
    );
    const dlg = screen.getByRole("dialog");
    expect(dlg).toHaveAttribute("aria-modal", "true");
    expect(dlg).toHaveAccessibleName("Settings");
  });

  it("closes on Escape, whatever the modal inside does", () => {
    // Escape used to be implemented per-component, so a modal that forgot it
    // simply had no Escape.
    const onClose = vi.fn();
    render(
      <Overlay onClose={onClose}>
        <button>inside</button>
      </Overlay>,
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps Tab inside the dialog", () => {
    render(
      <Overlay onClose={vi.fn()}>
        <button>first</button>
        <button>last</button>
      </Overlay>,
    );
    const last = screen.getByText("last");
    last.focus();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab" });
    expect(screen.getByText("first")).toHaveFocus();
  });

  it("wraps backwards too", () => {
    render(
      <Overlay onClose={vi.fn()}>
        <button>first</button>
        <button>last</button>
      </Overlay>,
    );
    screen.getByText("first").focus();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab", shiftKey: true });
    expect(screen.getByText("last")).toHaveFocus();
  });

  it("gives focus back to whatever opened it", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const { unmount } = render(
      <Overlay onClose={vi.fn()}>
        <button>inside</button>
      </Overlay>,
    );
    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it("puts focus in the dialog rather than leaving it outside", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    render(
      <Overlay onClose={vi.fn()}>
        <button>inside</button>
      </Overlay>,
    );
    expect(screen.getByText("inside")).toHaveFocus();
    opener.remove();
  });
});

describe("ModalHead", () => {
  it("shows the title", () => {
    render(<ModalHead title="Hello" onClose={vi.fn()} />);
    expect(screen.getByText("Hello")).toBeInTheDocument();
  });

  it("gives the close button a real name, not a glyph", () => {
    render(<ModalHead title="x" onClose={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("closes", async () => {
    const onClose = vi.fn();
    render(<ModalHead title="x" onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("Palette", () => {
  const items: PaletteItem[] = [
    { icon: "⛁", label: "Open connection", type: "Action", kbd: "⌘O", exec: vi.fn() },
    { icon: "⚙", label: "Open settings", type: "Action", exec: vi.fn() },
    { icon: "T", label: "users", type: "Table", exec: vi.fn() },
  ];
  const base = {
    items,
    q: "",
    idx: 0,
    onQ: vi.fn(),
    onIdx: vi.fn(),
    onPick: vi.fn(),
    onClose: vi.fn(),
  };

  it("focuses the input so you can type at once", () => {
    render(<Palette {...base} />);
    expect(screen.getByPlaceholderText(/Type a command/)).toHaveFocus();
  });

  it("lists everything with no query", () => {
    render(<Palette {...base} />);
    expect(screen.getByText("Open connection")).toBeInTheDocument();
    expect(screen.getByText("users")).toBeInTheDocument();
  });

  it("filters case-insensitively", () => {
    render(<Palette {...base} q="OPEN" />);
    expect(screen.getByText("Open connection")).toBeInTheDocument();
    expect(screen.queryByText("users")).not.toBeInTheDocument();
  });

  it("says so when nothing matches", () => {
    render(<Palette {...base} q="zzz" />);
    expect(screen.getByText("No matches")).toBeInTheDocument();
  });

  it("shows a shortcut when the item has one", () => {
    render(<Palette {...base} />);
    expect(screen.getByText("⌘O")).toBeInTheDocument();
  });

  it("reports typing and resets the selection to the top", async () => {
    // Without the reset, Enter fires whatever was highlighted for the old
    // query — a different command than the one now on screen.
    const onQ = vi.fn();
    const onIdx = vi.fn();
    render(<Palette {...base} onQ={onQ} onIdx={onIdx} />);
    await userEvent.type(screen.getByRole("textbox"), "u");
    expect(onQ).toHaveBeenCalledWith("u");
    expect(onIdx).toHaveBeenCalledWith(0);
  });

  it("picks on click", async () => {
    const onPick = vi.fn();
    render(<Palette {...base} onPick={onPick} />);
    await userEvent.click(screen.getByText("users"));
    expect(onPick).toHaveBeenCalledWith(items[2]);
  });

  it("picks the highlighted item on Enter", async () => {
    const onPick = vi.fn();
    render(<Palette {...base} idx={1} onPick={onPick} />);
    await userEvent.keyboard("{Enter}");
    expect(onPick).toHaveBeenCalledWith(items[1]);
  });

  it("moves down, stopping at the end", async () => {
    const onIdx = vi.fn();
    render(<Palette {...base} idx={2} onIdx={onIdx} />);
    await userEvent.keyboard("{ArrowDown}");
    expect(onIdx).toHaveBeenCalledWith(2);
  });

  it("moves up, stopping at the top", async () => {
    const onIdx = vi.fn();
    render(<Palette {...base} idx={0} onIdx={onIdx} />);
    await userEvent.keyboard("{ArrowUp}");
    expect(onIdx).toHaveBeenCalledWith(0);
  });

  it("moves the selection with the arrows", async () => {
    const onIdx = vi.fn();
    render(<Palette {...base} idx={0} onIdx={onIdx} />);
    await userEvent.keyboard("{ArrowDown}");
    expect(onIdx).toHaveBeenCalledWith(1);
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(<Palette {...base} onClose={onClose} />);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("clamps a stale index rather than picking undefined", async () => {
    // The filter can shrink the list under an index set for the old one.
    const onPick = vi.fn();
    render(<Palette {...base} q="users" idx={9} onPick={onPick} />);
    await userEvent.keyboard("{Enter}");
    expect(onPick).toHaveBeenCalledWith(items[2]);
  });

  it("does nothing on Enter when nothing matches", async () => {
    const onPick = vi.fn();
    render(<Palette {...base} q="zzz" onPick={onPick} />);
    await userEvent.keyboard("{Enter}");
    expect(onPick).not.toHaveBeenCalled();
  });
});

describe("TxPrompt", () => {
  const base = { onCommit: vi.fn(), onRollback: vi.fn(), onStay: vi.fn() };

  it("says that neither outcome is automatic", () => {
    render(<TxPrompt {...base} />);
    expect(screen.getByText(/will not automatically commit or roll back/)).toBeInTheDocument();
  });

  it("offers all three ways out", async () => {
    const onCommit = vi.fn();
    const onRollback = vi.fn();
    const onStay = vi.fn();
    render(<TxPrompt onCommit={onCommit} onRollback={onRollback} onStay={onStay} />);
    await userEvent.click(screen.getByRole("button", { name: /Commit & disconnect/ }));
    await userEvent.click(screen.getByRole("button", { name: /Rollback & disconnect/ }));
    await userEvent.click(screen.getByRole("button", { name: /Stay connected/ }));
    expect(onCommit).toHaveBeenCalled();
    expect(onRollback).toHaveBeenCalled();
    expect(onStay).toHaveBeenCalled();
  });

  it("treats dismissal as staying, never as a commit", async () => {
    const onStay = vi.fn();
    const { container } = render(<TxPrompt {...base} onStay={onStay} />);
    await userEvent.click(container.querySelector(".overlay")!);
    expect(onStay).toHaveBeenCalled();
  });
});

describe("ParamPrompt", () => {
  const base = {
    count: 2,
    values: ["", ""],
    onChange: vi.fn(),
    onRun: vi.fn(),
    onCancel: vi.fn(),
  };

  it("renders one field per placeholder, labelled $n", () => {
    render(<ParamPrompt {...base} />);
    expect(screen.getByText("$1")).toBeInTheDocument();
    expect(screen.getByText("$2")).toBeInTheDocument();
  });

  it("pluralises the count", () => {
    render(<ParamPrompt {...base} />);
    expect(screen.getByText(/2 placeholders/)).toBeInTheDocument();
  });

  it("stays singular for one", () => {
    render(<ParamPrompt {...base} count={1} values={[""]} />);
    expect(screen.getByText(/1 placeholder\./)).toBeInTheDocument();
  });

  it("reports edits with the index they belong to", async () => {
    const onChange = vi.fn();
    render(<ParamPrompt {...base} onChange={onChange} />);
    await userEvent.type(screen.getAllByRole("textbox")[1], "7");
    expect(onChange).toHaveBeenCalledWith(1, "7");
  });

  it("runs on Enter from a field", async () => {
    const onRun = vi.fn();
    render(<ParamPrompt {...base} onRun={onRun} />);
    await userEvent.type(screen.getAllByRole("textbox")[0], "{Enter}");
    expect(onRun).toHaveBeenCalled();
  });

  it("runs and cancels from the buttons", async () => {
    const onRun = vi.fn();
    const onCancel = vi.fn();
    render(<ParamPrompt {...base} onRun={onRun} onCancel={onCancel} />);
    await userEvent.click(screen.getByRole("button", { name: /Run with values/ }));
    await userEvent.click(screen.getByRole("button", { name: /Cancel/ }));
    expect(onRun).toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });

  it("shows the values it was given", () => {
    render(<ParamPrompt {...base} values={["abc"]} />);
    expect(screen.getAllByRole("textbox")[0]).toHaveValue("abc");
  });
});

describe("Guard", () => {
  const base = { sql: "update t set a=1", onCancel: vi.fn(), onRun: vi.fn() };

  it("names the verb it is guarding — UPDATE", () => {
    render(<Guard {...base} />);
    expect(screen.getByText("UPDATE")).toBeInTheDocument();
  });

  it("names the verb it is guarding — DELETE", () => {
    render(<Guard {...base} sql="  DELETE FROM t" />);
    expect(screen.getByText("DELETE")).toBeInTheDocument();
  });

  it("says every row, and that it cannot be undone", () => {
    render(<Guard {...base} />);
    expect(screen.getByText("every row")).toBeInTheDocument();
    expect(screen.getByText(/cannot be undone/)).toBeInTheDocument();
  });

  it("shows the statement being run", () => {
    render(<Guard {...base} />);
    expect(screen.getByText("update t set a=1")).toBeInTheDocument();
  });

  it("truncates a huge statement rather than filling the screen", () => {
    render(<Guard {...base} sql={"update t set a=1 -- " + "x".repeat(900)} />);
    expect(screen.getByText(/^update/).textContent!.length).toBe(400);
  });

  it("makes cancel the plain button and running the loud one", () => {
    render(<Guard {...base} />);
    expect(screen.getByRole("button", { name: "Run anyway" })).toHaveClass("danger");
    expect(screen.getByRole("button", { name: "Cancel" })).not.toHaveClass("danger");
  });

  it("cancels on dismissal, rather than running", async () => {
    const onCancel = vi.fn();
    const onRun = vi.fn();
    const { container } = render(<Guard {...base} onCancel={onCancel} onRun={onRun} />);
    await userEvent.click(container.querySelector(".overlay")!);
    expect(onCancel).toHaveBeenCalled();
    expect(onRun).not.toHaveBeenCalled();
  });

  it("runs when explicitly confirmed", async () => {
    const onRun = vi.fn();
    render(<Guard {...base} onRun={onRun} />);
    await userEvent.click(screen.getByRole("button", { name: "Run anyway" }));
    expect(onRun).toHaveBeenCalled();
  });
});

describe("ConnLost", () => {
  const base = { detail: "", onReconnect: vi.fn(), onClose: vi.fn() };

  it("promises nothing was re-run", () => {
    render(<ConnLost {...base} />);
    expect(screen.getByText(/nothing was re-run/)).toBeInTheDocument();
  });

  it("prefers the server's own explanation when there is one", () => {
    render(<ConnLost {...base} detail="terminated by administrator" />);
    expect(screen.getByText("terminated by administrator")).toBeInTheDocument();
    expect(screen.queryByText(/nothing was re-run/)).not.toBeInTheDocument();
  });

  it("reconnects and dismisses", async () => {
    const onReconnect = vi.fn();
    const onClose = vi.fn();
    render(<ConnLost {...base} onReconnect={onReconnect} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onReconnect).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});

describe("Settings", () => {
  const base = {
    theme: "dark" as const,
    telemetry: false,
    onTheme: vi.fn(),
    onTelemetry: vi.fn(),
    onClose: vi.fn(),
  };

  it("marks the current theme", () => {
    render(<Settings {...base} />);
    expect(screen.getByRole("button", { name: "Dark" })).toHaveClass("on");
    expect(screen.getByRole("button", { name: "Light" })).not.toHaveClass("on");
  });

  it("switches theme", async () => {
    const onTheme = vi.fn();
    render(<Settings {...base} onTheme={onTheme} />);
    await userEvent.click(screen.getByRole("button", { name: "Light" }));
    expect(onTheme).toHaveBeenCalledWith("light");
  });

  it("marks light when that is the theme", () => {
    render(<Settings {...base} theme="light" />);
    expect(screen.getByRole("button", { name: "Light" })).toHaveClass("on");
  });

  it("toggles telemetry both ways", async () => {
    const onTelemetry = vi.fn();
    const { container, rerender } = render(<Settings {...base} onTelemetry={onTelemetry} />);
    await userEvent.click(container.querySelector(".toggle")!);
    expect(onTelemetry).toHaveBeenCalledWith(true);
    rerender(<Settings {...base} telemetry onTelemetry={onTelemetry} />);
    await userEvent.click(container.querySelector(".toggle")!);
    expect(onTelemetry).toHaveBeenLastCalledWith(false);
  });

  it("shows telemetry as on when it is", () => {
    const { container } = render(<Settings {...base} telemetry />);
    expect(container.querySelector(".toggle")).toHaveClass("on");
  });

  it("promises no query text leaves the device", () => {
    render(<Settings {...base} />);
    expect(screen.getByText(/No query text or data ever leaves the device/)).toBeInTheDocument();
  });

  it("closes", async () => {
    const onClose = vi.fn();
    render(<Settings {...base} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("About", () => {
  it("shows the version and the OS it is running on", () => {
    render(<About version="0.1.0" os="macos" onClose={vi.fn()} />);
    // "macos" is what Rust's std::env::consts::OS returns; nobody writes it
    // that way.
    expect(screen.getByText("Version 0.1.0 · macOS")).toBeInTheDocument();
  });

  it("names each platform the way that platform does", () => {
    const { rerender } = render(<About version="0.1.0" os="windows" onClose={vi.fn()} />);
    expect(screen.getByText("Version 0.1.0 · Windows")).toBeInTheDocument();
    rerender(<About version="0.1.0" os="linux" onClose={vi.fn()} />);
    expect(screen.getByText("Version 0.1.0 · Linux")).toBeInTheDocument();
  });

  it("survives app_get_info not having answered yet", () => {
    // The version comes over IPC, so the first render has neither field.
    render(<About version="" os="" onClose={vi.fn()} />);
    expect(screen.getByText("Version —")).toBeInTheDocument();
  });

  it("credits the author, Claude and VS Code", () => {
    render(<About version="0.1.0" os="macos" onClose={vi.fn()} />);
    expect(screen.getByText("Talaat Magdy")).toBeInTheDocument();
    expect(screen.getByText("github.com/talaatmagdyx")).toBeInTheDocument();
    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(screen.getByText("Inspired by Visual Studio Code")).toBeInTheDocument();
  });

  it("opens links in the real browser, not in the app's own webview", async () => {
    // The whole point of routing through the opener plugin: an <a href> would
    // navigate this webview and the app would be gone with no way back.
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    render(<About version="0.1.0" os="macos" onClose={vi.fn()} />);

    await userEvent.click(screen.getByText("github.com/talaatmagdyx"));
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://github.com/talaatmagdyx"));

    await userEvent.click(screen.getByText("claude.com"));
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://claude.com"));
  });

  it("only ever opens URLs the capability file allows", async () => {
    // These two must match capabilities/default.json. A URL in one and not the
    // other is rejected at runtime, which no type check would catch.
    const allowed = ["https://github.com/talaatmagdyx", "https://claude.com"];
    expect(Object.values(ABOUT_LINKS).sort()).toEqual([...allowed].sort());
  });

  it("stays quiet when there is no browser to open", async () => {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    vi.mocked(openUrl).mockRejectedValueOnce(new Error("no handler"));
    render(<About version="0.1.0" os="macos" onClose={vi.fn()} />);
    // An About box is not worth an error dialog; the handle is written out in
    // full beside the link, so it is still copyable.
    await userEvent.click(screen.getByText("github.com/talaatmagdyx"));
    expect(screen.getByText("github.com/talaatmagdyx")).toBeInTheDocument();
  });

  it("closes", async () => {
    const onClose = vi.fn();
    render(<About version="0.1.0" os="macos" onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("Cheatsheet", () => {
  /** Say which keyboard we mean rather than inheriting jsdom's. */
  const platform = (value: string) => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(value);
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("");
  };

  // Nothing else in this file restores mocks, and a stubbed navigator that
  // outlives its test is a leak into whatever runs next.
  afterEach(() => vi.restoreAllMocks());

  it("lists the shortcuts with their keys", () => {
    platform("MacIntel");
    render(<Cheatsheet onClose={vi.fn()} />);
    expect(screen.getByText("Run query")).toBeInTheDocument();
    expect(screen.getByText("⌘↵")).toBeInTheDocument();
    expect(screen.getByText("Command palette")).toBeInTheDocument();
  });

  it("names keys a Windows keyboard actually has", () => {
    // The cheatsheet is the one screen whose entire job is telling you what to
    // press. Printing ⌘ to someone without a ⌘ key is the whole bug.
    platform("Win32");
    render(<Cheatsheet onClose={vi.fn()} />);
    expect(screen.getByText("Ctrl+Enter")).toBeInTheDocument();
    expect(screen.getByText("Ctrl+Shift+F")).toBeInTheDocument();
    expect(screen.queryByText(/⌘/)).not.toBeInTheDocument();
  });

  it("closes", async () => {
    const onClose = vi.fn();
    render(<Cheatsheet onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("UpdateToast", () => {
  const base = { version: "0.2.0", notes: "faster", onUpdate: vi.fn(), onDismiss: vi.fn() };

  it("names the version and the notes", () => {
    render(<UpdateToast {...base} />);
    expect(screen.getByText(/TupleNest 0\.2\.0 is ready to install/)).toBeInTheDocument();
    expect(screen.getByText("faster")).toBeInTheDocument();
  });

  it("updates and dismisses", async () => {
    const onUpdate = vi.fn();
    const onDismiss = vi.fn();
    render(<UpdateToast {...base} onUpdate={onUpdate} onDismiss={onDismiss} />);
    await userEvent.click(screen.getByRole("button", { name: "Restart & update" }));
    await userEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(onUpdate).toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalled();
  });

  it("locks both buttons while updating, so a restart cannot be double-fired", () => {
    render(<UpdateToast {...base} busy />);
    expect(screen.getByRole("button", { name: "Updating…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Later" })).toBeDisabled();
  });

  it("dismisses from the x", async () => {
    const onDismiss = vi.fn();
    const { container } = render(<UpdateToast {...base} onDismiss={onDismiss} />);
    await userEvent.click(container.querySelector(".ut-head .x")!);
    expect(onDismiss).toHaveBeenCalled();
  });
});

describe("Inspector", () => {
  it("pretty-prints JSON", () => {
    render(<Inspector text='{"a":1}' onClose={vi.fn()} />);
    expect(screen.getByText(/"a": 1/)).toBeInTheDocument();
  });

  it("shows non-JSON verbatim rather than erroring", () => {
    render(<Inspector text="not json at all" onClose={vi.fn()} />);
    expect(screen.getByText("not json at all")).toBeInTheDocument();
  });

  it("names the column when it knows it", () => {
    render(<Inspector text="{}" colName="payload" onClose={vi.fn()} />);
    expect(screen.getByText(/payload/)).toBeInTheDocument();
  });

  it("falls back to a generic label", () => {
    render(<Inspector text="{}" onClose={vi.fn()} />);
    expect(screen.getByText(/cell value/)).toBeInTheDocument();
  });

  it("closes", async () => {
    const onClose = vi.fn();
    render(<Inspector text="{}" onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });
});
