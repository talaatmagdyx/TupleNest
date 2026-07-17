import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { QueryResult } from "../ipc/types";
import { looksLikeSelect } from "../lib/sql";
import {
  DEFAULT_EXPLAIN,
  buildExplain,
  optionIssues,
  parsePlan,
  readPlanPayload,
  type ExplainOptions,
  type ParsedPlanNode,
} from "../lib/explain";

/** The plan currently on screen, and the statement that produced it. */
export type ExplainState = {
  title: string;
  /** The query being explained — not the EXPLAIN wrapper. */
  sql: string;
  /** The wrapper actually sent, kept verbatim so the modal can show it. */
  statement: string;
  nodes: ParsedPlanNode[] | null;
  stats: { label: string; value: string }[];
  suggestion: string | null;
  error: string | null;
  raw: string;
  /** The options that produced *this* plan, as opposed to the ones now set in
   *  the panel. The modal compares the two to say the plan is out of date. */
  ranOpts: ExplainOptions;
};

export type ExplainOutcome =
  | { kind: "blocked"; reason: "empty" | "disconnected" | "options" }
  /** `root` is the raw FORMAT JSON root, for plan comparison. Null when the
   *  server format wasn't JSON and there is nothing to compare. */
  | { kind: "ok"; root: Record<string, unknown> | null }
  | { kind: "error"; message: string };

export type ExplainRunArgs = {
  sql: string;
  title: string;
  connected: boolean;
  override?: unknown;
  /** Called once the run is committed to — after the checks pass, before the
   *  server is asked. This is where the modal opens: opening it only on the
   *  result would leave an EXPLAIN ANALYZE of a slow query looking like a
   *  button that did nothing. */
  onStart?: () => void;
};

export type Explain = {
  explain: ExplainState | null;
  opts: ExplainOptions;
  setOpts: (o: ExplainOptions) => void;
  busy: boolean;
  run: (args: ExplainRunArgs) => Promise<ExplainOutcome>;
};

/**
 * Running EXPLAIN and holding its result.
 *
 * The one rule worth stating: ANALYZE defaults on for a plain SELECT and off
 * for everything else, because EXPLAIN ANALYZE *executes* the statement. A
 * DELETE explained with ANALYZE really deletes. The user can still tick the
 * box — that is a deliberate act with a warning attached — but we never turn it
 * on for them on a statement that writes.
 */
export function useExplain(serverMajor?: number): Explain {
  const [explain, setExplain] = useState<ExplainState | null>(null);
  const [opts, setOpts] = useState<ExplainOptions>(DEFAULT_EXPLAIN);
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async ({ sql, title, connected, override, onStart }: ExplainRunArgs): Promise<ExplainOutcome> => {
      if (!sql.trim()) return { kind: "blocked", reason: "empty" };
      if (!connected) return { kind: "blocked", reason: "disconnected" };

      // Ignore anything that isn't really an options object. `onClick={run}`
      // hands over a MouseEvent, which used to sail through as `override` and
      // throw on `format.toUpperCase()` — the button silently did nothing.
      const valid = override && typeof (override as ExplainOptions).format === "string";
      const o = valid ? (override as ExplainOptions) : { ...opts, analyze: looksLikeSelect(sql) };
      setOpts(o);
      if (optionIssues(o, sql, serverMajor).some((i) => i.level === "error")) {
        return { kind: "blocked", reason: "options" };
      }

      const statement = buildExplain(sql, o);
      setBusy(true);
      // Show the old plan greyed out rather than an empty modal: a re-run with
      // one option changed should not blank the thing being compared against.
      setExplain((x) => ({
        title,
        sql,
        statement,
        nodes: x?.nodes ?? null,
        stats: x?.stats ?? [],
        suggestion: null,
        error: null,
        raw: x?.raw ?? "",
        ranOpts: x?.ranOpts ?? o,
      }));
      onStart?.();

      try {
        const qr = await invoke<QueryResult>("pg_query", { sql: statement });
        // FORMAT TEXT returns one row per *line* of the plan, so ask for all of
        // them — fetching a single row would silently keep only the first line.
        const rows = await invoke<unknown[][]>("pg_rows", { offset: 0, limit: Math.max(1, qr.storedRows) });
        const raw = readPlanPayload(rows, o.format);

        // Only FORMAT JSON can be walked into a tree; the rest are shown raw.
        if (o.format !== "json") {
          setExplain((x) => (x ? { ...x, raw, nodes: [], stats: [], error: null, ranOpts: o } : x));
          return { kind: "ok", root: null };
        }

        const cell = rows[0]?.[0];
        // `JSON.parse` hands back `any`, which spreads silently. FORMAT JSON
        // is documented to be an array of plan documents.
        const parsed: unknown = typeof cell === "string" ? (JSON.parse(cell) as unknown) : cell;
        const root = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, unknown>;
        const { nodes, stats, suggestion } = parsePlan(parsed);
        setExplain({ title, sql, statement, nodes, stats, suggestion, error: null, raw, ranOpts: o });
        return { kind: "ok", root };
      } catch (e) {
        const message = String(e);
        setExplain((x) => (x ? { ...x, error: message, nodes: [] } : x));
        return { kind: "error", message };
      } finally {
        setBusy(false);
      }
    },
    [opts, serverMajor],
  );

  return { explain, opts, setOpts, busy, run };
}
