import React from "react";
import { cellExport as cellText, mdCell, neutralizeFormula } from "./text";
import { maskLiterals } from "./complete";
import { invoke } from "@tauri-apps/api/core";

/** SQL syntax highlighting (from the HUD design's tokenizer). */
const SQL_RE =
  /(--[^\n]*)|('(?:[^']|'')*')|(\b\d+(?:\.\d+)?\b)|(\b(?:select|from|where|join|left|right|inner|outer|full|on|group|order|by|having|limit|offset|insert|into|values|update|set|delete|create|table|view|as|and|or|not|null|is|in|like|distinct|desc|asc|union|all|case|when|then|else|end|count|sum|avg|min|max|begin|commit|rollback|explain|analyze)\b)/gi;

/** A run of text and the highlight class it belongs to, or null for plain. */
type Piece = { text: string; cls: string | null };

function tokenPieces(sql: string): Piece[] {
  const out: Piece[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  const re = new RegExp(SQL_RE.source, "gi");
  while ((m = re.exec(sql))) {
    if (m.index > last) out.push({ text: sql.slice(last, m.index), cls: null });
    out.push({ text: m[0], cls: m[1] ? "tok-c" : m[2] ? "tok-s" : m[3] ? "tok-n" : "tok-k" });
    last = re.lastIndex;
  }
  if (last < sql.length) out.push({ text: sql.slice(last), cls: null });
  return out;
}

/**
 * Highlighted SQL, grouped one array per logical line.
 *
 * The editor wraps long lines, and a wrapped line occupies several visual rows.
 * That rules out the old arrangement — a single flowing <pre> beside a gutter of
 * fixed-height rows — because the gutter immediately drifts out of step with the
 * text. Grouping by line lets each line be its own block that carries its own
 * number, so a line that wraps to four rows takes its number with it.
 *
 * The tokenizer still runs over the whole text before the split, not line by
 * line: a string literal may span newlines, and re-starting the scan at every
 * line would end that literal at the first one.
 */
export function tokenizeLines(sql: string): React.ReactNode[][] {
  const lines: React.ReactNode[][] = [[]];
  let k = 0;
  for (const piece of tokenPieces(sql)) {
    const parts = piece.text.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) lines.push([]);
      if (parts[i] === "") continue;
      lines[lines.length - 1].push(
        piece.cls ? (
          <span key={k++} className={piece.cls}>
            {parts[i]}
          </span>
        ) : (
          parts[i]
        ),
      );
    }
  }
  return lines;
}

/** Pages the backend row store until `stored` rows are collected. */
/**
 * How many rows an export or copy actually contains.
 *
 * A result the backend truncated holds fewer rows than the query matched, and
 * a file written from it is a subset with nothing on its face to say so. The
 * grid shows a banner; the .csv on disk cannot. So the count says it: "100,000
 * of 4,213,662 rows (truncated)" rather than a confident "100,000 rows" beside
 * a file that is missing 98% of the answer.
 */
export function rowCountNote(written: number, result: { totalRows: number; truncated: boolean }): string {
  // The test is "did we write everything", not "did the store overflow". A
  // format cap (Markdown) or a clipboard cap loses rows without the store's
  // truncated flag ever being set, and a count that stayed quiet about that
  // would be the same lie the flag exists to prevent.
  if (result.totalRows <= written) return `${written.toLocaleString()} rows`;
  return `${written.toLocaleString()} of ${result.totalRows.toLocaleString()} rows (truncated)`;
}

export async function fetchAllRows(stored: number, cap = 100_000): Promise<unknown[][]> {
  const n = Math.min(stored, cap);
  const out: unknown[][] = [];
  for (let off = 0; off < n; off += 1000) {
    const page = await invoke<unknown[][]>("pg_rows", { offset: off, limit: 1000 });
    out.push(...page);
    if (page.length === 0) break;
  }
  return out;
}

/** CSV export safety: neutralize spreadsheet formulas, or preserve raw bytes. */
export type CsvSafetyMode = "spreadsheet-safe" | "raw";

/* ----------------------------------------------------------- export text
 *
 * Exports are written in pieces, not built as one string.
 *
 * The old shape — collect every row, format the whole document, then save —
 * blocked the main thread for the entire format pass, and a result can be
 * 100,000 rows. The document existed three times over at the peak: the row
 * arrays, the finished string, and the copy the IPC bridge escaped to carry
 * it. On a large result that is where the app stopped responding.
 *
 * So the three whole-document functions are defined in terms of the streaming
 * pieces rather than beside them. There is one set of escaping rules — which
 * matters, because they include the spreadsheet formula neutralization from
 * the security review, and a second copy of that would eventually drift from
 * this one.
 */

export type ExportKind = "csv" | "json" | "md";

/** Markdown is for pasting into a document, not for archiving a result set;
 *  past a thousand rows nobody reads it and no renderer enjoys it. CSV and
 *  JSON have no cap of their own beyond the result store's. */
export const EXPORT_CAPS: Partial<Record<ExportKind, number>> = { md: 1000 };

/** RFC-4180 field, formula-neutralized first when asked.
 *
 *  Order matters: neutralize FIRST, then quote. Quoting first means a leading
 *  `'` lands inside the quoted field where the spreadsheet still sees it, and
 *  a `"=..."` slips through. The quote trigger includes \r so a CR-bearing
 *  value is always wrapped. */
const csvField = (raw: string, mode: CsvSafetyMode) => {
  const s = mode === "spreadsheet-safe" ? neutralizeFormula(raw) : raw;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Everything before the first row: a header line, or an opening bracket. */
export function exportPrefix(
  kind: ExportKind,
  cols: { name: string }[],
  mode: CsvSafetyMode = "spreadsheet-safe"
): string {
  if (kind === "csv") return cols.map((c) => csvField(c.name, mode)).join(",");
  if (kind === "json") return "[";
  // mdCell on the header too: PostgreSQL allows `SELECT 1 AS "a|b"`, and a
  // pipe in a column name breaks the table exactly like one in a value.
  return `| ${cols.map((c) => mdCell(c.name)).join(" | ")} |\n| ${cols.map(() => "---").join(" | ")} |`;
}

/**
 * One batch of rows, ready to append.
 *
 * Every line carries its *leading* separator rather than a trailing one, so
 * chunks concatenate without the writer having to remember whether the last
 * one ended in a newline. `first` says whether this batch opens the document,
 * which is the only thing the separator depends on.
 */
export function exportChunk(
  kind: ExportKind,
  cols: { name: string }[],
  rows: unknown[][],
  first: boolean,
  mode: CsvSafetyMode = "spreadsheet-safe"
): string {
  if (kind === "csv") {
    return rows.map((r) => "\n" + r.map((v) => csvField(cellText(v), mode)).join(",")).join("");
  }
  if (kind === "md") {
    return rows.map((r) => "\n| " + r.map((v) => mdCell(cellText(v))).join(" | ") + " |").join("");
  }
  // Matches `JSON.stringify(array, null, 2)` exactly: each object is indented
  // one level, which means re-indenting its own newlines too.
  return rows
    .map((r, i) => {
      const obj = Object.fromEntries(cols.map((c, j) => [c.name, r[j] ?? null]));
      const body = JSON.stringify(obj, null, 2).replace(/\n/g, "\n  ");
      return `${first && i === 0 ? "\n  " : ",\n  "}${body}`;
    })
    .join("");
}

/** Everything after the last row. `wroteAny` distinguishes `[]` from `[…]`. */
export function exportSuffix(kind: ExportKind, wroteAny: boolean): string {
  return kind === "json" ? (wroteAny ? "\n]" : "]") : "";
}

/** The whole document in one string — for the clipboard, which cannot take it
 *  in pieces. File exports stream instead; see the note above. */
export function toExportText(
  kind: ExportKind,
  cols: { name: string }[],
  rows: unknown[][],
  mode: CsvSafetyMode = "spreadsheet-safe"
): string {
  const cap = EXPORT_CAPS[kind];
  const capped = cap === undefined ? rows : rows.slice(0, cap);
  return (
    exportPrefix(kind, cols, mode) +
    exportChunk(kind, cols, capped, true, mode) +
    exportSuffix(kind, capped.length > 0)
  );
}

export function toCSV(
  cols: { name: string }[],
  rows: unknown[][],
  mode: CsvSafetyMode = "spreadsheet-safe"
): string {
  return toExportText("csv", cols, rows, mode);
}

export function toJSONExport(cols: { name: string }[], rows: unknown[][]): string {
  return toExportText("json", cols, rows);
}

export function toMarkdown(cols: { name: string }[], rows: unknown[][]): string {
  return toExportText("md", cols, rows);
}

/**
 * Why a statement is being guarded, or null if it is not.
 *
 * This is best-effort, and the direction of its errors is the whole design: it
 * may warn about something harmless, but it must not stay quiet about something
 * destructive. The previous version tested the *raw* text, which meant a
 * trailing `-- where` satisfied its `\bwhere\b` check and disarmed it — the
 * exact shape of the near-miss it exists to catch. Everything here runs on
 * masked text for that reason.
 *
 * It is not a parser and it is not a security boundary: `pg_query` will execute
 * whatever it is given. Treat it as the seatbelt light, not the seatbelt.
 */
export type GuardReason = { verb: string; why: string };

const DDL_VERBS = /^(drop|truncate|alter|create|grant|revoke|reindex|vacuum|cluster)$/i;

/** First real keyword of a statement, skipping comments and whitespace. */
export function firstKeyword(sql: string): string | null {
  // Masked, so a leading `-- audit` or `/* x */` cannot hide the verb —
  // `^\s*` alone never skipped those.
  const m = /[A-Za-z_][A-Za-z0-9_]*/.exec(maskLiterals(sql));
  return m ? m[0].toLowerCase() : null;
}

/**
 * Statements worth stopping for on a guarded connection.
 *
 * Guarded environments are prod *and* staging: staging is where people rehearse
 * the destructive thing, and it is usually a restore of prod.
 */
export function guardReason(sql: string, env: string | null): GuardReason | null {
  if (env !== "prod" && env !== "staging") return null;

  const masked = maskLiterals(sql);
  const verb = firstKeyword(sql);
  if (!verb) return null;

  // A CTE can front a DELETE: `WITH x AS (…) DELETE FROM t`. The leading
  // keyword is `with`, so look for the real verb after it.
  const effective =
    verb === "with" ? (/\b(insert|update|delete|merge)\b/i.exec(masked)?.[1]?.toLowerCase() ?? verb) : verb;

  if (DDL_VERBS.test(effective)) {
    return { verb: effective.toUpperCase(), why: "This changes or removes database objects, not just rows." };
  }
  if (effective === "update" || effective === "delete") {
    // `\bwhere\b` on masked text: a commented-out or quoted WHERE no longer
    // counts as one.
    if (!/\bwhere\b/i.test(masked)) {
      return { verb: effective.toUpperCase(), why: "It has no WHERE clause, so it affects every row in the table." };
    }
  }
  return null;
}

/** Destructive-statement guard for prod/staging. See `guardReason`. */
export function needsGuard(sql: string, env: string | null): boolean {
  return guardReason(sql, env) !== null;
}

/** Lightweight SQL formatter: uppercases keywords, breaks major clauses. */
export function formatSQL(sql: string): string {
  const KW =
    /\b(select|from|where|join|left join|right join|inner join|full join|cross join|on|group by|order by|having|limit|offset|insert into|values|update|set|delete from|union all|union|and|or|as|desc|asc|distinct|case|when|then|else|end|returning|with)\b/gi;
  let out = sql.replace(KW, (m) => m.toUpperCase());
  const BREAK_BEFORE =
    /\s+(FROM|WHERE|LEFT JOIN|RIGHT JOIN|INNER JOIN|FULL JOIN|CROSS JOIN|JOIN|GROUP BY|ORDER BY|HAVING|LIMIT|OFFSET|UNION ALL|UNION|VALUES|SET|RETURNING)\b/g;
  out = out.replace(BREAK_BEFORE, "\n$1");
  out = out.replace(/\s+(AND|OR)\b/g, "\n  $1");
  return out.replace(/[ \t]+$/gm, "").trim();
}

export function looksLikeSelect(sql: string): boolean {
  return /^\s*(select|with|values|table)\b/i.test(sql);
}

/** Highest $n placeholder referenced in the SQL (ignoring string literals). */
export function paramCount(sql: string): number {
  const stripped = sql.replace(/'(?:[^']|'')*'/g, "''").replace(/--[^\n]*/g, "");
  let max = 0;
  for (const m of stripped.matchAll(/\$(\d+)/g)) {
    max = Math.max(max, Number(m[1]));
  }
  return max;
}

/** Coerce a UI string into a JSON value the backend maps to a ParamValue. */
export function coerceParam(raw: string): unknown {
  const t = raw.trim();
  if (t === "" || t.toLowerCase() === "null") return null;
  if (t.toLowerCase() === "true") return true;
  if (t.toLowerCase() === "false") return false;
  if (/^-?\d+$/.test(t)) return Number(t);
  if (/^-?\d*\.\d+$/.test(t)) return Number(t);
  return raw; // text as-is
}

export const ENV_COLORS: Record<string, { color: string; bg: string }> = {
  dev: { color: "#3fb950", bg: "rgba(63,185,80,.14)" },
  test: { color: "#9aa0a9", bg: "rgba(154,160,169,.14)" },
  staging: { color: "#e0a13a", bg: "rgba(224,161,58,.14)" },
  prod: { color: "#ef4d4d", bg: "rgba(239,77,77,.16)" },
};

export function envMeta(env: string | null | undefined) {
  return ENV_COLORS[env ?? "dev"] ?? ENV_COLORS.dev;
}

/* ------------------------------------------------------------ commenting */

export type EditResult = { sql: string; selectionStart: number; selectionEnd: number };

/** The lines a selection touches, and where each line starts.
 *
 *  A selection ending exactly at a line start does not include that line —
 *  otherwise selecting a whole line by dragging affects the one below it too. */
export function lineSpan(sql: string, start: number, end: number) {
  const lines = sql.split("\n");
  const offsets: number[] = [];
  let at = 0;
  for (const l of lines) {
    offsets.push(at);
    at += l.length + 1;
  }
  let first = 0;
  let last = 0;
  for (let i = 0; i < lines.length; i++) {
    if (offsets[i] <= start) first = i;
    if (offsets[i] <= end) last = i;
  }
  if (last > first && end === offsets[last]) last--;
  return { lines, offsets, first, last };
}

/** The `--` prefix, and how much whitespace precedes it, on one line. */
const COMMENT_RE = /^(\s*)--( ?)/;

/**
 * Comment or uncomment the lines the selection touches.
 *
 * Line comments, not block comments: PostgreSQL nests block comments, so
 * toggling them correctly means tracking depth, while `--` is unambiguous on
 * every line it appears. Editors offering both are often wrong about nesting.
 *
 * Commenting inserts at the *shallowest* indentation in the range, so a block
 * keeps its shape rather than having every line's comment land at a different
 * column. Uncommenting only happens when every non-blank line is already
 * commented — a half-commented block toggles to fully commented first, which
 * is the behaviour that lets you press it twice and know what you have.
 */
export function toggleLineComment(sql: string, start: number, end: number): EditResult {
  const { lines, offsets, first, last } = lineSpan(sql, start, end);

  const span = lines.slice(first, last + 1);
  const meaningful = span.filter((l) => l.trim() !== "");
  // A selection of nothing but blank lines: comment them, so the keystroke is
  // never a no-op the user has to wonder about.
  const allCommented = meaningful.length > 0 && meaningful.every((l) => COMMENT_RE.test(l));

  let delta = 0;
  let firstDelta = 0;
  const out = span.map((line, i) => {
    if (allCommented) {
      const m = COMMENT_RE.exec(line);
      if (!m) return line;
      const removed = m[0].length - m[1].length;
      if (i === 0) firstDelta = -removed;
      delta -= removed;
      return m[1] + line.slice(m[0].length);
    }
    if (line.trim() === "") return line; // never indent an empty line
    const indent = Math.min(
      ...meaningful.map((l) => (/^\s*/.exec(l) as RegExpExecArray)[0].length),
    );
    if (i === 0) firstDelta = 3;
    delta += 3;
    return line.slice(0, indent) + "-- " + line.slice(indent);
  });

  const next = [...lines.slice(0, first), ...out, ...lines.slice(last + 1)].join("\n");
  // Keep the selection over the same text, with one exception: a selection
  // that began at the start of a line stays there, so selecting whole lines
  // and commenting them leaves whole lines selected rather than everything
  // except the marker just inserted. A caret (start === end) rides with its
  // line so typing continues where it was.
  const startedAtLineStart = start === offsets[first];
  return {
    sql: next,
    selectionStart: startedAtLineStart ? offsets[first] : Math.max(offsets[first], start + firstDelta),
    selectionEnd: Math.max(offsets[first], end + delta),
  };
}

/* ------------------------------------------------------------- indenting */

/** Two spaces. Spaces rather than a tab because a tab renders at whatever width
 *  the next tool chooses, and SQL gets pasted into a lot of other tools. */
export const INDENT = "  ";

/**
 * Indent or outdent, the way Tab and Shift-Tab should behave.
 *
 * A bare caret inserts up to the next tab stop, so pressing Tab in the middle of
 * a line moves to a column rather than always adding two spaces. Anything with a
 * selection — even within a single line — shifts whole lines instead, because
 * that is what Tab is for in an editor and replacing a selection with a tab
 * character is a thing nobody wants in SQL.
 *
 * Outdent removes up to one level of leading whitespace and never reaches past
 * the start of the line; a line with no indentation is left alone rather than
 * eating the first real character.
 */
export function indentSelection(sql: string, start: number, end: number, outdent = false): EditResult {
  const { lines, offsets, first, last } = lineSpan(sql, start, end);

  if (!outdent && start === end) {
    const col = start - offsets[first];
    const pad = " ".repeat(INDENT.length - (col % INDENT.length));
    return {
      sql: sql.slice(0, start) + pad + sql.slice(start),
      selectionStart: start + pad.length,
      selectionEnd: start + pad.length,
    };
  }

  let firstDelta = 0;
  let delta = 0;
  const out = lines.slice(first, last + 1).map((line, i) => {
    if (outdent) {
      // A tab counts as a whole level; spaces come off up to a level's worth.
      const m = /^(\t| {1,2})/.exec(line);
      if (!m) return line;
      if (i === 0) firstDelta = -m[1].length;
      delta -= m[1].length;
      return line.slice(m[1].length);
    }
    // Never indent a blank line: it would leave trailing whitespace behind on a
    // line the user cannot see it on.
    if (line === "") return line;
    if (i === 0) firstDelta = INDENT.length;
    delta += INDENT.length;
    return INDENT + line;
  });

  const next = [...lines.slice(0, first), ...out, ...lines.slice(last + 1)].join("\n");
  // A selection that began at a line start stays there, so indenting whole
  // lines leaves whole lines selected rather than losing the new indentation
  // from the top of the block.
  const atLineStart = start === offsets[first];
  return {
    sql: next,
    selectionStart: atLineStart ? offsets[first] : Math.max(offsets[first], start + firstDelta),
    selectionEnd: Math.max(offsets[first], end + delta),
  };
}

/**
 * Enter, carrying the current line's indentation onto the new one.
 *
 * Opening a bracket adds a level. If the matching closer is sitting right after
 * the caret — which it is when the pair was auto-inserted — the closer is pushed
 * onto a third line at the original indentation and the caret lands in the
 * middle, which is the shape you wanted when you pressed Enter inside `(|)`.
 */
export function newlineIndent(sql: string, start: number, end: number): EditResult {
  const lineStart = sql.lastIndexOf("\n", start - 1) + 1;
  const indent = (/^[ \t]*/.exec(sql.slice(lineStart, start)) as RegExpExecArray)[0];

  const before = sql.slice(0, start).trimEnd();
  const opener = before.endsWith("(") ? ")" : before.endsWith("[") ? "]" : null;
  const inner = opener ? indent + INDENT : indent;

  const text = opener && sql[end] === opener ? `\n${inner}\n${indent}` : `\n${inner}`;
  const caret = start + 1 + inner.length;
  return {
    sql: sql.slice(0, start) + text + sql.slice(end),
    selectionStart: caret,
    selectionEnd: caret,
  };
}

/* ------------------------------------------------------------- pairing */

const PAIRS: Record<string, string> = { "(": ")", "[": "]", "'": "'", '"': '"' };
const CLOSERS = new Set([")", "]", "'", '"']);
const WORD = /[A-Za-z0-9_]/;

/**
 * What typing a bracket or quote should do, or null to just type it.
 *
 * Three behaviours, in order:
 *   - With text selected, the pair wraps it. Quoting a chosen identifier or
 *     bracketing a chosen expression is the one case where auto-pairing is
 *     unambiguously what was meant.
 *   - Typing a closer that is already the next character steps over it instead
 *     of doubling it, which is what makes the auto-inserted closer harmless.
 *   - Otherwise the pair is inserted with the caret between the two halves —
 *     but not when it would split a word. `don't` and `o'brien` must stay one
 *     word, and `foo(bar` should not become `foo()bar`.
 */
export function autoPair(sql: string, start: number, end: number, ch: string): EditResult | null {
  const nextCh = sql[end] ?? "";
  const prevCh = start > 0 ? sql[start - 1] : "";

  if (start !== end && PAIRS[ch]) {
    const inner = sql.slice(start, end);
    return {
      sql: sql.slice(0, start) + ch + inner + PAIRS[ch] + sql.slice(end),
      selectionStart: start + 1,
      selectionEnd: start + 1 + inner.length,
    };
  }

  if (start === end && CLOSERS.has(ch) && nextCh === ch) {
    return { sql, selectionStart: start + 1, selectionEnd: start + 1 };
  }

  if (start === end && PAIRS[ch]) {
    if (WORD.test(nextCh)) return null;
    // A quote after a word character is an apostrophe or the end of something,
    // not the start of a new literal. Brackets after a word are fine — that is
    // a function call.
    if ((ch === "'" || ch === '"') && (WORD.test(prevCh) || prevCh === ch)) return null;
    return {
      sql: sql.slice(0, start) + ch + PAIRS[ch] + sql.slice(start),
      selectionStart: start + 1,
      selectionEnd: start + 1,
    };
  }

  return null;
}

/** Backspace between the two halves of an empty pair removes both, so undoing
 *  an auto-inserted bracket takes one press rather than two. Null when the
 *  caret is anywhere else, leaving Backspace entirely alone. */
export function deletePair(sql: string, start: number, end: number): EditResult | null {
  if (start !== end || start === 0) return null;
  const close = PAIRS[sql[start - 1]];
  // `undefined !== undefined` is false, so testing the lookup against the next
  // character alone made backspace at the very end of any text delete two.
  if (close === undefined || close !== sql[start]) return null;
  return {
    sql: sql.slice(0, start - 1) + sql.slice(start + 1),
    selectionStart: start - 1,
    selectionEnd: start - 1,
  };
}

/* --------------------------------------------------------------- find */

export type Match = { start: number; end: number };

/**
 * Every occurrence of `needle`, left to right.
 *
 * Literal text, not a regular expression. A regex box in a SQL editor is a
 * trap: half the characters people search for here — `(`, `)`, `.`, `*`, `$`,
 * `[` — are regex syntax, so the common case would need escaping and the
 * uncommon case is served by the query itself. If regex search is ever added
 * it should be a deliberate toggle, not the default reading of what was typed.
 *
 * Overlapping matches are not returned: after a hit, scanning resumes at its
 * end, so searching `aa` in `aaa` finds one match rather than two. That is
 * what "replace all" needs to be sane.
 */
export function findMatches(text: string, needle: string, caseSensitive = false): Match[] {
  if (!needle) return [];
  const hay = caseSensitive ? text : text.toLowerCase();
  const pin = caseSensitive ? needle : needle.toLowerCase();
  const out: Match[] = [];
  let from = 0;
  for (;;) {
    const at = hay.indexOf(pin, from);
    if (at === -1) return out;
    out.push({ start: at, end: at + pin.length });
    from = at + pin.length;
  }
}

/** Replace one match, returning the new text and where the caret should land. */
export function replaceMatch(text: string, m: Match, replacement: string): EditResult {
  return {
    sql: text.slice(0, m.start) + replacement + text.slice(m.end),
    selectionStart: m.start,
    selectionEnd: m.start + replacement.length,
  };
}

/** Replace every match in one pass.
 *
 *  Built right to left so earlier offsets stay valid — the obvious left-to-right
 *  loop has to keep adjusting for the length difference, and gets it wrong the
 *  moment the replacement is shorter than the needle. */
export function replaceAllMatches(text: string, needle: string, replacement: string, caseSensitive = false): string {
  const ms = findMatches(text, needle, caseSensitive);
  let out = text;
  for (let i = ms.length - 1; i >= 0; i--) {
    out = out.slice(0, ms[i].start) + replacement + out.slice(ms[i].end);
  }
  return out;
}
