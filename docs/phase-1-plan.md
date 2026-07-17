# TupleNest — Phase 1 Plan: PostgreSQL Daily-Use Product

> **This is the plan as written before the code, kept as a record of intent.
> The crate names below are not all real.** Most notably there is no
> `safety-engine`: the write guards and DML generation this plan assigns to it
> live in `apps/desktop/src/lib/sql.tsx` and `apps/desktop/src/lib/dml.ts`.
> Likewise `sql-parser`, `sql-language-service`, `transaction-core`,
> `metadata-core`, `query-engine`, `export-core`, `task-engine` and
> `tunnel-core` were never written; they sat as empty stubs and have been
> deleted. `Cargo.toml` and the README's Architecture section describe what is
> actually here; where the two disagree, they are right and this is history.

**Goal:** an internal team can use TupleNest as its **primary PostgreSQL client**: connect (TLS/SSH), explore, write SQL with completion, execute with reliable cancellation, browse and safely edit data, manage transactions, keep history, export CSV/JSON, read explain plans, and get basic production warnings.

**Duration estimate:** 12–16 weeks (3–5 engineers), starting from Phase 0 exit.

## Exit criteria

1. Internal team uses it daily as primary PG client (2-week dogfood with issue log).
2. No result corruption under large tests (checksum-verified round trips, 10M-row runs).
3. Query cancellation is reliable (100/100 in the cancellation stress suite).
4. Reconnection is safe (drops detected, no silent retry of non-idempotent statements).
5. Active transactions cannot be silently lost (close/disconnect always prompts; state machine tested).

---

## Epics

### E1.1 — Production PostgreSQL driver (Weeks 1–4)

Beyond the Phase 0 PoC: full type conversion (numeric/decimal, timestamps + zones, intervals, bytea, arrays, enums, UUID, JSON/JSONB, ranges, composite), parameterized statements, multi-statement scripts, notices/warnings surfaced, per-session settings, server version detection (PG 13–17), error normalization complete.

Acceptance tests
- Type matrix round-trip test per PG version (values render, edit, and re-insert losslessly; checksummed).
- Driver contract suite passes; capability report published in repo (`docs/drivers/postgres.md`).
- Fault injection: kill connection mid-query → normalized network error, session marked broken, no corrupted grid state.

Crates: `driver-postgres`, `driver-api`.

### E1.2 — Connection manager, TLS, SSH tunnel (Weeks 1–4, parallel)

Stories
- As a user, I can create/edit/duplicate/delete connection profiles with environment tag (dev/staging/prod), color, and read-only flag.
- As a user, I can require TLS with full verification (system + custom CA), and add an explicit per-host exception only through a warning flow.
- As a user, I can connect through an SSH tunnel (password, key, agent; host-key verification with TOFU pinning).
- As a user, `connection_test` gives a staged report: DNS → TCP → SSH → TLS → auth → server version.

SQLite schema additions
```sql
CREATE TABLE connections (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, driver TEXT NOT NULL DEFAULT 'postgres',
  environment TEXT CHECK (environment IN ('dev','test','staging','prod')),
  color TEXT, read_only INTEGER DEFAULT 0,
  host TEXT, port INTEGER, database TEXT, username TEXT,
  secret_ref TEXT,                -- keychain reference, never the secret
  tls_mode TEXT NOT NULL DEFAULT 'verify-full', tls_ca_path TEXT,
  ssh_json TEXT,                  -- tunnel config, secret_refs only
  options_json TEXT, created_at INTEGER, updated_at INTEGER
);
```

Acceptance tests
- MITM test with bad cert fails closed; exception flow scoped to one host and logged.
- Tunnel survives idle keepalive; tunnel loss is reported distinctly from DB loss.
- Prod-tagged connections show persistent environment banner.

Crates: `connection-core`, `ssh-core`, `tunnel-core`, `credential-store`. Frontend: `connections`.

### E1.3 — Explorer & metadata cache (Weeks 3–7)

Stories
- As a user, I see a virtualized tree: databases → schemas → tables/views/materialized views/functions/sequences/indexes/triggers/extensions, with lazy incremental loading.
- As a user, I can search cached objects in <100ms and refresh a node without a blocking full refresh.
- As a user, I can open an object inspector (columns, indexes, constraints, DDL, row estimate).

SQLite schema additions
```sql
CREATE TABLE metadata_objects (
  connection_id TEXT NOT NULL, object_type TEXT NOT NULL, schema_name TEXT,
  object_name TEXT NOT NULL, parent TEXT, details_json TEXT,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (connection_id, object_type, schema_name, object_name)
);
CREATE INDEX idx_meta_search ON metadata_objects(connection_id, object_name);
```

Acceptance tests
- 10k-table database: tree remains responsive (virtualized), search <100ms from cache.
- Cache invalidation on DDL executed through the app; manual refresh per node.
- Inspector DDL matches `pg_dump --schema-only` output for the object (normalized).

Crates: `metadata-core`, `metadata-cache`. Frontend: `explorer`.

### E1.4 — SQL editor & basic completion (Weeks 4–9)

Stories
- As a user, I get a Monaco-based SQL editor with PG syntax highlighting, multi-statement support, statement-at-cursor detection, formatting, and files up to 10MB.
- As a user, I get completion for keywords, schemas, tables, columns (alias-aware within the current statement), and functions from the metadata cache, in <100ms when cached.
- As a user, current-statement execution (⌘Enter) and selection execution work predictably.

Acceptance tests
- Keystroke processing <16ms at p95 on a 5k-line script.
- Alias resolution: `SELECT o.| FROM orders o` completes `orders` columns.
- Statement splitter handles `$$` bodies, comments, and strings (fuzz-tested).

Crates: `sql-parser` (statement splitting + light parsing), `sql-language-service`. Frontend: `editor`, `packages/editor`.

### E1.5 — Query execution, streaming grid, cancellation (Weeks 5–10)

Stories
- As a user, running a query shows status (queued → running → streaming → done/cancelled/error), row count, elapsed time; results stream into a virtualized grid with bounded memory and disk spill for large sets.
- As a user, Cancel is always visible during execution and takes effect server-side in <1s.
- As a user, multiple result sets and messages (NOTICE, affected-row counts) are shown per statement.
- As a user, if the connection drops, I see exactly what happened; nothing silently re-runs.

APIs (Tauri commands): `query_prepare`, `query_execute`, `query_cancel`, `result_acknowledge`, `session_state`.
Transport: binary column-batch frames over Tauri channels; `result_acknowledge` provides backpressure.

Acceptance tests
- 10M-row stream: bounded RSS, spill to encrypted temp files, smooth scroll, first batch <100ms.
- Corruption gate: checksum of streamed cells equals server-side checksum (release blocker).
- Cancellation stress: 100 consecutive cancels of a long query — 100 clean terminations.
- Reconnect safety: mid-`UPDATE` drop → error + broken-session state; re-run requires explicit user action.

Crates: `query-engine`, `result-stream`, `transaction-core`. Frontend: `results`, `packages/grid`.

### E1.6 — Table browsing & safe editing (Weeks 8–12)

Stories
- As a user, I can open any table in a browser tab with server-side pagination, column sorting, and filter builder (no full-table load).
- As a user, I can edit cells/rows/insert/delete in a **pending changes** buffer, preview the exact SQL, and apply in one transaction; primary-key-less tables are read-only with an explanation.
- As a user, edits use optimistic concurrency (WHERE includes prior values or ctid strategy); conflicts are reported, never overwritten.

Acceptance tests
- Generated DML preview matches applied statements byte-for-byte (audited).
- Conflict test: concurrent external change → apply fails with a clear diff, no partial write (single transaction).
- NULL vs empty string vs default handled explicitly in the editor UI.

Crates: `transaction-core`, `safety-engine` (DML generation + guards). Frontend: `results` (edit mode).

### E1.7 — Transactions (Weeks 9–12)

Stories
- As a user, I can toggle auto-commit vs manual; in manual mode I see a persistent transaction indicator (state, duration, savepoints).
- As a user, closing a tab/connection/app with an open transaction always prompts: commit / rollback / stay.
- As a user, BEGIN/COMMIT/ROLLBACK/SAVEPOINT typed in SQL are tracked correctly by the state machine.

Acceptance tests
- Property-based state machine test covers all transitions incl. errors inside transactions (aborted state requires rollback).
- Kill app with open transaction → on restart, user is informed the transaction was rolled back by the server; nothing pretends it committed.

Crates: `transaction-core`.

### E1.8 — Query history (Weeks 10–12)

SQLite schema additions
```sql
CREATE TABLE query_history (
  id TEXT PRIMARY KEY, connection_id TEXT, database_name TEXT,
  query_text TEXT NOT NULL, started_at INTEGER NOT NULL, duration_ms INTEGER,
  status TEXT CHECK (status IN ('success','error','cancelled')),
  rows_affected INTEGER, error_summary TEXT, favorite INTEGER DEFAULT 0
);
CREATE INDEX idx_history_search ON query_history(connection_id, started_at DESC);
```

Stories: search/filter by connection/status/date/text; re-run and copy; favorites; retention setting; optional exclusion of query text for flagged (prod) connections.

Acceptance tests: 100k-entry history stays searchable <150ms; secrets/parameter values never stored.

Crates: `workspace-store`. Frontend: `history`.

### E1.9 — CSV & JSON export (Weeks 11–13)

Stories
- As a user, I can export a result set or table to CSV (delimiter, quoting, encoding, header options) and JSON (array or NDJSON), streamed to disk as a cancellable background task with progress.

Acceptance tests
- 10M-row export completes with bounded memory; cancel leaves no partial temp junk.
- Round-trip: export → import into PG → checksums match (corruption gate).
- Exports never include credentials; prod-tagged connections can require confirmation.

Crates: `export-core`, `task-engine`. Frontend: `export`.

### E1.10 — Explain plan & production warnings (Weeks 12–14)

Stories
- As a user, I can run EXPLAIN / EXPLAIN ANALYZE and see a tree view with per-node cost, rows (est vs actual), timing, and flags for seq scans on large tables, misestimates, and spills.
- As a user, on prod-tagged connections I get warnings before: UPDATE/DELETE without WHERE, DDL, TRUNCATE, and >N-row writes; read-only profiles block writes entirely.

Acceptance tests
- Plan JSON parsed for PG 13–17 fixtures; tree renders nested loops/CTEs/parallel nodes.
- Warning engine unit-tested against a corpus of dangerous statements (no false negative on the corpus).

Crates: `safety-engine`, `query-engine`. Frontend: `results` (plan tab).

### E1.11 — Hardening, dogfood, release (Weeks 14–16)

- 2-week internal dogfood as primary client; triage bar: zero data-corruption or credential bugs open.
- Release quality gates (from master spec §61): cancellation tested, transaction-close behavior tested, PG version matrix passed, installers tested on all platforms, accessibility baseline, performance benchmarks, crash recovery, security review.
- Tag `v0.2.0-beta`, publish signed installers + driver capability report.

---

## Milestones

| Milestone | Week | Proof |
|---|---|---|
| M1.1 TLS + SSH connections with staged test report | 4 | e2e tests |
| M1.2 Explorer + inspector on 10k-object DB | 7 | perf test |
| M1.3 Editor with cache-backed completion | 9 | latency benchmarks |
| M1.4 Streaming grid + reliable cancel + corruption gate | 10 | stress suite |
| M1.5 Safe editing + transactions | 12 | property tests |
| M1.6 History, export, explain, prod warnings | 14 | feature demos |
| M1.7 Dogfood complete, v0.2.0-beta | 16 | signed release |

## Test infrastructure (cross-cutting)

- Dockerized PG 13/14/15/16/17 matrix in CI; nightly large-data jobs (10M rows).
- Corruption gate, cancellation stress, and transaction state machine run on every PR touching `driver-*`, `query-engine`, `result-stream`, `transaction-core`.
- Frontend: component + keyboard + a11y tests; grid performance budget test.

## Out of scope for Phase 1

MySQL/MariaDB/SQLite/MSSQL (Phase 2), refactoring/semantic analysis (Phase 3), import wizard & schema diagrams (Phase 2), DuckDB/notebooks (Phase 4), NoSQL (Phase 5), monitoring (Phase 6), AI (Phase 7).
