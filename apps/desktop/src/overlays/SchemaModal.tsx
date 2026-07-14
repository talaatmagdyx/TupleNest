import type { DbColumn } from "../ipc/types";
import { ModalHead, Overlay } from "./Overlays";

export type SchemaExtra = {
  indexes: { name: string; def: string }[];
  rowsEstimate: number | null;
  totalSize: string | null;
  comment: string | null;
};

type Props = {
  schema: string;
  name: string;
  kind: string;
  columns: DbColumn[] | null; // null = loading
  extra: SchemaExtra | null;
  onClose: () => void;
};

/** Object detail peek (ⓘ in the explorer). Columns come from the live
 *  DescribeObject metadata; DDL is reconstructed from them. */
export default function SchemaModal(p: Props) {
  const cols = p.columns ?? [];
  const ddl =
    `create table ${p.schema}.${p.name} (\n` +
    cols
      .map(
        (c) =>
          `  ${c.name} ${c.dbType}${c.primaryKey ? " primary key" : ""}${
            !c.nullable && !c.primaryKey ? " not null" : ""
          }`
      )
      .join(",\n") +
    "\n);";
  return (
    <Overlay onClose={p.onClose}>
      <div className="modal schema-modal">
        <ModalHead
          title={
            <span style={{ display: "inline-flex", gap: 9, alignItems: "center" }}>
              <span className="obj-ic" style={{ color: "var(--tn-accent)" }}>
                T
              </span>
              <span className="mono">
                {p.schema}.{p.name}
              </span>
              <span className="chip" style={{ color: "var(--tn-tm)", background: "var(--tn-s2)" }}>
                {p.kind}
              </span>
            </span>
          }
          onClose={p.onClose}
        />
        <div className="modal-body">
          <div className="meta-grid">
            <div className="meta-cell">
              <div className="ml">Rows (est.)</div>
              <div className="mv">
                {p.extra?.rowsEstimate != null && p.extra.rowsEstimate >= 0
                  ? p.extra.rowsEstimate.toLocaleString()
                  : "—"}
              </div>
            </div>
            <div className="meta-cell">
              <div className="ml">Table size</div>
              <div className="mv">{p.extra?.totalSize ?? "—"}</div>
            </div>
            <div className="meta-cell">
              <div className="ml">Indexes</div>
              <div className="mv">{p.extra ? p.extra.indexes.length : "…"}</div>
            </div>
            <div className="meta-cell">
              <div className="ml">Comment</div>
              <div className="mv" style={{ fontSize: 11 }}>{p.extra?.comment ?? "—"}</div>
            </div>
          </div>
          <div className="sect-label">Columns</div>
          {!p.columns && <div className="note muted">loading…</div>}
          {cols.map((c) => (
            <div key={c.name} className="col-line" style={{ paddingLeft: 4 }} title={c.comment ?? ""}>
              <span style={{ width: 15 }}>{c.primaryKey ? "🔑" : ""}</span>
              <span style={{ color: "var(--tn-tp)", width: 170 }}>{c.name}</span>
              <span className="ty">{c.dbType}</span>
              {!c.nullable && <span className="nn">not null</span>}
            </div>
          ))}
          <div className="sect-label">Indexes</div>
          {p.extra && p.extra.indexes.length === 0 && <div className="note muted">no indexes</div>}
          {(p.extra?.indexes ?? []).map((ix) => (
            <div key={ix.name} className="col-line" style={{ paddingLeft: 4 }}>
              <span style={{ color: "var(--tn-tp)", width: 220, flex: "none", overflow: "hidden", textOverflow: "ellipsis" }}>
                {ix.name}
              </span>
              <span className="ty" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                {ix.def.replace(/^CREATE (UNIQUE )?INDEX \S+ ON \S+ USING /i, "$1")}
              </span>
            </div>
          ))}
          <div className="sect-label">DDL (reconstructed)</div>
          <pre
            className="mono"
            style={{
              background: "var(--tn-bg)",
              border: "1px solid var(--tn-bs)",
              borderRadius: 8,
              padding: "10px 13px",
              fontSize: 11.5,
              lineHeight: 1.6,
              whiteSpace: "pre-wrap",
            }}
          >
            {p.columns ? ddl : "…"}
          </pre>
        </div>
      </div>
    </Overlay>
  );
}
