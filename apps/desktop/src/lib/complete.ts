/** Schema-aware SQL completion engine.
 *
 *  Pure functions only — no React, no IPC — so the context logic is unit
 *  testable. The UI layer (SqlEditor) renders whatever `getCompletions`
 *  returns and applies the [from,to) replacement range.
 */

import type { DbColumn } from "../ipc/types";
import { tableKey } from "./nodes";

export type CatalogTable = { schema: string; name: string; kind: string };

export type Catalog = {
  schemas: string[];
  /** Every table/view we know about across loaded schemas. */
  tables: CatalogTable[];
  /** "schema.table" → columns. Populated lazily; missing is fine. */
  columns: Record<string, DbColumn[]>;
  /** Schema to assume for unqualified names (usually "public"). */
  searchPath: string[];
};

export type CompletionKind = "keyword" | "schema" | "table" | "view" | "column" | "function";

export type CompletionItem = {
  label: string;
  kind: CompletionKind;
  /** Right-aligned hint: data type, table name, "keyword", … */
  detail?: string;
  /** Text to insert; defaults to `label`. */
  insert?: string;
  /** Higher sorts first within the same kind. */
  boost?: number;
};

export type CompletionResult = {
  items: CompletionItem[];
  /** Replacement range in the source string. */
  from: number;
  to: number;
};

/** A table referenced by the statement, with its alias if any. */
export type TableRef = { schema: string | null; name: string; alias: string | null };

const KEYWORDS = [
  "select", "from", "where", "group by", "order by", "having", "limit", "offset",
  "join", "inner join", "left join", "right join", "full join", "cross join", "on", "using",
  "insert into", "values", "update", "set", "delete from", "returning",
  "create table", "create index", "create view", "alter table", "drop table",
  "distinct", "as", "and", "or", "not", "in", "exists", "between", "like", "ilike",
  "is null", "is not null", "case", "when", "then", "else", "end",
  "union", "union all", "intersect", "except", "with", "recursive",
  "asc", "desc", "nulls first", "nulls last", "primary key", "foreign key",
  "references", "default", "null", "true", "false", "begin", "commit", "rollback",
  "explain", "analyze", "vacuum", "cast", "coalesce",
];

const FUNCTIONS = [
  "count", "sum", "avg", "min", "max", "now", "current_date", "current_timestamp",
  "coalesce", "nullif", "greatest", "least", "length", "lower", "upper", "trim",
  "substring", "replace", "concat", "concat_ws", "split_part", "to_char", "to_date",
  "to_timestamp", "date_trunc", "extract", "age", "generate_series", "array_agg",
  "string_agg", "json_agg", "jsonb_agg", "row_number", "rank", "dense_rank",
  "lag", "lead", "first_value", "last_value", "unnest", "cardinality",
];

const IDENT = /[A-Za-z0-9_$]/;

/** Opening dollar-quote tag at `i` — `$$` or `$tag$` — or null. */
function dollarTagAt(sql: string, i: number): string | null {
  if (sql[i] !== "$") return null;
  // A tag is $$ or $ident$. Anything else starting with $ is a parameter
  // ($1) or part of an identifier, and must not be treated as a quote.
  let j = i + 1;
  while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j])) j++;
  if (sql[j] !== "$") return null;
  const tag = sql.slice(i, j + 1);
  // $1$ would be a parameter followed by junk, not a tag: PostgreSQL tags
  // cannot start with a digit.
  if (/^\$\d/.test(tag)) return null;
  return tag;
}

/**
 * Blank out comments and string/identifier literals so keyword scanning never
 * trips over their contents. Length is preserved so offsets stay valid.
 *
 * Handles the four things PostgreSQL actually has and a naive masker misses:
 *
 *  - **Dollar-quoting** (`$$ … $$`, `$tag$ … $tag$`). Function bodies are
 *    written this way, so without it a `;` inside a body split statements and a
 *    lone apostrophe in a comment inside a body opened a phantom string that
 *    swallowed the rest of the query.
 *  - **Nested block comments.** PostgreSQL nests them; C does not. Stopping at
 *    the first close marker leaks the tail of the comment back into the "code"
 *    stream.
 *  - **E-prefixed escape strings**, where a backslash escapes the closing quote.
 *  - Doubled quotes as escapes, which it already did.
 */
export function maskLiterals(sql: string): string {
  const out = sql.split("");
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    const tag = dollarTagAt(sql, i);
    if (two === "--") {
      let j = sql.indexOf("\n", i);
      if (j === -1) j = sql.length;
      blank(i, j);
      i = j;
    } else if (two === "/*") {
      // Nested: count depth rather than taking the first `*/`.
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql.slice(j, j + 2) === "/*") {
          depth++;
          j += 2;
        } else if (sql.slice(j, j + 2) === "*/") {
          depth--;
          j += 2;
        } else j++;
      }
      blank(i, j);
      i = j;
    } else if (tag) {
      const close = sql.indexOf(tag, i + tag.length);
      const j = close === -1 ? sql.length : close + tag.length;
      // Blank the body but leave the tags themselves: they are not identifiers
      // and cannot be mistaken for keywords.
      blank(i + tag.length, close === -1 ? sql.length : close);
      i = j;
    } else if (sql[i] === "'" || sql[i] === '"') {
      const q = sql[i];
      // E'…' / e'…' honour backslash escapes; plain '…' does not.
      const escaped = q === "'" && i > 0 && /[Ee]/.test(sql[i - 1]) && !IDENT.test(sql[i - 2] ?? " ");
      let j = i + 1;
      while (j < sql.length) {
        if (escaped && sql[j] === "\\") j += 2;
        else if (sql[j] === q && sql[j + 1] === q) j += 2;
        else if (sql[j] === q) {
          j++;
          break;
        } else j++;
      }
      blank(i + 1, j - 1);
      i = j;
    } else i++;
  }
  return out.join("");
}

/** The statement (split on top-level `;`) containing `cursor`. */
export function statementAt(sql: string, cursor: number): { text: string; start: number } {
  const masked = maskLiterals(sql);
  let start = 0;
  for (let i = 0; i < cursor && i < masked.length; i++) if (masked[i] === ";") start = i + 1;
  let end = masked.indexOf(";", cursor);
  if (end === -1) end = sql.length;
  return { text: sql.slice(start, end), start };
}

/** Identifier being typed at the cursor, plus an optional `alias.` / `schema.` qualifier. */
export function wordAt(sql: string, cursor: number): { word: string; from: number; qualifier: string | null } {
  let from = cursor;
  while (from > 0 && IDENT.test(sql[from - 1])) from--;
  const word = sql.slice(from, cursor);

  let qualifier: string | null = null;
  if (from > 0 && sql[from - 1] === ".") {
    const qEnd = from - 1;
    let qStart = qEnd;
    while (qStart > 0 && IDENT.test(sql[qStart - 1])) qStart--;
    if (qEnd > qStart) qualifier = sql.slice(qStart, qEnd);
  }
  return { word, from, qualifier };
}

const CLAUSE_RE =
  /\b(select|from|where|group\s+by|order\s+by|having|join|on|using|insert\s+into|values|update|set|delete\s+from|returning|into)\b/gi;

/** Which clause the cursor sits in — drives whether we suggest tables or columns. */
export function clauseAt(sql: string, cursor: number): string | null {
  const masked = maskLiterals(sql).slice(0, cursor);
  let last: string | null = null;
  CLAUSE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CLAUSE_RE.exec(masked)) !== null) last = m[1].toLowerCase().replace(/\s+/g, " ");
  return last;
}

const NOT_ALIAS = new Set([
  "on", "using", "where", "group", "order", "having", "limit", "offset", "join",
  "inner", "left", "right", "full", "cross", "set", "values", "returning",
  "union", "intersect", "except", "as", "and", "or",
]);

/**
 * Like `maskLiterals`, but leaves double-quoted identifiers intact.
 *
 * The two masks exist for two different readers and must not be merged.
 * `maskLiterals` blanks `"…"` because a keyword scanner has to: a table named
 * `"where"` would otherwise look like a WHERE clause and tell the
 * destructive-statement guard there is one. But an *identifier* parser needs to
 * see `"users"` — masking it is why any quoted or mixed-case table was silently
 * uneditable, since no table reference could be found at all.
 *
 * In PostgreSQL `"…"` is always an identifier and never a string, so keeping it
 * is safe here.
 */
export function maskStrings(sql: string): string {
  const out = sql.split("");
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    const tag = dollarTagAt(sql, i);
    if (two === "--") {
      let j = sql.indexOf("\n", i);
      if (j === -1) j = sql.length;
      blank(i, j);
      i = j;
    } else if (two === "/*") {
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql.slice(j, j + 2) === "/*") {
          depth++;
          j += 2;
        } else if (sql.slice(j, j + 2) === "*/") {
          depth--;
          j += 2;
        } else j++;
      }
      blank(i, j);
      i = j;
    } else if (tag) {
      const close = sql.indexOf(tag, i + tag.length);
      const j = close === -1 ? sql.length : close + tag.length;
      blank(i + tag.length, close === -1 ? sql.length : close);
      i = j;
    } else if (sql[i] === "'") {
      const escaped = i > 0 && /[Ee]/.test(sql[i - 1]) && !IDENT.test(sql[i - 2] ?? " ");
      let j = i + 1;
      while (j < sql.length) {
        if (escaped && sql[j] === "\\") j += 2;
        else if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") {
          j++;
          break;
        } else j++;
      }
      blank(i + 1, j - 1);
      i = j;
    } else if (sql[i] === '"') {
      // Skip over it without blanking — this is the whole point.
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '"' && sql[j + 1] === '"') j += 2;
        else if (sql[j] === '"') {
          j++;
          break;
        } else j++;
      }
      i = j;
    } else i++;
  }
  return out.join("");
}

/** `foo` or `"foo bar"`, as a regex source fragment. */
const IDENT_RE = String.raw`(?:[A-Za-z_][\w$]*|"(?:[^"]|"")*")`;

/** Strip the quotes from an identifier, undoubling any embedded quote. */
export function unquoteIdent(raw: string): string {
  if (!raw.startsWith('"')) return raw;
  return raw.slice(1, -1).replace(/""/g, '"');
}

/** Tables referenced by FROM / JOIN / UPDATE / INSERT INTO, with aliases.
 *
 *  The alias group carries a negative lookahead for reserved words. Without it
 *  a query like `from users join orders` would swallow `join` as the alias of
 *  `users`, leaving nothing for the next iteration to match — so `orders`
 *  would silently go missing.
 *
 *  Quoted identifiers are understood: `from "my table" t` is a real reference,
 *  and treating it as no reference at all made every mixed-case table
 *  permanently uneditable.
 */
export function parseTableRefs(sql: string): TableRef[] {
  const masked = maskStrings(sql);
  const reserved = [...NOT_ALIAS].join("|");
  const re = new RegExp(
    String.raw`\b(?:from|join|update|insert\s+into|delete\s+from)\s+(${IDENT_RE})` +
      String.raw`(?:\s*\.\s*(${IDENT_RE}))?` +
      String.raw`(?:\s+(?:as\s+)?(?!(?:${reserved})\b)(${IDENT_RE}))?`,
    "gi"
  );
  const refs: TableRef[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    const [, a, b, aliasRaw] = m;
    const schema = b ? unquoteIdent(a) : null;
    const name = unquoteIdent(b ? b : a);
    const alias = aliasRaw ? unquoteIdent(aliasRaw) : null;
    if (!refs.some((r) => r.schema === schema && r.name === name && r.alias === alias)) {
      refs.push({ schema, name, alias });
    }
  }
  return refs;
}

/**
 * Does the FROM clause list more than one relation, or a subquery?
 *
 * `parseTableRefs` only sees what follows a `from`/`join` keyword, so the
 * second table of an old-style comma join — `from users u, logs l` — was
 * invisible to it, and `\bjoin\b` never fired. The result: a cross join
 * reported exactly one table and the grid offered it for editing. A derived
 * table (`from (select …) x`) was likewise reported as its inner table.
 *
 * Scans the FROM clause at paren depth zero, so a comma inside `coalesce(a, b)`
 * or a subquery's own FROM does not count.
 */
export function fromClauseShape(sql: string): { commaJoin: boolean; derived: boolean } {
  const masked = maskStrings(sql);
  const m = /\bfrom\b/i.exec(masked);
  if (!m) return { commaJoin: false, derived: false };
  let i = m.index + m[0].length;
  let depth = 0;
  let commaJoin = false;
  let derived = false;
  // Skip whitespace to see whether the very first thing is a subquery.
  const firstNonSpace = masked.slice(i).search(/\S/);
  if (firstNonSpace >= 0 && masked[i + firstNonSpace] === "(") derived = true;
  const ENDS = /^(where|group|having|order|limit|offset|window|union|intersect|except|returning|for)$/i;
  while (i < masked.length) {
    const ch = masked[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) commaJoin = true;
    else if (depth === 0 && /[A-Za-z_]/.test(ch)) {
      const w = /^[A-Za-z_][\w$]*/.exec(masked.slice(i))![0];
      if (ENDS.test(w)) break;
      i += w.length;
      continue;
    }
    i++;
  }
  return { commaJoin, derived };
}

function columnsFor(ref: TableRef, cat: Catalog): { cols: DbColumn[]; table: string } {
  const candidates = ref.schema ? [ref.schema] : [...cat.searchPath, ...cat.schemas];
  for (const s of candidates) {
    const key = tableKey(s, ref.name);
    if (cat.columns[key]) return { cols: cat.columns[key], table: ref.name };
  }
  return { cols: [], table: ref.name };
}

/** How well `label` matches `word`, as a coarse tier.
 *  4 exact · 3 prefix · 2 substring · 1 subsequence · -1 no match.
 *  Deliberately coarse: tier is compared before kind, and length is only ever
 *  a final tiebreak — otherwise a short keyword like `cast` would outrank a
 *  prefix-matching table just for being three characters shorter.
 */
export const matchTier = (label: string, word: string): number => {
  if (!word) return 0;
  const l = label.toLowerCase();
  const w = word.toLowerCase();
  if (l === w) return 4;
  if (l.startsWith(w)) return 3;
  if (l.includes(w)) return 2;
  let i = 0;
  for (const ch of l) if (i < w.length && ch === w[i]) i++;
  return i === w.length ? 1 : -1;
};

const KIND_RANK: Record<CompletionKind, number> = {
  column: 5, table: 4, view: 4, schema: 3, function: 2, keyword: 1,
};

/** Main entry point: what should we offer at `cursor`? */
export function getCompletions(sql: string, cursor: number, cat: Catalog): CompletionResult {
  const { word, from, qualifier } = wordAt(sql, cursor);
  const stmt = statementAt(sql, cursor);
  const clause = clauseAt(sql, cursor);
  const refs = parseTableRefs(stmt.text);
  const raw: CompletionItem[] = [];

  const wantsTables =
    clause === "from" || clause === "join" || clause === "update" ||
    clause === "insert into" || clause === "delete from" || clause === "into";

  if (qualifier) {
    // `alias.` / `table.` → that table's columns. `schema.` → that schema's tables.
    const ref = refs.find(
      (r) => r.alias?.toLowerCase() === qualifier.toLowerCase() || r.name.toLowerCase() === qualifier.toLowerCase()
    );
    if (ref) {
      const { cols } = columnsFor(ref, cat);
      for (const c of cols) {
        raw.push({
          label: c.name,
          kind: "column",
          detail: `${c.dbType}${c.primaryKey ? " · pk" : ""}`,
          boost: c.primaryKey ? 2 : 0,
        });
      }
    }
    if (cat.schemas.some((s) => s.toLowerCase() === qualifier.toLowerCase())) {
      for (const t of cat.tables.filter((t) => t.schema.toLowerCase() === qualifier.toLowerCase())) {
        raw.push({ label: t.name, kind: t.kind === "table" ? "table" : "view", detail: t.kind });
      }
    }
  } else if (wantsTables) {
    for (const s of cat.schemas) raw.push({ label: s, kind: "schema", detail: "schema" });
    for (const t of cat.tables) {
      const inPath = cat.searchPath.includes(t.schema);
      raw.push({
        label: t.name,
        kind: t.kind === "table" ? "table" : "view",
        detail: inPath ? t.kind : `${t.schema} · ${t.kind}`,
        insert: inPath ? t.name : `${t.schema}.${t.name}`,
        boost: inPath ? 2 : 0,
      });
    }
  } else {
    // Column position: columns of in-scope tables, then aliases, functions, keywords.
    for (const ref of refs) {
      const { cols, table } = columnsFor(ref, cat);
      for (const c of cols) {
        raw.push({
          label: c.name,
          kind: "column",
          detail: `${c.dbType} · ${ref.alias ?? table}`,
          boost: c.primaryKey ? 1 : 0,
        });
      }
    }
    for (const ref of refs) {
      if (ref.alias) raw.push({ label: ref.alias, kind: "table", detail: `alias · ${ref.name}` });
    }
    for (const f of FUNCTIONS) raw.push({ label: f, kind: "function", detail: "function", insert: `${f}(` });
  }

  // Keywords are noise where only an identifier is legal: nobody wants `or`
  // offered after FROM, and an exact keyword match would otherwise outrank a
  // prefix-matching table purely on match tier.
  if (!wantsTables && !qualifier) {
    for (const k of KEYWORDS) raw.push({ label: k, kind: "keyword", detail: "keyword" });
  }

  // Dedupe by label+kind, keeping the first (most specific) occurrence.
  const seen = new Set<string>();
  const uniq = raw.filter((it) => {
    const k = `${it.kind}:${it.label.toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const items = uniq
    .map((it) => ({ it, t: matchTier(it.label, word) }))
    .filter((x) => x.t >= 0)
    .sort((a, b) => {
      if (b.t !== a.t) return b.t - a.t; // match quality first
      const ka = KIND_RANK[a.it.kind] + (a.it.boost ?? 0);
      const kb = KIND_RANK[b.it.kind] + (b.it.boost ?? 0);
      if (kb !== ka) return kb - ka; // then schema knowledge over keywords
      if (a.it.label.length !== b.it.label.length) return a.it.label.length - b.it.label.length;
      return a.it.label.localeCompare(b.it.label);
    })
    .slice(0, 50)
    .map((x) => x.it);

  return { items, from, to: cursor };
}

/** Tables the current statement references — used to prefetch their columns. */
export function tablesToPrefetch(sql: string, cursor: number, searchPath: string[]): { schema: string; name: string }[] {
  const stmt = statementAt(sql, cursor);
  return parseTableRefs(stmt.text).map((r) => ({
    schema: r.schema ?? searchPath[0] ?? "public",
    name: r.name,
  }));
}

/** If the cursor sits just after `some_schema.`, the schema whose object list
 *  we need in order to complete a table name. Null when the qualifier is an
 *  alias (that wants columns, not tables) or isn't a known schema. */
export function schemaToPrefetch(sql: string, cursor: number, cat: Catalog): string | null {
  const { qualifier } = wordAt(sql, cursor);
  if (!qualifier) return null;
  const refs = parseTableRefs(statementAt(sql, cursor).text);
  if (refs.some((r) => r.alias?.toLowerCase() === qualifier.toLowerCase())) return null;
  return cat.schemas.find((s) => s.toLowerCase() === qualifier.toLowerCase()) ?? null;
}
