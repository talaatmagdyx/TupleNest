/** Writing a file the user picked.
 *
 *  The dialog AND the write both happen in the Rust backend (`export_save`).
 *  The WebView supplies only the contents and a suggested name — never a path —
 *  so it cannot write anywhere the user did not choose in the native panel. The
 *  app therefore grants NO filesystem-write permission to the WebView at all;
 *  the "user picked it" invariant is enforced by construction, not convention.
 *  (Security review TAURI-01.)
 */

import { invoke } from "@tauri-apps/api/core";

export type SaveFilter = { name: string; extensions: string[] };

export const FILTERS: Record<string, SaveFilter> = {
  json: { name: "JSON", extensions: ["json"] },
  txt: { name: "Text", extensions: ["txt"] },
  md: { name: "Markdown", extensions: ["md"] },
  csv: { name: "CSV", extensions: ["csv"] },
};

/** Show a save panel and write `contents`.
 *  Returns the path written, or null when the user cancelled. */
export async function saveText(defaultName: string, contents: string, filter?: SaveFilter): Promise<string | null> {
  return invoke<string | null>("export_save", {
    defaultName,
    contents,
    filterName: filter?.name ?? null,
    extensions: filter?.extensions ?? null,
  });
}

/** Just the file name, for a confirmation toast.
 *
 *  `split().pop()` alone returns "" for a trailing separator — and `?? path`
 *  never catches it, because pop() on a non-empty array returns "" rather than
 *  undefined. Dropping empty segments first is what actually makes the
 *  fallback reachable. */
export function baseName(path: string): string {
  const segments = path.split(/[\\/]/).filter((s) => s.length > 0);
  return segments.pop() ?? path;
}
