import { describe, expect, it } from "vitest";
import { SHORTCUTS, matchShortcut, type ShortcutId } from "./shortcuts";

/** A keydown, close enough for the matchers. */
const ev = (key: string, over: Partial<KeyboardEvent> = {}) =>
  ({ key, metaKey: false, ctrlKey: false, shiftKey: false, ...over }) as KeyboardEvent;

const hit = (key: string, over: Partial<KeyboardEvent> = {}, typing = false) =>
  matchShortcut(ev(key, over), Boolean(over.metaKey ?? over.ctrlKey), typing);

describe("matchShortcut", () => {
  const cases: [string, string, Partial<KeyboardEvent>, ShortcutId][] = [
    ["run", "Enter", { metaKey: true }, "run"],
    ["palette", "k", { metaKey: true }, "palette"],
    ["new tab", "t", { metaKey: true }, "newTab"],
    ["format", "f", { metaKey: true, shiftKey: true }, "format"],
    ["search", "p", { metaKey: true }, "search"],
    ["open connection", "o", { metaKey: true }, "openConnection"],
    ["toggle explorer", "b", { metaKey: true }, "toggleExplorer"],
    ["theme", "l", { metaKey: true, shiftKey: true }, "theme"],
    ["copy cell", "c", { metaKey: true }, "copyCell"],
    ["escape", "Escape", {}, "escape"],
    ["cheatsheet", "?", {}, "cheatsheet"],
    ["find", "f", { metaKey: true }, "find"],
    ["toggle comment", "/", { metaKey: true }, "toggleComment"],
  ];
  for (const [name, key, mods, id] of cases) {
    it(`matches ${name}`, () => expect(hit(key, mods)).toBe(id));
  }

  it("accepts either case, because Shift and caps lock change the key", () => {
    expect(hit("K", { metaKey: true })).toBe("palette");
    expect(hit("F", { metaKey: true, shiftKey: true })).toBe("format");
  });

  it("takes Ctrl as the modifier too, for Windows and Linux", () => {
    expect(hit("k", { ctrlKey: true })).toBe("palette");
  });

  it("does not confuse a shifted binding with its unshifted one", () => {
    // ⌘F is Find and ⌘⇧F is Format — two different things one Shift apart.
    // Matching loosely would make them trade places depending on the order of
    // the list, which is exactly the kind of bug nobody reports clearly.
    expect(hit("f", { metaKey: true })).toBe("find");
    expect(hit("f", { metaKey: true, shiftKey: true })).toBe("format");
    // ⌘L is still unbound; ⌘⇧L switches the theme.
    expect(hit("l", { metaKey: true })).toBeNull();
    expect(hit("l", { metaKey: true, shiftKey: true })).toBe("theme");
  });

  it("ignores a bare letter with no modifier", () => {
    expect(hit("k")).toBeNull();
    expect(hit("t")).toBeNull();
  });

  it("stays out of the way while typing, but only where it would steal a key", () => {
    // "?" and ⌘C are ordinary things to press inside a text field.
    expect(hit("?", {}, true)).toBeNull();
    expect(hit("c", { metaKey: true }, true)).toBeNull();
    // Escape and Run still have to work from inside the editor.
    expect(hit("Escape", {}, true)).toBe("escape");
    expect(hit("Enter", { metaKey: true }, true)).toBe("run");
  });
});

describe("the shortcut table itself", () => {
  it("has no duplicate ids", () => {
    const ids = SHORTCUTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every shortcut a label and keys to show", () => {
    for (const s of SHORTCUTS) {
      expect(s.label.length, s.id).toBeGreaterThan(0);
      expect(s.keys.length, s.id).toBeGreaterThan(0);
    }
  });

  it("matches at most one shortcut per keystroke", () => {
    // Two entries claiming the same chord would make behaviour depend on the
    // order of the array, and the cheatsheet would show both as if they were
    // separate keys.
    for (const [key, mods] of [
      ["Enter", { metaKey: true }],
      ["k", { metaKey: true }],
      ["f", { metaKey: true, shiftKey: true }],
      ["Escape", {}],
      ["?", {}],
    ] as [string, Partial<KeyboardEvent>][]) {
      const e = ev(key, mods);
      const mod = Boolean(mods.metaKey ?? mods.ctrlKey);
      const matched = SHORTCUTS.filter((s) => s.match(e, mod));
      expect(matched.map((s) => s.id), `${key} matched more than one`).toHaveLength(1);
    }
  });
});
