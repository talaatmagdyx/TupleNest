# TupleNest — Phase 0 Plan: Product and Technical Foundation

> **This is the plan as written before the code, kept as a record of intent.
> The crate names below are not all real.** The build consolidated: there is no
> `app-core`, `query-engine`, `task-engine` or `sql-parser` crate — those
> responsibilities live in `apps/desktop/src-tauri` and in the frontend's
> `src/lib`. Ten crates named in these plans existed for a while as empty
> one-line stubs and have been deleted. `Cargo.toml` and the README's
> Architecture section describe what is actually here; where the two disagree,
> they are right and this is history.

**Goal:** a cross-platform (macOS/Windows/Linux) Tauri 2 + Rust + React shell with the core plumbing every later phase depends on, proven end-to-end by a PostgreSQL connection, streaming, and cancellation proof of concept.

**Duration estimate:** 8–10 weeks (2–4 engineers).
**License:** MIT (OSS from day one — public repo, CI, CONTRIBUTING, issue templates).

## Exit criteria (Definition of Done for the phase)

1. App runs on macOS, Windows, and Linux from CI-built artifacts.
2. Credentials never reach frontend state (verified by test + code review gate).
3. Application restores layout (tabs, splits, theme, window size) after restart.
4. A PostgreSQL connection can be opened via the driver API.
5. Streaming proof of concept: 1M+ rows flow to the grid in batches with bounded memory.
6. Cancellation proof of concept: a running query is cancelled server-side in <1s.

---

## Epics

### E0.1 — Repository, Rust workspace, CI (Week 1)

Stories
- As a contributor, I can clone the repo and `cargo build` the whole workspace on all three OSes.
- As a maintainer, every PR runs fmt, clippy (`-D warnings`), tests, and audit on a 3-OS matrix.

Acceptance tests
- CI green on ubuntu/macos/windows for an empty-crate workspace.
- `cargo deny`/`cargo audit` job fails on known vulnerable deps.
- README, LICENSE (MIT), CONTRIBUTING, CODE_OF_CONDUCT, issue/PR templates exist.

Crates: workspace root, all stub crates. Deliverable: this repo scaffold.

### E0.2 — Product definition & design system (Weeks 1–2, parallel)

Stories
- As the team, we have a one-page product definition (users, boundaries, non-goals) checked into `docs/`.
- As a designer/frontend dev, I have design tokens (color, spacing, type, density), light/dark/high-contrast themes, and component specs for: button, input, select, tree, tabs, table, dialog, toast, command palette.

Acceptance tests
- Tokens exported as CSS variables consumed by Tailwind config.
- Contrast ratios meet WCAG AA in all three themes.
- Storybook (or Ladle) renders all base components with keyboard navigation.

Frontend: `packages/ui`.

### E0.3 — Tauri application shell & capability model (Weeks 2–4)

Stories
- As a user, the app opens a window in <800ms with native menus and single-instance behavior.
- As a security reviewer, the WebView can only invoke an explicit allowlist of narrow commands (no `run_shell`, no arbitrary FS read).
- As a user, the app has a strict CSP and loads no remote executable code.

Acceptance tests
- Capability file enumerates every command; an unlisted command invocation fails a test.
- CSP blocks inline/remote script in an automated test.
- Cold-start window-visible time measured in CI (<800ms target on reference machine).

Crates: `app-core`. APIs (initial narrow command set):
`app_get_info`, `settings_get`, `settings_set`, `layout_save`, `layout_load`, `secret_set`, `secret_delete`, `connection_test`, `connection_open`, `connection_close`, `query_execute`, `query_cancel`, `result_acknowledge`.

Transport: JSON for control messages; Tauri channels + binary batches for result streaming (no per-cell JSON).

### E0.4 — React frontend foundation (Weeks 2–5)

Stories
- As a user, I have a command palette (⌘K) listing all registered commands with keyboard execution.
- As a user, I can open, close, reorder, and pin tabs; tabs survive restart.
- As a user, I can split the workspace horizontally/vertically and resize panes; layout survives restart.
- As a user, I can change theme (light/dark/high-contrast/system) and density; it applies instantly.
- As a user, I have a settings screen with searchable settings.

Acceptance tests
- Command registry: every UI action is a registered command with an ID and optional shortcut.
- Kill the app; relaunch restores tabs, splits, sizes, theme in <2.5s.
- All shell interactions work keyboard-only; focus indicators visible.
- Zustand stores contain zero secrets and zero connection state (lint rule + review checklist).

Stack: React, TypeScript, Vite, Zustand, TanStack Query/Virtual, Radix, Tailwind, React Router. Modules: `app-shell`, `commands`, `tabs`, `settings`, `theme`, `state`, `ipc`.

### E0.5 — SQLite application store (Weeks 3–4)

Stories
- As the app, I persist settings, layout, and workspace state in a versioned local SQLite DB with migrations.

Schema v1
```sql
CREATE TABLE meta        (key TEXT PRIMARY KEY, value TEXT);           -- schema_version, install_id
CREATE TABLE settings    (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE workspaces  (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER, updated_at INTEGER);
CREATE TABLE layouts     (workspace_id TEXT REFERENCES workspaces(id), layout_json TEXT NOT NULL,
                          updated_at INTEGER, PRIMARY KEY (workspace_id));
CREATE TABLE tabs        (id TEXT PRIMARY KEY, workspace_id TEXT REFERENCES workspaces(id),
                          kind TEXT NOT NULL, title TEXT, position INTEGER, pinned INTEGER DEFAULT 0,
                          state_json TEXT);
```

Acceptance tests
- Migration framework applies v0→v1; downgrade is refused with a clear error.
- Corrupt store is detected; app starts with recovery flow instead of crashing.

Crates: `workspace-store`.

### E0.6 — Credential store / OS keychain (Weeks 4–5)

Stories
- As a user, my database passwords are stored only in the OS keychain (Keychain/DPAPI-Credential Manager/Secret Service), referenced by opaque IDs.
- As a security reviewer, no secret ever appears in: frontend state, logs, SQLite, crash reports, or IPC payloads returned to the WebView.

Acceptance tests
- `secret_set` returns a reference ID; `secret_get` is **not** exposed to the frontend at all — only backend crates resolve references.
- Grep-gate test: serialized IPC fixtures and log fixtures contain no secret markers.
- Works on all three OSes in CI (headless secret-service on Linux).

Crates: `credential-store`.

### E0.7 — Logging, crash handling, update foundation (Weeks 5–6)

Stories
- As a maintainer, I get structured logs (timestamp, level, component, operation ID, duration, error category) with rotation; query text and credentials are never logged by default.
- As a user, a crash produces a sanitized report and the app offers restart with restored layout.
- As a maintainer, release artifacts are signed and the Tauri updater is wired to a manifest endpoint (can be dormant until Phase 1 release).

Acceptance tests
- Log redaction test: injected fake secret never appears in logs.
- Forced panic in a background task does not take down the app; it is reported.
- Updater verifies signature; tampered bundle is rejected.

Crates: `telemetry`, `task-engine` (background tasks with IDs + cancellation tokens).

### E0.8 — Driver API (Weeks 5–7)

Stories
- As a driver author, I implement `DatabaseDriver` + `DatabaseSession` traits and publish `DriverCapabilities`; the app can register, list, and describe drivers.
- As the frontend, I can read driver capabilities and hide unsupported actions.

Contract (from the master spec)
```rust
#[async_trait]
pub trait DatabaseDriver: Send + Sync {
    fn descriptor(&self) -> DriverDescriptor;
    fn capabilities(&self) -> DriverCapabilities;
    async fn test(&self, config: ConnectionConfig) -> Result<ConnectionTestReport, DriverError>;
    async fn connect(&self, config: ConnectionConfig) -> Result<Box<dyn DatabaseSession>, DriverError>;
}

#[async_trait]
pub trait DatabaseSession: Send + Sync {
    async fn execute(&mut self, request: QueryRequest) -> Result<QueryExecution, DriverError>;
    async fn cancel(&self, execution_id: ExecutionId) -> Result<(), DriverError>;
    async fn metadata(&self, request: MetadataRequest) -> Result<MetadataResponse, DriverError>;
    async fn begin(&mut self, options: TransactionOptions) -> Result<TransactionId, DriverError>;
    async fn commit(&mut self) -> Result<(), DriverError>;
    async fn rollback(&mut self) -> Result<(), DriverError>;
}
```

Also in scope: normalized `DriverError` taxonomy (config, DNS, network, TLS, auth, syntax, constraint, deadlock, timeout, cancellation, resource-exhausted, unsupported, internal — each with user title, native code, retryability, suggested actions) and a **driver contract test suite** (connection, metadata, execution, cancellation, transaction, type conversion, error normalization) any driver must pass.

Acceptance tests
- A mock driver passes the contract suite; a deliberately broken mock fails each contract category.
- Capabilities round-trip to the frontend and gate UI affordances.

Crates: `driver-api`, `connection-core`, `query-engine`, `result-stream` (batch model: bounded channels, backpressure, `result_acknowledge` flow control).

### E0.9 — PostgreSQL proof of concept (Weeks 7–9)

Stories
- As a user, I can define a PG connection (host/port/db/user/password-in-keychain), test it, open it, run a query, and see rows.
- As a user, I can run `SELECT * FROM generate_series(1, 5_000_000)` and scroll results while memory stays bounded.
- As a user, I can cancel that query and the server-side backend terminates in <1s.

Acceptance tests (against real PG in CI via Docker)
- Connect/execute/fetch happy path on PG 14–17.
- Streaming: peak RSS bounded (< configured cap) during 5M-row fetch; first batch rendered <100ms after arrival.
- Cancellation: `pg_stat_activity` confirms backend cancelled; UI reaches "cancelled" state.
- Wrong password → normalized auth error with actionable message (not a raw driver string).

Crates: `driver-postgres` (tokio-postgres). Frontend: minimal raw grid (virtualized).

### E0.10 — Phase 0 hardening & release gate (Week 10)

- 3-OS manual smoke pass, accessibility baseline (keyboard-only walkthrough, screen-reader labels on shell), performance targets measured (startup <800ms window / <1.5s interactive / <2.5s restore), security review of capabilities + secrets, tag `v0.1.0-alpha` with signed artifacts.

---

## Milestones

| Milestone | Week | Proof |
|---|---|---|
| M0.1 Shell boots on 3 OSes, CI green | 3 | CI artifacts |
| M0.2 Tabs/splits/settings/theme persist | 5 | restart demo |
| M0.3 Secrets in keychain, redaction gates | 6 | security tests |
| M0.4 Driver API + contract suite | 7 | mock driver passes |
| M0.5 PG connect + stream + cancel PoC | 9 | live demo, CI e2e |
| M0.6 v0.1.0-alpha tagged | 10 | signed release |

## Out of scope for Phase 0

Explorer tree, SQL editor/completion, safe editing, transactions UI, history, export, explain — all Phase 1. MySQL/others — Phase 2+.
