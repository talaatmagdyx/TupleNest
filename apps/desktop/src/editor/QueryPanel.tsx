import Grid from "../results/Grid";
import type { QueryResult } from "../ipc/types";

type Props = {
  sql: string;
  onSqlChange: (s: string) => void;
  connected: boolean;
  running: boolean;
  inTx: boolean;
  txPrompt: boolean;
  result: QueryResult | null;
  queryEpoch: number;
  onRun: () => void;
  onCancel: () => void;
  onBegin: () => void;
  onCommit: () => void;
  onRollback: () => void;
  onCommitAndDisconnect: () => void;
  onRollbackAndDisconnect: () => void;
  onStayConnected: () => void;
};

/** SQL editor, run/cancel, transaction controls, virtualized results. */
export default function QueryPanel(p: Props) {
  return (
    <section className="panel">
      <h2>Query</h2>
      <textarea
        rows={4}
        value={p.sql}
        onChange={(e) => p.onSqlChange(e.target.value)}
        spellCheck={false}
        disabled={!p.connected}
      />
      <div className="form-row">
        <button onClick={p.onRun} disabled={!p.connected || p.running}>
          {p.running ? "Running…" : "Run"}
        </button>
        <button onClick={p.onCancel} disabled={!p.running}>
          Cancel
        </button>
        <span className="tx-sep" />
        {!p.inTx ? (
          <button onClick={p.onBegin} disabled={!p.connected}>
            Begin
          </button>
        ) : (
          <>
            <span className="tx-chip">IN TRANSACTION</span>
            <button onClick={p.onCommit}>Commit</button>
            <button onClick={p.onRollback}>Rollback</button>
          </>
        )}
      </div>
      {p.txPrompt && (
        <div className="tx-prompt" role="alertdialog">
          <span>
            A transaction is still open. What should happen to it before
            disconnecting?
          </span>
          <button onClick={p.onCommitAndDisconnect}>Commit &amp; disconnect</button>
          <button onClick={p.onRollbackAndDisconnect}>Rollback &amp; disconnect</button>
          <button onClick={p.onStayConnected}>Stay connected</button>
        </div>
      )}
      {p.result && p.result.columns.length > 0 && (
        <Grid
          columns={p.result.columns}
          storedRows={p.result.storedRows}
          epoch={p.queryEpoch}
        />
      )}
    </section>
  );
}
