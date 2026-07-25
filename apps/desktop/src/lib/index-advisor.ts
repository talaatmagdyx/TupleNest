/**
 * Index advisor.
 *
 * The plan analyzer already *names* the nodes that want an index — a Seq Scan
 * that dominates, a filter that throws away most of what it reads. This turns
 * that observation into the statement you would actually run: it reads the
 * node's own `Filter`, works out which columns it tests and how, and writes a
 * `CREATE INDEX` following the one rule that governs a btree's usefulness —
 * every equality column first, then a single range column, because a btree can
 * seek on the equality prefix and one range boundary and no further.
 *
 * It is deliberately conservative. A suggestion that is *wrong* is worse than
 * no suggestion: someone runs it, waits out the build on a large table, and the
 * planner ignores the index. So the cases where a plain composite btree is not
 * the answer are declined rather than guessed at —
 *
 *   - `OR` between predicates: the planner wants a separate index per branch
 *     (or a bitmap OR of them), not one composite; recommending a composite
 *     would mislead.
 *   - a cast on the column side (`(created_at)::date = …`): a plain index on
 *     the column cannot serve it — that needs an expression index, which is a
 *     different and riskier recommendation.
 *   - a join predicate (`a.x = b.y`, column against column): indexing helps,
 *     but which side and which table is a judgement this does not make blind.
 *   - `<>` / `!=`: a btree cannot seek an inequality.
 *
 * None of these throw; they simply produce nothing, so the advisor is silent
 * exactly when it is unsure.
 */

import type { RawPlan } from "./explain";

export type IndexSuggestion = {
  /** Table the index is on, schema-qualified when the plan carried a schema. */
  table: string;
  /** Ordered column list: equality columns, then at most one range column. */
  columns: string[];
  /** The statement, ready to run — `CREATE INDEX ON t (a, b);` (server names it). */
  ddl: string;
  /** Why this node earned a suggestion, in one line. */
  reason: string;
};

/* -------------------------------------------------------------- attr readers */

const attrText = (n: RawPlan, key: string): string | null => {
  const v = n[key];
  return typeof v === "string" ? v : null;
};
const attrNum = (n: RawPlan, key: string): number | null => {
  const v = n[key];
  return typeof v === "number" ? v : null;
};

/* --------------------------------------------------------------- thresholds */

/** A residual filter on a node that *already* uses an index only earns a
 *  suggestion when it discards real volume — otherwise the existing index is
 *  almost certainly fine and a second one is just write overhead. A bare Seq
 *  Scan needs no such gate: scanning the whole table to apply a filter is the
 *  signal by itself. */
const RESIDUAL_FILTER_MIN_ROWS = 1000;

/* ------------------------------------------------------------ identifiers */

// No `i` flag on purpose: PostgreSQL folds an *unquoted* identifier to lower
// case, so `UserId` and `"UserId"` are different columns. A mixed-case name has
// to be quoted to mean itself — treating it as plain would emit a statement
// that indexes the wrong (lower-cased) column.
const PLAIN_IDENT = /^[a-z_][a-z0-9_$]*$/;

/** A single SQL identifier as it appears in a plan's condition text: either a
 *  double-quoted name (which may contain spaces, dots and doubled `""`) or a
 *  plain one. Used to build the predicate scanner. */
const IDENT = String.raw`(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)`;

/** Quote an identifier only when it is not already a plain lower-case name, so
 *  ordinary tables read cleanly and a `"weird Name"` still comes out valid. */
function quoteIdent(id: string): string {
  return PLAIN_IDENT.test(id) ? id : `"${id.replace(/"/g, '""')}"`;
}

/** `schema.table`, quoting each part, with the schema included only when the
 *  plan actually reported one (it does only under VERBOSE). */
function qualify(schema: string | null, table: string): string {
  const t = quoteIdent(table);
  return schema ? `${quoteIdent(schema)}.${t}` : t;
}

/* --------------------------------------------------------------- predicates */

type PredKind = "eq" | "range";
type Pred = { column: string; kind: PredKind };

/** The final component of a possibly-qualified, possibly-quoted reference, with
 *  its quotes removed — `o.status` → `status`, `"s"."Order Status"` → the raw
 *  `Order Status`. Splitting has to respect quotes so a dot *inside* a quoted
 *  name is not treated as a separator. Within one scan node every column
 *  belongs to that node's relation, so dropping the qualifier is safe. */
function bareColumn(ref: string): string {
  const parts: string[] = [];
  let i = 0;
  while (i < ref.length) {
    if (ref[i] === '"') {
      let buf = "";
      let j = i + 1;
      while (j < ref.length) {
        if (ref[j] === '"' && ref[j + 1] === '"') {
          buf += '"';
          j += 2;
          continue;
        }
        if (ref[j] === '"') {
          j++;
          break;
        }
        buf += ref[j++];
      }
      parts.push(buf);
      i = ref[j] === "." ? j + 1 : j;
    } else {
      let j = i;
      while (j < ref.length && ref[j] !== ".") j++;
      parts.push(ref.slice(i, j));
      i = j + 1;
    }
  }
  return parts[parts.length - 1] ?? "";
}

/**
 * Pull the indexable predicates out of a PostgreSQL condition string.
 *
 * Returns null — not an empty list — when the shape is one the advisor refuses
 * to guess at (an `OR`, so the caller emits nothing for that node). An empty
 * list means "looked, found nothing indexable here", which reads the same to
 * the caller but keeps the two intentions distinct.
 */
export function extractPredicates(raw: string): Pred[] | null {
  // Mask string literals first: a value like 'error code' or 'a or b' must not
  // be mistaken for structure. Postgres doubles embedded quotes, which this
  // collapses harmlessly — we only need the literal gone, not preserved.
  const masked = raw.replace(/'(?:[^']|'')*'/g, "§");

  // OR anywhere means a single composite btree is the wrong tool. Decline.
  if (/\bor\b/i.test(masked)) return null;

  // Strip casts: `§::text`, `col::date`, `x::numeric(10,2)`, `y::text[]`. A cast
  // on a *column* is handled separately below (it makes the column unindexable
  // by a plain index); here we only clear casts off literals so operators parse.
  const noCasts = masked.replace(/::\s*"?[a-z_][a-z0-9_ ]*"?(\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\))?(\s*\[\s*\])*/gi, "");

  const preds: Pred[] = [];
  const seen = new Set<string>();

  // column  OP  rhs   — longer operators first so `>=` is not read as `>`. The
  // column may be quoted (`"Order Status"`, which can hold spaces and dots) or
  // plain, and optionally qualified by a table/alias.
  const re = new RegExp(`(${IDENT}(?:\\.${IDENT})?)\\s*(>=|<=|<>|!=|=|>|<)\\s*(\\S+)`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(noCasts)) !== null) {
    const [, lhsRaw, op, rhsRaw] = m;

    // A cast on the column side — `(created_at)::date` — cannot be served by a
    // plain index on the column; it needs an expression index, which is a
    // different recommendation. The cast survives in `masked` (only literals
    // were masked, not casts), so detect it there and decline.
    if (columnWasCast(masked, lhsRaw)) continue;

    const rhs = rhsRaw.replace(/^\(+/, ""); // a leading paren from `(a = 1)`
    if (isColumnReference(rhs)) continue; // join predicate: col = col

    const column = bareColumn(lhsRaw);
    if (!column) continue;

    let kind: PredKind;
    if (op === "=") {
      kind = "eq"; // includes `= ANY (…)` — the planner can index that
    } else if (op === ">" || op === ">=" || op === "<" || op === "<=") {
      kind = "range";
    } else {
      continue; // <> / != : a btree cannot seek an inequality
    }

    // Keep the strongest classification per column: an equality use beats a
    // range use (a column tested both ways, e.g. BETWEEN, stays one range col).
    const key = column;
    if (seen.has(key)) {
      if (kind === "eq") {
        const existing = preds.find((p) => p.column === key);
        if (existing) existing.kind = "eq";
      }
      continue;
    }
    seen.add(key);
    preds.push({ column, kind });
  }
  return preds;
}

/** Operators that put a value on the right; shared by the predicate and
 *  expression scanners. */
const OP = String.raw`(?:>=|<=|<>|!=|=|>|<)`;

/** Function names that are really SQL keywords wearing parentheses. A btree
 *  expression index over `not (…)` or `in (…)` is nonsense, so they are never
 *  read as a function-on-a-column. */
const NOT_A_FUNCTION = new Set([
  "not", "and", "or", "in", "exists", "case", "when", "then", "else", "end",
  "between", "like", "ilike", "similar", "all", "any", "some",
]);

/**
 * Functions PostgreSQL will actually let you build an index on.
 *
 * `CREATE INDEX` rejects any expression that is not IMMUTABLE — the index is a
 * stored answer, so an expression whose result can change for the same input
 * would silently rot. The catch is that volatility is a property of the
 * *resolved overload*, not the name: `date_trunc('day', timestamptz)` is
 * STABLE because it depends on the session TimeZone, while the same call on a
 * plain `timestamp` is IMMUTABLE. A plan gives us the function name and the
 * column name, never the column's type, so we cannot tell those two apart.
 *
 * So the rule is a name is allowed only when *every* overload of it is
 * IMMUTABLE. This list was not written from memory — it was generated by
 * asking a live PostgreSQL 18 which candidates satisfy that, and it removed
 * four names that looked obviously safe: `date_trunc`, `to_char`, `concat`,
 * and `length` (which has a stable two-argument encoding form).
 *
 *     SELECT proname, bool_and(provolatile = 'i')
 *     FROM pg_proc GROUP BY proname;
 *
 * Anything not on this list is declined rather than guessed at, because a
 * `CREATE INDEX` that errors out is worse than no suggestion: it costs the
 * reader the time to run it and the trust to read the next one.
 */
const IMMUTABLE_FUNCTIONS = new Set([
  "abs", "ascii", "btrim", "ceil", "ceiling", "char_length", "encode", "floor",
  "initcap", "left", "lower", "ltrim", "md5", "mod", "octet_length", "power",
  "replace", "reverse", "right", "round", "rtrim", "sign", "split_part",
  "sqrt", "substr", "substring", "to_hex", "translate", "trunc", "upper",
]);

/**
 * Expression predicates a *plain* column index cannot serve — a function on a
 * column (`lower(email)`) or a cast (`(created_at)::date`). Each returned string
 * is the expression text exactly as the plan wrote it, ready to drop inside the
 * double parens an expression index needs: `CREATE INDEX ON t ((expr))`.
 *
 * The text is preserved verbatim on purpose. PostgreSQL uses an expression
 * index only when the indexed expression matches the query's character for
 * character after its own normalisation — reformatting it, or losing a literal
 * argument like the `'day'` in `date_trunc('day', ts)`, yields an index the
 * planner silently ignores. So literals are masked only to *find* structure,
 * never to build the suggestion.
 *
 * Conservative like the column path: nothing when the filter contains `OR`,
 * only expressions over exactly one column, and only against a value (not
 * another column).
 */
export function extractExpressionIndexes(raw: string): string[] {
  const masked = raw.replace(/'(?:[^']|'')*'/g, "§");
  if (/\bor\b/i.test(masked)) return [];

  const out: string[] = [];
  const seen = new Set<string>();
  const add = (expr: string) => {
    const e = expr.trim();
    if (e && !seen.has(e)) {
      seen.add(e);
      out.push(e);
    }
  };

  // Casts are deliberately absent.
  //
  // `(created_at)::date` was suggested here until a round-trip against a live
  // PostgreSQL 18 rejected the statement outright:
  //
  //     ERROR: functions in index expression must be marked IMMUTABLE
  //
  // A cast from `timestamptz` to `date` reads the session TimeZone, so it is
  // STABLE and cannot be indexed; the same cast from a plain `timestamp` is
  // IMMUTABLE and can. Which one applies depends on the column's type, and a
  // plan never states it — so every cast suggestion was a coin flip on whether
  // the statement would even run. Declined until the advisor has the column
  // types to decide with.
  //
  // A function call whose argument list references exactly one column. `[^()]*`
  // keeps the match to a single, un-nested call — enough for the common
  // `lower(col)` case without trying to parse arbitrary nesting.
  const fnRe = new RegExp(String.raw`([a-z_][a-z0-9_]*\s*\([^()]*\))\s*${OP}\s*(\S+)`, "gi");
  let m: RegExpExecArray | null;
  while ((m = fnRe.exec(raw)) !== null) {
    const expr = m[1];
    const name = (/^[a-z_][a-z0-9_]*/.exec(expr)?.[0] ?? "").toLowerCase();
    if (NOT_A_FUNCTION.has(name)) continue;
    // Only functions that are IMMUTABLE in every overload; see the set above.
    if (!IMMUTABLE_FUNCTIONS.has(name)) continue;
    if (isColumnReference(m[2])) continue;
    if (exprColumnCount(expr) !== 1) continue;
    add(expr);
  }

  return out;
}

/** How many distinct columns a function-call expression references. Literals
 *  are masked, and numbers, keywords and the function name never count — so
 *  `lower(email)` is 1, `date_trunc('day', ts)` is 1, `coalesce(a, b)` is 2,
 *  and a type modifier like `numeric(10,2)` is 0. Used to hold expression-index
 *  suggestions to the unambiguous single-column case. */
function exprColumnCount(fnCall: string): number {
  const open = fnCall.indexOf("(");
  const args = fnCall.slice(open + 1, fnCall.lastIndexOf(")"));
  // Mask literals, then strip casts, so the *type* name in `'day'::text` is not
  // miscounted as a column. Bounded by the comma/end of each argument.
  const masked = args
    .replace(/'(?:[^']|'')*'/g, "§")
    .replace(/::\s*"?[a-z_][a-z0-9_ ]*"?(\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\))?(\s*\[\s*\])*/gi, "");
  const cols = new Set<string>();
  // Match qualified references as one token so `t.email` counts as a single
  // column, not two.
  const idRe = new RegExp(`${IDENT}(?:\\.${IDENT})*`, "g");
  let m: RegExpExecArray | null;
  while ((m = idRe.exec(masked)) !== null) {
    const tok = m[0];
    if (
      /^(true|false|null|current_date|current_timestamp|current_time|localtime|localtimestamp|interval|distinct)$/i.test(
        tok,
      )
    ) {
      continue;
    }
    cols.add(bareColumn(tok).toLowerCase());
  }
  return cols.size;
}

/** True when `col` appears cast in the (literal-masked) source, i.e. followed
 *  by `::`. A qualified `t.col::date` and a parenthesised `(col)::date` both
 *  count. */
function columnWasCast(masked: string, col: string): boolean {
  // Escape every regex metacharacter in the raw column token so an identifier
  // like `"a.b"` or `weird$name` cannot corrupt the pattern.
  const lit = col.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // The lookbehind stops `at` from matching inside `created_at`; it sits fine
  // before a leading `"` on a quoted token too.
  return new RegExp(`(?<![A-Za-z0-9_$])${lit}\\s*\\)?\\s*::`, "i").test(masked);
}

/** Does the right-hand side look like another column rather than a value?
 *  Values after masking/cast-stripping are `§` (a literal), a number, `$1`, a
 *  function call `now(`, an array `ARRAY[` or `ANY (`, or a keyword. A bare
 *  word that is none of those is a column reference — the mark of a join. */
function isColumnReference(rhs: string): boolean {
  const t = rhs.replace(/[(),]+$/g, "");
  if (t === "" || t === "§") return false; // masked literal
  if (/^[§\d$]/.test(t)) return false; // literal, number, or $-param
  if (/^-?\d/.test(t)) return false; // signed number
  // ANY / ALL / a function call / array constructor — all values, not columns.
  if (/^(any|all|array)\b/i.test(t)) return false;
  if (/\(/.test(rhs)) return false; // now(), coalesce(...), etc.
  if (/^(true|false|null|current_date|current_timestamp|current_time|localtime|localtimestamp)$/i.test(t)) return false;
  // What's left — `other_col`, `b.id` — is a column reference.
  return /^[a-z_"][a-z0-9_$.".]*$/i.test(t);
}

/* ------------------------------------------------------------ column ordering */

/** Order columns for a btree: every equality column (in first-seen order),
 *  then at most one range column. Columns after the first range boundary give a
 *  btree nothing to seek on, so they are left out on purpose. */
function orderColumns(preds: Pred[]): string[] {
  const eq = preds.filter((p) => p.kind === "eq").map((p) => p.column);
  const firstRange = preds.find((p) => p.kind === "range" && !eq.includes(p.column));
  return firstRange ? [...eq, firstRange.column] : eq;
}

/* ---------------------------------------------------------------- the walk */

const SCAN_WITH_FILTER = /^(seq scan|index scan|index only scan|bitmap heap scan)$/i;

/** Whether a node's residual filter is worth an index. A Seq Scan always is
 *  (the filter *is* the whole read); an already-indexed scan only when its
 *  leftover filter discarded real volume. */
function filterWorthIndexing(nodeType: string, rowsRemoved: number | null): boolean {
  if (/^seq scan$/i.test(nodeType)) return true;
  return (rowsRemoved ?? 0) >= RESIDUAL_FILTER_MIN_ROWS;
}

function reasonFor(nodeType: string, table: string, rowsRemoved: number | null): string {
  if (/^seq scan$/i.test(nodeType)) {
    return rowsRemoved != null && rowsRemoved > 0
      ? `Seq Scan on ${table} reads the whole table and its filter discards ${rowsRemoved.toLocaleString()} rows.`
      : `Seq Scan on ${table} reads the whole table to apply this filter.`;
  }
  const removed = rowsRemoved != null ? rowsRemoved.toLocaleString() : "many";
  return `${nodeType} on ${table} applies a residual filter that discards ${removed} rows the index did not narrow.`;
}

function reasonForExpr(nodeType: string, table: string, expr: string): string {
  if (/^seq scan$/i.test(nodeType)) {
    return `Seq Scan on ${table} filters on ${expr}; a plain column index cannot serve an expression — an expression index can.`;
  }
  return `${nodeType} on ${table} applies a residual filter on ${expr}; only an expression index can serve it.`;
}

/**
 * Walk a raw FORMAT JSON plan and return the index statements its scans imply.
 *
 * Accepts the parsed JSON exactly as the server returns it — either the
 * `[{ "Plan": … }]` array or a bare plan object — and returns an empty list for
 * anything it cannot walk, never throwing: a plan we cannot read is a missing
 * suggestion, not a crash.
 */
export function suggestIndexes(parsed: unknown): IndexSuggestion[] {
  const root = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, unknown> | null;
  const plan = root?.["Plan"] as RawPlan | undefined;
  if (!plan || typeof plan !== "object") return [];

  const out: IndexSuggestion[] = [];
  const seen = new Set<string>(); // dedupe identical statements across nodes, by DDL

  const emit = (s: IndexSuggestion) => {
    if (!seen.has(s.ddl)) {
      seen.add(s.ddl);
      out.push(s);
    }
  };

  const walk = (n: RawPlan) => {
    const nodeType = attrText(n, "Node Type") ?? "";
    const relation = attrText(n, "Relation Name");
    const filter = attrText(n, "Filter");

    if (SCAN_WITH_FILTER.test(nodeType) && relation && filter) {
      const rowsRemoved = attrNum(n, "Rows Removed by Filter");
      if (filterWorthIndexing(nodeType, rowsRemoved)) {
        const table = qualify(attrText(n, "Schema"), relation);

        // Plain columns → one composite btree.
        const preds = extractPredicates(filter);
        if (preds) {
          const columns = orderColumns(preds);
          if (columns.length > 0) {
            const cols = columns.map(quoteIdent).join(", ");
            emit({
              table,
              columns,
              ddl: `CREATE INDEX ON ${table} (${cols});`,
              reason: reasonFor(nodeType, relation, rowsRemoved),
            });
          }
        }

        // Function/cast expressions → one expression index each.
        for (const expr of extractExpressionIndexes(filter)) {
          emit({
            table,
            columns: [expr],
            ddl: `CREATE INDEX ON ${table} ((${expr}));`,
            reason: reasonForExpr(nodeType, relation, expr),
          });
        }
      }
    }

    for (const c of n.Plans ?? []) walk(c);
  };
  walk(plan);
  return out;
}
