/** Shared shapes crossing the Tauri IPC boundary. Field names mirror the
 *  Rust structs (serde camelCase). */

export type AppInfo = { name: string; version: string; os: string };

export type SshParams = {
  host: string;
  port: number;
  username: string;
  keyPath: string;
  /** Pinned SHA-256 host key fingerprint; empty → known_hosts policy. */
  fingerprint: string;
};

export type PgParams = {
  host: string;
  port: number;
  database: string;
  username: string;
  secretRef: string | null;
  tlsMode: string;
  tlsCaPath: string | null;
  environment?: string | null;
  ssh?: SshParams | null;
};

export type TestStage = {
  name: string;
  passed: boolean;
  durationMs: number;
  detail: string | null;
};

export type TestReport = {
  serverVersion: string | null;
  stages: TestStage[];
};

export type ConnectionRecord = {
  id: string;
  name: string;
  driver: string;
  environment: string | null;
  color: string | null;
  readOnly: boolean;
  host: string;
  port: number;
  database: string;
  username: string;
  secretRef: string | null;
  tlsMode: string;
  tlsCaPath: string | null;
  sshJson: string | null;
};

export type MetadataOut<T> = {
  payload: T;
  cached: boolean;
  fetchedAt: number | null;
};

export type DbObject = { name: string; kind: string; comment: string | null };

export type DbColumn = {
  name: string;
  dbType: string;
  nullable: boolean;
  primaryKey: boolean;
  comment: string | null;
};

export type HistoryEntry = {
  id: string;
  connectionKey: string;
  sqlText: string | null;
  status: "success" | "error" | "cancelled";
  errorText: string | null;
  rowsReturned: number;
  rowsAffected: number | null;
  startedAt: number;
  durationMs: number;
  favorite: boolean;
};

export type SnippetRecord = {
  id: string;
  name: string;
  body: string;
  tags: string | null;
};

export type QueryResult = {
  columns: { name: string; dbType: string }[];
  totalRows: number;
  storedRows: number;
  truncated: boolean;
  rowsAffected: number | null;
  elapsedMs: number;
};
