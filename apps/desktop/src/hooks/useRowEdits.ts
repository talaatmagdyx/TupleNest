import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { QueryResult } from "../ipc/types";
import { buildStatements, type CellEdit, type EditTarget } from "../lib/dml";

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
        if (!joinExisting) await invoke("pg_begin");
        for (const st of statements) {
          await invoke<QueryResult>("pg_query", { sql: st.sql, params: st.params });
        }
        if (!joinExisting) await invoke("pg_commit");
        setEdits([]);
        setReviewOpen(false);
        return joinExisting
          ? { kind: "staged", count: statements.length }
          : { kind: "applied", count: statements.length };
      } catch (e) {
        const message = String(e);
        setApplyError(message);
        // Only unwind a transaction we opened. Rolling back the user's would
        // discard work of theirs that has nothing to do with these edits.
        if (!joinExisting) {
          try {
            await invoke("pg_rollback");
          } catch {
            // The session may already be gone, which is how we got here. The
            // original error is the one worth showing.
          }
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
