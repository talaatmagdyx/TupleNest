import type { HistoryEntry, QueryResult } from "../ipc/types";
import type { Catalog } from "../lib/complete";
import Grid from "../results/Grid";
import HistoryPanel from "../history/HistoryPanel";
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
  chart: { title: string; sub: string; data: ChartDatum[] } | null;
  onInspect: (text: string, colName: string) => void;
  onCopyable: (v: string | null) => void;
  onToast: (t: string) => void;
  onVisibleRows: (first: number, last: number) => void;
  catalog?: Catalog;
  onPrefetchTables?: (tables: { schema: string; name: string }[]) => void;
  onPrefetchSchema?: (schema: string) => void;
  history: {
    items: HistoryEntry[];
    search: string;
    onSearch: (s: string) => void;
    onClear: () => void;
    onToggleFavorite: (h: HistoryEntry) => void;
    onLoad: (sql: string) => void;
  };
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
            ⌘↵
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
        <button className="btn" onClick={p.onExplain} disabled={!p.connected}>
          Explain
        </button>
        <button className="btn" onClick={p.onFormat} title="Format SQL (⌘⇧F)">
          Format
        </button>
        <div className="menu-wrap">
          <button className="btn" onClick={p.onToggleExport} disabled={!r || r.columns.length === 0}>
            Export ▾
          </button>
          {p.exportMenu && (
            <div className="drop-menu">
              <div className="menu-label">Export result</div>
              <button onClick={() => p.onExport("csv")}>
                CSV <span>.csv</span>
              </button>
              <button onClick={() => p.onExport("json")}>
                JSON <span>.json</span>
              </button>
              <button onClick={() => p.onExport("md")}>
                Markdown <span>.md</span>
              </button>
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
        <button className="rtab" onClick={p.onExplain} title="Run EXPLAIN and show the plan">
          Plan
        </button>
        <div className="meta">
          {r && !p.lastError && <span style={{ color: "var(--tn-success)" }}>✓</span>}
          <span>{meta}</span>
        </div>
      </div>

      <div className="results-zone">
        {p.resultTab === "results" && (
          <>
            {p.lastError && <div className="error-box">{p.lastError}</div>}
            {!p.lastError && !r && !p.connected && (
              <div className="center-note">
                <div className="big">Not connected</div>
                <div>Connect to a database to run queries — ⌘K or the connection menu.</div>
              </div>
            )}
            {!p.lastError && !r && p.connected && (
              <div className="center-note">Run the query (⌘↵) to see results</div>
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
