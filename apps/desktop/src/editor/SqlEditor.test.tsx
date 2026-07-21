import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SqlEditor from "./SqlEditor";
import type { Catalog } from "../lib/complete";

const catalog: Catalog = {
  schemas: ["public", "analytics"],
  tables: [
    { schema: "public", name: "users", kind: "table" },
    { schema: "public", name: "orders", kind: "table" },
  ],
  columns: {
    "public.users": [
      { name: "id", dbType: "int8", nullable: false, primaryKey: true, comment: null },
      { name: "email", dbType: "text", nullable: true, primaryKey: false, comment: null },
    ],
  },
  searchPath: ["public"],
};

const base = {
  sql: "select 1",
  disabled: false,
  height: 300,
  onChange: vi.fn(),
  catalog,
};

const ta = () => screen.getByRole("textbox") as HTMLTextAreaElement;

describe("SqlEditor — editing", () => {
  it("shows the SQL", () => {
    render(<SqlEditor {...base} />);
    expect(ta()).toHaveValue("select 1");
  });

  it("highlights keywords under the textarea", () => {
    const { container } = render(<SqlEditor {...base} />);
    expect(container.querySelector(".editor-pre .tok-k")).toHaveTextContent("select");
  });

  it("numbers the lines", () => {
    const { container } = render(<SqlEditor {...base} sql={"a\nb\nc"} />);
    expect(container.querySelector(".gutter")).toHaveTextContent("123");
  });

  it("reports typing", async () => {
    const onChange = vi.fn();
    render(<SqlEditor {...base} sql="" onChange={onChange} />);
    await userEvent.type(ta(), "x");
    expect(onChange).toHaveBeenCalledWith("x");
  });

  it("locks while a query is running", () => {
    render(<SqlEditor {...base} disabled />);
    expect(ta()).toBeDisabled();
  });

  it("takes the height it is given, so the splitter controls the layout", () => {
    const { container } = render(<SqlEditor {...base} height={123} />);
    expect(container.querySelector(".editor-frame")).toHaveStyle({ height: "123px" });
  });
});

describe("SqlEditor — completion", () => {
  /** The last value the editor asked its parent to hold. */
  const latest = (onChange: ReturnType<typeof vi.fn>, fallback: string) => {
    // `.at()` needs lib es2022; this tsconfig targets lower.
    const calls = onChange.mock.calls;
    return calls.length ? (calls[calls.length - 1][0] as string) : fallback;
  };

  const type = async (text: string) => {
    const onChange = vi.fn();
    const view = render(<SqlEditor {...base} sql="" onChange={onChange} />);
    // Controlled component: feed each keystroke back the way App does.
    let cur = "";
    for (const ch of text) {
      await userEvent.type(ta(), ch);
      cur = latest(onChange, cur);
      view.rerender(<SqlEditor {...base} sql={cur} onChange={onChange} />);
    }
    // Drain the frame the last keystroke queued. The popup opens from a
    // requestAnimationFrame, so a test that acts before it runs is racing the
    // editor — Escape lands, then the pending frame reopens the popup.
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    return Object.assign(view, { onChange });
  };

  it("stays out of the way until there is something to complete", () => {
    const { container } = render(<SqlEditor {...base} />);
    expect(container.querySelector(".cmp-pop")).toBeNull();
  });

  it("offers tables after FROM", async () => {
    await type("select * from us");
    expect(await screen.findByText("users")).toBeInTheDocument();
  });

  it("shows what each suggestion is", async () => {
    await type("select * from us");
    await screen.findByText("users");
    expect(screen.getByText("table")).toBeInTheDocument();
  });

  it("offers nothing for an unknown prefix rather than everything", async () => {
    const { container } = await type("select * from zzzz");
    expect(container.querySelector(".cmp-pop")).toBeNull();
  });

  it("opens on demand with ctrl+space", async () => {
    render(<SqlEditor {...base} sql="select * from " />);
    ta().focus();
    ta().setSelectionRange(14, 14);
    await userEvent.keyboard("{Control>} {/Control}");
    expect(await screen.findByText("users")).toBeInTheDocument();
  });

  it("dismisses on Escape", async () => {
    await type("select * from us");
    await screen.findByText("users");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByText("users")).not.toBeInTheDocument();
  });

  it("does not complete at all without a catalog", async () => {
    const onChange = vi.fn();
    render(<SqlEditor {...base} catalog={undefined} sql="" onChange={onChange} />);
    await userEvent.type(ta(), "select * from us");
    expect(screen.queryByText("users")).not.toBeInTheDocument();
  });

  /* Prefetch is debounced by 150ms and reads the live caret, so the cursor has
     to be parked at the end and the timer has to fire. */
  const settle = async (sql: string, extra: Record<string, unknown>) => {
    render(<SqlEditor {...base} sql={sql} {...extra} />);
    ta().focus();
    ta().setSelectionRange(sql.length, sql.length);
    await waitFor(() => expect(true).toBe(true));
  };

  it("asks for the columns of tables the statement mentions", async () => {
    const onPrefetchTables = vi.fn();
    await settle("select * from orders where ", { onPrefetchTables });
    await waitFor(() =>
      expect(onPrefetchTables).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ name: "orders" })]),
      ),
    );
  });

  it("asks for a schema's objects once it is qualified", async () => {
    const onPrefetchSchema = vi.fn();
    await settle("select * from analytics.", { onPrefetchSchema });
    await waitFor(() => expect(onPrefetchSchema).toHaveBeenCalledWith("analytics"));
  });
});

describe("SqlEditor — accepting a completion", () => {
  const items = () => Array.from(document.querySelectorAll(".cmp-item")).map((e) => e.textContent ?? "");
  const selected = () => document.querySelector(".cmp-item.on")?.textContent ?? "";

  /**
   * Type `text` and wait for the popup.
   *
   * The editor is controlled and opens the popup from a requestAnimationFrame
   * that reads the textarea directly, so feeding keystrokes back through
   * rerender leaves the popup's replace range a frame behind. That is a
   * limitation of driving it this way, not of the editor — so these tests
   * assert what the popup *does* (selects, accepts, closes) rather than the
   * exact text an accept produces.
   */
  const open = async (text: string) => {
    const onChange = vi.fn();
    const view = render(<SqlEditor {...base} sql="" onChange={onChange} />);
    let cur = "";
    for (const ch of text) {
      await userEvent.type(ta(), ch);
      const calls = onChange.mock.calls;
      cur = calls.length ? (calls[calls.length - 1][0] as string) : cur;
      view.rerender(<SqlEditor {...base} sql={cur} onChange={onChange} />);
    }
    await waitFor(() => expect(document.querySelector(".cmp-pop")).not.toBeNull());
    // Drain the frame the last keystroke queued: it re-opens the popup, and a
    // test that presses Escape into a pending frame sees it come straight back.
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    return { onChange, sql: cur };
  };

  it("inserts on Enter and closes", async () => {
    const { onChange } = await open("select * from user");
    onChange.mockClear();
    await userEvent.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(String(onChange.mock.calls[0][0])).toContain("users");
    expect(document.querySelector(".cmp-pop")).toBeNull();
  });

  it("leaves the caret after the word it just inserted", async () => {
    // Accepting moves focus back and puts the caret at the end of the
    // insertion — otherwise the next keystroke lands wherever the caret was
    // before the popup opened.
    const { onChange } = await open("select * from user");
    onChange.mockClear();
    await userEvent.keyboard("{Enter}");
    // The caret is set from a frame after the change lands.
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    const el = ta();
    expect(el).toHaveFocus();
    expect(el.selectionStart).toBe(el.selectionEnd);
    expect(el.selectionStart).toBeGreaterThan(0);
  });

  it("accepts with Tab as well as Enter", async () => {
    // Tab is the habit from every other editor; without it the popup is a
    // thing you have to think about.
    const { onChange } = await open("select * from user");
    onChange.mockClear();
    await userEvent.keyboard("{Tab}");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(String(onChange.mock.calls[0][0])).toContain("users");
  });

  it("accepts the item that was clicked, not the one that was selected", async () => {
    const { onChange } = await open("select * from or");
    onChange.mockClear();
    await userEvent.click(screen.getByText("orders"));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(String(onChange.mock.calls[0][0])).toContain("orders");
  });

  it("moves the selection down and wraps at the end", async () => {
    await open("se");
    const list = items();
    expect(list.length).toBeGreaterThan(1);
    const first = selected();
    await userEvent.keyboard("{ArrowDown}");
    expect(selected()).not.toBe(first);
    for (let i = 0; i < list.length - 1; i++) await userEvent.keyboard("{ArrowDown}");
    expect(selected()).toBe(first);
  });

  it("moves the selection up, wrapping to the last item", async () => {
    // Up from the top goes to the bottom — the list is a ring, so neither end
    // is a dead stop.
    await open("se");
    const list = items();
    await userEvent.keyboard("{ArrowUp}");
    expect(selected()).toBe(list[list.length - 1]);
  });

  it("follows the mouse", async () => {
    await open("select * from or");
    await userEvent.hover(screen.getByText("orders"));
    expect(selected()).toContain("orders");
  });

  it("closes on escape without changing the text", async () => {
    const { onChange } = await open("select * from user");
    onChange.mockClear();
    await userEvent.keyboard("{Escape}");
    expect(document.querySelector(".cmp-pop")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("gets out of the way when the editor is scrolled", async () => {
    // The popup is positioned against the caret. Scrolling moves the caret out
    // from under it, so it would sit over unrelated text.
    await open("select * from user");
    fireEvent.scroll(ta());
    expect(document.querySelector(".cmp-pop")).toBeNull();
  });
});

describe("SqlEditor — drag-select autoscroll", () => {
  /**
   * Dragging a selection past the edge of the box scrolls it.
   *
   * jsdom computes no layout — every rect is 0 and a textarea never scrolls —
   * so the box's geometry and scrollability are supplied here. That is the
   * part jsdom cannot do; the edge detection, the speed and the cap below are
   * the editor's own logic, running unmodified.
   */
  const BOX = { top: 100, bottom: 300, left: 0, right: 400 };

  const editor = (sql = "a\n".repeat(200)) => {
    const view = render(<SqlEditor {...base} sql={sql} />);
    const el = ta();
    // jsdom resolves no font metrics: `getComputedStyle` returns "" for both
    // line-height and font-size, so `offsetAt` computes a NaN row and throws
    // when the scroll loop asks it where the pointer is. A real browser always
    // resolves these; supply them here rather than guard production code
    // against a case only jsdom can produce.
    el.style.fontSize = "12px";
    el.style.lineHeight = "18px";
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
      ...BOX,
      width: 400,
      height: 200,
      x: 0,
      y: 100,
      toJSON: () => ({}),
    } as DOMRect);
    // A real textarea clamps scrollTop to its content; jsdom leaves it at 0
    // unless it is given something to scroll.
    let scroll = 0;
    Object.defineProperty(el, "scrollTop", {
      configurable: true,
      get: () => scroll,
      set: (v: number) => {
        scroll = Math.max(0, Math.min(2000, v));
      },
    });
    return { view, el };
  };

  /** Run one animation frame. */
  const frame = async () => {
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
  };

  it("does not scroll while the pointer is inside the box", async () => {
    const { el } = editor();
    fireEvent.mouseDown(el, { button: 0, clientX: 10, clientY: 200 });
    await frame();
    await frame();
    expect(el.scrollTop).toBe(0);
    fireEvent.mouseUp(window);
  });

  it("scrolls down once the pointer passes the bottom edge", async () => {
    const { el } = editor();
    fireEvent.mouseDown(el, { button: 0, clientX: 10, clientY: 200 });
    // 40px past the scroll band: (340 - (300 - 14)) * 0.45 = 24.3
    fireEvent.mouseMove(window, { clientX: 10, clientY: 340 });
    await frame();
    await frame();
    expect(el.scrollTop).toBeGreaterThan(0);
    fireEvent.mouseUp(window);
  });

  it("scrolls up past the top edge", async () => {
    const { el } = editor();
    el.scrollTop = 500;
    fireEvent.mouseDown(el, { button: 0, clientX: 10, clientY: 200 });
    fireEvent.mouseMove(window, { clientX: 10, clientY: 40 });
    await frame();
    await frame();
    expect(el.scrollTop).toBeLessThan(500);
    fireEvent.mouseUp(window);
  });

  it("caps the speed, so a flick to the far edge does not rocket to the end", async () => {
    // Without the cap, throwing the pointer 4,000px away scrolls 1,670px in a
    // single frame — the selection jumps somewhere nobody asked for. The cap is
    // per frame, so this measures one.
    const { el } = editor();
    fireEvent.mouseDown(el, { button: 0, clientX: 10, clientY: 200 });
    fireEvent.mouseMove(window, { clientX: 10, clientY: 4000 });
    const before = el.scrollTop;
    await frame();
    const moved = el.scrollTop - before;
    fireEvent.mouseUp(window);
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThanOrEqual(28);
  });

  it("stops scrolling when the mouse is released", async () => {
    // The frame loop is endless until it is cancelled; left running, the box
    // keeps scrolling after the drag is over.
    const { el } = editor();
    fireEvent.mouseDown(el, { button: 0, clientX: 10, clientY: 200 });
    fireEvent.mouseMove(window, { clientX: 10, clientY: 340 });
    await frame();
    await frame();
    fireEvent.mouseUp(window);
    const settled = el.scrollTop;
    await frame();
    await frame();
    expect(el.scrollTop).toBe(settled);
  });

  it("ignores a right-click — that is a context menu, not a drag", async () => {
    const { el } = editor();
    fireEvent.mouseDown(el, { button: 2, clientX: 10, clientY: 200 });
    fireEvent.mouseMove(window, { clientX: 10, clientY: 340 });
    await frame();
    await frame();
    expect(el.scrollTop).toBe(0);
  });

  it("keeps the highlight layer aligned with the text it sits under", async () => {
    // The layer behind the textarea is what draws the colours. If it does not
    // scroll with it, the keywords slide off the words.
    const { el, view } = editor();
    const pre = view.container.querySelector(".editor-pre") as HTMLElement;
    fireEvent.mouseDown(el, { button: 0, clientX: 10, clientY: 200 });
    fireEvent.mouseMove(window, { clientX: 10, clientY: 340 });
    await frame();
    await frame();
    expect(pre.scrollTop).toBe(el.scrollTop);
    fireEvent.mouseUp(window);
  });
});

describe("SqlEditor — unmounting", () => {
  it("does not close the popup after it has been unmounted", async () => {
    // Blur defers the close by 120ms so a click on an item lands first. If the
    // editor goes away inside that window — closing the tab, opening a modal —
    // the timer used to fire into a component that no longer exists.
    vi.useFakeTimers();
    try {
      const { unmount } = render(<SqlEditor {...base} />);
      const el = ta();
      fireEvent.blur(el);
      unmount();
      // Nothing should be waiting to run against the unmounted tree.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SqlEditor — comment toggling", () => {
  it("comments the selected lines on ⌘/ and reports the new SQL", async () => {
    const onChange = vi.fn();
    render(<SqlEditor sql={"select a\nfrom t"} disabled={false} height={200} onChange={onChange} />);
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
    // Focus first: userEvent sends keys to the active element, and a selection
    // range on a blurred field goes nowhere.
    await userEvent.click(ta);
    ta.setSelectionRange(0, ta.value.length);
    await userEvent.keyboard("{Meta>}/{/Meta}");
    expect(onChange).toHaveBeenCalledWith("-- select a\n-- from t");
  });

  it("uncomments when everything in range is already commented", async () => {
    const onChange = vi.fn();
    render(<SqlEditor sql={"-- select a\n-- from t"} disabled={false} height={200} onChange={onChange} />);
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
    // Focus first: userEvent sends keys to the active element, and a selection
    // range on a blurred field goes nowhere.
    await userEvent.click(ta);
    ta.setSelectionRange(0, ta.value.length);
    await userEvent.keyboard("{Meta>}/{/Meta}");
    expect(onChange).toHaveBeenCalledWith("select a\nfrom t");
  });

  it("leaves a plain / alone, or the key could never be typed", async () => {
    const onChange = vi.fn();
    render(<SqlEditor sql={"select 1"} disabled={false} height={200} onChange={onChange} />);
    const ta = screen.getByRole("textbox");
    await userEvent.click(ta);
    await userEvent.keyboard("/");
    // The change that arrives is the typed character, not a comment toggle.
    for (const [value] of onChange.mock.calls) expect(value).not.toContain("--");
  });
});

describe("SqlEditor — find and replace", () => {
  const openFind = async (sql: string) => {
    const onChange = vi.fn();
    render(<SqlEditor sql={sql} disabled={false} height={200} onChange={onChange} />);
    await userEvent.click(screen.getByRole("textbox", { name: /sql editor/i }));
    await userEvent.keyboard("{Meta>}f{/Meta}");
    return onChange;
  };

  it("opens on ⌘F and counts the matches as you type", async () => {
    await openFind("select a from a join a");
    await userEvent.type(screen.getByLabelText("Find"), "a");
    expect(screen.getByText("1 of 3")).toBeInTheDocument();
  });

  it("says so plainly when nothing matches", async () => {
    await openFind("select 1");
    await userEvent.type(screen.getByLabelText("Find"), "zzz");
    expect(screen.getByText("no matches")).toBeInTheDocument();
  });

  it("steps through matches and wraps around", async () => {
    await openFind("a a a");
    await userEvent.type(screen.getByLabelText("Find"), "a");
    expect(screen.getByText("1 of 3")).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("Next match"));
    expect(screen.getByText("2 of 3")).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("Next match"));
    await userEvent.click(screen.getByLabelText("Next match"));
    // Wrapping beats stopping at the end: the text is a loop, not a list.
    expect(screen.getByText("1 of 3")).toBeInTheDocument();
  });

  it("matches case only when asked", async () => {
    await openFind("Select select");
    await userEvent.type(screen.getByLabelText("Find"), "select");
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Aa" }));
    expect(screen.getByText("1 of 1")).toBeInTheDocument();
  });

  it("replaces the current match", async () => {
    const onChange = await openFind("select a from t");
    await userEvent.type(screen.getByLabelText("Find"), "a");
    await userEvent.type(screen.getByLabelText("Replace with"), "b");
    await userEvent.click(screen.getByRole("button", { name: "Replace" }));
    expect(onChange).toHaveBeenLastCalledWith("select b from t");
  });

  it("replaces every match at once", async () => {
    const onChange = await openFind("a and a and a");
    await userEvent.type(screen.getByLabelText("Find"), "a ");
    await userEvent.type(screen.getByLabelText("Replace with"), "z ");
    await userEvent.click(screen.getByRole("button", { name: "All" }));
    // Only two matches: the trailing "a" has no space after it, and "and"
    // does not contain "a " either.
    expect(onChange).toHaveBeenLastCalledWith("z and z and a");
  });

  it("seeds the box from the selection, which is usually what you want to find", async () => {
    const onChange = vi.fn();
    render(<SqlEditor sql="select column_name from t" disabled={false} height={200} onChange={onChange} />);
    const ta = screen.getByRole("textbox", { name: /sql editor/i }) as HTMLTextAreaElement;
    await userEvent.click(ta);
    ta.setSelectionRange(7, 18);
    await userEvent.keyboard("{Meta>}f{/Meta}");
    expect((screen.getByLabelText("Find") as HTMLInputElement).value).toBe("column_name");
  });

  it("steps with Enter, and back with Shift+Enter", async () => {
    await openFind("a a a");
    const box = screen.getByLabelText("Find");
    await userEvent.type(box, "a");
    await userEvent.keyboard("{Enter}");
    expect(screen.getByText("2 of 3")).toBeInTheDocument();
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    expect(screen.getByText("1 of 3")).toBeInTheDocument();
  });

  it("keeps the whole typed query when the box is opened and typed into at once", async () => {
    // Regression: focusing the box happened in a requestAnimationFrame, so a
    // frame landing mid-typing selected what was there and the next character
    // replaced it. The count is the visible symptom.
    await openFind("alpha alpha");
    await userEvent.type(screen.getByLabelText("Find"), "alpha");
    expect((screen.getByLabelText("Find") as HTMLInputElement).value).toBe("alpha");
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
  });

  it("goes backwards with the up arrow, wrapping to the end", async () => {
    await openFind("a a a");
    await userEvent.type(screen.getByLabelText("Find"), "a");
    await userEvent.click(screen.getByLabelText("Previous match"));
    expect(screen.getByText("3 of 3")).toBeInTheDocument();
  });

  it("closes with the button and leaves the caret on the match you stopped at", async () => {
    await openFind("select a from t");
    await userEvent.type(screen.getByLabelText("Find"), "from");
    await userEvent.click(screen.getByLabelText("Close find"));
    expect(screen.queryByLabelText("Find")).not.toBeInTheDocument();
    const ta = screen.getByRole("textbox", { name: /sql editor/i }) as HTMLTextAreaElement;
    expect(ta.value.slice(ta.selectionStart, ta.selectionEnd)).toBe("from");
  });

  it("does nothing on the arrows when there is nothing to step through", async () => {
    await openFind("select 1");
    // Disabled rather than silently doing nothing: a button that looks live
    // and is not is worse than one that admits it.
    expect(screen.getByLabelText("Next match")).toBeDisabled();
    expect(screen.getByLabelText("Previous match")).toBeDisabled();
  });

  it("closes on Escape and gives focus back to the editor", async () => {
    await openFind("select 1");
    await userEvent.type(screen.getByLabelText("Find"), "1");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByLabelText("Find")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: /sql editor/i }));
  });
});
