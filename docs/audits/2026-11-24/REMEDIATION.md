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
| 15 | TN-006 title and status bars name the form, not the live session | 66 | merged | verified |
| 16 | TN-023 CSV import changes or invents data | 67 | merged | **not verified** (needs the file picker) |
| 17 | TN-019 json and jsonb values altered | 68 | merged | verified |
| 18 | TN-020 types rendered as hex | 69 | merged | verified |
| 19 | TN-025 load failures swallowed | 70 | merged | **not verified** (no failure could be induced) |
| 20 | TN-027 production audit row written late and its failure discarded | 71 | merged | verified, after TN-031; the refusal on a failed write was not exercised |
| 21 | TN-018 query parameters guessed and bound to four types only | 72 | merged | verified (`007` to a text column) |
| 22 | TN-009 read-only lets maintenance commands through | 73 | merged | verified (`VACUUM`) |
| 23 | TN-008 guard misses always-true WHERE and EXPLAIN ANALYZE | 74 | merged | verified |
| 24 | TN-031 two profiles for one database: the first one's tag wins (new, see below) | 75 | open | verified on its branch |
| 25 | Guard dialog and parameter prompt wording (found in verification) | 76 | open | verified on its branch |
| 26 | TN-011 signing key in the environment of the whole release build | — | not started: the release workflow cannot be tested without running a release build | — |
| 27 | TN-010 signing secrets not scoped to the `release` environment | — | repository-settings change for the owner | — |
| 28 | TN-005 release readiness and an end-to-end updater test | — | not started; no release until the items under "Still to verify" are closed | — |

Every merged fix has a regression test that fails without it, and passed the
full gates and CI (including the PostgreSQL 13, 15 and 17 contract jobs)
before merging.

Still open: TN-005, TN-010 and TN-011 (rows above), and the P3 list in
REPORT.md section F. Every other finding has a merged fix.

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

## Second verification pass (2026-11-25, later the same day)

**Build.** `main` at `f36b22e` (the merge of pull request 74), built and driven
the same way as the first pass, against a fresh scratch database holding one
table with `text`, `jsonb` and `json` columns. Three profiles for that one
database were written into the copy's own store: dev, prod, and dev read-only.
After TN-031 and the dialog wording were fixed, the copy was rebuilt from
`f034339` (the top of pull request 76) and the production and read-only checks
were repeated on it. Everything was removed afterwards.

| Finding | Action | Seen |
|---|---|---|
| TN-019 | `SELECT` a `jsonb` holding a 23-digit number and a `json` stored as `{"z":1,  "a":2, "a":3}`, plus a JSON `null` and a SQL NULL in each | The `json` cell keeps its spacing and both `a` keys; the inspector shows every digit of the number; JSON `null` and SQL NULL are drawn differently |
| TN-020 | One row of `interval`, `timetz`, `time '24:00:00'`, `date 'infinity'`, `int4range`, a two-dimensional `int4[]`, a `timestamp` with `.25`, a BC date | `1 year 2 mons -3…`, `10:30:00+02`, `24:00:00`, `infinity`, `[1,10)`, `{{1,2},{3,4}}`, `2024-01-15 10:30:00.25`; no hex |
| TN-006 | Connected to the dev profile, open the read-only profile's editor | Title bar and status bar still name the dev profile |
| TN-018 | `SELECT code, owner FROM accounts WHERE code = $1`, value `007` | One row: `007`, `alice` |
| TN-008 | On the prod profile: `DELETE FROM accounts WHERE 1=1`, then `EXPLAIN ANALYZE DELETE FROM accounts` | The confirmation dialog opens for both; cancelled; all three rows still present |
| TN-027 | On the prod profile: `SELECT 1/0` | Audit log holds `prod`, `SELECT 1/0`, although the statement failed; the history row has no SQL text |
| TN-009 | On the read-only profile: `VACUUM accounts` | "VACUUM is refused on a read-only connection … Nothing was run." |

### TN-031, found during this pass

The first attempt at the TN-027 check failed: under a window showing
PRODUCTION there was no audit row, and the history row held the SQL. The
backend decides a session's environment itself, from the saved profile the
connection matches, and with several matching profiles it took the first in
the list — here the dev one. **P1, Confirmed** in the built app and by a unit
test that fails on `main`. Fixed in pull request 75 by taking the most
protective tag among the matching profiles and the one asked for.

It leaves the opposite disagreement: a session opened from the dev-tagged
profile of such a pair is treated as production by the backend while the
window shows DEV and does not arm the statement guard. That errs on the
protective side for the audit log and history; it is not yet closed.

### Also found: dialog wording

The confirmation dialog said "Statement has no WHERE clause … this UPDATE will
affect every row" for every statement it was opened for, `DROP TABLE` and
`EXPLAIN ANALYZE DELETE` included. The parameter prompt still described the
type guessing TN-018 removed. Both corrected in pull request 76 and seen in
the rebuilt copy.

### Still to verify, added by this pass

- **TN-023** and **TN-026**: the CSV import, which needs the file picker.
- **TN-025**: a failed schema load, a failed page of rows, a dialog that
  cannot load. None could be induced by hand.
- **TN-027**: the refusal when the audit row cannot be written.
- **TN-009**: the monitor's cancel and terminate on a read-only profile.
- **TN-018** for placeholder types other than text; **TN-020** for ranges of
  timestamps, multiranges and `money` staying raw.

## What "done" means for the scores

The scores in REPORT.md go up as findings close, but some evidence cannot be
produced from the repository alone, and no code change substitutes for it:

- Runtime checks on Windows, Linux and an Intel Mac.
- Code signing and notarization, which need paid certificates.
- A real update from one published version to the next.
- The long-running scenarios (1 GB import, two-hour soak).

Those stay listed as open until someone runs them and records the result here.
