import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { HealthTab } from "../overlays/HealthModal";
import type { IndexHealth, MetadataOut, TableHealth, TopQueries } from "../ipc/types";

export const TOP_QUERY_LIMIT = 50;

export type Health = {
  tab: HealthTab;
  indexes: IndexHealth | null;
  tables: TableHealth | null;
  queries: TopQueries | null;
  error: string | null;
  /** Switch to a tab, fetching its data the first time only. */
  load: (tab: HealthTab) => Promise<void>;
};

/**
 * The three database-health reports.
 *
 * Each tab fetches on demand and then stays put: the index scan walks every
 * index in the database (8,887 of them here), and paying that again because
 * someone clicked back from Vacuum would be rude. The trade is that the
 * numbers are a snapshot from when the tab was first opened — acceptable,
 * because these are all slow-moving facts, unlike the live counters in the
 * server monitor.
 */
export function useHealth(): Health {
  const [tab, setTab] = useState<HealthTab>("indexes");
  const [indexes, setIndexes] = useState<IndexHealth | null>(null);
  const [tables, setTables] = useState<TableHealth | null>(null);
  const [queries, setQueries] = useState<TopQueries | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (next: HealthTab) => {
      setTab(next);
      setError(null);
      try {
        if (next === "indexes" && !indexes) {
          const r = await invoke<MetadataOut<IndexHealth>>("pg_metadata", {
            request: { kind: "index_health", schema: null },
          });
          setIndexes(r.payload);
        } else if (next === "tables" && !tables) {
          const r = await invoke<MetadataOut<TableHealth>>("pg_metadata", {
            request: { kind: "table_health", schema: null },
          });
          setTables(r.payload);
        } else if (next === "queries" && !queries) {
          const r = await invoke<MetadataOut<TopQueries>>("pg_metadata", {
            request: { kind: "top_queries", limit: TOP_QUERY_LIMIT },
          });
          setQueries(r.payload);
        }
      } catch (e) {
        setError(String(e));
      }
    },
    [indexes, tables, queries],
  );

  return { tab, indexes, tables, queries, error, load };
}
