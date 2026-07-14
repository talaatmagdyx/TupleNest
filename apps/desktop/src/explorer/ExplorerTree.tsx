import { useState } from "react";
import type { DbColumn, DbObject } from "../ipc/types";
import { DbIcon, SearchIcon } from "../lib/icons";

type Props = {
  schemas: string[] | null;
  metaCached: boolean;
  connected: boolean;
  openSchemas: Record<string, boolean>;
  objects: Record<string, DbObject[]>;
  openTables: Record<string, boolean>;
  columns: Record<string, DbColumn[]>;
  onToggleSchema: (schema: string) => void;
  onToggleTable: (schema: string, name: string) => void;
  onInsertSelect: (schema: string, name: string) => void;
  onDescribe: (schema: string, name: string) => void;
  onConnect?: () => void;
};

function objIcon(kind: string): { ch: string; color: string } {
  if (kind === "view") return { ch: "V", color: "var(--tn-purple)" };
  if (kind === "matview") return { ch: "M", color: "var(--tn-purple)" };
  if (kind === "foreign") return { ch: "F", color: "var(--tn-warning)" };
  return { ch: "T", color: "var(--tn-accent)" };
}

export default function ExplorerTree(p: Props) {
  const [filter, setFilter] = useState("");
  const f = filter.trim().toLowerCase();
  const match = (name: string) => !f || name.toLowerCase().includes(f);

  return (
    <>
      <div className="side-head">
        <span className="label">Explorer</span>
        {p.metaCached ? (
          <span className="src-chip cached">CACHED</span>
        ) : p.connected ? (
          <span className="src-chip live">
            <span className="dot" style={{ background: "var(--tn-success)" }} />
            live
          </span>
        ) : null}
      </div>
      {p.schemas !== null && (
        <div className="filter-box">
          <span className="muted" style={{ display: "inline-flex" }}>
            <SearchIcon />
          </span>
          <input placeholder="Filter objects…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
      )}
      <div className="tree">
        {p.schemas === null && p.connected && <div className="note">Loading schemas…</div>}
        {p.schemas === null && !p.connected && (
          <div className="explorer-empty">
            <p>Not connected.</p>
            {p.onConnect && (
              <button className="btn" onClick={p.onConnect}>
                New connection
              </button>
            )}
          </div>
        )}
        {(p.schemas ?? []).map((s) => {
          const objs = p.objects[s];
          const visible = f && objs ? objs.filter((o) => match(o.name)) : objs;
          if (f && objs && visible && visible.length === 0) return null;
          return (
            <div key={s}>
              <button className="tree-row" onClick={() => p.onToggleSchema(s)}>
                <span className={`caret ${p.openSchemas[s] || f ? "open" : ""}`}>▶</span>
                <span style={{ color: "var(--tn-ts)", display: "inline-flex" }}>
                  <DbIcon />
                </span>
                <span style={{ fontWeight: 600, color: "var(--tn-tp)" }}>{s}</span>
                {objs && <span className="count">{objs.length}</span>}
              </button>
              {(p.openSchemas[s] || (f && objs)) && (
                <div className="nested">
                  {!objs && <div className="note">loading…</div>}
                  {objs && objs.length === 0 && <div className="note">empty</div>}
                  {(visible ?? []).map((o) => {
                    const key = `${s}.${o.name}`;
                    const ic = objIcon(o.kind);
                    return (
                      <div key={o.name}>
                        <button className="tree-row" title={o.comment ?? o.kind}>
                          <span
                            className={`caret ${p.openTables[key] ? "open" : ""}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              p.onToggleTable(s, o.name);
                            }}
                          >
                            ▶
                          </span>
                          <span className="obj-ic" style={{ color: ic.color }}>
                            {ic.ch}
                          </span>
                          <span
                            style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", textAlign: "left" }}
                            onClick={() => p.onInsertSelect(s, o.name)}
                          >
                            {o.name}
                          </span>
                          <span className="hover-act">
                            <span
                              title="Describe"
                              onClick={(e) => {
                                e.stopPropagation();
                                p.onDescribe(s, o.name);
                              }}
                            >
                              ⓘ
                            </span>
                            <span
                              title="Insert select"
                              onClick={(e) => {
                                e.stopPropagation();
                                p.onInsertSelect(s, o.name);
                              }}
                            >
                              ↵
                            </span>
                          </span>
                        </button>
                        {p.openTables[key] && (
                          <div>
                            {!(key in p.columns) && <div className="note">loading…</div>}
                            {(p.columns[key] ?? []).map((c) => (
                              <div key={c.name} className="col-line" title={c.comment ?? ""}>
                                <span style={{ width: 13 }}>{c.primaryKey ? "🔑" : ""}</span>
                                <span style={{ color: "var(--tn-tp)" }}>{c.name}</span>
                                <span className="ty">{c.dbType}</span>
                                {!c.nullable && <span className="nn">not null</span>}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
