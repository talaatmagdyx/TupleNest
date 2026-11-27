# TupleNest Roadmap

The roadmap lives on the website, in one place:
**<https://talaatmagdyx.github.io/TupleNest/roadmap.html>** (source:
[`docs/site/roadmap.html`](site/roadmap.html)).

It covers what has shipped, what is in progress, what is planned or under
consideration, and what TupleNest will not become. In short, TupleNest is a
PostgreSQL IDE: support for every database engine is not planned, and no AI
assistant is promised.

The plans the project was built from are kept for their history:
[phase-0-plan.md](phase-0-plan.md) and [phase-1-plan.md](phase-1-plan.md).

Every stable release must pass the quality gates: no credential leakage, no
result corruption, tested cancellation, tested transaction-close behavior, a
PostgreSQL version matrix, installers on all platforms, an accessibility
baseline, performance benchmarks, crash recovery, and a security audit.
