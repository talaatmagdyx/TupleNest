import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { HistoryEntry } from "../ipc/types";

/** How many entries the panel shows. The store keeps more than this. */
export const HISTORY_LIMIT = 50;

export type History = {
  items: HistoryEntry[];
  search: string;
  setSearch: (s: string) => void;
  /** Re-read the list for the current search term. */
  refresh: () => Promise<void>;
  toggleFavorite: (id: string, favorite: boolean) => Promise<void>;
  /** Delete everything except favorites. */
  clear: () => Promise<void>;
};

/**
 * The query history list.
 *
 * Reads are sequence-numbered: typing in the search box fires one read per
 * keystroke, and those can land out of order. Without the check, a slow
 * response for "sel" arriving after a fast one for "select * from users"
 * repaints the list with results for a term the box no longer holds.
 *
 * Failures leave the previous list alone rather than blanking it — history is
 * a convenience, and an empty panel reads as "you have no history", which is a
 * worse lie than a slightly stale one.
 */
export function useHistory(): History {
  const [items, setItems] = useState<HistoryEntry[]>([]);
  const [search, setSearch] = useState("");
  const seq = useRef(0);
  // Read through a ref so `refresh` is stable: it is a dependency of the run
  // path and of every mutation below, and a new identity per keystroke would
  // re-fire all of them.
  const term = useRef(search);
  term.current = search;

  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const rows = await invoke<HistoryEntry[]>("history_list", {
        search: term.current || null,
        limit: HISTORY_LIMIT,
      });
      if (mine === seq.current) setItems(rows);
    } catch (e) {
      // Stale-but-present beats blank-and-wrong.
      console.error(e);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [search, refresh]);

  const toggleFavorite = useCallback(
    async (id: string, favorite: boolean) => {
      try {
        await invoke("history_favorite", { id, favorite });
      } catch (e) {
        console.error(e);
      }
      // Re-read either way: on failure this puts the star back where the
      // store actually has it, rather than leaving the UI asserting a change
      // that did not happen.
      await refresh();
    },
    [refresh],
  );

  const clear = useCallback(async () => {
    try {
      await invoke("history_clear", { includeFavorites: false });
    } catch (e) {
      console.error(e);
    }
    await refresh();
  }, [refresh]);

  return { items, search, setSearch, refresh, toggleFavorite, clear };
}
