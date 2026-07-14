import type { DbColumn, DbObject } from "../ipc/types";

type Props = {
  schemas: string[] | null;
  metaCached: boolean;
  openSchemas: Record<string, boolean>;
  objects: Record<string, DbObject[]>;
  openTables: Record<string, boolean>;
  columns: Record<string, DbColumn[]>;
  onToggleSchema: (schema: string) => void;
  onToggleTable: (schema: string, name: string) => void;
  onInsertSelect: (schema: string, name: string) => void;
};

/** Lazy metadata tree: schemas → objects → columns (E1.3). */
export default function ExplorerTree(p: Props) {
  return (
    <div className="explorer">
      <h2>
        Explorer{" "}
        {p.metaCached && (
          <span className="cache-badge" title="Served from local metadata cache">
            cached
          </span>
        )}
      </h2>
      {p.schemas === null && <p className="muted">Loading schemas…</p>}
      <ul className="tree">
        {(p.schemas ?? []).map((s) => (
          <li key={s}>
            <div className="tree-row" onClick={() => p.onToggleSchema(s)}>
              <span className="twisty">{p.openSchemas[s] ? "▾" : "▸"}</span>
              <span className="tree-label">{s}</span>
            </div>
            {p.openSchemas[s] && (
              <ul className="tree nested">
                {!(s in p.objects) && <li className="muted">loading…</li>}
                {(p.objects[s] ?? []).length === 0 && s in p.objects && (
                  <li className="muted">empty</li>
                )}
                {(p.objects[s] ?? []).map((o) => {
                  const key = `${s}.${o.name}`;
                  return (
                    <li key={o.name}>
                      <div className="tree-row" title={o.comment ?? o.kind}>
                        <span
                          className="twisty"
                          onClick={() => p.onToggleTable(s, o.name)}
                        >
                          {p.openTables[key] ? "▾" : "▸"}
                        </span>
                        <span className={`obj-kind kind-${o.kind}`}>
                          {o.kind === "table" ? "T" : o.kind === "view" ? "V" : "M"}
                        </span>
                        <span
                          className="tree-label clickable"
                          onClick={() => p.onInsertSelect(s, o.name)}
                          title={`Insert SELECT for ${key}`}
                        >
                          {o.name}
                        </span>
                      </div>
                      {p.openTables[key] && (
                        <ul className="tree nested cols">
                          {!(key in p.columns) && <li className="muted">loading…</li>}
                          {(p.columns[key] ?? []).map((c) => (
                            <li key={c.name} title={c.comment ?? ""}>
                              <span className="col-name">
                                {c.primaryKey ? "🔑 " : ""}
                                {c.name}
                              </span>
                              <span className="muted">
                                {c.dbType}
                                {c.nullable ? "" : " · not null"}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
