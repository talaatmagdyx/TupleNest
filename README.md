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

- **Connections** — saved profiles, credentials stored only in the macOS Keychain, never in state/logs/SQLite.
- **TLS** — disabled / prefer / verify-ca / verify-full, fails closed on cert problems.
- **SSH tunnels** — host-key-pinned (fingerprint or known_hosts), fails closed.
- **Schema explorer** — lazy tree of schemas → tables/views → columns, with indexes, size, and row estimates.
- **Streaming result grid** — bounded, virtualized, backpressured; large result sets never corrupt or blow up memory.
- **Query editor** — syntax highlighting, Format SQL, EXPLAIN / EXPLAIN ANALYZE plan tab, `$1..$n` parameter binding.
- **Schema-aware autocomplete** — context-driven completion as you type or on ⌃Space: tables and schemas after `FROM`/`JOIN`/`UPDATE`, columns of the in-scope tables in `SELECT`/`WHERE`/`ON`, alias resolution (`t.` → that table's columns), `schema.` → its tables, plus keywords and functions. Columns and object lists are fetched lazily on demand and cached; comments and string literals are masked so they never trigger false context.
- **Safe row editing** — double-click a cell to edit it. TupleNest only enables editing when it can prove the result maps to single rows of one table (single-table SELECT, no join/group/distinct/union/CTE, primary key present in the result); otherwise it says why. Changes stage locally — nothing is written until you review the exact generated `UPDATE`s and apply them, in one transaction that rolls back entirely on any failure. Values are always bound as parameters, identifiers are quote-escaped, every statement is primary-key-keyed (never unbounded), primary-key columns and computed columns are read-only, and prod gets an extra warning.
- **Transactions** — begin / commit / rollback with an unsafe-close guard.
- **Query history** — searchable, with a production-statement audit log (full SQL captured on prod).
- **Server monitoring** — live `pg_stat_activity`, locks, and DB stats; cancel or terminate a backend.
- **ER diagram** — foreign-key relationship graph.
- **SQL intelligence** — find usages of an identifier across every open tab (whole-identifier matches only, never inside a longer name, comment, or string), rename across tabs, diff two schemas column-by-column, and compare two EXPLAIN plans with cost/time deltas and a "new sequential scan" regression flag.
- **CSV import** — pick a file, review the inferred column names and types, then import in batches inside one transaction. Full RFC-4180 parsing (quoted delimiters, escaped quotes, embedded newlines, BOM); values bind as text so `numeric` precision survives intact.
- **Auto-update** — signed with a minisign key baked into the binary, so a compromised release host still can't push code. Refuses to update while a transaction is open.
- **SQL snippets** — reusable snippet library via the command palette.
- **Production safety** — prod connections flagged, guarded destructive statements, colored environment banner.
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

Design principles: Rust owns all connections, sessions, transactions, and result streams; the WebView only invokes narrow, capability-gated Tauri commands. Credentials live exclusively in the OS keychain. Results stream in bounded batches with backpressure. Query cancellation is a first-class, tested feature.

- [docs/ROADMAP.md](docs/ROADMAP.md) — Phases 0–9 overview
- [docs/design-requirements.md](docs/design-requirements.md) — UI design spec
- [docs/dev-sshd.md](docs/dev-sshd.md) — local sshd for tunnel tests

## License

[MIT](LICENSE)
