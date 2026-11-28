# Safety verification (phase 2)

Each guarantee below is checked against `main` as of 2026-11-28 and backed by an
automated test that fails if the guarantee breaks. Where a test already
covered it, it is cited rather than repeated; tests added on this branch are
marked *(new)*. Where a test shows the guarantee does **not** hold, the test
is kept but skipped (`#[ignore = "TN-0xx: …"]` or `it.skip("TN-0xx: …")`),
and the finding is listed at the end. Nothing is fixed here.

Paths are relative to the repository root. Rust tests are `file::module::name`;
TypeScript tests are `file › describe › test`. "Live" means it needs a
PostgreSQL server (`TUPLENEST_TEST_PG_*`) and is `#[ignore]`d like the others.

## Results

| Guarantee | Test(s) | How to reproduce | Status |
|---|---|---|---|
| **1. Guard asks before destructive or unbounded statements** (no WHERE, always-true WHERE, DROP, TRUNCATE, EXPLAIN ANALYZE of a write) | `apps/desktop/src/lib/sql.test.tsx › guard — phase 2 safety verification › asks on prod and staging…` *(new)*; `sql.test.tsx › needsGuard — bypasses the audit found`; `› guardReason — an always-true WHERE is not a WHERE`; `› guardReason — EXPLAIN ANALYZE runs the statement`; `apps/desktop/src/App.flows.test.tsx › App — the write guard › stops an unqualified DELETE against production`, `› sends nothing when the user backs out`; `hooks/useQuery.test.ts › useQuery — refusing to run › asks for confirmation before a prod UPDATE with no WHERE`; `hooks/useExplain.test.ts › refuses an explicit ANALYZE the guard would stop on a guarded connection`; Rust port: `apps/desktop/src-tauri/src/guard.rs::tests::*` | `cd apps/desktop && npx vitest run src/lib/sql.test.tsx -t "phase 2"` | **Holds on every connection** for the worst cases, and on prod and staging for the full list (since TN-034: `sql.test.tsx › TN-034: asks for confirmation on every connection…`, `App.flows.test.tsx › asks about a DELETE with no WHERE on dev too`); a DROP/TRUNCATE after `COMMIT;` in the same text can no longer run at all, since TN-032's fix (#115) |
| **1. …and on prod/staging the name is typed back** | `overlays/Overlays.test.tsx › Guard › asks for the name to be typed before %s runs`, `› does not enable on a near miss in case`; `sql.test.tsx › guardTarget — what has to be typed back on prod`; `App.flows.test.tsx › App — the write guard › runs it once the user confirms` | `npx vitest run src/overlays/Overlays.test.tsx -t Guard` | **Holds on prod and staging** (staging since TN-034). Tests: `sql.test.tsx › TN-034: wants the name typed on staging as well as prod`, `Overlays.test.tsx › asks for the name on staging too` |
| **2. Read-only is enforced by the database** (PostgreSQL) | `crates/driver-postgres/tests/live_pg.rs::read_only_refuses_writes_hidden_in_comments_ctes_and_mode_changes` *(new, live: checks `SHOW default_transaction_read_only` = on)*; `live_pg.rs::read_only_session_refuses_writes_at_the_server` | `cargo test -p tuplenest-driver-postgres --test live_pg -- --ignored read_only` | Holds |
| **2. Writes behind comments, CTEs, `DO`/`CALL`, `SET`/`RESET` of the setting, `BEGIN READ WRITE` are refused** (PostgreSQL) | `live_pg.rs::read_only_refuses_writes_hidden_in_comments_ctes_and_mode_changes` *(new: `/* */`, `--`, nested comments, writing CTEs, `EXPLAIN ANALYZE` of a writing CTE, `DO`, `CALL`, `RESET`, `SET … TO off/DEFAULT`, `SET SESSION CHARACTERISTICS … READ WRITE`, `BEGIN/START … READ WRITE`, `BEGIN; SET TRANSACTION READ WRITE`)*; `live_pg.rs::read_only_session_cannot_be_switched_back_to_read_write`; `::read_only_session_refuses_do_and_call`; `::read_only_session_sends_only_statements_that_read`; `crates/driver-postgres/src/lib.rs::tests::leading_words_skip_nested_and_unterminated_comments` | as above | **Holds since #115.** Before it, after a failed statement in a transaction, `COMMIT; BEGIN READ WRITE; DELETE …; COMMIT` wrote on a read-only profile (TN-032). Tests: `pg.rs::tests::a_read_only_session_cannot_write_through_the_commit_of_a_failed_transaction` (live), `live_pg.rs::read_only_session_cannot_write_behind_the_commit_of_a_failed_transaction` |
| **2. Read-only is enforced by the database** (SQLite: `SQLITE_OPEN_READ_ONLY` + `PRAGMA query_only`) | `crates/driver-sqlite/src/tests.rs::read_only_refuses_writes_behind_comments_ctes_and_transactions` *(new: checks `PRAGMA query_only` = 1; comments, CTE writes, `REPLACE`, `PRAGMA user_version = …`, a write after `BEGIN IMMEDIATE`)*; `::read_only_refuses_writes`; `::read_only_holds_after_query_only_is_switched_off`; `::read_only_refuses_writes_through_attach_and_vacuum_into`; `::several_statements_are_refused_not_half_run` | `cargo test -p tuplenest-driver-sqlite --lib read_only` | Holds |
| **3. A tab-owned transaction can't be committed from another tab** | `apps/desktop/src/App.handlers.test.tsx › App — one session, many tabs › refuses to commit from a tab that did not open the transaction, and says which did`, `› commits from the owning tab` | `npx vitest run src/App.handlers.test.tsx -t "has an owner"` | **Holds since #118**, for the buttons and for a typed `COMMIT`, `END`, `ROLLBACK` or `ABORT` (TN-035). Tests: `› TN-035: …` |
| **3. Commit after a server-side rollback doesn't report success** | `live_pg.rs::commit_of_a_failed_transaction_is_an_error_not_a_success`; `live_pg.rs::a_failed_commit_leaves_the_driver_agreeing_with_the_server`; `App.handlers.test.tsx › says nothing was committed when the server rolled the transaction back` | `cargo test -p tuplenest-driver-postgres --test live_pg -- --ignored commit` | Holds; the path no longer forwards the rest of the text (TN-032, #115) |
| **3. A typed `BEGIN` is noticed on disconnect** | `apps/desktop/src/App.session.test.tsx › App — a transaction opened by typing BEGIN › is asked about before Disconnect drops the session`; `live_pg.rs::server_in_transaction_sees_a_typed_begin`; `live_pg.rs::transaction_commands_follow_the_server_not_the_flag` | `npx vitest run src/App.session.test.tsx -t "typing BEGIN"` | Holds |
| **4. On prod/staging the audit row is written before the statement is sent** | `apps/desktop/src-tauri/src/pg.rs::audit_before_run_tests::the_row_is_there_when_the_call_returns`; `::every_statement_gets_its_own_row_in_order`; `pg.rs::tests::a_prod_session_is_audited_and_keeps_no_sql_in_history` *(new)*; `apps/desktop/src-tauri/src/mcp/tests.rs::prod_and_staging_statements_are_audited_before_they_run` (counts the audit rows at the moment each statement executes) | `cargo test -p tuplenest-desktop --bin tuplenest-desktop -- audit` | **Holds on prod and staging, in the window and through MCP** (staging in the window since TN-033). Test: `pg.rs::tests::a_staging_session_is_audited_before_it_runs`. Not testable here: the order inside the window's `run_query` (audit awaited before `execute`) needs a Tauri runtime; MCP's path, which is tested, shares `Store::audit_add` |
| **4. A failed audit write refuses the statement** | `pg.rs::audit_before_run_tests::a_store_that_cannot_be_used_refuses_the_statement`; `mcp/tests.rs::a_failed_audit_write_refuses_the_statement` (a trigger on `audit_log` makes the insert fail; nothing reaches the database) | `cargo test -p tuplenest-desktop --bin tuplenest-desktop -- refuses_the_statement` | Holds |
| **5. MCP: connections default to Off, indistinguishable from missing names** | `crates/workspace-store/src/lib.rs::tests::every_profile_starts_with_mcp_off`; `mcp/tests.rs::an_off_connection_is_invisible_and_unusable`; `::sqlite_is_off_by_default_like_any_profile`; `::switching_a_connection_off_takes_effect_on_the_next_call` | `cargo test -p tuplenest-desktop --bin tuplenest-desktop -- mcp::` | Holds |
| **5. MCP: Read-only can't write** | `mcp/tests.rs::read_only_opens_a_server_enforced_read_only_session`; `::live_read_only_reads_and_refuses_writes` (live); `::sqlite_read_only_access_refuses_writes_in_the_engine` | `cargo test -p tuplenest-desktop --bin tuplenest-desktop -- --ignored live_read_only` | Holds. TN-032 does not reach MCP: `COMMIT` and multiple statements are refused before anything is sent |
| **5. MCP: Read-and-write refuses anything the guard would ask about** | `mcp/tests.rs::read_write_refuses_what_the_guard_would_ask_about`; `::sqlite_read_write_still_refuses_what_the_guard_would_ask_about`; `::explain_never_runs_the_statement` | as above | Holds |
| **5. MCP: prod/staging/read-only profiles cap at Read only** | `workspace-store::tests::read_write_is_refused_for_prod_staging_and_read_only_profiles`; `::a_grant_drops_to_read_only_when_the_profile_becomes_prod`; `mcp/tests.rs::a_prod_profile_is_read_only_at_most`; `::a_profile_marked_read_only_in_the_app_stays_read_only`; `::sqlite_on_prod_is_read_only_and_audited_before_it_runs` | `cargo test -p tuplenest-workspace-store read_write` | Holds |
| **5. MCP: at most 500 rows or 1 MB per result** | `mcp/tests.rs::results_stop_at_the_row_cap_and_say_so`; `mcp/tests.rs::results_stop_at_the_byte_cap_and_say_so` *(new)* | `cargo test -p tuplenest-desktop --bin tuplenest-desktop -- results_stop_at` | Holds |
| **5. MCP: one statement per call** | `mcp/tests.rs::every_access_refuses_several_statements_and_transaction_control` | `cargo test -p tuplenest-desktop --bin tuplenest-desktop -- every_access` | Holds |
| **6. On prod, history stores no SQL text** | `mcp/tests.rs::history_records_the_mcp_client_and_hides_prod_sql`; `pg.rs::tests::a_prod_session_is_audited_and_keeps_no_sql_in_history` *(new; pins the input `record_history` reads)* | `cargo test -p tuplenest-desktop --bin tuplenest-desktop -- hides_prod_sql` | Holds. The window's `record_history` itself needs a Tauri runtime; its decision (`is_prod`) is tested |
| **6. `-- tuplenest:no-history` keeps a statement out of history** | `pg.rs::redact_sql_tests::no_history_directive_detected_case_insensitively`; `mcp/tests.rs::history_records_the_mcp_client_and_hides_prod_sql` (the directive leaves no row); `pg.rs::audit_before_run_tests::secrets_are_redacted_and_the_no_history_comment_does_not_silence_it` (it does not silence the audit log) | `cargo test -p tuplenest-desktop --bin tuplenest-desktop -- no_history` | Holds |
| **6. Passwords never reach logs or history** (TN-013 forms) | `pg.rs::redact_sql_tests::scrubs_the_whole_literal_however_it_is_quoted` (doubled quotes, `$$`, `$tag$`, `E''`, `U&''`, comments and nested comments before the literal, `ENCRYPTED PASSWORD`, `IDENTIFIED BY`, unterminated); `::scrubs_secrets_passed_to_crypto_functions`; `::keeps_the_statement_readable_around_the_literal`; `pg.rs::persisted_error_tests::keeps_title_sqlstate_category_but_drops_row_values`; `crates/telemetry/src/lib.rs::tests::no_secret_survives_a_redacted_dump`, `::redact_text_tests::*` | `cargo test -p tuplenest-desktop --bin tuplenest-desktop -- redact_sql` | Holds for the TN-013 forms. Also holds since #119 for a password set inside a `DO` block, function body, `EXECUTE` string or `format()` argument (TN-037). Tests: `pg.rs::redact_sql_tests::scrubs_a_password_set_from_inside_a_do_block`, `::scrubs_passwords_nested_in_literals` |
| **6. Live-only answers are not written to the on-disk metadata cache** (TN-012) | `pg.rs::cache_policy_tests::a_live_only_answer_is_neither_written_nor_read`; `::a_live_only_answer_already_on_disk_is_not_served`; `::every_request_is_one_or_the_other_and_the_purge_list_matches`; `::starting_up_removes_what_an_earlier_version_stored` | `cargo test -p tuplenest-desktop --bin tuplenest-desktop -- cache_policy` | Holds |
| **TN-016** SSH tunnel connect times out | `crates/ssh-core/src/lib.rs::open_timeout_tests::a_silent_server_is_given_up_on`; `::a_refused_connection_is_still_reported_as_refused`; `::the_limit_is_longer_than_the_postgres_connect_timeout`; `::the_limit_the_app_uses_is_bounded` *(new: `open_tunnel`'s limit is at most 30 s)* | `cargo test -p tuplenest-ssh-core --lib open_timeout` | Holds |
| **TN-026** Escape does not dismiss a running import | `apps/desktop/src/App.dismiss.test.tsx › App — Escape while the app is writing › does not close a running import when focus is outside the dialog`; `› still closes the import with Escape before anything is being written` | `npx vitest run src/App.dismiss.test.tsx -t Escape` | Holds |
| **TN-023** CSV import does not change or invent data | `apps/desktop/src/lib/csv.test.ts › CSV import integrity (TN-023)` (leading zeros, blank lines, unclosed quote, parser and `inferType` directly); `› beyond the rows the types are inferred from › infers from the first 500 rows, as the dialog does` *(new)*; `overlays/ImportModal.test.tsx › ImportModal — a file that cannot be imported faithfully` (non-UTF-8, UTF-16, cut-off character) | `npx vitest run src/lib/csv.test.ts -t TN-023` | **Holds since #117.** Before it, past the 500 rows types are inferred from, a later `007` in an `int8` column was stored as `7` (TN-036); now every row is checked and the import stops with the row number. Tests: `csv.test.ts › … › TN-036: …` |
| **TN-025** Load failures are surfaced | `apps/desktop/src/App.explorer.test.tsx › App — the catalog does not load › says why in the explorer, and Retry loads it`; `explorer/ExplorerTree.test.tsx › says why the schemas did not load and offers to try again`; `results/Grid.test.tsx › Grid — a page of rows that cannot be loaded › *`; `overlays/lazy.test.tsx › shows a dialog when its chunk cannot be loaded, and leaves the rest of the page alone`; `app-shell/ErrorBoundary.test.tsx › ErrorBoundary › *` (all induce the failure with mocks) | `npx vitest run src/App.explorer.test.tsx src/results/Grid.test.tsx src/overlays/lazy.test.tsx src/app-shell/ErrorBoundary.test.tsx` | Holds |
| **TN-007** switch between two profiles drops grid and staged edits | `apps/desktop/src/App.edits.test.tsx › App — nothing follows you to another connection › drops the grid and the staged edits when the titlebar switcher changes connection`; `› does not bring the old edit back when the same query is run on the new connection`; `› drops them when the form connects over a live session`; `hooks/useQuery.test.ts` (TN-007 epoch case) | `npx vitest run src/App.edits.test.tsx -t "another connection"` | Holds (switch dev → prod covered) |
| **TN-013** forms other than dollar-quoted `PASSWORD` | see guarantee 6, passwords | — | Holds for every TN-013 form; see TN-037 |
| **TN-021** `char(n)` and `bit(n)` | `live_pg.rs::a_row_edit_too_long_for_its_column_is_refused_not_truncated` (live: `varchar(5)`, `char(3)`, `bit(4)`, `bit varying(4)`, `varchar(3)[]`, too short for `bit(n)`); `apps/desktop/src/lib/dml.test.ts › castType — an edit is assigned, not truncated` | `cargo test -p tuplenest-driver-postgres --test live_pg -- --ignored too_long` | Holds |
| **TN-024** typed `BEGIN` on switch and update | `App.session.test.tsx › App — a transaction opened by typing BEGIN › is asked about before the connection switcher replaces the session`; `› holds an update back` | `npx vitest run src/App.session.test.tsx -t "typing BEGIN"` | Holds |

## Findings: guarantees that do not hold

Numbers continue from TN-031. All six are dealt with on `main`, each in its own pull request with its tests: TN-032, TN-035, TN-036 and TN-037 were fixed, TN-033 and TN-034 changed by decision (#123 and the guard pull request). The tests listed here run.

- **TN-032 (P1), fixed in #115. A read-only profile writes through the COMMIT of a failed
  transaction.** `PostgresSession::execute` sends a statement starting with
  `COMMIT`/`END` straight to `batch_execute` (simple-query protocol, every
  statement in the text runs) when the transaction has failed, before the
  read-only checks. Reproduce on a read-only profile: run `BEGIN`, then
  `SELECT 1/0`, then `COMMIT; BEGIN READ WRITE; DELETE FROM t; COMMIT`. The
  app reports "Nothing was committed"; the rows of `t` are gone. Test:
  `pg.rs::tests::a_read_only_session_cannot_write_through_the_commit_of_a_failed_transaction`
  (live) and `live_pg.rs::read_only_session_cannot_write_behind_the_commit_of_a_failed_transaction`.
  The fix sends that COMMIT through the extended protocol, which takes one
  statement, so `COMMIT; DROP TABLE t` can no longer run on any profile and
  the guard does not need to look past the first statement. MCP was not
  affected.
- **TN-033 (P2), changed in #123: staging is now audited from the window too. The window did not audit staging.** The audit log is written
  before the statement only for a session tagged prod. MCP audits staging; the
  window does not. README and PRIVACY.md describe it as prod-only, so this is
  the stated guarantee against the documented one. Reproduce: connect to a
  staging profile, run `SELECT 1`, open the audit log: no row. Test:
  `pg.rs::tests::a_staging_session_is_audited_before_it_runs`.
- **TN-034 (P2, design), changed: the guard now asks about the worst cases everywhere and wants the name on staging. It was narrower than stated.** It asks only
  on prod and staging, and asks for the name only on prod. Both are
  deliberate in the code and its tests (`does not second-guess the same
  statement on dev`, `asks for no typing on staging`). Reproduce: on a dev
  profile, run `DELETE FROM t`: it runs without a prompt; on staging, the
  prompt has no name box. Tests: `sql.test.tsx › TN-034: …` (two).
- **TN-035 (P2), fixed in #118. A typed `COMMIT` ignores the tab that owns the transaction.**
  Reproduce: Begin transaction in tab 1, open tab 2, type `COMMIT`, Run: tab
  1's work is committed. Tests: `App.handlers.test.tsx › TN-035: …` (seven).
- **TN-036 (P1, data), fixed in #117. CSV import changes values past the first 500 rows.**
  Types are inferred from the first 500 rows; later rows are cast to them, and
  PostgreSQL changes what fits loosely (`'007'::int8` is 7,
  `'2024-03-01 10:30'::date` is `2024-03-01`). Reproduce: import a file with
  500 rows of `7` and a 501st row `007`: the table held `7`. The import now
  checks every row and stops at the first that would change. Tests:
  `csv.test.ts › TN-036: …`, `ImportModal.test.tsx`.
- **TN-037 (P3), fixed in #119. A password set inside a `DO` block or function body is kept
  in history and the audit log.** Beyond TN-013's forms. Reproduce on a dev
  profile: `DO $$ BEGIN EXECUTE 'ALTER ROLE app PASSWORD ''x'''; END $$`; the
  history row holds `x`. Test:
  `pg.rs::redact_sql_tests::scrubs_a_password_set_from_inside_a_do_block`.

## Running the live tests

No test is skipped for a known failure any more. The app crate's live tests,
which CI does not run, need a local PostgreSQL:

```sh
cargo test -p tuplenest-desktop --bin tuplenest-desktop -- --ignored
```
