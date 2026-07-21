import React from "react";
import { cellExport as cellText, mdCell, neutralizeFormula } from "./text";
import { maskLiterals } from "./complete";
import { invoke } from "@tauri-apps/api/core";

/** SQL syntax highlighting (from the HUD design's tokenizer). */
const SQL_RE =
  /(--[^\n]*)|('(?:[^']|'')*')|(\b\d+(?:\.\d+)?\b)|(\b(?:select|from|where|join|left|right|inner|outer|full|on|group|order|by|having|limit|offset|insert|into|values|update|set|delete|create|table|view|as|and|or|not|null|is|in|like|distinct|desc|asc|union|all|case|when|then|else|end|count|sum|avg|min|max|begin|commit|rollback|explain|analyze)\b)/gi;

export function tokenizeSQL(sql: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  const re = new RegExp(SQL_RE.source, "gi");
  while ((m = re.exec(sql))) {
    if (m.index > last) out.push(sql.slice(last, m.index));
    const cls = m[1] ? "tok-c" : m[2] ? "tok-s" : m[3] ? "tok-n" : "tok-k";
    out.push(
      <span key={k++} className={cls}>
        {m[0]}
      </span>
    );
    last = re.lastIndex;
  }
  if (last < sql.length) out.push(sql.slice(last));
  out.push("\n");
  return out;
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
  if (!result.truncated || result.totalRows <= written) return `${written.toLocaleString()} rows`;
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

export function toCSV(
  cols: { name: string }[],
  rows: unknown[][],
  mode: CsvSafetyMode = "spreadsheet-safe"
): string {
  // Order: neutralize the formula FIRST, then RFC-4180 quote. Quoting after
  // means the leading `'` is inside the quoted field where the spreadsheet
  // still sees it; quoting first would let a `"=..."` slip through. The quote
  // trigger includes \r so a CR-bearing value is always wrapped.
  const esc = (raw: string) => {
    const s = mode === "spreadsheet-safe" ? neutralizeFormula(raw) : raw;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = cols.map((c) => esc(c.name)).join(",");
  return [head, ...rows.map((r) => r.map((v) => esc(cellText(v))).join(","))].join("\n");
}

export function toJSONExport(cols: { name: string }[], rows: unknown[][]): string {
  return JSON.stringify(
    rows.map((r) => Object.fromEntries(cols.map((c, i) => [c.name, r[i] ?? null]))),
    null,
    2
  );
}

export function toMarkdown(cols: { name: string }[], rows: unknown[][]): string {
  // mdCell everywhere a value lands in the table — including the header:
  // PostgreSQL allows `SELECT 1 AS "a|b"`, and a quoted column name with a
  // pipe (or backslash, or newline) breaks the table exactly like a cell
  // value does. The old code escaped only cell pipes, and only halfway —
  // see mdCell for the backslash trap CodeQL caught.
  const head = `| ${cols.map((c) => mdCell(c.name)).join(" | ")} |`;
  const sep = `| ${cols.map(() => "---").join(" | ")} |`;
  const body = rows
    .slice(0, 1000)
    .map((r) => `| ${r.map((v) => mdCell(cellText(v))).join(" | ")} |`);
  return [head, sep, ...body].join("\n");
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
  const lines = sql.split("\n");

  // Which lines the selection covers, by character offset.
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
  // A selection ending exactly at a line start does not include that line —
  // otherwise selecting a whole line by dragging comments the one below too.
  if (last > first && end === offsets[last]) last--;

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
