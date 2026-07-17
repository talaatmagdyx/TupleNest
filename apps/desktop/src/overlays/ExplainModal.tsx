import { useState } from "react";
import { ModalHead, Overlay } from "./Overlays";
import {
  OPTION_META,
  explainLabel,
  optionIssues,
  type ExplainFormat,
  type ExplainOptions,
} from "../lib/explain";

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

const FORMATS: ExplainFormat[] = ["json", "text", "yaml", "xml"];

type Props = {
  title: string;
  sql: string;
  options: ExplainOptions;
  serverMajor?: number;
  statement: string;
  /** Raw server payload — shown as-is for the non-JSON formats. */
  raw: string;
  /** True when the options have been changed since the shown plan was produced. */
  stale: boolean;
  nodes: PlanNode[] | null; // null = running
  stats: PlanStats;
  suggestion: string | null;
  error: string | null;
  busy: boolean;
  onOptions: (o: ExplainOptions) => void;
  onRerun: () => void;
  onExport: (kind: "json" | "txt" | "md") => void;
  onCopy: (kind: "json" | "txt" | "md") => void;
  onClose: () => void;
};

export default function ExplainModal(p: Props) {
  const [menu, setMenu] = useState(false);
  const issues = optionIssues(p.options, p.sql, p.serverMajor);
  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warning");
  // FORMAT JSON is what we parse into the tree; anything else can only be
  // exported raw, so say so rather than showing an empty plan.
  const rawOnly = p.options.format !== "json";

  const toggle = (key: keyof ExplainOptions) => p.onOptions({ ...p.options, [key]: !p.options[key] });

  return (
    <Overlay onClose={p.onClose}>
      <div className="modal explain-modal">
        <ModalHead
          title={
            <span style={{ display: "inline-flex", gap: 9, alignItems: "center" }}>
              <span className="chip" style={{ color: "var(--tn-accent)", background: "var(--tn-as)" }}>
                {explainLabel(p.options)}
              </span>
              <span className="mono" style={{ fontSize: 12, color: "var(--tn-tm)" }}>
                {p.title}
              </span>
            </span>
          }
          actions={
            <>
              <div className="menu-wrap">
                <button className="btn" disabled={!p.nodes && !p.error} onClick={() => setMenu((m) => !m)}>
                  Export ▾
                </button>
                {menu && (
                  <div className="drop-menu">
                    <div className="menu-label">Save plan as</div>
                    <button onClick={() => { setMenu(false); p.onExport("json"); }}>
                      JSON <span>.json</span>
                    </button>
                    <button onClick={() => { setMenu(false); p.onExport("txt"); }}>
                      Text tree <span>.txt</span>
                    </button>
                    <button onClick={() => { setMenu(false); p.onExport("md"); }}>
                      Markdown <span>.md</span>
                    </button>
                    <div className="divider" />
                    <div className="menu-label">Copy to clipboard</div>
                    <button onClick={() => { setMenu(false); p.onCopy("json"); }}>
                      JSON <span>for pev2 / depesz</span>
                    </button>
                    <button onClick={() => { setMenu(false); p.onCopy("txt"); }}>
                      Text tree
                    </button>
                  </div>
                )}
              </div>
              <button className="btn primary" onClick={p.onRerun} disabled={p.busy || errors.length > 0}>
                {p.busy ? "Running…" : "Re-run"}
              </button>
            </>
          }
          onClose={p.onClose}
        />

        <div className="ex-opts">
          {OPTION_META.map((m) => {
            const on = !!p.options[m.key];
            const unavailable = m.since !== undefined && p.serverMajor !== undefined && p.serverMajor < m.since;
            return (
              <button
                key={m.key}
                className={`ex-opt ${on ? "on" : ""} ${m.key === "analyze" && on ? "danger" : ""}`}
                title={unavailable ? `${m.hint} — needs PostgreSQL ${m.since}+` : m.hint}
                disabled={unavailable || p.busy}
                onClick={() => toggle(m.key)}
              >
                {m.label}
              </button>
            );
          })}
          <span className="ex-sep" />
          <select
            className="ex-format"
            value={p.options.format}
            disabled={p.busy}
            onChange={(e) => p.onOptions({ ...p.options, format: e.target.value as ExplainFormat })}
            title="Server output format. Only JSON can be drawn as a tree."
          >
            {FORMATS.map((f) => (
              <option key={f} value={f}>
                {f.toUpperCase()}
              </option>
            ))}
          </select>
        </div>

        {errors.map((i, k) => (
          <div key={k} className="ex-issue error">
            {i.message}
          </div>
        ))}
        {warnings.map((i, k) => (
          <div key={k} className="ex-issue warn">
            <strong>Careful.</strong> {i.message}
          </div>
        ))}
        {/* Never let changed options imply the plan below reflects them. */}
        {p.stale && !p.busy && errors.length === 0 && (
          <div className="ex-issue stale">
            Options changed — the plan below is from the previous run. Press <strong>Re-run</strong>.
          </div>
        )}

        <div className="ex-stmt mono" title={p.statement}>
          {p.statement}
        </div>

        <div className="explain-body" style={{ maxHeight: "52vh" }}>
          <div className="plan-col">
            {p.error && <div className="error-box">{p.error}</div>}
            {!p.error && p.busy && <div className="note muted">running EXPLAIN…</div>}
            {/* Non-JSON formats can't be drawn as a tree, but they are still
                the plan — show them verbatim rather than sending the user away.
                FORMAT TEXT in particular is what most people read in psql. */}
            {!p.error && !p.busy && rawOnly && (
              <pre className="ex-raw">{p.raw || "—"}</pre>
            )}
            {!p.error && !rawOnly &&
              (p.nodes ?? []).map((n, i) => {
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
            {p.stats.length === 0 && <div className="note muted">—</div>}
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
