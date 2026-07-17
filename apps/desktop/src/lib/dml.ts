import { cellText } from "./text";
/** Safe result-grid editing: decide whether a result is editable, and build
 *  parameterised DML for staged changes.
 *
 *  Pure functions only — this module decides what gets written to the user's
 *  database, so every rule here is unit tested. The bias is conservative: if we
 *  cannot prove a row maps to exactly one table row, editing is refused with a
 *  reason rather than guessed at.
 */

import type { Catalog } from "./complete";
import { maskLiterals, parseTableRefs, statementAt } from "./complete";

export type GridCol = { name: string; dbType: string };

export type EditTarget = {
  schema: string;
  table: string;
  /** Primary-key columns, with their position in the result row. */
  pk: { name: string; index: number }[];
  /** Result-column index → true when that column maps to a writable table column. */
  writable: boolean[];
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
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
    return raw; // let the server reject it with a real type error
  }
  return raw; // text, timestamps, json, uuid, … bind as text
}

const BLOCKERS: [RegExp, string][] = [
  [/\bgroup\s+by\b/i, "the query groups rows"],
  [/\bdistinct\b/i, "the query uses DISTINCT"],
  [/\bunion\b|\bintersect\b|\bexcept\b/i, "the query combines result sets"],
  [/\bhaving\b/i, "the query uses HAVING"],
  [/^\s*with\b/i, "the query uses a CTE"],
  [/\bjoin\b/i, "the query joins more than one table"],
];

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
    if (cat.columns[`${s}.${ref.name}`]) {
      schema = s;
      break;
    }
  }
  if (!schema) return { editable: false, reason: `columns for ${ref.name} are not loaded yet` };

  const meta = cat.tables.find(
    (t) => t.schema.toLowerCase() === schema.toLowerCase() && t.name.toLowerCase() === ref.name.toLowerCase()
  );
  if (meta && meta.kind !== "table") return { editable: false, reason: `${ref.name} is a ${meta.kind}, not a table` };

  const tableCols = cat.columns[`${schema}.${ref.name}`];
  const pkCols = tableCols.filter((c) => c.primaryKey);
  if (pkCols.length === 0) return { editable: false, reason: `${ref.name} has no primary key` };

  const pk: { name: string; index: number }[] = [];
  for (const c of pkCols) {
    const idx = names.indexOf(c.name.toLowerCase());
    if (idx === -1) return { editable: false, reason: `add the primary key (${c.name}) to the result to edit it` };
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
    return real.has(n) && !pkNames.has(n) && !generated.has(n);
  });

  return { editable: true, target: { schema, table: ref.name, pk, writable } };
}

/** `UPDATE t SET a=$1, b=$2 WHERE pk1=$3 AND pk2=$4` for one row's staged cells. */
export function buildUpdate(
  target: Pick<EditTarget, "schema" | "table" | "pk">,
  pkValues: unknown[],
  sets: { column: string; value: unknown }[]
): Statement {
  if (sets.length === 0) throw new Error("buildUpdate: no columns to set");
  if (pkValues.length !== target.pk.length) throw new Error("buildUpdate: primary key value count mismatch");

  const params: unknown[] = [];
  const setSql = sets
    .map((s) => {
      params.push(s.value);
      return `${quoteIdent(s.column)} = $${params.length}`;
    })
    .join(", ");
  const whereSql = target.pk
    .map((k, i) => {
      params.push(pkValues[i]);
      return `${quoteIdent(k.name)} = $${params.length}`;
    })
    .join(" AND ");

  return { sql: `UPDATE ${qualifiedName(target.schema, target.table)} SET ${setSql} WHERE ${whereSql}`, params };
}

export function buildDelete(
  target: Pick<EditTarget, "schema" | "table" | "pk">,
  pkValues: unknown[]
): Statement {
  if (pkValues.length !== target.pk.length) throw new Error("buildDelete: primary key value count mismatch");
  const params: unknown[] = [];
  const whereSql = target.pk
    .map((k, i) => {
      params.push(pkValues[i]);
      return `${quoteIdent(k.name)} = $${params.length}`;
    })
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
        list.map((e) => ({ column: e.column, value: e.value }))
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
