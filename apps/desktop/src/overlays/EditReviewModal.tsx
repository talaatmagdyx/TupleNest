import { buildStatements, previewSql, type CellEdit, type EditTarget } from "../lib/dml";

type Props = {
  target: EditTarget;
  edits: CellEdit[];
  env: string | null;
  applying: boolean;
  error: string | null;
  onApply: () => void;
  onDiscard: () => void;
  onClose: () => void;
};

/** Shows exactly what will be sent before a single row is written.
 *  The preview substitutes literals for readability; execution always binds
 *  the values as parameters. */
export default function EditReviewModal(p: Props) {
  const statements = buildStatements(p.target, p.edits);
  const rows = new Set(p.edits.map((e) => e.rowKey)).size;
  const isProd = p.env === "prod";

  return (
    <div className="overlay center" onClick={p.onClose}>
      <div className="modal edit-review" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="t">Review changes</span>
          <button className="x" onClick={p.onClose}>
            ×
          </button>
        </div>

        <div className="er-sum">
          <span className="er-count">{p.edits.length}</span>
          <span>
            cell{p.edits.length === 1 ? "" : "s"} across {rows} row{rows === 1 ? "" : "s"} in{" "}
            <code>
              {p.target.schema}.{p.target.table}
            </code>
          </span>
        </div>

        {isProd && (
          <div className="er-warn">
            <strong>Production.</strong> These statements will modify live data. Every row is keyed by
            primary key, but there is no undo — review each statement below.
          </div>
        )}

        <div className="er-list">
          {statements.map((st, i) => (
            <pre key={i} className="er-sql">
              {previewSql(st)}
            </pre>
          ))}
        </div>

        {p.error && <div className="er-error">{p.error}</div>}

        <div className="er-foot">
          <span className="er-note">Runs in one transaction — any failure rolls back all of it.</span>
          <div className="grow" />
          <button className="btn" onClick={p.onDiscard} disabled={p.applying}>
            Discard
          </button>
          <button
            className={`btn ${isProd ? "danger" : "primary"}`}
            onClick={p.onApply}
            disabled={p.applying}
          >
            {p.applying ? "Applying…" : isProd ? `Apply to production` : `Apply ${statements.length}`}
          </button>
        </div>
      </div>
    </div>
  );
}
