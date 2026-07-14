import { ModalHead, Overlay } from "./Overlays";

export type PlanNode = {
  kind: string;
  title: string;
  detail: string;
  ms: number | null;
  pct: number; // 0..100 of total time/cost
  indent: number;
  hot: boolean;
};

export type PlanStats = { label: string; value: string }[];

function kindColors(kind: string, hot: boolean): { color: string; bg: string } {
  if (hot) return { color: "var(--tn-danger)", bg: "rgba(239,77,77,.14)" };
  if (/sort|limit|aggregate|agg/i.test(kind)) return { color: "var(--tn-warning)", bg: "rgba(224,161,58,.14)" };
  if (/join|hash|merge|nested/i.test(kind)) return { color: "var(--tn-accent)", bg: "rgba(77,141,255,.14)" };
  if (/index/i.test(kind)) return { color: "var(--tn-success)", bg: "rgba(63,185,80,.14)" };
  return { color: "var(--tn-ts)", bg: "var(--tn-s2)" };
}

type Props = {
  title: string;
  analyzed: boolean;
  nodes: PlanNode[] | null; // null = running
  stats: PlanStats;
  suggestion: string | null;
  error: string | null;
  onClose: () => void;
};

export default function ExplainModal(p: Props) {
  return (
    <Overlay onClose={p.onClose}>
      <div className="modal explain-modal">
        <ModalHead
          title={
            <span style={{ display: "inline-flex", gap: 9, alignItems: "center" }}>
              <span className="chip" style={{ color: "var(--tn-accent)", background: "var(--tn-as)" }}>
                {p.analyzed ? "EXPLAIN ANALYZE" : "EXPLAIN"}
              </span>
              <span className="mono" style={{ fontSize: 12, color: "var(--tn-tm)" }}>
                {p.title}
              </span>
            </span>
          }
          onClose={p.onClose}
        />
        <div className="explain-body" style={{ maxHeight: "62vh" }}>
          <div className="plan-col">
            {p.error && <div className="error-box">{p.error}</div>}
            {!p.error && p.nodes === null && <div className="note muted">running EXPLAIN…</div>}
            {(p.nodes ?? []).map((n, i) => {
              const kc = kindColors(n.kind, n.hot);
              return (
                <div key={i} className={`plan-node ${n.hot ? "hot" : ""}`} style={{ marginLeft: n.indent * 22 }}>
                  <div className="pn-head">
                    <span className="pn-kind" style={{ color: kc.color, background: kc.bg }}>
                      {n.kind.toUpperCase()}
                    </span>
                    <span className="pn-title">{n.title}</span>
                    {n.hot && <span className="hotchip">HOT</span>}
                    <span className="pn-cost">{n.ms !== null ? `${n.ms.toFixed(1)} ms` : ""}</span>
                  </div>
                  <div className="pn-bar">
                    <i style={{ width: `${Math.max(2, n.pct)}%`, background: kc.color }} />
                  </div>
                  <div className="pn-detail">{n.detail}</div>
                </div>
              );
            })}
          </div>
          <div className="plan-stats">
            <div className="sect-label" style={{ marginTop: 0 }}>
              Statistics
            </div>
            {p.stats.map((s) => (
              <div key={s.label} className="kv-row">
                <span className="kl">{s.label}</span>
                <span className="mono" style={{ fontSize: 11.5 }}>
                  {s.value}
                </span>
              </div>
            ))}
            {p.suggestion && (
              <div className="tip-card">
                <b>💡 Suggestion</b> — {p.suggestion}
              </div>
            )}
          </div>
        </div>
      </div>
    </Overlay>
  );
}
