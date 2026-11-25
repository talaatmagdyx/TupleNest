# Remediation plan

For the findings in [REPORT.md](REPORT.md). Updated as work lands.

## Rules for every fix

1. One focused branch and pull request per independent issue. No bundling.
2. Revalidate the finding against the latest `main` before changing anything;
   if it no longer reproduces, record that and close it without a change.
3. A regression test that fails before the fix and passes after, plus negative
   and adversarial cases. Where the behaviour depends on PostgreSQL, a live
   integration test in `crates/driver-postgres/tests/live_pg.rs` (run by the
   contract-test jobs in CI on PostgreSQL 13, 15 and 17).
4. No new abstractions and no unrelated refactoring. Existing behaviour stays
   unless the change is the point of the fix and is called out.
5. Full gates before opening the pull request: `cargo fmt --check`, clippy
   with `-D warnings`, `cargo test --workspace`, `cargo deny check`, the live
   tests the change touches, `tsc`, eslint, and the whole vitest suite with
   coverage.
6. Each pull request states: root cause, exact code changes, regression tests,
   before and after evidence, remaining risks, gate results.
7. **No release is published** until every P1 below is merged and
   independently verified.

## Severity review

Four P2 findings were reviewed again for silent data corruption or credential
exposure, as a condition of starting remediation:

| Finding | Was | Now | Why |
|---|---|---|---|
| TN-007 stale grid after a profile switch | P2 | **P1** | Staged edits survive the switch and Apply would send them to the newly connected database: a write to the wrong database |
| TN-021 `varchar(n)` edits truncate silently | P2 | **P1** | Confirmed silent data corruption: the value is cut to fit and the edit reports one row updated |
| TN-022 aliased column taken for the primary key | P2 | P2, fixed with TN-002 | The old-value check usually turns it into a refusal; it shares TN-002's root cause (the target is inferred from names) and the same code |
| TN-013 password redaction misses common forms | P2 | P2, moved up | Credentials reach a file, but one that is 0600 inside a 0700 folder, and it needs the user to have typed the password into SQL. Scheduled directly after the P1s |

## Order

Data integrity and safety first, release engineering last.

| # | Finding | Branch | Status |
|---|---|---|---|
| 1 | TN-003 Explain can execute a writing statement | `fix/tn-003-explain-safety` | open: pull request 50 |
| 2 | TN-002 row edit written to the wrong schema, with TN-022 | `fix/tn-002-edit-target` | open: pull request 51 |
| 3 | TN-001 Commit reports success after a rollback | `fix/tn-001-commit-tag` | open: pull request 52 |
| 4 | TN-030 read-only profile runs `DO`/`CALL` behind a nested comment (new, see below) | `fix/tn-030-readonly-nested-comment` | open: pull request 53 |
| 5 | TN-004 Format SQL rewrites literals and quoted identifiers | `fix/tn-004-format-literals` | open: pull request 54 |
| 6 | TN-021 row edit truncates `varchar(n)`, `char(n)`, `bit(n)` | `fix/tn-021-edit-truncation` | planned |
| 7 | TN-007 result grid and staged edits survive a profile switch | `fix/tn-007-session-switch` | planned |
| 8 | TN-013 password redaction | `fix/tn-013-redaction` | planned |
| 9 | TN-005 release readiness and an end-to-end updater test | `release/…` | blocked on 1 to 7 |

Each pull request changes one thing, but several touch the same files
(`CHANGELOG.md`, `lib/sql.tsx` and its tests, the end of `live_pg.rs`), so
they merge one at a time, each rebased on the one before.

### TN-030, found during remediation

While fixing TN-001, a test for a `COMMIT` behind a nested comment failed, and
the cause turned out to be shared with the read-only check: the driver's
`leading_words` helper skipped a leading `/* … */` by stopping at the first
`*/`, and PostgreSQL nests block comments. On a read-only profile,
`/* a /* b */ c */ DO $$ … $$` was read as starting with `c`, so the refusal of
`DO` and `CALL` did not apply and the block ran; a `DO` block can commit,
switch the session to read-write and write. **P1, Confirmed** by the existing
live test with the nested-comment case added, which fails on `main`.

Then the remaining P2 findings in the order of REPORT.md section F, and the P3
findings after them.

## Intended fix for each P1

Each is confirmed or adjusted when the finding is revalidated.

- **TN-003.** ANALYZE defaults on only when the statement neither starts with
  nor contains a writing verb once literals and comments are masked, and the
  "this will really execute" warning uses the same test. Explain on a prod or
  staging connection goes through the same guard as Run when ANALYZE is on.
- **TN-002 / TN-022.** Before an edit is offered, ask the server which table
  the reference resolves to (`to_regclass`) and refuse editing when it is not
  the table the catalog lookup chose. Key and writable columns must be bare
  column references in the select list.
- **TN-021.** Cast edited values to the base type without its length modifier,
  so PostgreSQL's assignment rules reject an over-long value instead of
  cutting it.
- **TN-007.** One "session changed" step, used by connect, profile switch and
  disconnect, that drops the result, staged edits, chart and transaction flag.
- **TN-001.** `end_transaction("COMMIT")` reads the command tag and returns an
  error when PostgreSQL answered `ROLLBACK`.
- **TN-004.** The formatter rewrites only the code between string literals,
  comments and quoted identifiers.

## What "done" means for the scores

The scores in REPORT.md go up as findings close, but some evidence cannot be
produced from the repository alone, and no code change substitutes for it:

- Runtime checks on Windows, Linux and an Intel Mac.
- Code signing and notarization, which need paid certificates.
- A real update from one published version to the next.
- The long-running scenarios (1 GB import, two-hour soak).

Those stay listed as open until someone runs them and records the result here.
