import { useCallback, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { MetadataOut, SearchResults } from "../ipc/types";

/** Below this, the term matches most of the catalog and the result is noise. */
export const MIN_TERM = 2;
export const SEARCH_LIMIT = 200;

export type Search = {
  results: SearchResults | null;
  busy: boolean;
  error: string | null;
  run: (term: string) => Promise<void>;
  reset: () => void;
};

/**
 * Name search across every schema.
 *
 * Sequence-numbered because keystrokes race. Without it a slow answer for
 * "eng" can land after a fast answer for "eng_int" and overwrite it — the
 * user sees results for a term they have already finished typing past, which
 * looks like the search is simply wrong.
 */
export function useSearch(): Search {
  const [results, setResults] = useState<SearchResults | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const reset = useCallback(() => {
    seq.current++; // abandon anything in flight
    setResults(null);
    setError(null);
    setBusy(false);
  }, []);

  const run = useCallback(async (term: string) => {
    const mine = ++seq.current;
    const t = term.trim();
    if (t.length < MIN_TERM) {
      setResults(null);
      setBusy(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await invoke<MetadataOut<SearchResults>>("pg_metadata", {
        request: { kind: "search_objects", term: t, limit: SEARCH_LIMIT },
      });
      if (mine !== seq.current) return; // a newer keystroke already won
      setResults(r.payload);
    } catch (e) {
      if (mine === seq.current) setError(String(e));
    } finally {
      if (mine === seq.current) setBusy(false);
    }
  }, []);

  return { results, busy, error, run, reset };
}
