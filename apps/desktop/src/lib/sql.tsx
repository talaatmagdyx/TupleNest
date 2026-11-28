import React from "react";
import { maskLiterals } from "./complete";

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

/**
 * How many rows an export or copy actually contains.
 *
 * A result the backend truncated holds fewer rows than the query matched, and
 * a file written from it is a subset with nothing on its face to say so. The
 * grid shows a banner; the .csv on disk cannot. So the count says it: "20,000
 * of 4,213,662 rows (truncated)" rather than a confident "20,000 rows" beside
 * a file that is missing more than 99% of the answer.
 */
export function rowCountNote(
  written: number,
  result: { totalRows: number; totalKnown?: boolean; truncated: boolean },
): string {
  // The backend stopped reading at its cap: there is no total to compare
  // with, only "at least this many".
  if (result.totalKnown === false) {
    const of = written < result.totalRows ? `${written.toLocaleString()} of ` : "";
    return `${of}${totalRowsText(result)} rows ${STOPPED_AT_LIMIT}`;
  }
  // The test is "did we write everything", not "did the store overflow". A
  // format cap (Markdown) or a clipboard cap loses rows without the store's
  // truncated flag ever being set, and a count that stayed quiet about that
  // would be the same lie the flag exists to prevent.
  if (result.totalRows <= written) return `${written.toLocaleString()} rows`;
  return `${written.toLocaleString()} of ${result.totalRows.toLocaleString()} rows (truncated)`;
}

/** Said beside a total the backend did not read to the end of. */
export const STOPPED_AT_LIMIT = "(stopped at the limit)";

/**
 * A result's total row count as text: "4,213,662", or "20,000+" when the
 * backend stopped reading at its row cap. Past the cap a plain read is not
 * streamed to the end just to count it (that took seconds on a large table),
 * so the only honest total is a lower bound.
 */
export function totalRowsText(result: { totalRows: number; totalKnown?: boolean }): string {
  return `${result.totalRows.toLocaleString()}${result.totalKnown === false ? "+" : ""}`;
}

/** CSV export safety: neutralize spreadsheet formulas, or preserve raw bytes. */
export type CsvSafetyMode = "spreadsheet-safe" | "raw";

/* ----------------------------------------------------------- export text
 *
 * The formats themselves (CSV with formula neutralization, JSON, Markdown)
 * live in the backend, src-tauri/src/export.rs: it formats straight from the
 * stored rows and writes into the file, so rows never come into the page and
 * there is one copy of the escaping rules. What stays here is what the UI
 * decides: which kind, and how many rows.
 */

export type ExportKind = "csv" | "json" | "md";

/** Markdown is for pasting into a document, not for archiving a result set;
 *  past a thousand rows nobody reads it and no renderer enjoys it. CSV and
 *  JSON have no cap of their own beyond the result store's. */
export const EXPORT_CAPS: Partial<Record<ExportKind, number>> = { md: 1000 };


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

/** Does this statement end the current transaction (`COMMIT`, `ROLLBACK`,
 *  `END`, `ABORT`)? `ends_transaction` in driver-postgres; change both. One
 *  word is enough: `pg_query` prepares the text, so it is one statement. */
export function endsTransaction(sql: string): boolean {
  const verb = firstKeyword(sql);
  return verb === "commit" || verb === "rollback" || verb === "end" || verb === "abort";
}

/**
 * Statements worth stopping for.
 *
 * On prod *and* staging (staging is where people rehearse the destructive
 * thing, and it is usually a restore of prod) the whole list below asks. On
 * every other connection — dev, test, untagged — only the worst cases do, the
 * ones `guardTarget` names: no undo short of a restore is just as true of a
 * dev database someone has spent a day loading (TN-034).
 */
/**
 * Blank the inside of SQLite's other identifier quotes, `[name]` and
 * `` `name` ``, in text `maskLiterals` has already masked: `DELETE FROM
 * [where]` deletes every row, and must not read as bounded. In PostgreSQL
 * `[…]` is an array subscript; blanking one can only hide a WHERE, which errs
 * towards stopping. `mask_bracket_quotes` in `guard.rs`; change both.
 */
export function maskBracketQuotes(masked: string): string {
  return masked.replace(/\[[^\]]*\]?|`[^`]*`?/g, (m) => {
    const close = m.length > 1 && (m.endsWith("]") || (m.startsWith("`") && m.endsWith("`"))) ? 1 : 0;
    return m[0] + m.slice(1, m.length - close).replace(/[^\n]/g, " ") + (close ? m[m.length - 1] : "");
  });
}

export function guardReason(sql: string, env: string | null): GuardReason | null {
  if (env !== "prod" && env !== "staging") return guardTarget(sql, "prod") ? guardReason(sql, "prod") : null;

  const masked = maskBracketQuotes(maskLiterals(sql));
  const verb = firstKeyword(sql);
  if (!verb) return null;

  // EXPLAIN ANALYZE runs what it explains. Typed into the editor it went
  // straight through, because its first word is `explain`: judge the
  // statement inside it. (The Explain button has its own check.)
  if (verb === "explain") {
    const head = /^\s*explain\s*(?:\(([^)]*)\)|((?:\s*\b(?:analyze|analyse|verbose)\b)*))/i.exec(masked);
    if (!head) return null;
    const options = head[1] ?? head[2] ?? "";
    const analyze = /\banaly[sz]e\b(?!\s*(?:false|off|0)\b)/i.test(options);
    if (!analyze) return null;
    const inner = guardReason(sql.slice(head[0].length), env);
    return inner && { verb: inner.verb, why: `EXPLAIN ANALYZE runs the statement. ${inner.why}` };
  }

  // A CTE can front a DELETE: `WITH x AS (…) DELETE FROM t`. The leading
  // keyword is `with`, so look for the real verb after it.
  const effective =
    verb === "with" ? (/\b(insert|update|delete|merge)\b/i.exec(masked)?.[1]?.toLowerCase() ?? verb) : verb;

  if (DDL_VERBS.test(effective)) {
    return { verb: effective.toUpperCase(), why: "This changes or removes database objects, not just rows." };
  }
  // Their effect is not visible in the text, so there is nothing to check:
  // a DO block or procedure can delete anything, MERGE can delete matched
  // rows, and COPY … FROM writes a whole file into a table.
  if (effective === "do" || effective === "call" || effective === "merge") {
    return { verb: effective.toUpperCase(), why: "What this changes cannot be seen from the statement itself." };
  }
  // Top level only: `COPY (SELECT … FROM t) TO STDOUT` reads, it does not write.
  if (effective === "copy" && /\bfrom\b/i.test(masked.replace(/\([^()]*\)/g, " ").replace(/\([^()]*\)/g, " "))) {
    return { verb: "COPY", why: "COPY … FROM writes rows straight into the table." };
  }
  // Every UPDATE/DELETE needs its own WHERE. One WHERE anywhere in the text
  // used to count, so `WITH d AS (DELETE FROM a WHERE false) DELETE FROM
  // users` — or a WHERE only inside a subquery — disarmed the guard.
  const unbounded = unboundedDml(masked);
  if (unbounded) {
    return {
      verb: unbounded.verb.toUpperCase(),
      why: unbounded.trivial
        ? "Its WHERE clause is always true, so it affects every row in the table."
        : "It has no WHERE clause, so it affects every row in the table.",
    };
  }
  return null;
}

/**
 * The first UPDATE or DELETE whose own clause has no WHERE, or null.
 *
 * "Its own clause" is the text from the verb to the end of the enclosing
 * parentheses (a CTE body) or the statement, at the verb's nesting level: a
 * WHERE inside a subquery bounds the subquery, not the DELETE. Works on masked
 * text, so quoted or commented WHERE clauses never count. `DO UPDATE` (upsert) and
 * `FOR [NO KEY] UPDATE` (row locks) are not row-wide writes and are skipped.
 */
export function dmlWithoutWhere(masked: string): string | null {
  return unboundedDml(masked)?.verb ?? null;
}

/**
 * The first UPDATE or DELETE that reaches every row: no WHERE of its own, or
 * one that is plainly always true (`WHERE true`, `WHERE 1=1`, `WHERE 'a'='a'`,
 * or any of those as one side of a top-level OR).
 *
 * The second case is the habit the guard is for: `WHERE 1=1` is what a query
 * builder leaves behind when every filter was optional, and it used to count
 * as a WHERE. Only the obvious spellings are recognised; `WHERE id = id` and
 * `WHERE now() > '2000-01-01'` are as unbounded and are not caught.
 */
function unboundedDml(masked: string): { verb: string; trivial: boolean; at: number } | null {
  const re = /\b(update|delete)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    const before = masked.slice(0, m.index).trimEnd().toLowerCase();
    if (/\b(do|for|key)$/.test(before)) continue;
    let depth = 0;
    let own = "";
    // Where each character of `own` sits in `masked`, to find the WHERE's
    // condition with its parentheses still in it.
    const at: number[] = [];
    let end = masked.length;
    for (let i = m.index; i < masked.length; i++) {
      const c = masked[i];
      if (c === "(") depth++;
      else if (c === ")") {
        if (depth === 0) {
          end = i; // end of the CTE body this verb lives in
          break;
        }
        depth--;
      } else if (c === ";" && depth === 0) {
        end = i;
        break;
      }
      if (depth === 0) {
        own += c;
        at.push(i);
      }
    }
    const verb = m[1].toLowerCase();
    const where = /\bwhere\b/i.exec(own);
    if (!where) return { verb, trivial: false, at: m.index };
    if (alwaysTrue(masked.slice(at[where.index] + where[0].length, end))) return { verb, trivial: true, at: m.index };
  }
  return null;
}

/** Is this WHERE condition (masked text) one of the plainly-always-true ones? */
function alwaysTrue(condition: string): boolean {
  const whole = condition.replace(/\breturning\b[\s\S]*$/i, "");
  return whole.split(/\bor\b/i).some((part) => {
    let c = part.trim().toLowerCase();
    while (c.startsWith("(") && c.endsWith(")")) c = c.slice(1, -1).trim();
    c = c.replace(/\s+/g, "");
    // `=` alone, or between empty quotes, is two string literals compared:
    // masking blanked what was in them. Which strings is not known, so this
    // also flags `'a' = 'b'`, which matches nothing — asking is the safe side.
    return c === "true" || c === "notfalse" || c === "1" || /^(\d+)=\1$/.test(c) || /^('')?=('')?$/.test(c);
  });
}

/** One name: plain or double-quoted, optionally schema-qualified. */
const NAME = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)(?:\s*\.\s*(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*))*`;
/** A comma-separated list of names, as `DROP TABLE a, b` and `TRUNCATE a, b` take. */
const NAME_LIST = new RegExp(String.raw`${NAME}(?:\s*,\s*${NAME})*`, "y");

/** The names written at `from` in the original text, or null. The keywords
 *  before it were matched on masked text; the names are read from the
 *  original, where a quoted identifier still has its letters. */
function namesAt(sql: string, from: number): string | null {
  NAME_LIST.lastIndex = from;
  const m = NAME_LIST.exec(sql);
  return m ? m[0] : null;
}

/**
 * The object a prod or staging statement destroys outright, which the guard
 * asks to be typed back before it will run it — or null when the statement is
 * not one of the worst cases, or the connection is neither.
 *
 * The worst cases are the ones with no undo short of a restore: DELETE or
 * UPDATE with no WHERE (or an always-true one), DROP, and TRUNCATE. The other
 * guarded statements (ALTER, DO, COPY …) still ask, but one click answers.
 * Staging wants the typing too (TN-034): it is usually a copy of prod, and the
 * same reflex click does the same damage there. Elsewhere one click answers.
 */
export function guardTarget(sql: string, env: string | null): { verb: string; name: string } | null {
  if (env !== "prod" && env !== "staging") return null;
  const masked = maskLiterals(sql);
  const verb = firstKeyword(sql);
  if (!verb) return null;
  if (verb === "explain") {
    const head = /^\s*explain\s*(?:\(([^)]*)\)|((?:\s*\b(?:analyze|analyse|verbose)\b)*))/i.exec(masked);
    if (!head || !guardReason(sql, env)) return null;
    return guardTarget(sql.slice(head[0].length), env);
  }
  if (verb === "drop" || verb === "truncate") {
    const re =
      verb === "drop"
        ? /^\s*drop\s+(?:(?:materialized|foreign)\s+)?[a-z]+\s+(?:by\s+)?(?:concurrently\s+)?(?:if\s+exists\s+)?/yi
        : /^\s*truncate\s+(?:table\s+)?(?:only\s+)?/yi;
    const m = re.exec(masked);
    if (!m) return null;
    const name = namesAt(sql, m[0].length);
    return name ? { verb: verb.toUpperCase(), name } : null;
  }
  const u = unboundedDml(masked);
  if (!u) return null;
  const re = u.verb === "delete" ? /delete\s+from\s+(?:only\s+)?/yi : /update\s+(?:only\s+)?/yi;
  re.lastIndex = u.at;
  const m = re.exec(masked);
  if (!m) return null;
  const name = namesAt(sql, u.at + m[0].length);
  return name ? { verb: u.verb.toUpperCase(), name } : null;
}

/** Destructive-statement guard. See `guardReason`. */
export function needsGuard(sql: string, env: string | null): boolean {
  return guardReason(sql, env) !== null;
}

/**
 * Lightweight SQL formatter: uppercases keywords, breaks major clauses.
 *
 * Only code is formatted. The patterns used to run over the whole text, so
 * the words inside `'made from scratch and love, order by mail'` were
 * uppercased and broken across lines, trailing spaces inside a multi-line
 * string were trimmed, and `"from"` became `"FROM"` — another column. Format
 * and then Run wrote different data than was typed. String and dollar-quoted
 * bodies, comments and quoted identifiers now pass through byte for byte.
 */
export function formatSQL(sql: string): string {
  const spans: [number, number][] = [];
  maskLiterals(sql, (from, to) => {
    if (to > from) spans.push([from, to]);
  });

  let out = "";
  let at = 0;
  for (const [from, to] of [...spans, [sql.length, sql.length] as [number, number]]) {
    let code = formatCode(sql.slice(at, from));
    if (at === 0) code = code.trimStart();
    if (from === sql.length) code = code.trimEnd();
    out += code + sql.slice(from, to);
    at = to;
  }
  return out;
}

/** `formatSQL` for a stretch that is known to be code. */
function formatCode(code: string): string {
  const KW =
    /\b(select|from|where|join|left join|right join|inner join|full join|cross join|on|group by|order by|having|limit|offset|insert into|values|update|set|delete from|union all|union|and|or|as|desc|asc|distinct|case|when|then|else|end|returning|with)\b/gi;
  // A dollar-quote tag is not a keyword: `$end$` must still close `$end$`.
  let out = code.replace(KW, (m, _k: string, i: number) =>
    code[i - 1] === "$" || code[i + m.length] === "$" ? m : m.toUpperCase(),
  );
  const BREAK_BEFORE =
    /\s+(FROM|WHERE|LEFT JOIN|RIGHT JOIN|INNER JOIN|FULL JOIN|CROSS JOIN|JOIN|GROUP BY|ORDER BY|HAVING|LIMIT|OFFSET|UNION ALL|UNION|VALUES|SET|RETURNING)\b/g;
  out = out.replace(BREAK_BEFORE, "\n$1");
  out = out.replace(/\s+(AND|OR)\b/g, "\n  $1");
  // Trailing blanks before a line break only: this stretch may end where a
  // string begins, and the space before it is not the end of a line.
  return out.replace(/[ \t]+(?=\n)/g, "");
}

export function looksLikeSelect(sql: string): boolean {
  return /^\s*(select|with|values|table)\b/i.test(sql);
}

/**
 * Whether a statement that *looks* like a query writes anyway.
 *
 * `looksLikeSelect` reads the first keyword, and the first keyword of
 * `WITH gone AS (DELETE FROM users RETURNING id) SELECT count(*) FROM gone` is
 * WITH. EXPLAIN ANALYZE executes what it explains, so treating that as a plain
 * query deleted the rows from a button labelled Explain. `SELECT … INTO t`
 * creates a table the same way.
 *
 * Masked first, so a keyword inside a string, a comment or a quoted identifier
 * does not count. `FOR UPDATE` locks rows; it does not change them.
 *
 * It errs towards "writes": a false yes costs a ticked box, a false no costs
 * data. What it cannot see is a function with side effects — `SELECT purge()`
 * — which nothing short of the server can.
 */
export function hasWriteVerb(sql: string): boolean {
  const masked = maskLiterals(sql);
  const re = /\b(insert|update|delete|merge|into)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    if (m[1].toLowerCase() === "update" && /\b(for|key)$/i.test(masked.slice(0, m.index).trimEnd())) continue;
    return true;
  }
  return false;
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

/**
 * What was typed into a parameter box, as the value to bind: the text, or
 * null for an empty box or the word `null`.
 *
 * Nothing is guessed from the characters. The driver sends a text parameter
 * in text format and the server parses it for the placeholder's own type, as
 * it would a quoted literal. Guessing here was wrong whenever the guess and
 * the placeholder disagreed: `007` for a text column became the number 7,
 * `true` for a text column could not be bound, and a decimal went through a
 * double — `0.1234567890123456789` for a numeric lost its last digits.
 */
export function coerceParam(raw: string): string | null {
  const t = raw.trim();
  if (t === "" || t.toLowerCase() === "null") return null;
  return raw;
}

/** Environment badge colours, as theme tokens so the badge follows the light
 *  and dark palettes. Each pair is text on its own tint over an island, held
 *  to 4.5:1 by styles.contrast.test.ts. */
export const ENV_COLORS: Record<string, { color: string; bg: string }> = {
  dev: { color: "var(--tn-success)", bg: "var(--tn-success-tint)" },
  test: { color: "var(--tn-ts)", bg: "var(--tn-s2)" },
  staging: { color: "var(--tn-warning)", bg: "var(--tn-warn-tint)" },
  prod: { color: "var(--tn-danger)", bg: "var(--tn-danger-tint)" },
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
