import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { QueryResult } from "../ipc/types";
import { hasWriteVerb, looksLikeSelect, needsGuard } from "../lib/sql";
import { DEFAULT_EXPLAIN, type ExplainOptions } from "../lib/explain-options";
import type { Insight, ParsedPlanNode } from "../lib/explain";
import { loadExplain } from "../lib/explain-load";
import type { IndexSuggestion } from "../lib/index-advisor";
import type { Catalog } from "../lib/complete";

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
  /** The richer, ordered observations shown under the plan. */
  insights: Insight[];
  /** Runnable CREATE INDEX statements the plan's scans imply. */
  indexSuggestions: IndexSuggestion[];
  error: string | null;
  raw: string;
  /** The options that produced *this* plan, as opposed to the ones now set in
   *  the panel. The modal compares the two to say the plan is out of date. */
  ranOpts: ExplainOptions;
};

export type ExplainOutcome =
  | { kind: "blocked"; reason: "empty" | "disconnected" | "options" | "guard" }
  /** `root` is the raw FORMAT JSON root, for plan comparison. Null when the
   *  server format wasn't JSON and there is nothing to compare. */
  | { kind: "ok"; root: Record<string, unknown> | null }
  | { kind: "error"; message: string };

export type ExplainRunArgs = {
  sql: string;
  title: string;
  connected: boolean;
  /** The connection's environment tag. With ANALYZE on, the statement really
   *  runs, so it answers to the same guard as Run. */
  env?: string | null;
  override?: unknown;
  /** Column types, so the index advisor can tell an indexable expression from
   *  one PostgreSQL would reject. Passed per run rather than to the hook
   *  because the catalog is built further down the component. */
  catalog?: Catalog;
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
 * on for them on a statement that writes. "Writes" is decided by the whole
 * statement, not its first word: a WITH can carry a DELETE.
 *
 * Ticking the box does not get past the guard either. On a guarded connection
 * a statement Run would stop for is refused here, and the user is sent to the
 * editor, where the confirmation dialog is.
 */
export function useExplain(serverMajor?: number): Explain {
  const [explain, setExplain] = useState<ExplainState | null>(null);
  const [opts, setOpts] = useState<ExplainOptions>(DEFAULT_EXPLAIN);
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async ({ sql, title, connected, env, override, onStart, catalog }: ExplainRunArgs): Promise<ExplainOutcome> => {
      if (!sql.trim()) return { kind: "blocked", reason: "empty" };
      if (!connected) return { kind: "blocked", reason: "disconnected" };

      // Ignore anything that isn't really an options object. `onClick={run}`
      // hands over a MouseEvent, which used to sail through as `override` and
      // throw on `format.toUpperCase()` — the button silently did nothing.
      const valid = override && typeof (override as ExplainOptions).format === "string";
      const o = valid
        ? (override as ExplainOptions)
        : { ...opts, analyze: looksLikeSelect(sql) && !hasWriteVerb(sql) };
      setOpts(o);
      if (o.analyze && needsGuard(sql, env ?? null)) return { kind: "blocked", reason: "guard" };
      // The plan parser and index advisor are a chunk of their own, read from
      // disk the first time a plan is asked for rather than at startup.
      const [{ buildExplain, optionIssues, parsePlan, readPlanPayload }, { catalogTypeLookup }] = await Promise.all([
        loadExplain(),
        import("../lib/index-advisor"),
      ]);
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
        insights: x?.insights ?? [],
        indexSuggestions: x?.indexSuggestions ?? [],
        error: null,
        raw: x?.raw ?? "",
        ranOpts: x?.ranOpts ?? o,
      }));
      onStart?.();

      try {
        // Detached: the plan comes back inline and the result the grid is
        // showing stays in the backend store. Running EXPLAIN used to replace
        // that store, so the grid had to be cleared and the last Run's rows
        // were lost just for looking at a plan. FORMAT TEXT is one row per
        // *line* of the plan; a detached run returns all of them.
        const qr = await invoke<QueryResult>("pg_query", { sql: statement, detached: true });
        const rows = qr.rows ?? [];
        const raw = readPlanPayload(rows, o.format);

        // Only FORMAT JSON can be walked into a tree; the rest are shown raw.
        if (o.format !== "json") {
          setExplain((x) =>
            x ? { ...x, raw, nodes: [], stats: [], insights: [], indexSuggestions: [], error: null, ranOpts: o } : x,
          );
          return { kind: "ok", root: null };
        }

        const cell = rows[0]?.[0];
        // `JSON.parse` hands back `any`, which spreads silently. FORMAT JSON
        // is documented to be an array of plan documents.
        const parsed: unknown = typeof cell === "string" ? (JSON.parse(cell) as unknown) : cell;
        const root = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, unknown>;
        // Column types turn "might not be indexable" into a decidable question
        // for the advisor; without a catalog it stays on its cautious path.
        const { nodes, stats, suggestion, insights, indexSuggestions } = parsePlan(
          parsed,
          catalog ? catalogTypeLookup(catalog) : undefined,
        );
        setExplain({
          title,
          sql,
          statement,
          nodes,
          stats,
          suggestion,
          insights,
          indexSuggestions,
          error: null,
          raw,
          ranOpts: o,
        });
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
