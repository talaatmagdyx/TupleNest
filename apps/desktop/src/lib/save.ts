/** Writing a file the user picked.
 *
 *  The app has no ambient filesystem access: `dialog:allow-save` plus
 *  `fs:allow-write-text-file` mean we can only write to a path the user chose
 *  in the native save panel, and nowhere else.
 */

import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";

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
  const path = await save({
    defaultPath: defaultName,
    filters: filter ? [filter] : undefined,
  });
  if (!path) return null; // cancelled — not an error
  await writeTextFile(path, contents);
  return path;
}

/** Just the file name, for a confirmation toast. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
