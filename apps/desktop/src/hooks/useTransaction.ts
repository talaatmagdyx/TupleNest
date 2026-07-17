import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type TxOutcome = { ok: true } | { ok: false; message: string };

export type Transaction = {
  /** True when the server has an open transaction on this session. */
  inTx: boolean;
  /** Epoch ms of BEGIN, for the status bar's timer. Null when none is open. */
  openSince: number | null;
  /** Id of the tab that opened it, and its name at the time — see the note on
   *  ownership below. Null when no transaction is open. */
  owner: { tabId: string; tabName: string } | null;
  begin: (owner: { tabId: string; tabName: string }) => Promise<TxOutcome>;
  commit: () => Promise<TxOutcome>;
  rollback: () => Promise<TxOutcome>;
  /** Session gone — the transaction went with it, whatever we thought. */
  forget: () => void;
};

/**
 * The open-transaction flag, and which tab owns it.
 *
 * `inTx` is a claim about the *server's* state, so it only ever changes when
 * the server confirms it. The whole point of the flag is that the close
 * prompt and the status bar can be trusted; a flag that drifts optimistically
 * is worse than no flag, because it tells someone their work is committed
 * when it is still sitting in an open transaction.
 *
 * ## Why a transaction has an owner
 *
 * TupleNest holds **one** PostgreSQL session, and query tabs are text editors
 * over it — they are not separate sessions. A transaction therefore belongs to
 * the connection, not to a tab, and every tab's statements land inside it.
 *
 * That is a defensible model (it is psql's), but it was invisible, and
 * invisible it is a trap: tab A ran `BEGIN; DELETE FROM users;`, you switched
 * to tab B, pressed Commit believing you were committing tab B's work, and
 * committed the delete. Nothing in the UI connected the two.
 *
 * So the transaction records the tab that opened it. Committing or rolling
 * back from anywhere else is refused and says who owns it. This does not give
 * tabs real isolation — `SET search_path` and temp tables are still shared,
 * and fixing that means a session per tab — but it does stop the one failure
 * where a click commits work the user cannot see.
 */
export function useTransaction(): Transaction {
  const [inTx, setInTx] = useState(false);
  const [openSince, setOpenSince] = useState<number | null>(null);
  const [owner, setOwner] = useState<{ tabId: string; tabName: string } | null>(null);

  const begin = useCallback(
    async (o: { tabId: string; tabName: string }): Promise<TxOutcome> => {
      try {
        await invoke("pg_begin");
        setInTx(true);
        setOpenSince(Date.now());
        setOwner(o);
        return { ok: true };
      } catch (e) {
        // No BEGIN, no transaction. Claiming one would arm a close prompt for
        // something that does not exist.
        return { ok: false, message: String(e) };
      }
    },
    [],
  );

  const end = useCallback(async (cmd: "pg_commit" | "pg_rollback"): Promise<TxOutcome> => {
    try {
      await invoke(cmd);
      setInTx(false);
      setOpenSince(null);
      setOwner(null);
      return { ok: true };
    } catch (e) {
      // Deliberately leaves `inTx` set. A COMMIT that failed did not commit:
      // the transaction is still open on the server, and clearing the flag
      // here is how someone ends up believing their write landed.
      return { ok: false, message: String(e) };
    }
  }, []);

  const commit = useCallback(() => end("pg_commit"), [end]);
  const rollback = useCallback(() => end("pg_rollback"), [end]);

  const forget = useCallback(() => {
    setInTx(false);
    setOpenSince(null);
    setOwner(null);
  }, []);

  return { inTx, openSince, owner, begin, commit, rollback, forget };
}
