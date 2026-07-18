import type { QueryResult } from "../ipc/types";
import { kbd } from "../lib/platform";
import type { Catalog } from "../lib/complete";
import type { CellEdit, EditTarget } from "../lib/dml";
import Grid from "../results/Grid";
import HistoryPanel, { type HistoryPanelProps } from "../history/HistoryPanel";
import SqlEditor from "./SqlEditor";
import { PlayIcon } from "../lib/icons";

export type ResultTab = "results" | "chart" | "messages" | "history";
export type ChartDatum = { label: string; v: number };

type Props = {
  sql: string;
  onSqlChange: (s: string) => void;
  connected: boolean;
  running: boolean;
  inTx: boolean;
  editorH: number;
  onSplitStart: (e: React.MouseEvent) => void;
  status: { icon: string; text: string; color: string } | null;
  result: QueryResult | null;
  lastError: string | null;
  queryEpoch: number;
  resultTab: ResultTab;
  onResultTab: (t: ResultTab) => void;
  onRun: () => void;
  onCancel: () => void;
  onBegin: () => void;
  onCommit: () => void;
  onRollback: () => void;
  onExplain: () => void;
  onFormat: () => void;
  exportMenu: boolean;
  onToggleExport: () => void;
  onExport: (kind: "csv" | "json" | "md") => void;
  onCopyResult?: (kind: "csv" | "json" | "md") => void;
  csvSafe: boolean;
  onCsvSafe: (v: boolean) => void;
  chart: { title: string; sub: string; data: ChartDatum[] } | null;
  onInspect: (text: string, colName: string) => void;
  onCopyable: (v: string | null) => void;
  onToast: (t: string) => void;
  onVisibleRows: (first: number, last: number) => void;
  catalog?: Catalog;
  onPrefetchTables?: (tables: { schema: string; name: string }[]) => void;
  onPrefetchSchema?: (schema: string) => void;
  editTarget?: EditTarget | null;
  editReason?: string | null;
  edits?: CellEdit[];
  onStageEdit?: (e: CellEdit) => void;
  onReviewEdits?: () => void;
  onDiscardEdits?: () => void;
  // Taken from the panel rather than restated: the two copies had already
  // drifted, and this one still claimed the actions were synchronous.
  history: HistoryPanelProps;
};

export default function QueryPanel(p: Props) {
  const r = p.result;
  const meta = p.lastError
    ? "error"
    : r
      ? r.columns.length === 0
        ? `${r.rowsAffected ?? 0} rows affected · ${r.elapsedMs} ms`
        : r.truncated
          ? `${r.storedRows.toLocaleString()} of ${r.totalRows.toLocaleString()} rows · ${r.elapsedMs} ms · streamed`
          : `${r.totalRows.toLocaleString()} rows · ${r.elapsedMs} ms · streamed`
      : "—";

  const tabs: [ResultTab, string][] = [
    ["results", "Results"],
    ["chart", "Chart"],
    ["messages", "Messages"],
    ["history", "History"],
  ];

  return (
    <>
      <div className="toolbar">
        <button className="btn primary" onClick={p.onRun} disabled={!p.connected || p.running}>
          {p.running ? <span className="spin" /> : <PlayIcon />} {p.running ? "Running" : "Run"}{" "}
          <span className="kbd" style={{ background: "rgba(0,0,0,.2)", color: "inherit", borderColor: "transparent" }}>
            {kbd("mod", "enter")}
          </span>
        </button>
        <button className="btn" onClick={p.onCancel} disabled={!p.running}>
          Cancel
        </button>
        <span className="sep" />
        {p.inTx ? (
          <>
            <span className="tx-chip">
              <span className="pulse" /> IN TRANSACTION
            </span>
            <button className="btn commit" onClick={p.onCommit}>
              Commit
            </button>
            <button className="btn rollback" onClick={p.onRollback}>
              Rollback
            </button>
          </>
        ) : (
          <button className="btn" onClick={p.onBegin} disabled={!p.connected}>
            Begin transaction
          </button>
        )}
        <div className="grow" />
        {/* Wrapped, not passed by reference: onClick would hand the click event
            to onExplain's first parameter. */}
        <button className="btn" onClick={() => p.onExplain()} disabled={!p.connected}>
          Explain
        </button>
        <button className="btn" onClick={p.onFormat} title={`Format SQL (${kbd("mod", "shift", "F")})`}>
          Format
        </button>
        <div className="menu-wrap">
          <button className="btn" onClick={p.onToggleExport} disabled={!r || r.columns.length === 0}>
            Export ▾
          </button>
          {p.exportMenu && (
            <div className="drop-menu">
              <div className="menu-label">Save result as</div>
              <button onClick={() => p.onExport("csv")}>
                CSV <span>.csv</span>
              </button>
              <button onClick={() => p.onExport("json")}>
                JSON <span>.json</span>
              </button>
              <button onClick={() => p.onExport("md")}>
                Markdown <span>.md</span>
              </button>
              <div className="divider" />
              <label className="menu-check" title="Prefixes cells starting with = + - @ so spreadsheets treat them as text, not formulas">
                <input
                  type="checkbox"
                  checked={p.csvSafe}
                  onChange={(e) => p.onCsvSafe(e.target.checked)}
                />
                <span>Spreadsheet-safe CSV</span>
              </label>
              {p.onCopyResult && (
                <>
                  <div className="divider" />
                  <div className="menu-label">Copy to clipboard</div>
                  <button onClick={() => p.onCopyResult!("csv")}>CSV</button>
                  <button onClick={() => p.onCopyResult!("md")}>Markdown</button>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="editor-zone">
        <SqlEditor
          sql={p.sql}
          disabled={!p.connected}
          height={p.editorH}
          onChange={p.onSqlChange}
          catalog={p.catalog}
          onPrefetchTables={p.onPrefetchTables}
          onPrefetchSchema={p.onPrefetchSchema}
        />
        {p.status && (
          <div className="run-status" style={{ color: p.status.color }}>
            <span>{p.status.icon}</span>
            <span>{p.status.text}</span>
          </div>
        )}
      </div>

      <div className="splitter" onMouseDown={p.onSplitStart} title="Drag to resize">
        <span />
      </div>

      <div className="rtabs">
        {tabs.map(([id, label]) => (
          <button key={id} className={`rtab ${p.resultTab === id ? "on" : ""}`} onClick={() => p.onResultTab(id)}>
            {label}
          </button>
        ))}
        <button className="rtab" onClick={() => p.onExplain()} title="Run EXPLAIN and show the plan">
          Plan
        </button>
        {p.editTarget && (
          <span className="edit-chip" title={`Rows map to ${p.editTarget.schema}.${p.editTarget.table} — double-click a cell to edit`}>
            editable
          </span>
        )}
        <div className="meta">
          {r && !p.lastError && <span style={{ color: "var(--tn-success)" }}>✓</span>}
          <span>{meta}</span>
        </div>
      </div>

      {/* `editReason` was declared, passed in by App, and never rendered — so
          the specific explanation analyzeEditability works to produce ("no
          primary key", "more than one table is referenced") was computed and
          thrown away, leaving cells that just silently refuse to edit. Only
          shown when there is a result to explain and nothing staged. */}
      {p.editReason && r && r.columns.length > 0 && (p.edits?.length ?? 0) === 0 && (
        <div className="edit-bar readonly">
          <span className="muted">Read-only — {p.editReason}.</span>
        </div>
      )}

      {(p.edits?.length ?? 0) > 0 && (
        <div className="edit-bar">
          <span className="dot-pulse" />
          <span>
            <strong>{p.edits!.length}</strong> pending change{p.edits!.length === 1 ? "" : "s"}
          </span>
          <span className="sep-dot">·</span>
          <span className="muted">nothing is written until you apply</span>
          <div className="grow" />
          <button className="btn" onClick={p.onDiscardEdits}>
            Discard
          </button>
          <button className="btn primary" onClick={p.onReviewEdits}>
            Review &amp; apply
          </button>
        </div>
      )}

      <div className="results-zone">
        {p.resultTab === "results" && (
          <>
            {p.lastError && <div className="error-box">{p.lastError}</div>}
            {!p.lastError && !r && !p.connected && (
              <div className="center-note">
                <div className="big">Not connected</div>
                <div>Connect to a database to run queries — {kbd("mod", "K")} or the connection menu.</div>
              </div>
            )}
            {!p.lastError && !r && p.connected && (
              <div className="center-note">Run the query ({kbd("mod", "enter")}) to see results</div>
            )}
            {!p.lastError && r && r.columns.length === 0 && (
              <div className="center-note">
                <div className="big">{r.rowsAffected ?? 0} row(s) affected</div>
                <div>{r.elapsedMs} ms</div>
              </div>
            )}
            {!p.lastError && r && r.columns.length > 0 && r.totalRows === 0 && (
              <div className="center-note">
                <div className="big">0 rows</div>
                <div>The query ran fine but matched no rows.</div>
              </div>
            )}
            {!p.lastError && r && r.columns.length > 0 && r.totalRows > 0 && (
              <>
                {r.truncated && (
                  <div className="trunc-note">
                    showing first {r.storedRows.toLocaleString()} of {r.totalRows.toLocaleString()} rows
                  </div>
                )}
                <Grid
                  columns={r.columns}
                  storedRows={r.storedRows}
                  epoch={p.queryEpoch}
                  onInspect={p.onInspect}
                  onCopyable={p.onCopyable}
                  onToast={p.onToast}
                  onVisible={p.onVisibleRows}
                  target={p.editTarget}
                  edits={p.edits}
                  onStage={p.onStageEdit}
                />
              </>
            )}
          </>
        )}
        {p.resultTab === "messages" && (
          <div className="msg-pane">
            {!r && !p.lastError && <div>no messages yet</div>}
            {p.lastError && <div style={{ color: "var(--tn-danger)" }}>✕ {p.lastError}</div>}
            {r && (
              <>
                <div style={{ color: "var(--tn-success)" }}>✓ {meta}</div>
                {r.truncated && <div>first {r.storedRows.toLocaleString()} rows kept in memory for scrolling</div>}
                <div>columns: {r.columns.map((c) => `${c.name} ${c.dbType}`).join(", ") || "—"}</div>
              </>
            )}
          </div>
        )}
        {p.resultTab === "chart" && (
          <div className="chart-pane">
            {!p.chart && (
              <div className="center-note" style={{ padding: 40 }}>
                Chart needs a result with one text column and one numeric column.
              </div>
            )}
            {p.chart && (
              <>
                <div className="chart-title">{p.chart.title}</div>
                <div className="chart-sub">{p.chart.sub}</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {p.chart.data.map((d, i) => {
                    const max = Math.max(...p.chart!.data.map((x) => x.v), 1);
                    return (
                      <div key={i} className="chart-row">
                        <div className="lbl">{d.label}</div>
                        <div className="track">
                          <div className="fill" style={{ width: `${(d.v / max) * 100}%` }} />
                        </div>
                        <div className="val">{d.v.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}
        {p.resultTab === "history" && <HistoryPanel {...p.history} />}
      </div>
    </>
  );
}
