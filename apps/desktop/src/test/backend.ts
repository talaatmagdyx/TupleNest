import { vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { ConnectionRecord, HistoryEntry, QueryResult } from "../ipc/types";

/**
 * A fake backend for mounting App.
 *
 * App is 1,600 lines of wiring over `invoke`, so it cannot be rendered at all
 * without one — every mount effect calls out on the first tick. This stands in
 * for the Rust side: a router keyed by command, with the same shapes the real
 * commands return.
 *
 * It answers, it does not assert. Tests that care what was sent read
 * `sent(cmd)`; the rest just need the app to come up.
 */

export type Backend = {
  /** Override or add a command handler mid-test. */
  on: (cmd: string, fn: (args: Record<string, unknown>) => unknown) => void;
  /** Every call made to `cmd`, in order, with its arguments. */
  sent: (cmd: string) => Record<string, unknown>[];
  calls: () => string[];
};

export const CONNECTION: ConnectionRecord = {
  id: "c1",
  name: "local dev",
  environment: "dev",
  color: null,
  readOnly: false,
  host: "localhost",
  port: 5432,
  database: "omniserve",
  username: "omniserve",
  secretRef: null,
  tlsMode: "prefer",
  tlsCaPath: null,
  sshJson: null,
} as unknown as ConnectionRecord;

/** A production profile. The write guard keys off the environment, so it only
 *  exists for a connection like this one. */
export const PROD: ConnectionRecord = {
  ...CONNECTION,
  id: "c2",
  name: "prod db",
  environment: "prod",
} as unknown as ConnectionRecord;

export const HISTORY: HistoryEntry = {
  id: "h1",
  connectionKey: "local",
  sqlText: "select 1",
  status: "success",
  errorText: null,
  rowsReturned: 1,
  rowsAffected: null,
  startedAt: 0,
  durationMs: 3,
  favorite: false,
};

/** A two-column result: one text column to group by, one numeric to sum. */
export const RESULT: QueryResult = {
  columns: [
    { name: "kind", dbType: "text" },
    { name: "n", dbType: "int4" },
  ],
  totalRows: 2,
  storedRows: 2,
  truncated: false,
  rowsAffected: null,
} as unknown as QueryResult;

export const ROWS: unknown[][] = [
  ["r", 4132],
  ["i", 13109],
];

/** The exact wording pg.rs uses when the session is gone. `isConnectionLost`
 *  matches on this prefix, capital C and all. */
export const LOST =
  "Connection lost: server closed the connection unexpectedly — the session was closed. " +
  "Reconnect to continue; nothing was re-run.";

/** The plan the server returns for FORMAT JSON. */
export const PLAN = [
  {
    Plan: {
      "Node Type": "Seq Scan",
      "Relation Name": "pg_class",
      "Actual Total Time": 8.0,
      "Actual Rows": 21662,
      Plans: [{ "Node Type": "Result", "Actual Total Time": 1.0 }],
    },
    "Planning Time": 0.07,
    "Execution Time": 13.3,
  },
];

const defaults = (): Record<string, (args: Record<string, unknown>) => unknown> => ({
  app_get_info: () => ({ version: "0.1.0", os: "macos" }),
  settings_get: () => null,
  settings_set: () => undefined,
  connection_list: () => [CONNECTION, PROD],
  connection_save: () => CONNECTION,
  connection_delete: () => undefined,
  snippet_list: () => [],
  snippet_save: () => undefined,
  history_list: () => [HISTORY],
  history_favorite: () => undefined,
  history_clear: () => undefined,
  // `pg_secret_save` is the real command (main.rs, pg.rs). This used to say
  // `secret_set` — a name from the phase-0 plan that was never built — so the
  // fixture was answering a command nothing calls, and the keychain path went
  // untested because reaching it threw "no handler" instead.
  pg_secret_save: () => "ref-1",
  pg_connect: () => undefined,
  pg_disconnect: () => undefined,
  pg_begin: () => undefined,
  pg_commit: () => undefined,
  pg_rollback: () => undefined,
  pg_cancel: () => undefined,
  // The server monitor's own command. It reads `db` unconditionally, so an
  // empty object here is a render crash, not an empty panel.
  pg_activity: () => ({
    sessions: [],
    locks: [],
    db: {
      backends: 1,
      commits: 100,
      rollbacks: 2,
      blocksHit: 900,
      blocksRead: 100,
      tuplesReturned: 5000,
      tuplesFetched: 400,
      size: "12 MB",
    },
  }),
  pg_admin_backend: () => true,
  audit_list: () => [],
  pg_query: () => RESULT,
  pg_rows: () => ROWS,
  pg_test: () => ({
    stages: [{ name: "dns", passed: true, ms: 1, detail: "" }],
    serverVersion: "18.0",
  }),
  pg_metadata: (a) => metadata(a),
  pg_metadata_cached: (a) => metadata((a.request ?? {}) as Record<string, unknown>),
});

function metadata(a: Record<string, unknown>): unknown {
  const req = (a.request ?? a) as Record<string, unknown>;
  switch (req.kind) {
    case "server_info":
      return { payload: { version: "PostgreSQL 18.0 on aarch64-apple-darwin" }, cached: false };
    case "list_schemas":
      return { payload: ["public"], cached: false };
    case "list_objects":
      return { payload: [{ name: "users", kind: "table", isPartitioned: false, partitionCount: 0 }], cached: false };
    case "describe_object":
      return {
        payload: { columns: [{ name: "id", dbType: "int4", nullable: false, isPrimaryKey: true }] },
        cached: false,
      };
    case "list_indexes":
      return { payload: [{ name: "users_pkey", definition: "", isUnique: true, isPrimary: true }], cached: false };
    case "list_constraints":
      return { payload: [], cached: false };
    case "list_partitions":
      return { payload: [], cached: false };
    case "list_types":
      return { payload: [], cached: false };
    case "list_routines":
      return { payload: [], cached: false };
    default:
      return { payload: [], cached: false };
  }
}

/** Install the fake backend onto the mocked `invoke`. */
export function backend(): Backend {
  const handlers = defaults();
  const log: { cmd: string; args: Record<string, unknown> }[] = [];

  vi.mocked(invoke).mockImplementation((async (cmd: string, rawArgs?: unknown) => {
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    log.push({ cmd, args });
    const h = handlers[cmd];
    // An unknown command is a test-fixture gap, not app behaviour. Say so
    // rather than returning undefined and failing somewhere unrelated.
    if (!h) throw new Error(`fake backend: no handler for "${cmd}"`);
    try {
      return h(args) as never;
    } catch (e) {
      // Tauri rejects with the command's `Err(String)` — a bare string, not an
      // Error. Handlers throw because it reads better; the contract is
      // restored here so `String(e)` in the app sees what it really would,
      // with no "Error: " in front of it.
      throw e instanceof Error ? e.message : e;
    }
  }) as never);

  return {
    on: (cmd, fn) => {
      handlers[cmd] = fn;
    },
    sent: (cmd) => log.filter((c) => c.cmd === cmd).map((c) => c.args),
    calls: () => log.map((c) => c.cmd),
  };
}
