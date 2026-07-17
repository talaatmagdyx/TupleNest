/**
 * Turning values of unknown type into text.
 *
 * A cell out of Postgres is `unknown`: a string, a number, or — for json and
 * jsonb — an object. `String(anObject)` is `"[object Object]"`, which is how a
 * jsonb value ended up as a bar labelled `[object Object]` in a chart, as
 * `'[object Object]'` in the statement preview the user reads before approving
 * a write, and as a spurious UPDATE staged for a cell nobody edited.
 *
 * Every call site had to answer this and they did not all answer it the same
 * way, so it lives here once. The two exported functions differ only in what a
 * null is: on screen it is worth seeing, in a CSV field it is emptiness.
 */

/** The shared rule, for a value already known not to be null or undefined. */
function text(v: NonNullable<unknown>): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  if (typeof v === "object") return JSON.stringify(v);
  // A symbol or a function is not something Postgres hands back, but `unknown`
  // permits it and `String(aSymbol)` throws. Say what it was instead.
  return Object.prototype.toString.call(v);
}

/** A cell as it should read on screen. `null` is shown, because a null and an
 *  empty string are different facts and the grid should not hide which. */
export function cellText(v: unknown): string {
  return v === null || v === undefined ? "null" : text(v);
}

/** A cell as it should be written to a file, where a null is an empty field —
 *  the convention every spreadsheet expects. */
export function cellExport(v: unknown): string {
  return v === null || v === undefined ? "" : text(v);
}

/**
 * A value made safe to sit inside one Markdown table cell.
 *
 * Order matters and each step exists for a reason:
 *
 * 1. Backslash FIRST. Escaping `|` as `\|` while leaving `\` alone means a
 *    value ending in `\` turns the escape into `\\|` — a literal backslash
 *    followed by a *live* pipe, which splits the cell after all. This is
 *    CodeQL js/incomplete-sanitization, and it was right: escaping a
 *    meta-character with a character you did not escape is not escaping.
 * 2. Then `|`, the cell separator itself.
 * 3. Then newlines, which no escape can save — a raw newline ends the table
 *    row no matter what precedes it. `<br>` keeps multi-line values readable
 *    in rendered Markdown and harmless in raw text; `\r` is dropped so CRLF
 *    data does not leave a stray CR in the cell.
 */
export function mdCell(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r/g, "")
    .replace(/\n/g, "<br>");
}

/**
 * An error as one line of text.
 *
 * Tauri rejects with the command's `Err(String)` — a bare string, not an Error
 * — so this has to read both. `String(e)` alone is right for the string case
 * and gives "[object Object]" for anything structured.
 */
export function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  if (e === null || e === undefined) return String(e);
  return text(e);
}
