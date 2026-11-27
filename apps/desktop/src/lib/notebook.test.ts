import { describe, expect, it } from "vitest";
import { newCell, notebookMarkdown, type Notebook } from "./notebook";

const result = {
  columns: [
    { name: "reason", dbType: "text" },
    { name: "n", dbType: "int4" },
  ],
  rows: [
    ["late | delivery", 412],
    ["damaged", 160],
  ],
  ranAt: "2026-11-27T10:00:00Z",
};

describe("notebook", () => {
  it("starts a chart on the nearest SQL cell above it", () => {
    const a = newCell("sql", []);
    const b = newCell("sql", [a]);
    const t = newCell("text", [a, b]);
    expect(newCell("chart", [a, b, t])).toMatchObject({ kind: "chart", source: b.id, chart: "bar" });
    expect(newCell("chart", [])).toMatchObject({ source: null });
    expect(a.id).not.toBe(b.id);
  });

  it("exports text, SQL with its result, and charts as Markdown", () => {
    const nb: Notebook = {
      id: "n1",
      name: "Refunds",
      connectionId: null,
      cells: [
        { id: "t", kind: "text", text: "Why did refunds rise?" },
        { id: "s", kind: "sql", sql: "select reason, n from r", result: { ...result, truncated: true } },
        { id: "c", kind: "chart", source: "s", chart: "bar" },
        { id: "k", kind: "chart", source: "s", chart: "number" },
        { id: "e", kind: "sql", sql: "select boom", result: { columns: [], rows: [], ranAt: "", error: "column \"boom\" does not exist\nLINE 1" } },
        { id: "u", kind: "sql", sql: "update t set x = 1", result: { columns: [], rows: [], ranAt: "", rowsAffected: 3 } },
        { id: "x", kind: "chart", source: "e", chart: "line" },
        { id: "y", kind: "sql", sql: "select 2" },
      ],
    };
    expect(notebookMarkdown(nb)).toBe(
      [
        "# Refunds",
        "Why did refunds rise?",
        "```sql\nselect reason, n from r\n```",
        "| reason | n |\n| --- | --- |\n| late \\| delivery | 412 |\n| damaged | 160 |\n\n_first 2 rows_",
        "_bar chart: sum(n) by reason_\n\n| label | value |\n| --- | --- |\n| late \\| delivery | 412 |\n| damaged | 160 |",
        "**n: 412**",
        "```sql\nselect boom\n```",
        '> Error: column "boom" does not exist',
        "```sql\nupdate t set x = 1\n```",
        "_3 rows affected_",
        "_Chart: nothing to draw_",
        "```sql\nselect 2\n```",
      ].join("\n\n") + "\n",
    );
  });
});
