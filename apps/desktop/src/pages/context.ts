import { engineOf, type Engine } from "../lib/engine";
import type { ConnectionRecord, SnippetRecord } from "../ipc/types";

/** What App hands every page. Kept small on purpose: a page reads the session
 *  through this and runs SQL through `invoke`, like the modals do. */
export type PageContext = {
  /** A session is live. */
  live: boolean;
  /** The live session's engine (PostgreSQL when none is live). Backup and
   *  roles are PostgreSQL-only; see `unsupported` in lib/engine. */
  engine: Engine;
  /** The live session's environment tag, or null when not connected. */
  env: string | null;
  /** The saved profile the live session was opened from, if any. */
  liveProfile: ConnectionRecord | null;
  saved: ConnectionRecord[];
  snippets: SnippetRecord[];
  /** The active editor tab's SQL. */
  currentSql: string;
  toast: (text: string) => void;
};

/** Is this profile a PostgreSQL one? A profile with no engine is. */
export function isPostgres(profile: ConnectionRecord | null | undefined): boolean {
  return engineOf(profile?.engine) === "postgres";
}
