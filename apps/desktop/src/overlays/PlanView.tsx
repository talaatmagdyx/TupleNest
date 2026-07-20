import type { Insight, NodeFlag } from "../lib/explain";

/** One drawable plan node. The richer fields are optional so a plain fixture —
 *  or a plan from a server that reported less — still types. */
export type PlanNode = {
  kind: string;
  title: string;
  detail: string;
  ms: number | null;
  pct: number; // 0..100 of total time/cost
  indent: number;
  hot: boolean;
  selfMs?: number | null;
  selfPct?: number;
  rowsEst?: number | null;
  rowsActual?: number | null;
  misestimate?: number | null;
  loops?: number | null;
  rowsRemoved?: number | null;
  flags?: NodeFlag[];
};

export type PlanStats = { label: string; value: string }[];

/** 300000 → "300k". Loop counts get long and the badge has to stay short. */
export function compact(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
  if (n >= 1_000) return `${Math.round(n / 100) / 10}k`;
  return String(n);
}

function kindColors(kind: string, hot: boolean): { color: string; bg: string } {
  if (hot) return { color: "var(--tn-danger)", bg: "rgba(239,77,77,.14)" };
  if (/sort|limit|aggregate|agg/i.test(kind)) return { color: "var(--tn-warning)", bg: "rgba(224,161,58,.14)" };
  if (/join|hash|merge|nested/i.test(kind)) return { color: "var(--tn-accent)", bg: "rgba(77,141,255,.14)" };
  if (/index/i.test(kind)) return { color: "var(--tn-success)", bg: "rgba(63,185,80,.14)" };
  return { color: "var(--tn-ts)", bg: "var(--tn-s2)" };
}

/** The badges shown next to a node, in priority order. Seq-scan is deliberately
 *  not a badge — it's already colour-coded and would be noise on every table
 *  read; the badges are for the things worth looking at. */
export function nodeChips(n: PlanNode): { label: string; cls: string; title: string }[] {
  const f = n.flags ?? [];
  const chips: { label: string; cls: string; title: string }[] = [];
  if (f.includes("bottleneck"))
    chips.push({ label: "BOTTLENECK", cls: "bottleneck", title: "Most of the execution self-time is spent here" });
  if (f.includes("never-executed"))
    chips.push({ label: "NEVER EXECUTED", cls: "", title: "The executor never reached this branch" });
  if (f.includes("wasteful-filter") && n.rowsRemoved != null)
    chips.push({
      label: `DISCARDED ${compact(n.rowsRemoved)}`,
      cls: "warn",
      title: "Most of the rows this node read were thrown away by its filter",
    });
  if (f.includes("disk-sort"))
    chips.push({ label: "DISK SORT", cls: "warn", title: "This sort spilled to disk — consider raising work_mem" });
  if (f.includes("spill"))
    chips.push({ label: "SPILLED", cls: "warn", title: "A hash step used multiple batches — consider raising work_mem" });
  if (f.includes("heavy-read"))
    chips.push({ label: "HEAVY READ", cls: "warn", title: "Read a lot of blocks from disk rather than cache" });
  if (f.includes("high-loops") && n.loops != null)
    chips.push({ label: `${compact(n.loops)} LOOPS`, cls: "info", title: "This node ran many times" });
  if (f.includes("misestimate") && n.misestimate != null)
    chips.push({
      label: `EST ×${Math.round(n.misestimate)} OFF`,
      cls: "info",
      title: "The row estimate missed the actual count by this factor",
    });
  return chips;
}

type Props = {
  nodes: PlanNode[] | null; // null = still running
  stats: PlanStats;
  suggestion: string | null;
  /** Richer, ordered observations. When present, shown instead of `suggestion`. */
  insights?: Insight[];
  error: string | null;
  busy?: boolean;
  /** A format we cannot draw as a tree — show the server's own output instead. */
  rawOnly?: boolean;
  raw?: string;
  maxHeight?: string;
  /** Shown in the stats column when there is no plan yet. */
  placeholder?: string;
};

/**
 * The plan tree and its statistics — shared by the EXPLAIN modal and the
 * paste-a-plan window so both draw a plan the same way, whether it came from
 * this connection or from someone's clipboard.
 */
export default function PlanView(p: Props) {
  return (
    <div className="explain-body" style={{ maxHeight: p.maxHeight ?? "52vh" }}>
      <div className="plan-col">
        {p.error && <div className="error-box">{p.error}</div>}
        {!p.error && p.busy && <div className="note muted">running EXPLAIN…</div>}
        {/* Non-JSON formats can't be drawn as a tree, but they are still the
            plan — show them verbatim rather than sending the user away. */}
        {!p.error && !p.busy && p.rawOnly && <pre className="ex-raw">{p.raw || "—"}</pre>}
        {!p.error && !p.rawOnly && !p.nodes && p.placeholder && <div className="note muted">{p.placeholder}</div>}
        {!p.error && !p.rawOnly &&
          (p.nodes ?? []).map((n, i) => {
            const kc = kindColors(n.kind, n.hot);
            const chips = nodeChips(n);
            const isBottleneck = (n.flags ?? []).includes("bottleneck");
            // The bar shows where time is actually spent. With ANALYZE that is
            // self-time; without it, cost share is all there is.
            const hasSelf = n.selfMs != null && n.selfPct != null;
            const barPct = hasSelf ? (n.selfPct as number) : n.pct;
            return (
              <div
                key={i}
                className={`plan-node ${n.hot ? "hot" : ""} ${isBottleneck ? "bottleneck" : ""}`}
                style={{ marginLeft: n.indent * 22 }}
              >
                <div className="pn-head">
                  <span className="pn-kind" style={{ color: kc.color, background: kc.bg }}>
                    {n.kind.toUpperCase()}
                  </span>
                  <span className="pn-title">{n.title}</span>
                  {n.hot && <span className="hotchip">HOT</span>}
                  {chips.map((c) => (
                    <span key={c.label} className={`pn-chip ${c.cls}`} title={c.title}>
                      {c.label}
                    </span>
                  ))}
                  <span className="pn-cost">
                    {(n.flags ?? []).includes("never-executed")
                      ? "never executed"
                      : hasSelf
                        ? `self ${(n.selfMs as number).toFixed(1)} ms`
                        : n.ms !== null
                          ? `${n.ms.toFixed(1)} ms`
                          : ""}
                  </span>
                </div>
                <div className="pn-bar" title={hasSelf ? "Share of execution self-time" : "Share of total cost"}>
                  <i style={{ width: `${Math.max(2, barPct)}%`, background: kc.color }} />
                </div>
                <div className="pn-detail">
                  {n.detail}
                  {hasSelf && n.ms !== null && <span className="pn-incl"> · {n.ms.toFixed(1)} ms total</span>}
                </div>
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
        {p.stats.length === 0 && (
          <div className="note muted">
            {/* A bare dash reads as a bug. Say why there is nothing here. */}
            {p.rawOnly ? "Statistics need FORMAT JSON." : "—"}
          </div>
        )}
        {/* The richer insights supersede the single suggestion when present;
            a plain fixture with only `suggestion` still shows its tip. */}
        {p.insights && p.insights.length > 0 ? (
          <div className="ex-insights">
            <div className="sect-label">Insights</div>
            {p.insights.map((ins, k) => (
              <div key={k} className={`ex-insight ${ins.level}`}>
                <span className="ins-mark">{ins.level === "tip" ? "💡" : ins.level === "warn" ? "⚠️" : "ℹ️"}</span>
                <span>{ins.text}</span>
              </div>
            ))}
          </div>
        ) : (
          p.suggestion && (
            <div className="tip-card">
              <b>💡 Suggestion</b> — {p.suggestion}
            </div>
          )
        )}
      </div>
    </div>
  );
}
