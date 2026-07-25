/** Phase 4 — CSV parsing and type inference for the import wizard.
 *
 *  Pure functions, unit tested. A real RFC-4180 parser: quoted fields, escaped
 *  quotes, embedded newlines and commas. Hand-rolled rather than pulled from a
 *  dependency so the import path has no supply-chain surface.
 */

export type CsvTable = { header: string[]; rows: string[][] };

/** Parse RFC-4180 CSV. `delimiter` is usually "," but TSV works too. */
/**
 * An RFC-4180 reader that can be fed the file a piece at a time.
 *
 * The whole-string parser this replaces could not be used on a file larger
 * than memory, and the naive fix — split on newlines, parse each piece — is
 * wrong: a quoted field may legally contain the delimiter, a newline, or both,
 * so a chunk boundary can fall inside a value. Keeping the state machine's
 * `field` / `row` / `inQuotes` across calls is what makes chunking safe, and
 * it is the same machine as before so behaviour is unchanged.
 *
 * `push` returns only the rows that were *completed* by that chunk; a row half
 * seen is retained until the rest arrives. `end` flushes the last row, which
 * matters because a file need not end with a newline.
 */
export class CsvStreamParser {
  private row: string[] = [];
  private field = "";
  private inQuotes = false;
  private fieldWasQuoted = false;
  private atStart = true;
  /** A chunk can end on `"` while the escape `""` straddles the boundary. */
  private pendingQuote = false;

  constructor(private readonly delimiter = ",") {}

  push(chunk: string): string[][] {
    const rows: string[][] = [];
    let text = chunk;

    // Strip a UTF-8 BOM — Excel loves emitting one and it corrupts the first
    // header. Only ever at the very beginning of the file, not of each chunk.
    // The `length` guard matters: an empty first chunk is not the start of any
    // content, and clearing the flag on one left a real BOM in the *next*
    // chunk unstripped. A reader handing over a zero-length chunk is perfectly
    // legal, so this is not hypothetical.
    if (this.atStart && text.length > 0) {
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      this.atStart = false;
    }

    let i = 0;
    // Resolve a quote left dangling by the previous chunk before anything else.
    if (this.pendingQuote) {
      this.pendingQuote = false;
      if (text[0] === '"') {
        this.field += '"'; // it was an escaped quote after all
        i = 1;
      } else {
        this.inQuotes = false; // it really did close the field
      }
    }

    const endField = () => {
      this.row.push(this.field);
      this.field = "";
      this.fieldWasQuoted = false;
    };
    const endRow = () => {
      endField();
      rows.push(this.row);
      this.row = [];
    };

    while (i < text.length) {
      const c = text[i];

      if (this.inQuotes) {
        if (c === '"') {
          if (i + 1 >= text.length) {
            // Cannot tell `""` from a closing quote yet — wait for more input.
            this.pendingQuote = true;
            i++;
            continue;
          }
          if (text[i + 1] === '"') {
            this.field += '"'; // escaped quote
            i += 2;
            continue;
          }
          this.inQuotes = false;
          i++;
          continue;
        }
        this.field += c;
        i++;
        continue;
      }

      if (c === '"' && this.field === "") {
        this.inQuotes = true;
        this.fieldWasQuoted = true;
        i++;
        continue;
      }
      if (c === this.delimiter) {
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
      this.field += c;
      i++;
    }

    return rows;
  }

  /** The final row, when the file did not end with a newline. */
  end(): string[][] {
    // A chunk that ended mid-escape closed the field; nothing more is coming.
    this.pendingQuote = false;
    if (this.field !== "" || this.fieldWasQuoted || this.row.length > 0) {
      this.row.push(this.field);
      const last = this.row;
      this.field = "";
      this.fieldWasQuoted = false;
      this.row = [];
      return [last];
    }
    return [];
  }
}

/** Parse a complete CSV string. Kept for callers that already hold the whole
 *  file — it is now the streaming parser fed a single chunk, so the two cannot
 *  drift apart. */
export function parseCsv(text: string, delimiter = ","): CsvTable {
  const parser = new CsvStreamParser(delimiter);
  const rows = [...parser.push(text), ...parser.end()];
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
