# TupleNest

**A modern, safety-first desktop IDE for PostgreSQL.**

Rust + Tauri 2 + React + TypeScript · macOS, Windows, Linux · MIT licensed

TupleNest is a fast, local-first workspace for exploring, developing, debugging, and operating PostgreSQL databases. This release ships a complete PostgreSQL adapter; other engines are on the roadmap.

## Install

Every platform is built from the same source on its own CI runner. Credentials
always go to the OS keychain — Keychain on macOS, Credential Manager on Windows,
Secret Service on Linux — never to a config file.

| Platform | Download | Notes |
| --- | --- | --- |
| **macOS** (Apple Silicon) | `TupleNest_0.1.0_aarch64.dmg` | macOS 10.15+ |
| **macOS** (Intel) | the `.dmg` marked Intel | macOS 10.15+ |
| **Windows** | the `.exe` installer, or the `.msi` | Windows 10+; WebView2 ships with Windows 11 and is installed automatically if missing |
| **Linux** | the `.AppImage`, `.deb`, or `.rpm` | needs `webkit2gtk-4.1`; built on Ubuntu 22.04, so glibc 2.35+ |

**macOS** — drag TupleNest into Applications. The build is not notarized, so the
first launch needs Gatekeeper approval: right-click the app → **Open** →
**Open**, or run once:

```sh
xattr -dr com.apple.quarantine /Applications/TupleNest.app
```

**Windows** — the installer is unsigned, so SmartScreen shows "Windows protected
your PC" on first run: click **More info** → **Run anyway**.

**Linux** — `chmod +x` the AppImage and run it, or install the `.deb` /`.rpm`.
A keyring daemon (GNOME Keyring, KWallet) must be running, or saved passwords
have nowhere to live.

> Auto-update is built in but has nowhere to point yet: the release endpoint
> does not exist, so the app never finds an update and never nags about it.
> Upgrading means downloading the next build by hand.

## What's included (PostgreSQL)

- **Connections** — saved profiles, credentials stored only in the OS keychain (Keychain / Credential Manager / Secret Service), never in state, logs, or SQLite. Optional read-only profiles, enforced by the server.
- **TLS** — disabled / prefer / verify-ca / verify-full, fails closed on cert problems.
- **SSH tunnels** — host-key-pinned (fingerprint or known_hosts), fails closed.
- **Schema explorer** — lazy tree of schemas → tables/views → columns, with indexes, size, and row estimates.
- **Streaming result grid** — virtualized and backpressured. Rows arrive in bounded batches and the grid keeps the first 100,000, telling you when it truncated; a checksum test pins that nothing is lost or duplicated on the way. Note the cap counts rows, not bytes: 100,000 very wide rows can still be a lot of memory.
- **Query editor** — syntax highlighting, Format SQL, EXPLAIN / EXPLAIN ANALYZE plan tab, `$1..$n` parameter binding.
- **Schema-aware autocomplete** — context-driven completion as you type or on ⌃Space: tables and schemas after `FROM`/`JOIN`/`UPDATE`, columns of the in-scope tables in `SELECT`/`WHERE`/`ON`, alias resolution (`t.` → that table's columns), `schema.` → its tables, plus keywords and functions. Columns and object lists are fetched lazily on demand and cached; comments and string literals are masked so they never trigger false context.
- **Safe row editing** — double-click a cell to edit it. Editing is offered only for a single-table SELECT with the primary key in the result, and refused with a reason otherwise (join, group, distinct, union, CTE, no primary key). That check is conservative but syntactic, not a proof — so nothing is written until you review the exact generated `UPDATE`s. What the writes themselves guarantee is stronger, and tested: values are always bound as parameters, identifiers are quote-escaped, every statement is keyed by the full primary key and can never be unbounded, and the whole set applies in one transaction that rolls back entirely on any failure — including if a statement matches zero rows because someone else changed it first. Primary-key, computed and generated columns are read-only. Prod gets an extra warning.
- **Transactions** — begin / commit / rollback. Closing the window or disconnecting with one open always prompts. One session serves every tab, so a transaction belongs to the connection: the tab that opened it owns it, and committing from another tab is refused rather than silently committing work you cannot see.
- **Query history** — searchable, with a production-statement audit log (full SQL captured on prod).
- **Server monitoring** — live `pg_stat_activity`, locks, and DB stats; cancel or terminate a backend.
- **ER diagram** — foreign-key relationship graph.
- **SQL intelligence** — find usages of an identifier across every open tab (whole-identifier matches only — not inside a longer name, comment, or string; identifiers are matched as ASCII, so unicode names are not yet handled), rename across tabs, diff two schemas column-by-column, and compare two EXPLAIN plans with cost/time deltas and a "new sequential scan" regression flag.
- **CSV import** — pick a file, review the inferred column names and types, then import in batches inside one transaction. RFC-4180 parsing (quoted delimiters, escaped quotes, embedded newlines), plus BOM handling; values bind as text so `numeric` precision survives intact. The whole file is read into memory, so very large CSVs are not yet practical.
- **Auto-update** — updates are signed offline and verified against a minisign public key baked into the binary. The release host only serves bytes; it never holds the private key, so a compromised host cannot make the app accept an update. Refuses to update while a transaction is open.
- **SQL snippets** — reusable snippet library via the command palette.
- **Production safety** — prod and staging connections flagged; `UPDATE`/`DELETE` without a `WHERE`, and DDL such as `DROP`/`TRUNCATE`/`ALTER`, ask before they run (checked against SQL with comments and strings masked, so a commented-out `WHERE` does not disarm it). Best-effort, not a boundary — it is the seatbelt light, not the seatbelt. Read-only profiles are enforced by PostgreSQL itself. Colored environment banner.
- **Signature UX** — environment-reactive ambient window frame (dev / staging / prod), unified macOS titlebar, collapsible + resizable activity-rail sidebar.

## Build from source

```sh
cd apps/desktop
npm install --include=dev
npm run tauri build      # produces target/release/bundle/{macos,dmg}
```

Dev mode: `npm run tauri dev`.

> **`NODE_ENV` gotcha.** If your shell exports `NODE_ENV=production`, npm sets
> `omit=dev` and silently strips `vite`, `vitest`, and `typescript` — later
> installs then break the build. Always install with `--include=dev`. Do *not*
> "fix" that by exporting `NODE_ENV=development`: Vite reads it at build time and
> will bundle React's **development** build into the release (≈+400 kB and
> slower). Install with `--include=dev`; build with `NODE_ENV` left at
> production.

Run the test suites:

```sh
cargo test                 # Rust unit tests
cd apps/desktop && npm test # TypeScript (vitest): completion engine, DML generation
```

Live PostgreSQL / SSH contract tests are marked `#[ignore]` and require a local Postgres on `:5432` and the dev sshd from `docs/dev-sshd.md`:

```sh
cargo test -- --ignored
```

## Architecture

```
apps/desktop/       Tauri 2 desktop app (React frontend + src-tauri)
crates/             Rust workspace: driver-api, driver-postgres, connection-core,
                    credential-store, ssh-core, workspace-store, metadata-cache,
                    result-stream, telemetry, …
docs/               Roadmap, phase plans, dev setup
```

Design principles: Rust owns all connections, sessions, transactions, and result streams; the WebView only invokes narrow, capability-gated Tauri commands. Credentials live exclusively in the OS keychain. Results stream in bounded batches with backpressure. Query cancellation uses the PostgreSQL wire-protocol cancel key and is covered by contract tests that run against a real server on every push.

- [docs/ROADMAP.md](docs/ROADMAP.md) — Phases 0–9 overview
- [docs/design-requirements.md](docs/design-requirements.md) — UI design spec
- [docs/dev-sshd.md](docs/dev-sshd.md) — local sshd for tunnel tests

## License

[MIT](LICENSE)
