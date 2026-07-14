import type { ConnectionRecord } from "../ipc/types";
import { envMeta } from "../lib/sql";

type Props = {
  saved: ConnectionRecord[];
  activeId: string | null;
  connected: boolean;
  onLoad: (c: ConnectionRecord) => void;
  onNew: () => void;
  onDelete: (c: ConnectionRecord) => void;
};

export default function SavedList(p: Props) {
  return (
    <>
      <div className="side-head">
        <span className="label">Connections</span>
        <button className="plus" title="New connection" onClick={p.onNew}>
          ＋
        </button>
      </div>
      <div className="conn-list">
        {p.saved.length === 0 && <div className="note muted" style={{ padding: "2px 8px", fontSize: 11 }}>No saved connections yet.</div>}
        {p.saved.map((c) => {
          const m = envMeta(c.environment);
          const active = c.id === p.activeId;
          return (
            <button key={c.id} className={`conn-card ${active ? "active" : ""}`} onClick={() => p.onLoad(c)}>
              <span className="pg-avatar">PG</span>
              <span className="meta">
                <span className="nm">
                  {c.name}
                  {active && p.connected && (
                    <span className="dot" style={{ background: "#3fb950", boxShadow: "0 0 6px rgba(63,185,80,.5)" }} />
                  )}
                </span>
                <span className="full">
                  {c.username}@{c.host}:{c.port}/{c.database}
                </span>
              </span>
              <span className="env-pill" style={{ color: m.color, background: m.bg }}>
                {c.environment ?? "dev"}
              </span>
              <button
                className="del"
                title="Delete"
                onClick={(e) => {
                  e.stopPropagation();
                  p.onDelete(c);
                }}
              >
                ×
              </button>
            </button>
          );
        })}
      </div>
    </>
  );
}
