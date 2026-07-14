# TupleNest

**A modern, open-source, cross-platform IDE for relational and NoSQL databases.**

Rust + Tauri 2 + React + TypeScript · macOS / Windows / Linux · MIT licensed

TupleNest aims to be the fastest, safest workspace for exploring, developing, debugging, and operating databases — competing with DataGrip, DBeaver, TablePlus, and friends on five differentiators: performance, modern UX, production safety, native multi-model support, and local-first privacy.

## Status

Pre-alpha. Currently executing **Phase 0** (foundation) and planning **Phase 1** (PostgreSQL daily-use product).

- [docs/ROADMAP.md](docs/ROADMAP.md) — Phases 0–9 overview
- [docs/phase-0-plan.md](docs/phase-0-plan.md) — full Phase 0 backlog: epics, stories, acceptance tests, milestones
- [docs/phase-1-plan.md](docs/phase-1-plan.md) — full Phase 1 backlog

## Repository layout

```
apps/desktop/       Tauri 2 desktop app (React frontend + src-tauri)
crates/             Rust workspace crates (driver-api, driver-postgres, query-engine, …)
packages/           Shared frontend packages (ui, editor, grid)
extensions/         Plugin ecosystem (reserved, Phase 8)
docs/               Roadmap and phase plans
```

## Core principles

1. Credentials live only in the OS keychain — never in frontend state, logs, or SQLite.
2. Rust owns connections, sessions, transactions, executions, and result streams; the WebView invokes only narrow, capability-gated Tauri commands.
3. Results stream in bounded binary batches with backpressure — no result corruption, ever (checksum-gated releases).
4. Query cancellation is a first-class, tested feature.
5. Every driver publishes an honest capability report and passes the contract test suite.

## Getting started (Phase 0)

```sh
cargo build            # builds the Rust workspace
# frontend: see apps/desktop/README.md to initialize the Tauri 2 + React app
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Everything is planned in the open — pick a story from the phase plans.

## License

[MIT](LICENSE)
