import { useMemo, useState } from "react";
import { ModalHead, Overlay } from "./Overlays";
import PlanView from "./PlanView";
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

type Props = { onClose: () => void };

export default function PastePlanModal(p: Props) {
  const [text, setText] = useState("");
  const [submitted, setSubmitted] = useState("");

  const result = useMemo(() => analyzePasted(submitted), [submitted]);

  return (
    <Overlay onClose={p.onClose}>
      <div className="modal explain-modal">
        <ModalHead
          title={
            <span style={{ display: "inline-flex", gap: 9, alignItems: "center" }}>
              <span className="chip" style={{ color: "var(--tn-accent)", background: "var(--tn-as)" }}>
                ANALYZE A PASTED PLAN
              </span>
              {result.kind === "ok" && (
                <span className="mono" style={{ fontSize: 12, color: "var(--tn-tm)" }}>
                  read as {result.format.toUpperCase()}
                </span>
              )}
            </span>
          }
          actions={
            <>
              <button className="btn" disabled={!text.trim()} onClick={() => { setText(""); setSubmitted(""); }}>
                Clear
              </button>
              <button className="btn primary" disabled={!text.trim()} onClick={() => setSubmitted(text)}>
                Analyze
              </button>
            </>
          }
          onClose={p.onClose}
        />

        <div className="ex-issue stale" style={{ background: "transparent" }}>
          Paste the output of <code className="mono">EXPLAIN (ANALYZE, BUFFERS)</code> — the indented text from psql, or
          FORMAT JSON. Nothing is sent anywhere; the plan is read on this machine.
        </div>

        <div style={{ padding: "0 16px 12px" }}>
          <textarea
            className="mono"
            aria-label="Paste a query plan"
            placeholder={"Sort  (cost=92391.90..93141.90 rows=300000 width=85) (actual time=143.935..157.570 rows=300000.00 loops=1)\n  Sort Method: external merge  Disk: 27944kB\n  ->  Seq Scan on orders  (cost=0.00..7672.00 …)"}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            value={text}
            onChange={(e) => setText(e.target.value)}
            style={{ width: "100%", minHeight: 120, resize: "vertical" }}
          />
          {submitted && result.kind === "unreadable" && (
            <div className="ex-issue error" style={{ marginTop: 8 }}>
              That doesn&apos;t look like a PostgreSQL plan. Paste the whole EXPLAIN output, including the first line.
            </div>
          )}
        </div>

        {result.kind === "ok" && (
          <PlanView
            nodes={result.plan.nodes}
            stats={result.plan.stats}
            suggestion={result.plan.suggestion}
            insights={result.plan.insights}
            error={null}
            maxHeight="40vh"
          />
        )}
      </div>
    </Overlay>
  );
}
