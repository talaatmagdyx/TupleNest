import { invoke } from "@tauri-apps/api/core";

/**
 * Is a transaction open on the server? Asks the server, not the UI.
 *
 * The UI's `inTx` only follows the Begin button. A `BEGIN` typed in the editor
 * opens a transaction it never hears about, and import and row edits then sent
 * a second BEGIN and went on to COMMIT or ROLLBACK the user's own work.
 *
 * If the check itself fails, assume a transaction is open: the caller then
 * works inside a savepoint, which the server refuses outside a transaction —
 * a visible failure, never a silent COMMIT of someone else's work.
 */
export async function serverInTransaction(): Promise<boolean> {
  try {
    return (await invoke<boolean>("pg_in_transaction")) === true;
  } catch {
    return true;
  }
}
