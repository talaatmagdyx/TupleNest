import type { ConnectionRecord } from "../ipc/types";

type Props = {
  saved: ConnectionRecord[];
  activeId: string | null;
  onLoad: (c: ConnectionRecord) => void;
  onNew: () => void;
  onDelete: (c: ConnectionRecord) => void;
};

/** Saved connection profiles list (E1.2). */
export default function SavedList({ saved, activeId, onLoad, onNew, onDelete }: Props) {
  return (
    <>
      <div className="sidebar-head">
        <h2>Connections</h2>
        <button onClick={onNew} title="New connection">
          +
        </button>
      </div>
      {saved.length === 0 && <p className="muted">No saved connections yet.</p>}
      <ul className="conn-list">
        {saved.map((c) => (
          <li
            key={c.id}
            className={c.id === activeId ? "active" : ""}
            onClick={() => onLoad(c)}
          >
            <span className={`env env-${c.environment ?? "dev"}`}>
              {(c.environment ?? "dev").slice(0, 4)}
            </span>
            <span
              className="conn-name"
              title={`${c.username}@${c.host}:${c.port}/${c.database}`}
            >
              {c.name}
            </span>
            <button
              className="ghost"
              title="Delete"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(c);
              }}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
