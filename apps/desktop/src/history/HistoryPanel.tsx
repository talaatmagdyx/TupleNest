import type { HistoryEntry } from "../ipc/types";

type Props = {
  items: HistoryEntry[];
  search: string;
  onSearch: (s: string) => void;
  onClear: () => void;
  onToggleFavorite: (h: HistoryEntry) => void;
  onLoad: (sql: string) => void;
};

/** Query history with search, favorites, click-to-load (E1.5). */
export default function HistoryPanel(p: Props) {
  return (
    <section className="panel">
      <h2>History</h2>
      <div className="form-row">
        <input
          placeholder="search history…"
          value={p.search}
          onChange={(e) => p.onSearch(e.target.value)}
          style={{ flex: 1 }}
        />
        <button onClick={p.onClear} title="Clear non-favorites">
          Clear
        </button>
      </div>
      {p.items.length === 0 && <p className="muted">No history yet.</p>}
      <ul className="history-list">
        {p.items.map((h) => (
          <li key={h.id} title={h.errorText ?? h.sqlText ?? ""}>
            <span className={`hstatus ${h.status}`}>
              {h.status === "success" ? "✓" : h.status === "cancelled" ? "⊘" : "✗"}
            </span>
            <span
              className={`hsql ${h.sqlText ? "clickable" : ""}`}
              onClick={() => h.sqlText && p.onLoad(h.sqlText)}
            >
              {h.sqlText ?? <em className="muted">(query text hidden — prod)</em>}
            </span>
            <span className="muted hmeta">
              {h.status === "success"
                ? `${h.rowsReturned || h.rowsAffected || 0} rows`
                : h.status}
              {" · "}
              {h.durationMs}ms
              {" · "}
              {new Date(h.startedAt * 1000).toLocaleTimeString()}
            </span>
            <button
              className={`ghost star ${h.favorite ? "on" : ""}`}
              title={h.favorite ? "Unfavorite" : "Favorite"}
              onClick={() => p.onToggleFavorite(h)}
            >
              {h.favorite ? "★" : "☆"}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
