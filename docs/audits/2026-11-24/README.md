# Audit of 2026-11-24

An engineering, security, performance and open-source audit of TupleNest.
Verdict: **beta ready with conditions**. No P0 findings; five P1.

| File | What it is |
|---|---|
| [REPORT.md](REPORT.md) | The consolidated report: scores, findings TN-001 to TN-029, measurements, threat model, verdict |
| [REMEDIATION.md](REMEDIATION.md) | The remediation plan and its status, one row per finding |
| [reviewers/](reviewers/) | The five reviewers' full reports, unedited apart from file paths |
| [evidence/](evidence/) | Their reproduction scripts, logs and raw outputs |

## What was audited

- **Commit:** `533545341b7ed1aca7b02f68a61c2c338c8b8f6e` on `main`.
  `main` moved to `63b950596cea948ea896e3565403c723b1f2486f` during the audit;
  the only difference is `.github/workflows/pages.yml`, so every file and line
  reference holds for both.
- **Nothing was modified** in the repository or on GitHub during the audit.
  Reproductions lived outside the tree and are copied here afterwards.

## Method

Five reviewers read the source independently, one area each: Rust architecture
and resources; PostgreSQL correctness; security and supply chain; frontend, UX
and tests; open-source readiness and releases. A second pass then re-checked
every P1 and the main P2 findings against the code, GitHub settings or a live
PostgreSQL, and downgraded what did not hold at the stated severity (listed in
REPORT.md, "Withdrawn or downgraded").

Confidence levels: **Confirmed** means reproduced by something that was run, or
an unambiguous configuration fact. **High-confidence** means clear code
evidence with no reproduction. **Potential** means plausible and unvalidated.

## Environment

| | |
|---|---|
| Machine | Apple M4 Pro, 12 cores, 24 GB, macOS 26.6 (arm64) |
| Rust | rustc / cargo 1.96.1 (Homebrew). CI uses the latest stable, 1.100 at the time |
| Node | 23.9 (Homebrew) |
| PostgreSQL | 18.0 (Homebrew) on localhost, no TLS |
| Load | An unrelated virtual machine kept the load average between 15 and 181. **Timings are noisy; memory figures were stable across runs** |
| Databases | Disposable `tuplenest_audit_rust` and `tuplenest_audit_pg`, created for the audit and dropped afterwards |

## Commands and results

| Command | Result | Log |
|---|---|---|
| `cargo fmt --all -- --check` | pass | `evidence/audit-rust/tool-output/fmt.txt` |
| `cargo clippy --workspace --all-targets --all-features -- -D warnings` | pass (local 1.96) | `evidence/audit-rust/tool-output/clippy.txt` |
| `cargo test --workspace` | pass: 181 run, 54 ignored (live PostgreSQL and SSH) | `evidence/audit-rust/tool-output/test.txt` |
| `cargo audit` | 0 vulnerabilities, 6 allowed warnings (unmaintained transitive crates) | `evidence/audit-rust/tool-output/audit.txt`, `evidence/audit-sec/cargo-audit.txt` |
| `cargo deny check` | advisories, bans, licenses, sources ok; one stale ignore entry | reviewer 3 report |
| `cargo test -p tuplenest-driver-postgres --test live_pg -- --ignored` | 49 passed against PostgreSQL 18 | reviewer 2 report |
| `npx tsc --noEmit`, `npx eslint src` | pass | `evidence/audit-fe/tsc.txt`, `eslint.txt` |
| `npx vitest run --coverage` | 76 files, 2,047 tests pass; statements 97.39%, branches 92.02%, functions 97.31%, lines 98.70% | `evidence/audit-fe/vitest.txt` |
| `npm audit` in `apps/desktop` | 0 | reviewer 3 report |
| `npm audit` in `e2e` | 27 (test tooling only) | reviewer 3 report |
| Wide-result benchmark, 3 runs | 19.2–19.9 MB peak | `evidence/audit-rust/tool-output/bench_*.txt` |

## Evidence, by finding

| Finding | Evidence |
|---|---|
| TN-001 commit after an aborted transaction | `evidence/audit-pg/probe/src/main.rs` (suite `tx`), output `params_tx.out` |
| TN-002, TN-021, TN-022 row-edit target, truncation, aliased key | `evidence/audit-pg/fe/probe.test.ts`, output `fe.out` |
| TN-003 Explain runs a writing CTE; TN-004 formatter | `evidence/audit-fe/pure.audit.test.tsx` |
| TN-006, TN-007, TN-024 session identity, stale grid, typed BEGIN | `evidence/audit-fe/app.audit.test.tsx` |
| TN-009 read-only side effects; lost-session detection | `evidence/audit-pg/kill_ro.out` |
| TN-013 password redaction | `evidence/audit-sec/redact/main.rs` |
| TN-016 SSH hang; TN-017 memory after drop; all memory tables | `evidence/audit-rust/harness/src/main.rs` |
| TN-018 to TN-020 parameters, JSON, type rendering | `evidence/audit-pg/types.out`, `params_tx.out` |
| TN-025 failed modal chunk; grid focus | `evidence/audit-fe/lazy.audit.test.tsx`, `grid.audit.test.tsx` |

## Re-running the evidence

The scripts were written to run from outside the repository and refer to it by
absolute path, so they need their paths adjusted before they run again:

- **Rust harnesses** (`evidence/audit-rust/harness`, `evidence/audit-pg/probe`):
  point the `path = …` dependencies in `Cargo.toml` at this checkout's crates,
  create an empty PostgreSQL database, set `TUPLENEST_TEST_PG_DB` to its name,
  and `cargo run --release -- <suite>`. Suites are listed at the top of each
  `main.rs`.
- **Frontend probes** (`evidence/audit-fe/*.audit.test.tsx`,
  `evidence/audit-pg/fe/probe.test.ts`): each asserts the *correct* behaviour,
  so it fails while the finding is open. Run from `apps/desktop` with the
  scratch vitest config next to it, after fixing its `root`.

Each fix in REMEDIATION.md adds its own regression test to the normal suites,
so these probes are a record of what was observed, not something CI runs.

## What the audit could not establish

Listed in full under "Missing evidence" in REPORT.md. In short: nothing was
validated on Windows or Linux or on an Intel Mac; no installer was downloaded
or its signature checked; the updater has never run end to end; no TLS server
and no real SSH endpoint were exercised beyond one hang case; the 1 GB import,
large export and two-hour soak scenarios were not run.
