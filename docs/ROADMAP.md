# TupleNest Roadmap

| Phase | Theme | Outcome |
|---|---|---|
| **0** | Product & technical foundation | Cross-platform Tauri shell, Rust workspace, command/tab/pane system, settings, themes, SQLite store, keychain, capability model, logging, crash handling, update foundation, driver API, PostgreSQL connect/stream/cancel PoC. → [phase-0-plan.md](phase-0-plan.md) |
| **1** | PostgreSQL daily-use product | Production PG driver, connection manager (TLS, SSH), explorer + metadata cache, SQL editor + completion, execution + streaming grid, table browsing, safe editing, transactions, history, CSV/JSON export, explain plan, production warnings. → [phase-1-plan.md](phase-1-plan.md) |
| 2 | Relational core | MySQL, MariaDB, SQLite, SQL Server; capability UI; dialect completion; advanced editing; import wizard; schema diagrams; snippets; workspace files; Git. |
| 3 | Advanced SQL IDE | Semantic analysis, refactoring, find usages, navigation, formatter, parameters, plan & schema comparison. |
| 4 | Large data & analytics | Embedded DuckDB, notebooks, charts, large-file import/export. |
| 5 | NoSQL foundation | MongoDB, Redis/Valkey, Elasticsearch/OpenSearch, native editors. |
| 6 | Production operations | Monitoring, sessions/locks/replication, safety engine with approvals, audit. |
| 7 | AI assistant | Permission-planned, redacted, audited AI for generate/explain/review/optimize. |
| 8 | Plugin ecosystem | Signed plugins, extension SDK, driver marketplace. |
| 9 | Team & enterprise | Shared workspaces, org policies, SSO. |

Every stable release must pass the quality gates: no credential leakage, no result corruption, tested cancellation, tested transaction-close behavior, DB version matrix, installers on all platforms, accessibility baseline, performance benchmarks, crash recovery, security audit.
