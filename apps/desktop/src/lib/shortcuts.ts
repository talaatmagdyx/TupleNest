/**
 * Every global keyboard shortcut, defined once.
 *
 * There used to be two lists: the `if/else` chain in App's keydown handler,
 * and a hand-written array in the cheatsheet the `?` key opens. They drifted,
 * as two lists of the same thing do — the app bound ⌘⇧L, ⌘O, ⌘B and ⌘P and
 * the cheatsheet, whose entire job is to say which keys exist, mentioned none
 * of them. The website's shortcut table had drifted from both.
 *
 * So the table below is the only place a shortcut is described. The handler
 * asks it what was pressed and the cheatsheet renders it; neither has its own
 * opinion. A test asserts the handler contains no key comparisons of its own,
 * because the failure mode is not a wrong entry here — it is someone adding a
 * binding somewhere else and this file never hearing about it.
 */

export type ShortcutId =
  | "run"
  | "format"
  | "theme"
  | "openConnection"
  | "toggleExplorer"
  | "palette"
  | "search"
  | "newTab"
  | "copyCell"
  | "cheatsheet"
  | "escape";

export type Shortcut = {
  id: ShortcutId;
  /** How the cheatsheet names it. */
  label: string;
  /** Parts for `kbd()`, so the keys shown match the platform. */
  keys: string[];
  /** A condition worth stating next to the key, or nothing. */
  note?: string;
  /** True when the binding does nothing while a text field has focus. */
  needsNotTyping?: boolean;
  match: (e: KeyboardEvent, mod: boolean) => boolean;
};

/** Letter keys arrive as either case depending on Shift and caps lock. */
const letter = (k: string) => (e: KeyboardEvent, mod: boolean) =>
  mod && !e.shiftKey && e.key.toLowerCase() === k;

const shiftLetter = (k: string) => (e: KeyboardEvent, mod: boolean) =>
  mod && e.shiftKey && e.key.toLowerCase() === k;

export const SHORTCUTS: Shortcut[] = [
  { id: "run", label: "Run query", keys: ["mod", "enter"], match: (e, mod) => mod && e.key === "Enter" },
  { id: "palette", label: "Command palette", keys: ["mod", "K"], match: letter("k") },
  { id: "newTab", label: "New query tab", keys: ["mod", "T"], match: letter("t") },
  { id: "format", label: "Format SQL", keys: ["mod", "shift", "F"], match: shiftLetter("f") },
  {
    id: "search",
    label: "Search database objects",
    keys: ["mod", "P"],
    note: "while connected",
    match: letter("p"),
  },
  { id: "openConnection", label: "Open connection", keys: ["mod", "O"], match: letter("o") },
  { id: "toggleExplorer", label: "Show or hide the sidebar", keys: ["mod", "B"], match: letter("b") },
  { id: "theme", label: "Switch light / dark", keys: ["mod", "shift", "L"], match: shiftLetter("l") },
  {
    id: "copyCell",
    label: "Copy the selected cell",
    keys: ["mod", "C"],
    note: "when nothing else is selected",
    needsNotTyping: true,
    match: letter("c"),
  },
  {
    id: "escape",
    label: "Close the overlay, else cancel the query",
    keys: ["Esc"],
    match: (e) => e.key === "Escape",
  },
  {
    id: "cheatsheet",
    label: "This cheatsheet",
    keys: ["?"],
    needsNotTyping: true,
    match: (e) => e.key === "?",
  },
];

/**
 * Which shortcut was pressed, if any.
 *
 * `typing` is passed in rather than derived here so the caller keeps one
 * definition of what counts as a text field. Bindings that would otherwise
 * swallow a keystroke meant for an input are skipped while typing.
 */
export function matchShortcut(e: KeyboardEvent, mod: boolean, typing: boolean): ShortcutId | null {
  for (const s of SHORTCUTS) {
    if (s.needsNotTyping && typing) continue;
    if (s.match(e, mod)) return s.id;
  }
  return null;
}
