import { cellText } from "./text";
import { tableKey } from "./nodes";
/** Safe result-grid editing: decide whether a result is editable, and build
 *  parameterised DML for staged changes.
 *
 *  Pure functions only — this module decides what gets written to the user's
 *  database, so every rule here is unit tested. The bias is conservative: if we
 *  cannot prove a row maps to exactly one table row, editing is refused with a
 *  reason rather than guessed at.
 */

import type { Catalog } from "./complete";
import { fromClauseShape, maskLiterals, maskStrings, parseTableRefs, statementAt, unquoteIdent } from "./complete";

export type GridCol = { name: string; dbType: string };

export type EditTarget = {
  /** The SQL dialect to write in; absent is PostgreSQL. SQLite has no `::`
   *  casts and no `to_regclass`, and needs neither: it binds values to the
   *  column's affinity, and its name resolution is checked another way. */
  engine?: "postgres" | "sqlite";
  schema: string;
  table: string;
  /** Primary-key columns, with their position in the result row. */
  pk: { name: string; index: number }[];
  /** Result-column index → true when that column maps to a writable table column. */
  writable: boolean[];
  /**
   * Table column name → its type (as the catalog spells it). With it, every
   * placeholder is bound as text and cast, `$n::text::uuid`, the way CSV
   * import does. Binary-bound text was refused for uuid, timestamptz, numeric
   * and NULL ("error serializing parameter"), and a number above 2^53 was
   * rounded before it ever left JavaScript.
   */
  types?: Record<string, string>;
  /**
   * The table as the query named it, when it named no schema: `users`, not
   * `public.users`. Which schema that means is the server's decision, made
   * from the session's `search_path` — which the app does not know. `schema`
   * above is a guess from the catalog, so every UPDATE carries a test that the
   * name still resolves to the table being written (see `buildUpdate`).
   */
  resolvedFrom?: string;
};

export type Editability = { editable: true; target: EditTarget } | { editable: false; reason: string };

/** One staged cell change.
 *
 *  Identity is the primary key, never the row's position: the grid can be
 *  re-sorted after an edit is staged, and a positional key would then paint the
 *  pending value onto a different row than the one being updated.
 */
export type CellEdit = {
  /** Stable identity — `rowKey(pkValues)`. */
  rowKey: string;
  /** Primary-key values for that row, in `target.pk` order. */
  pkValues: unknown[];
  column: string;
  value: unknown;
  /**
   * What the cell held when the grid loaded it.
   *
   * This is the whole of the optimistic-concurrency check: it goes into the
   * WHERE, so the write only lands if the value is still what the user was
   * looking at when they decided to change it. Without it the edit was blind
   * last-write-wins — another session's change was overwritten with no
   * warning, no diff, and nothing to detect it, because under READ COMMITTED
   * there is no serialization error either.
   */
  oldValue: unknown;
};

/** Stable identity for a row, derived from its primary-key values. */
export function rowKey(pkValues: unknown[]): string {
  return JSON.stringify(pkValues);
}

export type Statement = { sql: string; params: unknown[] };

/** Double-quote an identifier, escaping embedded quotes. Never interpolate a
 *  raw identifier into SQL without this. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function qualifiedName(schema: string, table: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

const NUMERIC = /^(int2|int4|int8|smallint|integer|bigint|serial|bigserial|numeric|decimal|real|float4|float8|double precision|money)/i;
const BOOLEAN = /^(bool|boolean)$/i;

/** Turn the string a user typed into a JSON value the driver can bind.
 *  Unlike the generic `coerceParam`, this is type-aware: "123" stays the text
 *  "123" in a text column instead of silently becoming a number. */
export function coerceValue(raw: string, dbType: string): unknown {
  const t = raw.trim();
  if (t === "" || t.toLowerCase() === "null") return null;
  if (BOOLEAN.test(dbType)) {
    const l = t.toLowerCase();
    if (["true", "t", "yes", "y", "1"].includes(l)) return true;
    if (["false", "f", "no", "n", "0"].includes(l)) return false;
    return raw;
  }
  if (NUMERIC.test(dbType)) {
    // Exact text unless it is a number JavaScript holds exactly: Number()
    // turned 9007199254740993 into …992, and the edit wrote that.
    if (/^-?\d+(\.\d+)?$/.test(t)) {
      return /^-?\d+$/.test(t) && Number.isSafeInteger(Number(t)) ? Number(t) : t;
    }
    return raw; // let the server reject it with a real type error
  }
  return raw; // text, timestamps, json, uuid, … bind as text
}

/*
 * Shapes that break the one-row-to-one-table-row mapping the write depends on.
 *
 * This is a blocklist over masked text, not a parser, and the honest reading is
 * "conservative heuristics + a reviewed diff", not proof. It only has to be
 * wrong in one direction: refusing something editable is an inconvenience,
 * offering something that is not is a wrong write.
 */
const BLOCKERS: [RegExp, string][] = [
  [/\bgroup\s+by\b/i, "the query groups rows"],
  [/\bdistinct\b/i, "the query uses DISTINCT"],
  [/\bunion\b|\bintersect\b|\bexcept\b/i, "the query combines result sets"],
  [/\bhaving\b/i, "the query uses HAVING"],
  // Anywhere, not just at the start: `select * from (with c as (…) select …)`
  // is still a CTE, and `^\s*with` never saw it.
  [/\bwith\b[\s\S]*\bas\s*\(/i, "the query uses a CTE"],
  [/\bjoin\b/i, "the query joins more than one table"],
  [/\blateral\b/i, "the query uses LATERAL"],
];

/**
 * Which output columns are a table column and nothing else.
 *
 * Columns are matched to the table by name, and a name is whatever the query
 * says it is: `select parent_id as id` and `select id + 1 as id` both produce a
 * column called `id`. Treating that as the primary key keyed the UPDATE on a
 * value that is not the key. So a column counts only when its select-list item
 * is a bare reference — `id`, `u.id`, `"Id"` — or it arrived through `*`.
 *
 * Works on text with strings and comments masked but quoted identifiers kept,
 * and steps over those, since `"a, b"` and `"from"` are legal names.
 */
export function directColumns(stmt: string): { star: boolean; names: Set<string> } {
  const masked = maskStrings(stmt);
  const out = { star: false, names: new Set<string>() };
  const start = /\bselect\b/i.exec(masked);
  if (!start) return out;

  const items: string[] = [];
  let depth = 0;
  let from = start.index + start[0].length;
  let i = from;
  for (; i < masked.length; i++) {
    const c = masked[i];
    if (c === '"') {
      i++;
      while (i < masked.length && (masked[i] !== '"' || masked[i + 1] === '"')) i += masked[i] === '"' ? 2 : 1;
    } else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0 && c === ",") {
      items.push(masked.slice(from, i));
      from = i + 1;
    } else if (depth === 0 && /^from\b/i.test(masked.slice(i)) && !/[\w$]/.test(masked[i - 1] ?? " ")) break;
  }
  items.push(masked.slice(from, i));

  const ident = String.raw`(?:[A-Za-z_][\w$]*|"(?:[^"]|"")*")`;
  const star = new RegExp(String.raw`^(?:${ident}\s*\.\s*)?\*$`);
  const bare = new RegExp(String.raw`^(?:${ident}\s*\.\s*)?(${ident})$`);
  for (const raw of items) {
    const item = raw.trim();
    if (star.test(item)) out.star = true;
    else {
      const m = bare.exec(item);
      // Unquoted names fold to lower case, as the server folds them.
      if (m) out.names.add(m[1].startsWith('"') ? unquoteIdent(m[1]).toLowerCase() : m[1].toLowerCase());
    }
  }
  return out;
}

/** Can rows of this result be traced back to single rows of one table? */
export function analyzeEditability(sql: string, cols: GridCol[], cat: Catalog | undefined): Editability {
  if (!cat) return { editable: false, reason: "schema is still loading" };
  if (cols.length === 0) return { editable: false, reason: "the result has no columns" };

  const stmt = statementAt(sql, sql.length).text;
  const masked = maskLiterals(stmt);

  // Blockers first: they give a specific reason (a CTE would otherwise just be
  // reported as "not a SELECT", which is true but unhelpful).
  for (const [re, why] of BLOCKERS) if (re.test(masked)) return { editable: false, reason: why };
  if (!/^\s*select\b/i.test(masked)) return { editable: false, reason: "only SELECT results are editable" };

  /*
   * The FROM clause has to be looked at directly, because `parseTableRefs`
   * only sees what follows a `from`/`join` keyword:
   *
   *   from users u, logs l        → one ref (`users`), no `join` keyword
   *   from (select * from users) x → one ref (`users`), which is not the
   *                                  relation the result's rows came from
   *
   * Both used to report a single table and be offered for editing.
   */
  const shape = fromClauseShape(stmt);
  if (shape.derived) return { editable: false, reason: "the query selects from a subquery" };
  if (shape.commaJoin) return { editable: false, reason: "the query reads from more than one table" };

  const refs = parseTableRefs(stmt);
  if (refs.length !== 1) {
    return { editable: false, reason: refs.length === 0 ? "no table was detected" : "more than one table is referenced" };
  }

  const names = cols.map((c) => c.name.toLowerCase());
  if (new Set(names).size !== names.length) {
    return { editable: false, reason: "the result has duplicate column names" };
  }

  const ref = refs[0];
  const candidates = ref.schema ? [ref.schema] : [...cat.searchPath, ...cat.schemas];
  let schema: string | null = null;
  for (const s of candidates) {
    if (cat.columns[tableKey(s, ref.name)]) {
      schema = s;
      break;
    }
  }
  if (!schema) return { editable: false, reason: `columns for ${ref.name} are not loaded yet` };

  const meta = cat.tables.find(
    (t) => t.schema.toLowerCase() === schema.toLowerCase() && t.name.toLowerCase() === ref.name.toLowerCase()
  );
  if (meta && meta.kind !== "table") return { editable: false, reason: `${ref.name} is a ${meta.kind}, not a table` };

  const tableCols = cat.columns[tableKey(schema, ref.name)];
  const pkCols = tableCols.filter((c) => c.primaryKey);
  if (pkCols.length === 0) return { editable: false, reason: `${ref.name} has no primary key` };

  const direct = directColumns(stmt);
  const isDirect = (name: string) => direct.star || direct.names.has(name.toLowerCase());

  const pk: { name: string; index: number }[] = [];
  for (const c of pkCols) {
    const idx = names.indexOf(c.name.toLowerCase());
    if (idx === -1) return { editable: false, reason: `add the primary key (${c.name}) to the result to edit it` };
    if (!isDirect(c.name)) {
      return { editable: false, reason: `the key column ${c.name} is renamed or computed in this query` };
    }
    pk.push({ name: c.name, index: idx });
  }

  const pkNames = new Set(pkCols.map((c) => c.name.toLowerCase()));
  const real = new Set(tableCols.map((c) => c.name.toLowerCase()));
  // Columns the *server* computes. Offering these for editing builds an UPDATE
  // PostgreSQL will reject — the user gets a raw error from the database for a
  // cell the app told them was editable.
  const generated = new Set(
    tableCols.filter((c) => c.generated).map((c) => c.name.toLowerCase()),
  );
  // A column is writable when it is a real column of the table, is not part of
  // the primary key — editing a PK changes row identity, so we refuse it — and
  // is not computed by the server.
  const writable = cols.map((c) => {
    const n = c.name.toLowerCase();
    return real.has(n) && !pkNames.has(n) && !generated.has(n) && isDirect(n);
  });

  const types = Object.fromEntries(tableCols.map((c) => [c.name, c.dbType]));
  // Only an unqualified name is at the mercy of `search_path`. Written back
  // the way the query wrote it, so the server folds or keeps its case the same
  // way both times.
  const quoted = quoteIdent(ref.name);
  const resolvedFrom = ref.schema ? undefined : stmt.includes(quoted) ? quoted : ref.name;
  return {
    editable: true,
    target: { ...(cat.engine ? { engine: cat.engine } : {}), schema, table: ref.name, pk, writable, types, resolvedFrom },
  };
}

/** A type name safe to splice into `::type` — catalog-supplied, so checked. */
const SAFE_TYPE = /^[A-Za-z_][A-Za-z0-9_ ."]*(\(\d+(,\s*\d+)?\))?(\[\])*$/;

/** The value as the text PostgreSQL will cast, or null. */
function asText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  return JSON.stringify(v);
}

/**
 * The type to cast an edited value to, given the column's.
 *
 * Not always the column's own type. An *explicit* cast to a length-limited
 * type truncates, by the SQL standard: `'abcdefghij'::varchar(5)` is `abcde`,
 * with no error. So `SET name = $1::text::character varying(5)` stored a
 * shortened value and reported one row updated. A plain assignment of the same
 * value is refused ("value too long"), which is what an edit should get.
 *
 * So for the types where the two differ — character and bit strings — the
 * cast drops the length and the assignment to the column enforces it. `bpchar`
 * and `bit varying` rather than `character` and `bit`, which without a length
 * mean a length of one.
 */
export function castType(type: string): string {
  const m = /^(character varying|varchar|character|char|bpchar|bit varying|varbit|bit)\s*\(\d+\)((?:\[\])*)$/i.exec(
    type.trim(),
  );
  if (!m) return type;
  const base = m[1].toLowerCase();
  const to =
    base === "character varying" || base === "varchar"
      ? "character varying"
      : base.includes("bit")
        ? "bit varying"
        : "bpchar";
  return to + m[2];
}

/** `$n`, cast to the column's type when it is known: `$n::text::uuid`. */
function placeholder(
  target: Pick<EditTarget, "types" | "engine">,
  column: string,
  params: unknown[],
  value: unknown,
): string {
  const type = target.types?.[column];
  // SQLite has no casts to add: the value is bound as it is, and the
  // column's affinity converts it on the way in.
  if (target.engine === "sqlite" || !type || !SAFE_TYPE.test(type)) {
    params.push(value);
    return `$${params.length}`;
  }
  params.push(asText(value));
  return `$${params.length}::text::${castType(type)}`;
}

/** `col IS NOT DISTINCT FROM $n`. `json` has no equality operator, so it is
 *  compared as jsonb. */
function unchangedTest(
  target: Pick<EditTarget, "types" | "engine">,
  column: string,
  params: unknown[],
  old: unknown,
): string {
  if (target.engine !== "sqlite" && target.types?.[column]?.toLowerCase() === "json") {
    params.push(asText(old));
    return `${quoteIdent(column)}::jsonb IS NOT DISTINCT FROM $${params.length}::text::jsonb`;
  }
  return `${quoteIdent(column)} IS NOT DISTINCT FROM ${placeholder(target, column, params, old)}`;
}

/**
 * `UPDATE t SET a=$1 WHERE pk=$2 AND a IS NOT DISTINCT FROM $3` for one row's
 * staged cells.
 *
 * The primary key says *which* row. The old values say *which version* of it:
 * the write lands only if every cell being changed still holds what the grid
 * showed when the edit was staged. If someone else got there first, the
 * statement matches zero rows, and `useRowEdits` turns that into a refusal
 * rather than a silent overwrite.
 *
 * `IS NOT DISTINCT FROM` and not `=`, because `= NULL` is never true: with `=`,
 * editing any cell that was NULL would match nothing and every such edit would
 * be reported as a conflict.
 *
 * And the table itself is checked. `select * from users` reads whichever
 * `users` the session's `search_path` finds first; `target.schema` is where
 * the catalog guessed it was. When those differ — two tenants with the same
 * tables, a temp table shadowing a real one — an UPDATE to the guess changed a
 * row of a table the grid never showed, and passed the one-row check doing it.
 * So the statement asks the server, in the same breath as the write, whether
 * the name the query used still means the table being written. If not, it
 * matches zero rows.
 *
 * SQLite resolves an unqualified name to `temp` first, then `main`, then the
 * attached databases in order — the catalog's candidate order after `temp`.
 * So the test there is that no temporary table or view has taken the name.
 */
export function buildUpdate(
  target: Pick<EditTarget, "schema" | "table" | "pk" | "types" | "resolvedFrom" | "engine">,
  pkValues: unknown[],
  sets: { column: string; value: unknown; oldValue: unknown }[]
): Statement {
  if (sets.length === 0) throw new Error("buildUpdate: no columns to set");
  if (pkValues.length !== target.pk.length) throw new Error("buildUpdate: primary key value count mismatch");

  const params: unknown[] = [];
  const setSql = sets
    .map((s) => `${quoteIdent(s.column)} = ${placeholder(target, s.column, params, s.value)}`)
    .join(", ");
  const keyed = target.pk.map((k, i) => `${quoteIdent(k.name)} = ${placeholder(target, k.name, params, pkValues[i])}`);
  const unchanged = sets.map((s) => unchangedTest(target, s.column, params, s.oldValue));
  const same: string[] = [];
  if (target.resolvedFrom && target.engine === "sqlite") {
    if (target.schema !== "temp") {
      params.push(target.table);
      same.push(
        `NOT EXISTS (SELECT 1 FROM temp.sqlite_schema WHERE type IN ('table', 'view') AND name = $${params.length} COLLATE NOCASE)`,
      );
    }
  } else if (target.resolvedFrom) {
    params.push(target.resolvedFrom, qualifiedName(target.schema, target.table));
    same.push(`to_regclass($${params.length - 1}) = to_regclass($${params.length})`);
  }
  const whereSql = [...keyed, ...unchanged, ...same].join(" AND ");

  return { sql: `UPDATE ${qualifiedName(target.schema, target.table)} SET ${setSql} WHERE ${whereSql}`, params };
}

export function buildDelete(
  target: Pick<EditTarget, "schema" | "table" | "pk" | "types" | "engine">,
  pkValues: unknown[]
): Statement {
  if (pkValues.length !== target.pk.length) throw new Error("buildDelete: primary key value count mismatch");
  const params: unknown[] = [];
  const whereSql = target.pk
    .map((k, i) => `${quoteIdent(k.name)} = ${placeholder(target, k.name, params, pkValues[i])}`)
    .join(" AND ");
  return { sql: `DELETE FROM ${qualifiedName(target.schema, target.table)} WHERE ${whereSql}`, params };
}

/** Group staged cell edits into one UPDATE per row, keyed by primary key. */
export function buildStatements(target: EditTarget, edits: CellEdit[]): Statement[] {
  const byRow = new Map<string, CellEdit[]>();
  for (const e of edits) {
    const list = byRow.get(e.rowKey);
    if (list) list.push(e);
    else byRow.set(e.rowKey, [e]);
  }
  const out: Statement[] = [];
  for (const list of byRow.values()) {
    out.push(
      buildUpdate(
        target,
        list[0].pkValues,
        list.map((e) => ({ column: e.column, value: e.value, oldValue: e.oldValue }))
      )
    );
  }
  return out;
}

/** Human-readable preview: `$n` placeholders substituted with literals.
 *  For display only — never executed. Execution always uses bound params. */
export function previewSql(st: Statement): string {
  return st.sql.replace(/\$(\d+)/g, (_, n) => {
    const v = st.params[Number(n) - 1];
    if (v === null || v === undefined) return "NULL";
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    // `String(aJsonbValue)` is "[object Object]" — and this preview is the
    // whole point of the review step.
    return `'${cellText(v).replace(/'/g, "''")}'`;
  });
}
