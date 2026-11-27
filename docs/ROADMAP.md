# TupleNest Roadmap

The roadmap lives on the website, in one place:
**<https://talaatmagdyx.github.io/TupleNest/roadmap.html>** (source:
[`docs/site/roadmap.html`](site/roadmap.html)).

It covers what has shipped, what is planned, and what TupleNest will not
become. In short: the engines are PostgreSQL and SQLite, and no other engine
(MySQL, MariaDB, SQL Server, MongoDB, Redis) is planned; there is no hosted
or cloud service. The assistant sends your question, the query and schema
names, but never row data. An AI tool you connect over MCP does receive rows,
but only from the connections you turn on for it.

The plans the project was built from are kept for their history:
[phase-0-plan.md](development/phase-0-plan.md) and [phase-1-plan.md](development/phase-1-plan.md).

Every stable release must pass the quality gates: no credential leakage, no
result corruption, tested cancellation, tested transaction-close behavior, a
PostgreSQL version matrix, installers on all platforms, an accessibility
baseline, performance benchmarks, crash recovery, and a security audit.
