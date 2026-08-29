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

/**
 * Show a save panel and open the file for a streamed write.
 *
 * The dialog is deliberately first. `saveText` needs the finished document
 * before it can ask where to put it, which for a large result means a long
 * unresponsive pause with nothing on screen, and everything thrown away if the
 * user then cancels. Returns the chosen path, or null when cancelled.
 *
 * The same invariant holds as for `saveText`: the WebView never supplies a
 * path. It gets one back only to name the file in a toast.
 */
export async function beginSave(defaultName: string, filter?: SaveFilter): Promise<string | null> {
  return invoke<string | null>("export_begin", {
    defaultName,
    filterName: filter?.name ?? null,
    extensions: filter?.extensions ?? null,
  });
}

/** Append to the open export. */
export async function writeChunk(chunk: string): Promise<void> {
  await invoke("export_write", { chunk });
}

/** Flush and close. The file is only complete once this resolves. */
export async function finishSave(): Promise<void> {
  await invoke("export_finish");
}

/** Abandon the open export and delete the partial file. */
export async function abortSave(): Promise<void> {
  await invoke("export_abort");
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
