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
        {p.saved.length === 0 && (
          <div className="conn-empty">
            <p>No connections yet.</p>
            <button className="btn primary" onClick={p.onNew}>
              ＋ New connection
            </button>
          </div>
        )}
        {p.saved.map((c) => {
          const m = envMeta(c.environment);
          const active = c.id === p.activeId;
          return (
            // A container, not a button. Delete has to be its own control, and
            // a <button> inside a <button> is invalid HTML — React warns about
            // it, the parser may hoist the inner one out, and assistive tech
            // has no way to present a control nested in a control.
            <div key={c.id} className={`conn-card ${active ? "active" : ""}`}>
              <button className="conn-open" onClick={() => p.onLoad(c)}>
                <span className="pg-avatar">PG</span>
                <span className="meta">
                  <span className="nm">
                    {c.name}
                    {active && p.connected && (
                      <span
                        className="dot"
                        style={{ background: "#3fb950", boxShadow: "0 0 6px rgba(63,185,80,.5)" }}
                      />
                    )}
                  </span>
                  <span className="full">
                    {c.username}@{c.host}:{c.port}/{c.database}
                  </span>
                </span>
                <span className="env-pill" style={{ color: m.color, background: m.bg }}>
                  {c.environment ?? "dev"}
                </span>
              </button>
              <button className="del" title="Delete" aria-label={`Delete ${c.name}`} onClick={() => p.onDelete(c)}>
                ×
              </button>
            </div>
          );
        })}
      </div>
    </>
  );
}
