import { useMemo, useState } from "react";
import type { HistoryEntry } from "../ipc/types";
import { hasWriteVerb, tokenizeLines } from "../lib/sql";
import PageHeader, { onPageKeyDown } from "./PageHeader";

export type HistoryFilter = "all" | "connection" | "writes" | "failed" | "today";

const FILTERS: { id: HistoryFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "connection", label: "This connection" },
  { id: "writes", label: "Writes" },
  { id: "failed", label: "Failed" },
  { id: "today", label: "Today" },
];

export type HistoryPageProps = {
  items: HistoryEntry[];
  search: string;
  onSearch: (s: string) => void;
  /** The store's key for the live session (`user@host:port/database`, or
   *  `sqlite:<path>` for a SQLite file), or null when disconnected. History
   *  rows carry the same key, so "this connection" is an exact match. */
  connectionKey: string | null;
  onClear: () => void | Promise<void>;
  onToggleFavorite: (h: HistoryEntry) => void | Promise<void>;
  onOpen: (sql: string) => void;
  /** Absent when there is nowhere to save to. */
  onSave?: (sql: string) => void;
  onClose: () => void;
};

/** Does this entry pass the chip? Exported for the tests: the chips are the
 *  page's only logic, and "today" depends on the clock. */
export function matchesFilter(
  h: HistoryEntry,
  f: HistoryFilter,
  key: string | null,
  now: Date = new Date(),
): boolean {
  switch (f) {
    case "all":
      return true;
    case "connection":
      return key !== null && h.connectionKey === key;
    case "writes":
      // Prod rows carry no text; a row count of changed rows is all there is.
      return h.sqlText !== null ? hasWriteVerb(h.sqlText) : h.rowsAffected !== null;
    case "failed":
      return h.status === "error";
    case "today":
      return new Date(h.startedAt * 1000).toDateString() === now.toDateString();
  }
}

const STATUS: Record<HistoryEntry["status"], { label: string; tone: string }> = {
  success: { label: "OK", tone: "ok" },
  error: { label: "Failed", tone: "bad" },
  cancelled: { label: "Cancelled", tone: "warn" },
};

const firstLine = (sql: string) => sql.trim().split("\n")[0];

function rowsText(h: HistoryEntry): string {
  if (h.status !== "success") return STATUS[h.status].label;
  const n = h.rowsAffected ?? h.rowsReturned;
  return `${n.toLocaleString()} ${n === 1 ? "row" : "rows"}`;
}

const when = (h: HistoryEntry) =>
  new Date(h.startedAt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * History as a page of the main area: search and chips on top, the list, and
 * the statement picked from it on the right. The result drawer's History tab
 * (history/HistoryPanel) stays as the quick version next to the grid.
 */
export default function HistoryPage(p: HistoryPageProps) {
  const [filter, setFilter] = useState<HistoryFilter>("all");
  const [picked, setPicked] = useState<string | null>(null);
  const shown = useMemo(
    () => p.items.filter((h) => matchesFilter(h, filter, p.connectionKey)),
    [p.items, filter, p.connectionKey],
  );
  const sel = shown.find((h) => h.id === picked) ?? shown[0] ?? null;

  return (
    <div className="page history-page" onKeyDown={onPageKeyDown(p.onClose)}>
      <section className="page-island grow-col" aria-label="Query history">
        <PageHeader
          title="History"
          sub="Every statement you ran, newest first. Query text on production is not kept."
          onBack={p.onClose}
          actions={
            <button className="btn" onClick={p.onClear} title="Clear non-favorites">
              Clear
            </button>
          }
        />
        <div className="page-tools">
          <label className="filter-box page-search">
            <span className="muted" aria-hidden>
              ⌕
            </span>
            <input
              aria-label="Search history"
              placeholder="Search SQL"
              value={p.search}
              onChange={(e) => p.onSearch(e.target.value)}
            />
          </label>
          <div className="chip-filters" role="group" aria-label="Filter history">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                className={`fchip ${filter === f.id ? "on" : ""}`}
                aria-pressed={filter === f.id}
                disabled={f.id === "connection" && p.connectionKey === null}
                onClick={() => setFilter(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
        <ul className="hp-list" aria-label="Statements">
          {shown.length === 0 && <li className="center-note hp-empty">{p.items.length ? "Nothing matches." : "No history yet."}</li>}
          {shown.map((h) => {
            const st = STATUS[h.status];
            return (
              <li key={h.id} className={`hp-row ${sel?.id === h.id ? "on" : ""}`}>
                <button className="hp-pick" aria-current={sel?.id === h.id} onClick={() => setPicked(h.id)}>
                  <span className={`hp-dot ${st.tone}`} aria-hidden />
                  <span className="hp-main">
                    <span className={`hp-sql ${h.sqlText === null ? "hidden-prod" : ""}`}>
                      {h.sqlText === null ? "(query text hidden — prod)" : firstLine(h.sqlText)}
                    </span>
                    <span className="hp-meta">
                      {[h.connectionKey, rowsText(h), `${h.durationMs} ms`, h.actor].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  <span className={`tchip ${st.tone}`}>{st.label}</span>
                  <span className="hp-when">{when(h)}</span>
                </button>
                <button
                  className="star"
                  style={{ color: h.favorite ? "var(--tn-warning)" : "var(--tn-tm)" }}
                  title={h.favorite ? "Unfavorite" : "Favorite"}
                  aria-pressed={h.favorite}
                  onClick={() => p.onToggleFavorite(h)}
                >
                  ★
                </button>
              </li>
            );
          })}
        </ul>
      </section>
      <aside className="page-island side-pane" aria-label="Selected statement">
        <span className="pane-label">Selected</span>
        {!sel ? (
          <p className="page-sub">Pick a statement to see it in full.</p>
        ) : (
          <>
            <pre className="hp-code">
              {highlighted(sel.sqlText)}
            </pre>
            <div className="fact-grid">
              <div className="fact">
                <span>Connection</span>
                <b>{sel.connectionKey}</b>
              </div>
              <div className="fact">
                <span>Result</span>
                <b className={`tone-${STATUS[sel.status].tone}`}>{rowsText(sel)}</b>
              </div>
              <div className="fact">
                <span>Ran</span>
                <b>{new Date(sel.startedAt * 1000).toLocaleString()}</b>
              </div>
              <div className="fact">
                <span>Took</span>
                <b>{sel.durationMs} ms</b>
              </div>
              {sel.actor && (
                <div className="fact">
                  <span>Sent by</span>
                  <b>{sel.actor}</b>
                </div>
              )}
            </div>
            {sel.errorText && <div className="error-box">{sel.errorText}</div>}
            <div className="pane-actions">
              <button className="btn primary" disabled={sel.sqlText === null} onClick={() => p.onOpen(sel.sqlText ?? "")}>
                Open in editor
              </button>
              {p.onSave && (
                <button className="btn" disabled={sel.sqlText === null} onClick={() => p.onSave?.(sel.sqlText ?? "")}>
                  Save as query
                </button>
              )}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

/** The statement, highlighted the way the editor would show it. */
function highlighted(sql: string | null) {
  if (sql === null) return <span className="muted">Query text is not kept for production connections.</span>;
  return tokenizeLines(sql).map((line, i) => <div key={i}>{line.length ? line : " "}</div>);
}
