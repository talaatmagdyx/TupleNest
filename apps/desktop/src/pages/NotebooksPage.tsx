import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ChartView from "../charts/ChartView";
import { CHART_KINDS, type ChartKind } from "../lib/chart";
import { renderMarkdown } from "../lib/markdown";
import { NOTEBOOK_ROWS, newCell, notebookMarkdown, type Cell, type CellResult, type Notebook } from "../lib/notebook";
import { FILTERS, baseName, saveText } from "../lib/save";
import { guardReason } from "../lib/sql";
import { cellText, errText } from "../lib/text";
import { Guard } from "../overlays/Overlays";
import type { QueryResult } from "../ipc/types";
import type { PageContext } from "./context";

type Summary = { id: string; name: string; connectionId: string | null; updatedAt: number };

/**
 * SQL notebooks: text, SQL and chart cells in one document.
 *
 * Nothing runs on open — a notebook shows the results it was saved with, and
 * a SQL cell runs only on its own Run. That run is the editor's: `pg_query`
 * (detached, so the grid keeps its result) with the guard asked first on prod
 * and staging, the audit row and history as usual, and 200 rows kept.
 */
export default function NotebooksPage(p: { ctx: PageContext }) {
  const { ctx } = p;
  const toast = ctx.toast;
  const [list, setList] = useState<Summary[] | null>(null);
  const [nb, setNb] = useState<Notebook | null>(null);
  const [dirty, setDirty] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [guardFor, setGuardFor] = useState<Extract<Cell, { kind: "sql" }> | null>(null);
  const [editing, setEditing] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setList(await invoke<Summary[]>("notebook_list"));
    } catch (e) {
      setList([]);
      toast(`Notebooks did not load: ${errText(e)}`);
    }
  }, [toast]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading on mount is what an effect is for
    void refresh();
  }, [refresh]);

  const open = async (id: string) => {
    const got = await invoke<Notebook | null>("notebook_get", { id });
    if (!got) return;
    setNb(got);
    setDirty(false);
    setEditing(new Set());
  };

  const create = () => {
    const first = newCell("text", []);
    setNb({ id: null, name: "Untitled notebook", connectionId: ctx.liveProfile?.id ?? null, cells: [first] });
    setEditing(new Set([first.id]));
    setDirty(true);
  };

  const change = (next: Notebook) => {
    setNb(next);
    setDirty(true);
  };
  /** Functional, so a run that finishes after more typing patches the
   *  notebook as it is then, not as it was when the run started. */
  const setCell = (id: string, patch: Partial<Cell>) => {
    setNb((cur) => cur && { ...cur, cells: cur.cells.map((c) => (c.id === id ? ({ ...c, ...patch } as Cell) : c)) });
    setDirty(true);
  };

  const save = async () => {
    if (!nb) return;
    try {
      const saved = await invoke<Notebook>("notebook_save", {
        id: nb.id,
        name: nb.name,
        connectionId: nb.connectionId,
        cells: nb.cells,
      });
      setNb(saved);
      setDirty(false);
      await refresh();
    } catch (e) {
      toast(`Not saved: ${errText(e)}`);
    }
  };

  const remove = async () => {
    if (!nb) return;
    if (nb.id) await invoke("notebook_delete", { id: nb.id });
    setNb(null);
    setDirty(false);
    await refresh();
  };

  const exportMd = async () => {
    if (!nb) return;
    const path = await saveText(`${nb.name}.md`, notebookMarkdown(nb), FILTERS.md);
    if (path) toast(`Exported ${baseName(path)}`);
  };

  const owner = nb?.connectionId ? ctx.saved.find((c) => c.id === nb.connectionId) : undefined;
  const canRun = !!nb && ctx.pg && (!nb.connectionId || nb.connectionId === ctx.liveProfile?.id);

  const run = async (cell: Extract<Cell, { kind: "sql" }>, confirmed = false) => {
    if (!confirmed && guardReason(cell.sql, ctx.env)) {
      setGuardFor(cell);
      return;
    }
    setRunning(cell.id);
    let result: CellResult;
    const ranAt = new Date().toISOString();
    try {
      const r = await invoke<QueryResult>("pg_query", { sql: cell.sql, detached: true, maxRows: NOTEBOOK_ROWS });
      const rows = r.rows ?? [];
      result = {
        columns: r.columns,
        rows: rows.slice(0, NOTEBOOK_ROWS),
        truncated: r.truncated || rows.length > NOTEBOOK_ROWS,
        rowsAffected: r.rowsAffected,
        ranAt,
      };
    } catch (e) {
      result = { columns: [], rows: [], ranAt, error: errText(e) };
    }
    setRunning(null);
    setCell(cell.id, { result });
  };

  const sqlCells = nb?.cells.filter((c): c is Extract<Cell, { kind: "sql" }> => c.kind === "sql") ?? [];

  return (
    <section className="page" aria-label="Notebooks">
      <div className="page-head">
        <h1 className="page-title">{nb?.name ?? "Notebooks"}</h1>
        {dirty && <span className="page-sub">unsaved</span>}
        <div className="grow" />
        {list && list.length > 0 && (
          <select aria-label="Open notebook" value={nb?.id ?? ""} onChange={(e) => void open(e.target.value)}>
            <option value="" disabled>
              Open a notebook…
            </option>
            {list.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name}
              </option>
            ))}
          </select>
        )}
        {nb && (
          <>
            <button className="btn" onClick={() => setRenaming(nb.name)}>
              Rename
            </button>
            <button className="btn" onClick={() => void exportMd()}>
              Export Markdown
            </button>
            <button className="btn" onClick={() => void remove()}>
              Delete
            </button>
            <button className="btn primary" disabled={!dirty} onClick={() => void save()}>
              Save
            </button>
          </>
        )}
        <button className="btn" onClick={create}>
          New notebook
        </button>
      </div>

      {nb && renaming !== null && (
        <form
          className="page-strip"
          onSubmit={(e) => {
            e.preventDefault();
            change({ ...nb, name: renaming });
            setRenaming(null);
          }}
        >
          <label>
            Notebook name
            <input autoFocus value={renaming} onChange={(e) => setRenaming(e.target.value)} />
          </label>
          <button className="btn primary" type="submit">
            Rename
          </button>
        </form>
      )}

      {!nb && list && (
        <div className="page-empty">
          <div className="big">{list.length ? "Open a notebook, or start one" : "No notebooks yet"}</div>
          <p>
            A notebook mixes notes, queries and charts. Each query cell keeps its last {NOTEBOOK_ROWS} rows, so the page
            reopens as you left it. Nothing runs until you press Run.
          </p>
        </div>
      )}

      {nb && (
        <div className="nb-doc">
          <div className="page-strip">
            <label>
              SQL cells run on
              <select
                aria-label="Connection"
                value={nb.connectionId ?? ""}
                onChange={(e) => change({ ...nb, connectionId: e.target.value || null })}
              >
                <option value="">whichever is connected</option>
                {ctx.saved.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            {!canRun && (
              <span className="page-sub" role="status">
                {ctx.pg ? `Connect to ${owner?.name ?? "that connection"} to run cells.` : "Connect to a PostgreSQL database to run cells."}
              </span>
            )}
          </div>

          {nb.cells.map((c, i) => (
            <article key={c.id} className={`nb-cell nb-${c.kind}`} aria-label={`Cell ${i + 1}, ${c.kind}`}>
              <header>
                <span className="nb-kind">{c.kind === "sql" ? "SQL" : c.kind === "text" ? "Text" : "Chart"}</span>
                {c.kind === "sql" && c.result && (
                  <span className="page-sub">
                    ran {new Date(c.result.ranAt).toLocaleString()}
                    {c.result.error ? "" : ` · ${c.result.rows.length}${c.result.truncated ? "+" : ""} rows`}
                  </span>
                )}
                <div className="grow" />
                {c.kind === "text" && (
                  <button
                    className="btn xs"
                    onClick={() =>
                      setEditing((s) => {
                        const n = new Set(s);
                        if (n.has(c.id)) n.delete(c.id);
                        else n.add(c.id);
                        return n;
                      })
                    }
                  >
                    {editing.has(c.id) ? "Done" : "Edit"}
                  </button>
                )}
                {c.kind === "sql" && (
                  <button
                    className="btn xs primary"
                    disabled={!canRun || running !== null || !c.sql.trim()}
                    onClick={() => void run(c)}
                  >
                    {running === c.id ? "Running…" : "Run"}
                  </button>
                )}
                <button
                  className="btn xs"
                  aria-label={`Delete cell ${i + 1}`}
                  onClick={() => change({ ...nb, cells: nb.cells.filter((x) => x.id !== c.id) })}
                >
                  Delete
                </button>
              </header>

              {c.kind === "text" &&
                (editing.has(c.id) ? (
                  <textarea
                    aria-label={`Text of cell ${i + 1}`}
                    value={c.text}
                    rows={4}
                    onChange={(e) => setCell(c.id, { text: e.target.value })}
                  />
                ) : (
                  <div className="nb-md">{c.text.trim() ? renderMarkdown(c.text) : <span className="page-sub">Empty text cell</span>}</div>
                ))}

              {c.kind === "sql" && (
                <>
                  <textarea
                    className="mono"
                    aria-label={`SQL of cell ${i + 1}`}
                    value={c.sql}
                    rows={3}
                    spellCheck={false}
                    onChange={(e) => setCell(c.id, { sql: e.target.value })}
                  />
                  {c.result?.error && <div className="dash-error">{c.result.error}</div>}
                  {c.result && !c.result.error && <ResultTable result={c.result} />}
                </>
              )}

              {c.kind === "chart" && (
                <ChartCell
                  cell={c}
                  sources={sqlCells}
                  onChange={(patch) => setCell(c.id, patch)}
                />
              )}
            </article>
          ))}

          <div className="nb-add">
            {(["text", "sql", "chart"] as const).map((k) => (
              <button key={k} className="btn" onClick={() => change({ ...nb, cells: [...nb.cells, newCell(k, nb.cells)] })}>
                + {k === "sql" ? "SQL" : k === "text" ? "Text" : "Chart"}
              </button>
            ))}
          </div>
        </div>
      )}

      {guardFor && (
        <Guard
          sql={guardFor.sql}
          env={ctx.env}
          onCancel={() => setGuardFor(null)}
          onRun={() => {
            const cell = guardFor;
            setGuardFor(null);
            void run(cell, true);
          }}
        />
      )}
    </section>
  );
}

function ResultTable(p: { result: CellResult }) {
  const r = p.result;
  if (r.columns.length === 0) {
    return <div className="page-sub">{(r.rowsAffected ?? 0).toLocaleString()} rows affected</div>;
  }
  return (
    <div className="nb-result">
      <table>
        <thead>
          <tr>
            {r.columns.map((c, i) => (
              <th key={i} scope="col">
                {c.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {r.rows.map((row, i) => (
            <tr key={i}>
              {row.map((v, j) => (
                <td key={j}>{cellText(v)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ChartCell(p: {
  cell: Extract<Cell, { kind: "chart" }>;
  sources: Extract<Cell, { kind: "sql" }>[];
  onChange: (patch: { source?: string | null; chart?: ChartKind }) => void;
}) {
  const src = p.sources.find((s) => s.id === p.cell.source);
  return (
    <>
      <div className="page-strip nb-chart-opts">
        <label>
          From
          <select
            aria-label="Chart source"
            value={p.cell.source ?? ""}
            onChange={(e) => p.onChange({ source: e.target.value || null })}
          >
            <option value="">Choose a SQL cell…</option>
            {p.sources.map((s, i) => (
              <option key={s.id} value={s.id}>
                SQL cell {i + 1}: {s.sql.trim().slice(0, 40) || "(empty)"}
              </option>
            ))}
          </select>
        </label>
        <select
          aria-label="Chart kind"
          value={p.cell.chart}
          onChange={(e) => p.onChange({ chart: e.target.value as ChartKind })}
        >
          {CHART_KINDS.map((k) => (
            <option key={k.kind} value={k.kind}>
              {k.label}
            </option>
          ))}
        </select>
      </div>
      {src?.result && !src.result.error ? (
        <ChartView kind={p.cell.chart} columns={src.result.columns} rows={src.result.rows} />
      ) : (
        <div className="page-sub">Run the SQL cell to draw this chart.</div>
      )}
    </>
  );
}
