import { useMemo, useState } from "react";
import { ModalHead, Overlay } from "./Overlays";
import PlanView from "./PlanView";
import { PastePlanRailIcon } from "../lib/icons";
import { kbd } from "../lib/platform";
import { parsePlan, type ParsedPlan } from "../lib/explain";
import { detectPlanFormat, parseTextPlan } from "../lib/explain-text";

/**
 * Analyse a plan someone pasted — from psql, a ticket, a colleague's message.
 *
 * No connection required, and nothing leaves the machine. The alternative
 * people reach for is pasting the plan into a website, which hands a third
 * party your table names, index names, filter conditions and sometimes literal
 * values out of production. This does the same job locally.
 */

export type PasteResult =
  | { kind: "empty" }
  | { kind: "unreadable" }
  | { kind: "ok"; format: "json" | "text"; plan: ParsedPlan };

/** Read a pasted plan in either format. Exported for testing: the decision of
 *  what a blob of text is deserves its own assertions. */
export function analyzePasted(input: string): PasteResult {
  if (!input.trim()) return { kind: "empty" };
  const format = detectPlanFormat(input);
  if (!format) return { kind: "unreadable" };

  try {
    const root: unknown = format === "json" ? JSON.parse(input) : parseTextPlan(input);
    const plan = parsePlan(root);
    // A document we could read but found no nodes in is not a plan we can show.
    if (plan.nodes.length === 0) return { kind: "unreadable" };
    return { kind: "ok", format, plan };
  } catch {
    return { kind: "unreadable" };
  }
}

/** A small plan to show the thing working. Written here rather than lifted from
 *  a database: an example that ships in the binary must not carry anyone's
 *  table names. */
const EXAMPLE = [
  "Sort  (cost=92391.90..93141.90 rows=300000 width=85) (actual time=143.935..157.570 rows=300000.00 loops=1)",
  "  Sort Key: created_at",
  "  Sort Method: external merge  Disk: 27944kB",
  "  Buffers: shared hit=383 read=4295, temp read=13953 written=14714",
  "  ->  Seq Scan on events  (cost=0.00..7672.00 rows=300000 width=85) (actual time=0.055..24.336 rows=300000.00 loops=1)",
  "        Filter: (kind = 'click'::text)",
  "        Rows Removed by Filter: 120000",
  "        Buffers: shared hit=377 read=4295",
  "Planning Time: 1.319 ms",
  "Execution Time: 168.402 ms",
].join("\n");

type Props = { onClose: () => void };

export default function PastePlanModal(p: Props) {
  const [text, setText] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [editing, setEditing] = useState(true);

  const result = useMemo(() => analyzePasted(submitted), [submitted]);
  // Detected as you type, so the answer to "will this work?" arrives before
  // pressing anything.
  const live = useMemo(() => (text.trim() ? detectPlanFormat(text) : null), [text]);
  const lines = text.trim() ? text.trim().split("\n").length : 0;

  const analyze = () => {
    setSubmitted(text);
    if (analyzePasted(text).kind === "ok") setEditing(false);
  };
  const reset = () => {
    setText("");
    setSubmitted("");
    setEditing(true);
  };

  return (
    <Overlay onClose={p.onClose}>
      <div className="modal explain-modal">
        <ModalHead
          title={
            <span style={{ display: "inline-flex", gap: 9, alignItems: "center" }}>
              <span className="chip" style={{ color: "var(--tn-accent)", background: "var(--tn-as)" }}>
                ANALYZE A PASTED PLAN
              </span>
              <span className="mono" style={{ fontSize: 12, color: "var(--tn-tm)" }}>
                no connection needed
              </span>
            </span>
          }
          actions={
            editing ? (
              <>
                <button className="btn" disabled={!text.trim()} onClick={reset}>
                  Clear
                </button>
                <button className="btn primary" disabled={!text.trim()} onClick={analyze}>
                  Analyze
                </button>
              </>
            ) : (
              <button className="btn" onClick={() => setEditing(true)}>
                Edit plan
              </button>
            )
          }
          onClose={p.onClose}
        />

        {editing ? (
          <div className="paste-wrap">
            <div className={`paste-zone ${text ? "filled" : ""}`}>
              <textarea
                aria-label="Paste a query plan"
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
                value={text}
                autoFocus
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  // The plan is multi-line, so Enter must stay Enter.
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && text.trim()) analyze();
                }}
              />
              {!text && (
                <div className="paste-hint">
                  <span className="ph-icon">
                    <PastePlanRailIcon size={26} />
                  </span>
                  <b>Paste a query plan</b>
                  <span>
                    Output of <code className="mono">EXPLAIN (ANALYZE, BUFFERS)</code> — psql text or FORMAT JSON
                  </span>
                  <span className="ph-priv">Read on this machine. Nothing is sent anywhere.</span>
                </div>
              )}
            </div>

            <div className="paste-bar">
              {live && <span className="fmt-chip ok">{live.toUpperCase()} PLAN</span>}
              {text.trim() && !live && <span className="fmt-chip no">NOT RECOGNISED</span>}
              {lines > 0 && <span className="pb-meta">{lines} lines</span>}
              <span className="grow" />
              {!text && (
                <button className="btn" onClick={() => setText(EXAMPLE)}>
                  Try an example
                </button>
              )}
              <span className="pb-meta">{kbd("mod", "↵")} to analyze</span>
            </div>

            {submitted && result.kind === "unreadable" && (
              <div className="ex-issue error" style={{ marginTop: 10 }}>
                That doesn&apos;t look like a PostgreSQL plan. Paste the whole EXPLAIN output, starting from the first
                node line.
              </div>
            )}
          </div>
        ) : (
          result.kind === "ok" && (
            <div className="paste-summary">
              <span className="fmt-chip ok">read as {result.format.toUpperCase()}</span>
              <span>
                {result.plan.nodes.length} nodes · {lines} lines
              </span>
              <span className="grow" style={{ flex: 1 }} />
              <button className="btn" onClick={reset}>
                Clear
              </button>
            </div>
          )
        )}

        {result.kind === "ok" && (
          <PlanView
            nodes={result.plan.nodes}
            stats={result.plan.stats}
            suggestion={result.plan.suggestion}
            insights={result.plan.insights}
            error={null}
            maxHeight={editing ? "34vh" : "52vh"}
          />
        )}
      </div>
    </Overlay>
  );
}
