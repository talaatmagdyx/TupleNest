import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { QueryResult } from "../ipc/types";
import { needsGuard, paramCount } from "../lib/sql";

/** The backend prefixes a lost session with this; nothing else does. */
export const LOST_PREFIX = "Connection lost:";

/**
 * Did this failure mean the session is gone?
 *
 * Tauri rejects with the plain `Err(String)`, so the prefix is at the start.
 * An `Error` would stringify to "Error: Connection lost: …" and slip past a
 * bare `startsWith` — cheap to tolerate, and the cost of missing it is that
 * the app keeps claiming to be connected to a server that has hung up.
 */
export function isConnectionLost(message: string): boolean {
  return message.replace(/^Error:\s*/, "").startsWith(LOST_PREFIX);
}

/** The short title of a multi-line backend error — what fits in one line of UI. */
export function firstLine(message: string): string {
  const nl = message.indexOf("\n");
  return nl === -1 ? message : message.slice(0, nl);
}

export type RunStatus = { icon: string; text: string; color: string };

/**
 * What `run` decided. The hook executes; the caller owns the overlays, so it
 * is told what is needed rather than being asked to guess from state.
 */
export type RunOutcome =
  | { kind: "blocked"; reason: "empty" | "disconnected" }
  | { kind: "needs-guard" }
  | { kind: "needs-params"; count: number }
  | { kind: "ok"; result: QueryResult }
  | { kind: "error"; message: string; connectionLost: boolean };

export type RunOptions = {
  /** Environment of the live session — only "prod" arms the WHERE guard. */
  env: string | null;
  /** The user has seen the guard and said yes. */
  force?: boolean;
  /** Bound $1..$n values. `undefined` means "not asked yet". */
  params?: unknown[];
};

/** The line under the toolbar after a run. */
export function statusText(r: QueryResult): string {
  if (r.columns.length === 0) {
    return `${r.rowsAffected ?? 0} row(s) affected in ${r.elapsedMs}ms`;
  }
  // Say when the grid is holding less than the query returned, or the row
  // count and the scrollable rows silently disagree.
  const kept = r.truncated ? ` (first ${r.storedRows.toLocaleString()} kept for scrolling)` : "";
  return `${r.totalRows.toLocaleString()} row(s) in ${r.elapsedMs}ms${kept}`;
}

export type Query = {
  running: boolean;
  result: QueryResult | null;
  lastError: string | null;
  /** The SQL that produced `result` — editability is judged on this, not on
   *  whatever has since been typed into the editor. */
  ranSql: string;
  /** Bumped per result, so the grid knows to drop its state. */
  epoch: number;
  status: RunStatus | null;
  run: (sql: string, opts: RunOptions) => Promise<RunOutcome>;
  cancel: () => Promise<void>;
  reset: () => void;
};

export function useQuery(): Query {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [ranSql, setRanSql] = useState("");
  const [epoch, setEpoch] = useState(0);
  const [status, setStatus] = useState<RunStatus | null>(null);

  const reset = useCallback(() => {
    setResult(null);
    setLastError(null);
    setStatus(null);
    setRanSql("");
  }, []);

  const run = useCallback(async (sql: string, opts: RunOptions): Promise<RunOutcome> => {
    if (!sql.trim()) return { kind: "blocked", reason: "empty" };

    // Order matters. The guard asks "do you mean to touch every row?", which
    // has to be answered before we go looking for placeholders to bind.
    if (!opts.force && needsGuard(sql, opts.env)) return { kind: "needs-guard" };

    const pc = paramCount(sql);
    if (pc > 0 && opts.params === undefined) return { kind: "needs-params", count: pc };

    setRunning(true);
    setStatus(null);
    try {
      const r = await invoke<QueryResult>("pg_query", { sql, params: opts.params ?? null });
      setResult(r);
      setRanSql(sql);
      setLastError(null);
      setEpoch((n) => n + 1);
      setStatus({ icon: "✓", text: statusText(r), color: "var(--tn-success)" });
      return { kind: "ok", result: r };
    } catch (e) {
      const message = String(e);
      // A failed run must not leave the previous result on screen next to an
      // error — that reads as "this is what your query returned".
      setResult(null);
      setLastError(message);
      // The backend's layout contract: line one is the short title, the rest
      // is the server's full report (DETAIL, HINT, constraint names). The
      // one-line status bar gets the title; the error box gets everything.
      setStatus({ icon: "✕", text: firstLine(message), color: "var(--tn-danger)" });
      return { kind: "error", message, connectionLost: isConnectionLost(message) };
    } finally {
      setRunning(false);
    }
  }, []);

  const cancel = useCallback(async () => {
    await invoke("pg_cancel").catch(() => {});
  }, []);

  return { running, result, lastError, ranSql, epoch, status, run, cancel, reset };
}
