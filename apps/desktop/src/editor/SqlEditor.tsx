import { tokenizeSQL } from "../lib/sql";

type Props = {
  sql: string;
  disabled: boolean;
  height: number;
  onChange: (sql: string) => void;
};

/** Overlay editor from the HUD design: highlighted <pre> under a
 *  transparent <textarea> with an accent caret, plus a line gutter. */
export default function SqlEditor(p: Props) {
  const lines = p.sql.split("\n");
  return (
    <div className="editor-frame" style={{ height: p.height }}>
      <div className="gutter">
        {lines.map((_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <div className="editor-rel">
        <pre className="editor-pre">{tokenizeSQL(p.sql)}</pre>
        <textarea
          className="editor-ta"
          value={p.sql}
          spellCheck={false}
          disabled={p.disabled}
          onChange={(e) => p.onChange(e.target.value)}
        />
      </div>
    </div>
  );
}
