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

| # | Finding | Pull request | Status | In the app |
|---|---|---|---|---|
| 1 | TN-003 Explain can execute a writing statement | 50 | merged | verified (Dev profile; the production block is not) |
| 2 | TN-002 row edit written to the wrong schema, with TN-022 | 51 | merged | verified |
| 3 | TN-001 Commit reports success after a rollback | 52 | merged | verified, button and typed `COMMIT` |
| 4 | TN-030 read-only profile runs `DO`/`CALL` behind a nested comment (new, see below) | 53 | merged | verified |
| 5 | TN-004 Format SQL rewrites literals and quoted identifiers | 54 | merged | verified |
| 6 | TN-021 row edit truncates `varchar(n)`, `char(n)`, `bit(n)` | 55 | merged | verified (`varchar(n)` only) |
| 7 | TN-007 result grid and staged edits survive a profile switch | 56 | merged | verified (disconnect and reconnect; not a switch between two profiles) |
| 8 | TN-013 password redaction | 57 | merged | verified (dollar-quoted `PASSWORD` only) |
| 9 | TN-016 SSH tunnel connect has no timeout | 59 | merged | **not verified** |
| 10 | TN-012 live-only answers written to the on-disk cache | 60 | merged | startup purge verified; the health panels were not opened |
| 11 | TN-024 typed `BEGIN` not noticed on disconnect, switch or update | 61 | merged | verified (disconnect only) |
| 12 | TN-026 Escape dismisses a running import | 62 | merged | **not verified** |
| 13 | TN-014, TN-015, TN-017 documentation that contradicted the code | 63 | merged | not applicable; the live site matches `main` |
| 14 | TN-028, TN-029 release SBOM and build instructions | 64 | merged | the documented build command produced the app used below; the SBOM step runs only in a release |
| 15 | TN-005 release readiness and an end-to-end updater test | — | not started; no release until the items under "Still to verify" are closed | — |

Every merged fix has a regression test that fails without it, and passed the
full gates and CI (including the PostgreSQL 13, 15 and 17 contract jobs)
before merging.

Still open: TN-006, TN-008 to TN-011, TN-018 to TN-020, TN-023, TN-025, TN-027
and the P3 list, in the order of REPORT.md section F. TN-010 (move the two
signing secrets into the `release` environment) is a repository-settings
change for the owner; the sentence in SECURITY.md is already corrected.

## Verification in a built app (2026-11-25)

**Build.** `main` at `aab2a3d` (the merge of pull request 64), release build,
macOS on Apple Silicon, built with `tauri build --bundles app` and the bundle
identifier overridden to `app.tuplenest.verify` so the copy kept its own data
folder. PostgreSQL 18.0 on localhost, a scratch database with one table
`accounts (id int primary key, owner text, balance int, code varchar(5))` in
`public` and an empty schema `other`. Driven by hand through the window. The
scratch database, the test role and the test data folder were removed
afterwards, so nothing below can be re-read from disk; it is a record of what
was seen.

**Method note.** Keystrokes sent to the SQL editor while the window was in the
background dropped characters, so each test statement was placed in the copy's
`query_history` table and loaded into the editor by clicking it in History.
The statements ran through the normal Run, Explain, Format and Review paths.

| Finding | Action | Seen |
|---|---|---|
| TN-003 | Explain on `WITH d AS (DELETE FROM accounts WHERE id = 3 RETURNING *) SELECT * FROM d` | ANALYZE unticked; `EXPLAIN (BUFFERS, FORMAT JSON)` sent; plan shown; row 3 still present |
| TN-004 | Format on a statement with runs of spaces inside a string, a quoted identifier, a block comment and a line comment | Keywords upper-cased and the statement re-broken; all four spans byte-for-byte as written, including a lower-case `from` inside the string |
| TN-021 | Edit `code` (`varchar(5)`) from `AAA` to `AAAtoolong`, apply | Statement casts to `character varying` with no length; refused with SQLSTATE 22001; table unchanged |
| TN-022 | `SELECT id AS key, owner FROM public.accounts` | Result is read-only |
| TN-002 | `SET search_path = other, public`; `SELECT * FROM accounts`; create `other.accounts` from another session; edit `owner`, apply | Statement carries `to_regclass('accounts') = to_regclass('"public"."accounts"')`; refused with the message naming the search path; neither table written |
| TN-007 | With an edit staged, disconnect, then reconnect | Result grid and pending-change bar gone on both |
| TN-001 | Begin transaction, `SELECT 1/0`, press Commit; then the same with typed `BEGIN` and typed `COMMIT` | Both: "Nothing was committed: the transaction had failed and was rolled back", the typed one with SQLSTATE 25P02 |
| TN-024 | Run a typed `BEGIN` (toolbar still offers "Begin transaction"), then Disconnect | "You have an open transaction" dialog with commit, rollback and stay |
| TN-013 | `CREATE ROLE … PASSWORD $pw$…$pw$` | History shows `$pw$[REDACTED]$pw$`; the password is in no row the app wrote and in no log file |
| TN-012 | Insert `top_queries`, `search` and `columns` rows into the cache, start the app | Log: "removed live-only entries stored by an earlier version", removed 2; `columns` kept. After the session the cache held only `schema`, `object`, `columns`, `routines`, `types`, `server` |
| TN-030 | Read-only profile; `/* outer /* inner */ still comment */ DO $$ BEGIN SET LOCAL transaction_read_only = off; UPDATE … END $$` | "DO blocks and CALL are refused on a read-only connection … Nothing was run."; row unchanged |

A separate check with a row lock held by another session showed the Review
dialog disables its buttons while the write waits and applies the edit once
the lock is released. That is not TN-026, which is about the import dialog.

### Still to verify

- **TN-016.** Needs a profile whose SSH host does not answer.
- **TN-026.** Needs a CSV import in flight, which needs the file picker.
- **TN-003 on production.** The guard on ANALYZE for a prod or staging profile.
- **TN-012, the write side.** Opening the server monitor and health panels and
  confirming nothing of theirs reaches the cache. The monitor did not open
  during this pass.
- **TN-021** for `char(n)` and `bit(n)`; **TN-013** for the other spellings;
  **TN-007** and **TN-024** for a switch between two profiles and for the
  update prompt.
- Everything on Windows, Linux and an Intel Mac.

### Observations, not yet triaged

Seen during the pass; none is a regression from the fixes above.

- A typed `COMMIT` that is refused (TN-001) is stored in history with status
  `cancelled`, not `error`.
- The renamed-key case (TN-022) shows "add the primary key (id) to the result
  to edit it" although `id` is in the result under another name. The more
  specific "renamed or computed" message did not appear.
- Escape did not close the Review changes dialog after a failed apply, though
  it closed the connection menu in the same session. Not established whether
  that is the app or the way the key was delivered to a background window.
- Disconnecting with an edit staged gives no warning that it will be dropped.

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
