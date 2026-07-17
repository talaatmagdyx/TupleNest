import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type TxOutcome = { ok: true } | { ok: false; message: string };

export type Transaction = {
  /** True when the server has an open transaction on this session. */
  inTx: boolean;
  /** Epoch ms of BEGIN, for the status bar's timer. Null when none is open. */
  openSince: number | null;
  begin: () => Promise<TxOutcome>;
  commit: () => Promise<TxOutcome>;
  rollback: () => Promise<TxOutcome>;
  /** Session gone — the transaction went with it, whatever we thought. */
  forget: () => void;
};

/**
 * The open-transaction flag.
 *
 * `inTx` is a claim about the *server's* state, so it only ever changes when
 * the server confirms it. The whole point of the flag is that the close
 * prompt and the status bar can be trusted; a flag that drifts optimistically
 * is worse than no flag, because it tells someone their work is committed
 * when it is still sitting in an open transaction.
 */
export function useTransaction(): Transaction {
  const [inTx, setInTx] = useState(false);
  const [openSince, setOpenSince] = useState<number | null>(null);

  const begin = useCallback(async (): Promise<TxOutcome> => {
    try {
      await invoke("pg_begin");
      setInTx(true);
      setOpenSince(Date.now());
      return { ok: true };
    } catch (e) {
      // No BEGIN, no transaction. Claiming one would arm a close prompt for
      // something that does not exist.
      return { ok: false, message: String(e) };
    }
  }, []);

  const end = useCallback(async (cmd: "pg_commit" | "pg_rollback"): Promise<TxOutcome> => {
    try {
      await invoke(cmd);
      setInTx(false);
      setOpenSince(null);
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
  }, []);

  return { inTx, openSince, begin, commit, rollback, forget };
}
