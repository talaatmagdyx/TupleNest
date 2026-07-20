import { useState } from "react";
import { ModalHead, Overlay } from "./Overlays";
import PlanView from "./PlanView";
import type { PlanNode, PlanStats } from "./PlanView";
import {
  OPTION_META,
  explainLabel,
  optionIssues,
  type ExplainFormat,
  type ExplainOptions,
  type Insight,
} from "../lib/explain";

/** Re-exported so callers keep importing the node shape from here. The drawing
 *  itself lives in PlanView, which the paste-a-plan window shares. */
export type { PlanNode, PlanStats } from "./PlanView";

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
  /** Richer, ordered observations. When present, shown instead of `suggestion`. */
  insights?: Insight[];
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

        <PlanView
          nodes={p.nodes}
          stats={p.stats}
          suggestion={p.suggestion}
          insights={p.insights}
          error={p.error}
          busy={p.busy}
          rawOnly={rawOnly}
          raw={p.raw}
        />
      </div>
    </Overlay>
  );
}
