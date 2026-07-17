import { ModalHead, Overlay } from "./Overlays";

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
  onClose: () => void;
};

const KIND_COLOR: Record<string, string> = {
  table: "var(--tn-accent)",
  view: "var(--tn-purple)",
  matview: "var(--tn-purple)",
  sequence: "var(--tn-success)",
  index: "var(--tn-brand-a, #FFC24B)",
};

/** Values worth reading as code rather than prose. */
const isCode = (k: string) => /definition|sql|bounds|partitioned by|column/i.test(k);
/** Values that are their own warning. */
const isBad = (v: string) => /never used|NO — rebuild|unknown —/i.test(v);

export default function DetailsModal(p: Props) {
  const color = KIND_COLOR[p.details?.kind ?? "table"] ?? "var(--tn-ts)";
  return (
    <Overlay onClose={p.onClose}>
      <div className="modal details-modal">
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
          onClose={p.onClose}
        />
        <div className="modal-body">
          {p.error && <div className="error-box">{p.error}</div>}
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
        </div>
      </div>
    </Overlay>
  );
}
