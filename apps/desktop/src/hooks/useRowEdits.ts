import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { QueryResult } from "../ipc/types";
import { buildStatements, type CellEdit, type EditTarget } from "../lib/dml";

/** Fixed name: only ever one edit-apply in flight, and it is released or
 *  rolled back to in the same function. A generated name would leak savepoints
 *  into the user's transaction if an apply ever failed to unwind. */
const SAVEPOINT = "tuplenest_edit";

export type ApplyOutcome =
  /** Nothing staged, or nowhere to write it. */
  | { kind: "noop" }
  /** Written and committed by us. The grid should re-read. */
  | { kind: "applied"; count: number }
  /** Written inside the user's own open transaction — not committed. Theirs
   *  to commit or roll back, and the grid must NOT re-read: a re-read would
   *  show uncommitted rows as though they were stored. */
  | { kind: "staged"; count: number }
  | { kind: "error"; message: string };

export type RowEdits = {
  edits: CellEdit[];
  /** Replace the edit for a cell, or add it. One edit per cell — staging the
   *  same cell twice is a correction, not a second write. */
  stage: (e: CellEdit) => void;
  discard: () => void;
  reviewOpen: boolean;
  setReviewOpen: (v: boolean) => void;
  applying: boolean;
  applyError: string | null;
  apply: (args: { target: EditTarget | null; inTx: boolean }) => Promise<ApplyOutcome>;
};

/**
 * Staged cell edits and their write.
 *
 * Two rules the tests pin down:
 *
 * All-or-nothing. The statements go inside one transaction, so a set of edits
 * either lands whole or not at all. A partial write would leave the grid and
 * the table disagreeing with no record of where it stopped.
 *
 * Never commit someone else's transaction. If the user already has one open we
 * join it and leave the decision to them — issuing COMMIT here would commit
 * whatever else they had pending, which we did not write and cannot see.
 *
 * `epoch` invalidates the staged set: edits belong to the result they were
 * made against, and a new result means those row keys may address other rows.
 */
export function useRowEdits(epoch: number): RowEdits {
  const [edits, setEdits] = useState<CellEdit[]>([]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  /**
   * Drop the staged set the moment the result changes.
   *
   * Adjusted during render rather than in an effect. An effect runs *after* the
   * render commits, which left one painted frame where the new result was shown
   * with the previous result's edits still staged against it — row keys that
   * may address entirely different rows. React re-runs this component before
   * committing anything, so nothing is ever drawn from the wrong epoch.
   *
   * This is the pattern React documents for adjusting state when a prop
   * changes; the `prev` state is how it detects the change.
   */
  const [prevEpoch, setPrevEpoch] = useState(epoch);
  if (epoch !== prevEpoch) {
    setPrevEpoch(epoch);
    setEdits([]);
    setReviewOpen(false);
    setApplyError(null);
  }

  const stage = useCallback((e: CellEdit) => {
    setEdits((list) => {
      const i = list.findIndex((x) => x.rowKey === e.rowKey && x.column === e.column);
      if (i === -1) return [...list, e];
      const next = [...list];
      next[i] = e;
      return next;
    });
  }, []);

  const discard = useCallback(() => {
    setEdits([]);
    setReviewOpen(false);
    setApplyError(null);
  }, []);

  const apply = useCallback(
    async ({ target, inTx }: { target: EditTarget | null; inTx: boolean }): Promise<ApplyOutcome> => {
      if (!target || edits.length === 0) return { kind: "noop" };
      setApplying(true);
      setApplyError(null);
      const statements = buildStatements(target, edits);
      const joinExisting = inTx;
      try {
        if (joinExisting) {
          // Inside the user's transaction we cannot BEGIN, and we must not
          // COMMIT or ROLLBACK — that would decide the fate of work of theirs
          // we know nothing about. A savepoint gives us the one thing we need:
          // the ability to undo *our* statements and nothing else. Without it,
          // a failure on statement 2 would leave statement 1 applied inside
          // their transaction, which is the partial write the review flow
          // exists to prevent.
          await invoke("pg_query", { sql: `SAVEPOINT ${SAVEPOINT}`, params: [] });
        } else {
          await invoke("pg_begin");
        }
        for (const st of statements) {
          const res = await invoke<QueryResult>("pg_query", { sql: st.sql, params: st.params });
          /*
           * Check what the server actually did, rather than inferring success
           * from "pg_query did not throw".
           *
           * Every statement here is keyed by a full primary key, so it must
           * touch exactly one row. Zero means the row is gone — someone else
           * deleted it, or changed its key, between the grid loading it and
           * this apply. That is not success, and it used to be reported as
           * success: the transaction committed, the toast said "Applied", and
           * the row simply vanished on the next read with no explanation.
           *
           * More than one would mean the primary key is not unique, which
           * should be impossible; if it ever happens, stopping is the only
           * defensible response.
           */
          const n = res?.rowsAffected ?? null;
          if (n !== null && n !== 1) {
            throw new Error(
              n === 0
                ? "This row no longer exists — another session deleted it or changed its primary key. " +
                  "Nothing was written; your edits are still here. Re-run the query to see the current rows."
                : `Expected to change 1 row but matched ${n}. Nothing was written.`,
            );
          }
        }
        if (joinExisting) {
          await invoke("pg_query", { sql: `RELEASE SAVEPOINT ${SAVEPOINT}`, params: [] });
        } else {
          await invoke("pg_commit");
        }
        setEdits([]);
        setReviewOpen(false);
        return joinExisting
          ? { kind: "staged", count: statements.length }
          : { kind: "applied", count: statements.length };
      } catch (e) {
        const message = String(e);
        setApplyError(message);
        // Unwind exactly what we did, and nothing else. Rolling the user's
        // transaction back would discard work of theirs unrelated to these
        // edits; leaving our half-applied statements in it would be worse.
        try {
          await invoke(joinExisting ? "pg_query" : "pg_rollback", {
            ...(joinExisting ? { sql: `ROLLBACK TO SAVEPOINT ${SAVEPOINT}`, params: [] } : {}),
          });
        } catch {
          // The session may already be gone, which is how we got here. The
          // original error is the one worth showing.
        }
        return { kind: "error", message };
      } finally {
        setApplying(false);
      }
    },
    [edits],
  );

  return { edits, stage, discard, reviewOpen, setReviewOpen, applying, applyError, apply };
}
