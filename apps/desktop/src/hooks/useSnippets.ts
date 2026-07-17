import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SnippetRecord } from "../ipc/types";

export type SaveOutcome = { ok: true } | { ok: false; message: string };

export type Snippets = {
  items: SnippetRecord[];
  refresh: () => Promise<void>;
  /** Save a new snippet, or overwrite `id` when given one. */
  save: (args: { id?: string | null; name: string; body: string; tags?: string | null }) => Promise<SaveOutcome>;
};

/** A default name for a snippet: its first line, near enough. */
export function suggestName(body: string, max = 40): string {
  return body.slice(0, max).replace(/\s+/g, " ").trim();
}

/**
 * The saved snippets library.
 *
 * The list is re-read from the store after a save rather than patched in
 * memory: the store assigns the id and applies its own name collision rules,
 * so what it holds after the write is the only version worth showing.
 */
export function useSnippets(): Snippets {
  const [items, setItems] = useState<SnippetRecord[]>([]);

  const refresh = useCallback(async () => {
    try {
      setItems(await invoke<SnippetRecord[]>("snippet_list"));
    } catch (e) {
      // Stale-but-present beats blank: an empty library reads as "you saved
      // nothing", which is worse than showing the last known list.
      console.error(e);
    }
  }, []);

  const save = useCallback(
    async ({ id = null, name, body, tags = null }: { id?: string | null; name: string; body: string; tags?: string | null }): Promise<SaveOutcome> => {
      try {
        await invoke("snippet_save", { id, name, body, tags });
        await refresh();
        return { ok: true };
      } catch (e) {
        return { ok: false, message: String(e) };
      }
    },
    [refresh],
  );

  return { items, refresh, save };
}
