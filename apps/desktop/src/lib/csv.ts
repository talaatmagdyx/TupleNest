/** Phase 4 — CSV parsing and type inference for the import wizard.
 *
 *  Pure functions, unit tested. A real RFC-4180 parser: quoted fields, escaped
 *  quotes, embedded newlines and commas. Hand-rolled rather than pulled from a
 *  dependency so the import path has no supply-chain surface.
 */

export type CsvTable = { header: string[]; rows: string[][] };

/** Parse RFC-4180 CSV. `delimiter` is usually "," but TSV works too. */
export function parseCsv(text: string, delimiter = ","): CsvTable {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  let inQuotes = false;
  let fieldWasQuoted = false;

  // Strip a UTF-8 BOM — Excel loves emitting one and it corrupts the first header.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const endField = () => {
    row.push(field);
    field = "";
    fieldWasQuoted = false;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'; // escaped quote
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }

    if (c === '"' && field === "") {
      inQuotes = true;
      fieldWasQuoted = true;
      i++;
      continue;
    }
    if (c === delimiter) {
      endField();
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }
    if (c === "\n") {
      endRow();
      i++;
      continue;
    }
    field += c;
    i++;
  }

  // Trailing field/row, unless the file simply ended with a newline.
  if (field !== "" || fieldWasQuoted || row.length > 0) endRow();

  const header = rows.shift() ?? [];
  return { header, rows };
}

export type InferredType = "int8" | "numeric" | "boolean" | "timestamptz" | "date" | "text";

const INT_RE = /^-?\d{1,18}$/;
const NUM_RE = /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const BOOL_RE = /^(true|false|t|f|yes|no|y|n|0|1)$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TS_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[-+]\d{2}:?\d{2})?$/;

const isBlank = (v: string) => v.trim() === "";

/** Best Postgres type for a column of raw CSV strings.
 *  Conservative: anything that doesn't fit cleanly becomes `text`, because a
 *  wrong-but-narrow type loses data while `text` never does. */
export function inferType(values: string[]): InferredType {
  const vals = values.filter((v) => !isBlank(v));
  if (vals.length === 0) return "text";

  const all = (re: RegExp) => vals.every((v) => re.test(v.trim()));

  // Bools before ints: a column of only 0/1 is ambiguous, and an integer
  // reading is far more often what people mean.
  if (all(BOOL_RE) && !all(INT_RE)) return "boolean";
  if (all(INT_RE)) return "int8";
  if (all(NUM_RE)) return "numeric";
  if (all(DATE_RE)) return "date";
  if (all(TS_RE)) return "timestamptz";
  return "text";
}

export function inferTypes(t: CsvTable, sample = 500): InferredType[] {
  return t.header.map((_, ci) => inferType(t.rows.slice(0, sample).map((r) => r[ci] ?? "")));
}

/** Turn an arbitrary CSV header into a safe, unique snake_case column name. */
export function normalizeColumnName(raw: string, taken: Set<string>): string {
  let n = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!n) n = "column";
  if (/^\d/.test(n)) n = `c_${n}`; // can't start with a digit
  n = n.slice(0, 63); // Postgres identifier limit

  let out = n;
  let k = 2;
  while (taken.has(out)) out = `${n}_${k++}`;
  taken.add(out);
  return out;
}

export function normalizeHeader(header: string[]): string[] {
  const taken = new Set<string>();
  return header.map((h) => normalizeColumnName(h, taken));
}

const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;

export function buildCreateTable(
  schema: string,
  table: string,
  columns: { name: string; type: InferredType }[]
): string {
  const cols = columns.map((c) => `  ${quoteIdent(c.name)} ${c.type}`).join(",\n");
  return `CREATE TABLE ${quoteIdent(schema)}.${quoteIdent(table)} (\n${cols}\n)`;
}

/** A parameterised multi-row INSERT for one batch.
 *
 *  Every value is bound as **text** and cast in SQL, rather than bound as a
 *  native JS type. Three reasons:
 *
 *   1. tokio-postgres refuses to bind a JS number to `numeric` or a string to
 *      `date` — the types must match exactly, so native binding fails outright.
 *   2. Routing a decimal through a JS `number` is lossy: `numeric` is arbitrary
 *      precision, an f64 is not. Text preserves the digits the user gave us.
 *   3. It is what COPY and psql do — Postgres' own parsers accept every literal
 *      form we might see, so we don't reimplement date parsing in TypeScript.
 *
 *  Note the *double* cast `$1::text::numeric`. A single `$1::numeric` does not
 *  work: Postgres infers the parameter's type from the cast, so `$1` would be
 *  inferred as `numeric` and we'd be back to binding text to a numeric param.
 *  Casting to `text` first pins the parameter to text, then converts.
 *
 *  Values are still bound, never interpolated.
 */
export function buildInsert(
  schema: string,
  table: string,
  columns: { name: string; type: InferredType }[],
  rows: string[][]
): { sql: string; params: unknown[] } {
  if (rows.length === 0) throw new Error("buildInsert: no rows");
  const params: unknown[] = [];
  const tuples = rows.map((r) => {
    const ph = columns.map((c, ci) => {
      params.push(coerceCell(r[ci] ?? "", c.type));
      return c.type === "text" ? `$${params.length}::text` : `$${params.length}::text::${c.type}`;
    });
    return `(${ph.join(", ")})`;
  });
  const colList = columns.map((c) => quoteIdent(c.name)).join(", ");
  return {
    sql: `INSERT INTO ${quoteIdent(schema)}.${quoteIdent(table)} (${colList}) VALUES ${tuples.join(", ")}`,
    params,
  };
}

/** One CSV cell as the text Postgres will cast, or NULL for a blank.
 *  A blank cell means NULL rather than an empty string — matching COPY's
 *  default `\N` semantics and avoiding '' in a numeric column. */
export function coerceCell(raw: string, type: InferredType): string | null {
  const v = raw.trim();
  if (v === "") return null;
  // Text keeps its original spacing; everything else is a literal Postgres
  // parses, where surrounding whitespace is noise.
  return type === "text" ? raw : v;
}
