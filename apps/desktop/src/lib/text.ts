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
