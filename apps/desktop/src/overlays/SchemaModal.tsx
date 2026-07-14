import type { DbColumn } from "../ipc/types";
import { ModalHead, Overlay } from "./Overlays";

type Props = {
  schema: string;
  name: string;
  kind: string;
  columns: DbColumn[] | null; // null = loading
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
              <div className="ml">Columns</div>
              <div className="mv">{p.columns ? cols.length : "…"}</div>
            </div>
            <div className="meta-cell">
              <div className="ml">Primary key</div>
              <div className="mv">{cols.find((c) => c.primaryKey)?.name ?? "—"}</div>
            </div>
            <div className="meta-cell">
              <div className="ml">Not null</div>
              <div className="mv">{cols.filter((c) => !c.nullable).length}</div>
            </div>
            <div className="meta-cell">
              <div className="ml">Kind</div>
              <div className="mv">{p.kind}</div>
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
