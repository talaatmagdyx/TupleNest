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

export type DbObject = {
  name: string;
  /** table | view | matview | foreign | sequence */
  kind: string;
  comment: string | null;
  /** True for a partitioned parent (relkind 'p'). */
  isPartitioned: boolean;
  /** Direct children. Partitioning here is multi-level, so a child may itself
   *  be partitioned. */
  partitionCount: number;
};

export type DbPartition = {
  name: string;
  /** FOR VALUES FROM (…) TO (…) */
  bounds: string | null;
  bytes: number;
  rowsEstimate: number;
  /** A partition is frequently partitioned again — here by channel, then by
   *  quarter. The tree needs this to offer a Partitions node without first
   *  fetching a level it may never open. */
  isPartitioned: boolean;
  partitionCount: number;
};

export type DbConstraint = {
  name: string;
  /** primary key | foreign key | unique | check | exclusion | not null */
  kind: string;
  definition: string | null;
  isValid: boolean;
};

export type DbIndex = {
  name: string;
  definition: string;
  isUnique: boolean;
  isPrimary: boolean;
  bytes: number;
  /** Times this index has been used. 0 = dead weight. */
  scans: number;
  isValid: boolean;
};

export type DbType = {
  name: string;
  /** enum | composite | domain | range */
  kind: string;
  comment: string | null;
  /** Comma-separated labels, for enums. */
  labels: string | null;
};

export type DbRoutine = {
  name: string;
  /** function | procedure | aggregate | window */
  kind: string;
  args: string | null;
  returns: string | null;
  comment: string | null;
  language: string;
};

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

// --- Health, search and partitions -----------------------------------------

/** Why an index is or isn't worth dropping. `keep` exists because the naive
 *  "never scanned" report proposes dropping primary keys. */
export type IndexVerdict = "used" | "keep" | "review" | "candidate";

export type IndexHealthItem = {
  schema: string;
  table: string;
  columns: string;
  method: string;
  scans: number;
  bytes: number;
  size: string;
  /** How many physical indexes this one logical index spans (partitions). */
  members: number;
  sampleIndex: string;
  /** Fully-qualified, quote_ident-escaped names. Populated only for verdicts
   *  that could lead to a DROP — the rest would be dead weight on the wire. */
  indexIdents: string[];
  verdict: IndexVerdict;
  why: string;
};

export type IndexHealth = {
  items: IndexHealthItem[];
  droppableBytes: number;
  droppableIndexes: number;
};

export type TableHealthItem = {
  schema: string;
  table: string;
  liveTuples: number;
  deadTuples: number;
  deadPct: number;
  vacuumed: string;
  analyzed: string;
  neverAnalyzed: boolean;
  size: string;
};

export type TableHealth = {
  items: TableHealthItem[];
  /** Counted across the whole database, not just the rows in `items`. */
  neverAnalyzed: number;
  neverVacuumed: number;
  totalTables: number;
  truncated: boolean;
};

export type TopQueryItem = {
  queryId: string;
  query: string;
  calls: number;
  totalMs: number;
  meanMs: number;
  rows: number;
};

/** `available: false` is a normal state, not an error: the extension needs a
 *  server restart to install, so the app must explain rather than fail. */
export type TopQueries = {
  available: boolean;
  reason?: string;
  remedy?: string;
  items: TopQueryItem[];
};

export type SearchHit = {
  schema: string;
  name: string;
  kind: string;
  /** Set when the match was on a column rather than the object name. */
  column: string;
};

export type SearchResults = { items: SearchHit[]; truncated: boolean };

export type PartitionRow = {
  name: string;
  bounds: string;
  size: string;
  rows: number;
  rowsKnown: boolean;
  isPartitioned: boolean;
  partitionCount: number;
};

export type PartitionOverview = {
  partitioned: boolean;
  strategy: string;
  partitionKey: string;
  items: PartitionRow[];
};
