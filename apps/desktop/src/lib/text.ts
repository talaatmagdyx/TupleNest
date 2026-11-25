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
 * way, so it lives here once. (Export files are formatted in the backend —
 * src-tauri/src/export.rs — where a null is an empty field instead.)
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

/**
 * A JSON document re-indented, with every token left as it was written.
 *
 * `JSON.stringify(JSON.parse(text), null, 2)` is shorter and shows a
 * different document: a number past 2^53 rounded, `1.10` as `1.1`, one of a
 * duplicated key gone, integer-like keys moved to the front. A viewer for a
 * database value must not do that, so this only moves whitespace. `JSON.parse`
 * is used to decide whether the text is JSON at all; its result is discarded.
 * Text that is not JSON comes back unchanged.
 */
export function prettyJson(src: string): string {
  try {
    JSON.parse(src);
  } catch {
    return src;
  }
  let out = "";
  let depth = 0;
  const line = () => `\n${"  ".repeat(depth)}`;
  const space = (ch: string) => ch === " " || ch === "\n" || ch === "\r" || ch === "\t";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"') {
      // The text is valid JSON, so the string closes.
      let j = i + 1;
      while (src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else if (c === "{" || c === "[") {
      let j = i + 1;
      while (space(src[j])) j++;
      if (src[j] === "}" || src[j] === "]") {
        out += c + src[j]; // empty: `{}` and `[]` stay on one line
        i = j + 1;
      } else {
        depth++;
        out += c + line();
        i++;
      }
    } else if (c === "}" || c === "]") {
      depth--;
      out += line() + c;
      i++;
    } else if (c === ",") {
      out += `,${line()}`;
      i++;
    } else if (c === ":") {
      out += ": ";
      i++;
    } else {
      if (!space(c)) out += c;
      i++;
    }
  }
  return out;
}

