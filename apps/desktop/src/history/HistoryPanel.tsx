import type { HistoryEntry } from "../ipc/types";

type Props = {
  items: HistoryEntry[];
  search: string;
  onSearch: (s: string) => void;
  onClear: () => void;
  onToggleFavorite: (h: HistoryEntry) => void;
  onLoad: (sql: string) => void;
};

const GLYPH: Record<string, [string, string]> = {
  success: ["✓", "var(--tn-success)"],
  error: ["✕", "var(--tn-danger)"],
  cancelled: ["⊘", "var(--tn-warning)"],
};

/** History as a result-drawer tab (HUD design). */
export default function HistoryPanel(p: Props) {
  return (
    <div className="hist-pane">
      <div className="hist-bar">
        <div className="filter-box">
          <span className="muted">⌕</span>
          <input placeholder="Search history…" value={p.search} onChange={(e) => p.onSearch(e.target.value)} />
        </div>
        <button className="btn" onClick={p.onClear} title="Clear non-favorites">
          Clear
        </button>
      </div>
      <div className="hist-list">
        {p.items.length === 0 && (
          <div className="center-note" style={{ padding: 30 }}>
            No history yet.
          </div>
        )}
        {p.items.map((h) => {
          const hidden = h.sqlText === null;
          const [glyph, color] = hidden ? ["—", "var(--tn-tm)"] : GLYPH[h.status];
          return (
            <div key={h.id} className="hist-row" title={h.errorText ?? h.sqlText ?? ""}>
              <span className="glyph" style={{ color }}>
                {glyph}
              </span>
              <span
                className={`sqltxt ${hidden ? "hidden-prod" : ""}`}
                onClick={() => h.sqlText && p.onLoad(h.sqlText)}
              >
                {h.sqlText ?? "(query text hidden — prod)"}
              </span>
              <span className="hmeta">
                {h.status === "success" ? `${h.rowsReturned || h.rowsAffected || 0} rows` : h.status}
                {" · "}
                {h.durationMs}ms
                {" · "}
                {new Date(h.startedAt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
              <button
                className="star"
                style={{ color: h.favorite ? "var(--tn-warning)" : "var(--tn-bh)" }}
                title={h.favorite ? "Unfavorite" : "Favorite"}
                onClick={() => p.onToggleFavorite(h)}
              >
                ★
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
