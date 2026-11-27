import { classify, diffLines } from "./answer";

type Props = {
  sql: string;
  /** Environment of the live session, for the guard note. */
  env: string | null;
  /** For a Fix: the editor text being replaced. The card then shows a diff
   *  and its primary button applies the fix instead of inserting. */
  baseSql?: string;
  /** True while the answer is still arriving: the statement may be partial. */
  streaming?: boolean;
  onInsert: (sql: string) => void;
  onApply: (sql: string) => void;
  onCopy: (sql: string) => void;
};

/**
 * One SQL suggestion. Nothing here runs anything: the buttons put the text
 * in the editor or on the clipboard, and the user's own Run is what sends it
 * to the database — through the read-only, guard and audit paths unchanged.
 */
export default function CodeCard(p: Props) {
  const c = classify(p.sql, p.env);
  const isFix = p.baseSql !== undefined && p.baseSql.trim() !== "";
  const diff = isFix ? diffLines(p.baseSql!, p.sql) : null;
  return (
    <div className="ap-card" data-kind={c.kind}>
      <div className="ap-card-head">
        <span className={`ap-badge ap-badge-${c.kind}`}>{c.label}</span>
        {isFix && <span className="ap-card-sub">Proposed fix</span>}
      </div>
      {diff ? (
        <div className="ap-code ap-diff" role="group" aria-label="Changes to the query">
          {diff.map((d, i) => (
            <div key={i} className={`ap-diff-${d.op}`}>
              <span className="ap-diff-mark" aria-hidden>
                {d.op === "add" ? "+" : d.op === "del" ? "−" : " "}
              </span>
              <span className="sr-only">{d.op === "add" ? "added: " : d.op === "del" ? "removed: " : ""}</span>
              {d.text || " "}
            </div>
          ))}
        </div>
      ) : (
        <pre className="ap-code">{p.sql}</pre>
      )}
      <div className="ap-card-acts">
        {isFix ? (
          <button className="btn primary xs" disabled={p.streaming} onClick={() => p.onApply(p.sql)}>
            Apply the fix
          </button>
        ) : (
          <button className="btn primary xs" disabled={p.streaming} onClick={() => p.onInsert(p.sql)}>
            Insert into editor
          </button>
        )}
        <button className="btn xs" disabled={p.streaming} onClick={() => p.onCopy(p.sql)}>
          Copy
        </button>
      </div>
      <div className="ap-card-note">{c.note}</div>
    </div>
  );
}
