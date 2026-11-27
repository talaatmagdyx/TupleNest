/** Database engines: which one a profile or session is, what the app can do
 *  on it, and how it is named on screen.
 *
 *  The backend's seam is `src-tauri/src/engine.rs`; this is the WebView's.
 *  A feature an engine lacks is hidden or disabled with the reason below —
 *  never shown as a panel that then fails. */

export type Engine = "postgres" | "sqlite";

/** A profile or session's engine. Absent is PostgreSQL: every profile and
 *  every backend from before engines existed. */
export function engineOf(v: string | null | undefined): Engine {
  return v === "sqlite" ? "sqlite" : "postgres";
}

export type EngineChoice = {
  /** Two letters for the badge. */
  code: string;
  name: string;
  status: "available" | "next" | "planned";
  /** Set only for engines that can be picked today. */
  engine?: Engine;
};

/** The engine picker, in the design's order. Only `available` ones can be
 *  chosen; the rest say when to expect them. */
export const ENGINE_CHOICES: EngineChoice[] = [
  { code: "PG", name: "PostgreSQL", status: "available", engine: "postgres" },
  { code: "SQ", name: "SQLite", status: "available", engine: "sqlite" },
  { code: "MY", name: "MySQL / MariaDB", status: "next" },
  { code: "MS", name: "SQL Server", status: "planned" },
  { code: "MG", name: "MongoDB", status: "planned" },
  { code: "RD", name: "Redis", status: "planned" },
];

export const STATUS_LABEL: Record<EngineChoice["status"], string> = {
  available: "Available",
  next: "Coming next",
  planned: "Planned",
};

export function engineName(e: Engine): string {
  return e === "sqlite" ? "SQLite" : "PostgreSQL";
}

export function engineBadge(e: Engine): string {
  return e === "sqlite" ? "SQ" : "PG";
}

/** App features that exist for some engines only. */
export type Feature =
  | "monitor"
  | "health"
  | "partitions"
  | "schemaCompare"
  | "planCompare"
  | "explainAnalyze"
  | "csvImport"
  | "ssh"
  | "tls";

const SQLITE_LACKS: Record<Feature, string> = {
  monitor: "SQLite has no server, so there are no sessions or locks to monitor.",
  health: "Index and table health read PostgreSQL's pg_stat statistics, which SQLite does not keep.",
  partitions: "SQLite has no table partitioning.",
  schemaCompare: "Schema compare reads PostgreSQL's catalog; it does not compare SQLite files yet.",
  planCompare: "Plan comparison needs PostgreSQL's JSON plans; SQLite's EXPLAIN QUERY PLAN has no costs to compare.",
  explainAnalyze: "SQLite shows EXPLAIN QUERY PLAN as rows; there is no plan view or ANALYZE.",
  csvImport: "CSV import writes PostgreSQL casts; it does not import into SQLite yet.",
  ssh: "A SQLite database is a file on this machine: there is nothing to tunnel to.",
  tls: "A SQLite database is a file on this machine: there is no connection to encrypt.",
};

/** Why `feature` is not available on `engine`, or null when it is. */
export function unsupported(engine: Engine, feature: Feature): string | null {
  return engine === "sqlite" ? SQLITE_LACKS[feature] : null;
}

/** The last part of a path: what a SQLite file is called on screen. */
export function fileName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** The key the backend files a session's history and audit rows under
 *  (`cache_key` and `sqlite_cache_key` in src-tauri/src/pg.rs). */
export function sessionKey(t: {
  engine: Engine;
  database: string;
  username: string;
  host: string;
  port: number;
}): string {
  return t.engine === "sqlite" ? `sqlite:${t.database.trim()}` : `${t.username}@${t.host}:${t.port}/${t.database}`;
}

/** Where a saved profile points, for one line under its name. */
export function profileTarget(c: {
  engine?: string | null;
  username: string;
  host: string;
  port: number;
  database: string;
}): string {
  return engineOf(c.engine) === "sqlite" ? c.database : `${c.username}@${c.host}:${c.port}/${c.database}`;
}
