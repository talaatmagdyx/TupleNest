/**
 * SQL notebooks: the document model and its Markdown export.
 *
 * A notebook is a list of cells. A SQL cell keeps its last result — at most
 * `NOTEBOOK_ROWS` rows, which the store enforces too — so a notebook reopens
 * showing what it showed, without running anything.
 */
import { chartData, type ChartKind } from "./chart";
import { cellText, mdCell } from "./text";

/** Rows a SQL cell keeps from its last run. */
export const NOTEBOOK_ROWS = 200;

export type CellResult = {
  columns: { name: string; dbType: string }[];
  rows: unknown[][];
  /** More rows than were kept. */
  truncated?: boolean;
  rowsAffected?: number | null;
  /** ISO time of the run. */
  ranAt: string;
  error?: string;
};

export type Cell =
  | { id: string; kind: "text"; text: string }
  | { id: string; kind: "sql"; sql: string; result?: CellResult }
  | { id: string; kind: "chart"; source: string | null; chart: ChartKind };

export type Notebook = {
  id: string | null;
  name: string;
  connectionId: string | null;
  cells: Cell[];
};

let seq = 0;
export function cellId(): string {
  seq += 1;
  return `c${Date.now().toString(36)}${seq}`;
}

export function newCell(kind: Cell["kind"], cells: Cell[]): Cell {
  if (kind === "text") return { id: cellId(), kind, text: "" };
  if (kind === "sql") return { id: cellId(), kind, sql: "" };
  // A chart starts on the nearest SQL cell above it.
  const source = [...cells].reverse().find((c) => c.kind === "sql")?.id ?? null;
  return { id: cellId(), kind, source, chart: "bar" };
}

function table(r: CellResult): string {
  if (r.columns.length === 0) return `_${r.rowsAffected ?? 0} rows affected_`;
  const head = `| ${r.columns.map((c) => mdCell(c.name)).join(" | ")} |`;
  const rule = `| ${r.columns.map(() => "---").join(" | ")} |`;
  const body = r.rows.map((row) => `| ${row.map((v) => mdCell(cellText(v))).join(" | ")} |`);
  const more = r.truncated ? [``, `_first ${r.rows.length} rows_`] : [];
  return [head, rule, ...body, ...more].join("\n");
}

/** The notebook as one Markdown document: text as written, SQL in fences
 *  with its kept result as a table, a chart as the table of what it plots. */
export function notebookMarkdown(nb: Notebook): string {
  const parts: string[] = [`# ${nb.name}`];
  for (const c of nb.cells) {
    if (c.kind === "text") {
      parts.push(c.text);
    } else if (c.kind === "sql") {
      parts.push("```sql\n" + c.sql + "\n```");
      if (c.result?.error) parts.push("> Error: " + c.result.error.split("\n")[0]);
      else if (c.result) parts.push(table(c.result));
    } else {
      const src = nb.cells.find((s) => s.id === c.source);
      const r = src?.kind === "sql" ? src.result : undefined;
      const data = r && !r.error ? chartData(c.chart, r.columns, r.rows) : null;
      if (!data) parts.push(`_Chart: nothing to draw_`);
      else if (data.kind === "number") parts.push(`**${mdCell(data.title)}: ${data.value}**`);
      else
        parts.push(
          [`_${data.kind} chart: ${mdCell(data.title)}_`, ``, `| label | value |`, `| --- | --- |`]
            .concat(data.points.map((pt) => `| ${mdCell(pt.label)} | ${pt.v} |`))
            .join("\n"),
        );
    }
  }
  return parts.join("\n\n") + "\n";
}
