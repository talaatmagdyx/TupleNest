import { useState } from "react";
import { ModalHead, Overlay } from "./Overlays";
import { parseForeignKey, type TableStructure } from "../lib/structure";

/** Whatever the server chose to tell us about this object. The shape is
 *  generic on purpose — a sequence, an index and a table have almost nothing
 *  in common, and the UI shouldn't pretend otherwise. */
export type ObjectDetails = {
  title: string;
  kind: string;
  sections: { label: string; rows: { k: string; v: string }[] }[];
};

type Props = {
  schema: string;
  details: ObjectDetails | null; // null = loading
  error: string | null;
  /** Undefined: not a relation with columns. Null: still loading. */
  structure?: TableStructure | null;
  /** "Query this table": puts a select for it in the editor. */
  onQuery?: () => void;
  /** Present only while the ER diagram can be opened (it needs a session). */
  onDiagram?: () => void;
  onClose: () => void;
};

const KIND_COLOR: Record<string, string> = {
  table: "var(--tn-accent)",
  view: "var(--tn-purple)",
  matview: "var(--tn-purple)",
  sequence: "var(--tn-success)",
  index: "var(--tn-warning)",
};

/** Values worth reading as code rather than prose. */
const isCode = (k: string) => /definition|sql|bounds|partitioned by|column/i.test(k);
/** Values that are their own warning. */
const isBad = (v: string) => /never used|NO — rebuild|unknown —/i.test(v);

type Tab = "structure" | "details";

export default function DetailsModal(p: Props) {
  const color = KIND_COLOR[p.details?.kind ?? "table"] ?? "var(--tn-ts)";
  const tabbed = p.structure !== undefined;
  // Details first: this dialog is what the explorer's Details button opens,
  // and the sizes and counters are what that button promises.
  const [tab, setTab] = useState<Tab>("details");
  const shown: Tab = tabbed ? tab : "details";
  const tabs: { id: Tab; label: string }[] = [
    { id: "details", label: "Details" },
    { id: "structure", label: "Structure" },
  ];
  return (
    <Overlay onClose={p.onClose}>
      <div className={`modal details-modal ${tabbed ? "wide" : ""}`}>
        <ModalHead
          title={
            <span style={{ display: "inline-flex", gap: 9, alignItems: "center" }}>
              <span className="chip" style={{ color, background: "var(--tn-s2)" }}>
                {(p.details?.kind ?? "object").toUpperCase()}
              </span>
              <span className="mono" style={{ fontSize: 12.5, color: "var(--tn-tp)" }}>
                {p.schema}.{p.details?.title ?? "…"}
              </span>
            </span>
          }
          actions={
            p.onQuery && (
              <button className="btn primary" onClick={p.onQuery}>
                Query this table
              </button>
            )
          }
          onClose={p.onClose}
        />
        {tabbed && (
          <div
            className="det-tabs"
            role="tablist"
            aria-label="Table views"
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                e.preventDefault();
                setTab((t) => (t === "structure" ? "details" : "structure"));
              }
            }}
          >
            {tabs.map((t) => (
              <button
                key={t.id}
                role="tab"
                id={`det-tab-${t.id}`}
                aria-selected={shown === t.id}
                aria-controls={`det-panel-${t.id}`}
                tabIndex={shown === t.id ? 0 : -1}
                className={`det-tab ${shown === t.id ? "on" : ""}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}
        <div
          className="modal-body"
          role={tabbed ? "tabpanel" : undefined}
          id={tabbed ? `det-panel-${shown}` : undefined}
          aria-labelledby={tabbed ? `det-tab-${shown}` : undefined}
        >
          {p.error && <div className="error-box">{p.error}</div>}
          {shown === "structure" ? (
            <Structure s={p.structure ?? null} onDiagram={p.onDiagram} />
          ) : (
            <>
              {!p.error && !p.details && <div className="note muted">loading…</div>}
              {p.details?.sections.length === 0 && <div className="note muted">Nothing to report.</div>}
              {p.details?.sections.map((s) => (
                <div key={s.label} className="det-sect">
                  <div className="sect-label">{s.label}</div>
                  {s.rows.map((r) => (
                    <div key={r.k} className="kv-row">
                      <span className="kl">{r.k}</span>
                      <span
                        className={isCode(r.k) ? "det-code" : "det-v"}
                        style={isBad(r.v) ? { color: "var(--tn-danger)" } : undefined}
                      >
                        {r.v}
                      </span>
                    </div>
                  ))}
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </Overlay>
  );
}

/** Columns on the left; indexes and relations beside them. */
function Structure(p: { s: TableStructure | null; onDiagram?: () => void }) {
  if (!p.s) return <div className="note muted">loading…</div>;
  const fks = p.s.constraints
    .filter((c) => c.kind === "foreign key")
    .map((c) => ({ name: c.name, fk: parseForeignKey(c.definition) }));
  const fkCols = new Set(fks.flatMap((f) => (f.fk ? f.fk.from.split(",").map((c) => c.trim()) : [])));
  return (
    <div className="det-structure">
      <table className="page-table det-cols">
        <thead>
          <tr>
            <th scope="col">Column</th>
            <th scope="col">Type</th>
            <th scope="col">Null</th>
            <th scope="col">Notes</th>
          </tr>
        </thead>
        <tbody>
          {p.s.columns.length === 0 && (
            <tr>
              <td colSpan={4} className="center-note">
                No columns could be read.
              </td>
            </tr>
          )}
          {p.s.columns.map((c) => (
            <tr key={c.name}>
              <td className="mono strong">{c.name}</td>
              <td className="mono kw">{c.dbType}</td>
              <td className="muted">{c.nullable ? "yes" : "no"}</td>
              <td className="det-notes">
                {c.primaryKey && <span className="tchip warn">primary key</span>}
                {fkCols.has(c.name) && <span className="tchip info">foreign key</span>}
                {c.generated && <span className="tchip">generated</span>}
                {c.comment && <span className="muted">{c.comment}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <aside className="det-side" aria-label="Indexes and relations">
        <div className="det-card">
          <span className="pane-label">Indexes</span>
          {p.s.indexes.length === 0 && <span className="muted">None.</span>}
          {p.s.indexes.map((ix) => (
            <div key={ix.name} className="det-item">
              <span className="mono strong">{ix.name}</span>
              <span className="muted">
                {[ix.isPrimary ? "primary" : ix.isUnique ? "unique" : null, // SQLite keeps no usage counters: its scans come back null,
                  // and a missing number is left out rather than shown as 0.
                  typeof ix.scans === "number" ? `${ix.scans.toLocaleString()} scans` : null, ix.isValid ? null : "invalid"]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              <span className="mono det-def">{ix.definition}</span>
            </div>
          ))}
        </div>
        <div className="det-card">
          <span className="pane-label">Relations</span>
          {fks.length === 0 && <span className="muted">No foreign keys.</span>}
          {fks.map((f) => (
            <div key={f.name} className="det-rel mono">
              {f.fk ? (
                <>
                  {f.fk.from} → <b>{f.fk.to}</b>
                </>
              ) : (
                f.name
              )}
            </div>
          ))}
          {p.onDiagram && (
            <button className="btn" onClick={p.onDiagram}>
              Show in ER diagram
            </button>
          )}
        </div>
      </aside>
    </div>
  );
}
