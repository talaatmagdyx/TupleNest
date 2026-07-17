/**
 * Turning values of unknown type into text.
 *
 * A cell out of Postgres is `unknown`: a string, a number, or — for json and
 * jsonb — an object. `String(anObject)` is `"[object Object]"`, which is how a
 * jsonb value ends up as a bar labelled `[object Object]` in a chart, or as
 * `'[object Object]'` in the statement preview the user reads before approving
 * a write.
 *
 * Every call site had to answer this and they did not all answer it the same
 * way, so it lives here once. The two functions differ only in what a null is:
 * on screen it is worth seeing, in a CSV field it is emptiness.
 */

/** A cell as it should read on screen. `null` is shown, because a null and an
 *  empty string are different facts and the grid should not hide which. */
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** A cell as it should be written to a file, where a null is an empty field —
 *  the convention every spreadsheet expects. */
export function cellExport(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
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
  if (typeof e === "object") return JSON.stringify(e);
  return String(e);
}
