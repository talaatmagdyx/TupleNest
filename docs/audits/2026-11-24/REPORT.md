# TupleNest audit report

**Verdict: BETA READY WITH CONDITIONS.** The audit found no critical (P0) issues and five high-severity (P1) ones. Memory and resource handling are sound and measured. What blocks broader adoption is three data-correctness defects, a published build that is three months behind `main`, and docs that claim more than the code does.

**Scope and method**
- Commit `5335453` on `main`. `main` later moved to `63b9505`, which changes only the Pages workflow.
- Five independent reviewers read the source. A second pass then re-checked every P1 and the main P2s against the code, GitHub settings or Postgres.
- Nothing in the repo or on GitHub was modified, and the disposable databases were dropped.
- Each reviewer's full report is in `reviewers/`; their scripts, logs and raw outputs are in `evidence/`. See `README.md` for the environment, commands and results.
- Environment: macOS 26.6 on Apple M4 Pro (12 cores, 24 GB), rustc 1.96.1, PostgreSQL 18.0, Node 23.9. The Mac was under heavy load from an unrelated virtual machine (load average 15–181), so timings are noisy; memory figures were stable.

## A. Executive summary

Scoring: 10 means no known P1 or P2 and complete evidence. Each confirmed P1 costs about 1.5 points, each cluster of P2s about 1, and missing evidence about 1.

| Area | Score | Basis |
|---|---|---|
| Engineering (Rust) | 8 | All five cargo checks pass, clean dependency direction, no deadlock path found, no P1 |
| Security | 7 | No P0/P1; fail-closed TLS and SSH; signing-key custody and two false privacy claims |
| Memory efficiency | 8 | Measured: at most 58 MB on hostile inputs, 4–7 MB on million-row queries, no leak over 100 cycles |
| Performance | 6 | Benchmarks exist but timings were unreliable under load; a truncated query still streams every row |
| Reliability | 6 | Commit can falsely report success; SSH connect can hang forever; errors swallowed in several UI paths |
| Open-source readiness | 5 | Good policies and CI; stale release, zero issues, no architecture doc |
| Contributor experience | 6 | Tests run without infrastructure; toolchain mismatches give opaque failures |
| Public release readiness | 4 | Newest published build lacks fixes the changelog describes; updater has never run |

## B. Verified findings

### High severity (P1): all re-checked in the second pass

**TN-001 — Commit reports success after PostgreSQL rolled the transaction back**
- Category: Correctness. Confidence: Confirmed.
- Location: `crates/driver-postgres/src/lib.rs:416-438` (`end_transaction`); `apps/desktop/src/App.tsx:910-912`, `973-983`.
- Reproduction: begin, insert a row, run a failing statement (or cancel one, or hit the statement timeout), then Commit. Expected: an error or "rolled back". Actual: a "COMMIT" toast, and the table has 0 rows. Reproduced again in `psql` in the second pass.
- Root cause: `COMMIT` on an aborted transaction returns the tag `ROLLBACK` without an error, and the driver discards the tag.
- Fix: read the command tag and return an error when it is `ROLLBACK`.
- Verification: a live test where `commit()` must return an error after a failed statement.

**TN-002 — Row edits can be written to a different schema than the grid read**
- Category: Data integrity. Confidence: Confirmed for the generated SQL and its effect (reviewer ran it); the UI path is code evidence.
- Location: `apps/desktop/src/lib/dml.ts:162-171`; `apps/desktop/src/lib/nodes.ts:185-189`.
- Reproduction: two tables named `users`, in `public` and `tenant_b`, with `search_path = tenant_b, public`. The grid shows `tenant_b.users`; the edit's UPDATE targets `"public"."users"` and changed the wrong row with "1 row affected".
- Root cause: the target schema is guessed (always `public` when it exists); nothing reads the server's `search_path`.
- Fix: resolve the table on the server (for example `to_regclass`) and refuse the edit when it disagrees.

**TN-003 — "Explain" executes a data-modifying CTE for real**
- Category: Safety. Confidence: Confirmed.
- Location: `apps/desktop/src/hooks/useExplain.ts:86`; `lib/sql.tsx:212-214`; `lib/explain.ts:49-53`.
- Reproduction: `WITH gone AS (DELETE FROM users RETURNING id) SELECT count(*) FROM gone`, then click Explain. The app sends `EXPLAIN (ANALYZE, …)`, which runs the delete. The production guard is not on this path. A read-only profile does block it.
- Root cause: both classifiers look only at the first keyword.
- Fix: turn ANALYZE off when the masked SQL contains a write verb, reusing the guard's CTE logic.

**TN-004 — Format SQL rewrites string literals and quoted identifiers**
- Category: Correctness. Confidence: Confirmed.
- Location: `apps/desktop/src/lib/sql.tsx:200-210`.
- Reproduction: `'made from scratch and love, order by mail'` becomes a string with uppercase keywords and line breaks inside it; `"from"` becomes `"FROM"`. Format followed by Run then writes different data or reads a different column.
- Fix: format only the code between literals, comments and quoted identifiers. The existing tests contain no literal at all.

**TN-005 — The published build lacks safety fixes the changelog describes**
- Category: Release. Confidence: Confirmed.
- Evidence: the newest published release is beta.11 (Aug 29). beta.12 has been a draft since Nov 23, and `main` is 42 commits past beta.11. `releases/latest` returns 404 because every release is a prerelease, so no installed copy is ever told about an update.
- Impact: anyone downloading today gets a build whose known guard and read-only holes are listed in the public changelog. The beta.12 draft itself still lets `DO`/`CALL` write on a read-only profile.
- Fix: don't publish the beta.12 draft; tag and publish a new beta from `main`, and test one real update first.

### Medium severity (P2)

| ID | Finding | Location | Confidence |
|---|---|---|---|
| TN-006 | Title bar and status bar name the profile in the connection form, not the live session. Downgraded from P1 because the environment pill and production banner are correct | `App.tsx:1449`, `1508-1512` | Confirmed |
| TN-007 | Switching profile keeps the previous database's result grid, and staged edits could be applied to the new database | `App.tsx:454-490` | Confirmed |
| TN-008 | The write guard is armed only on connections tagged prod or staging; new profiles default to dev with read-only off. On prod it misses `WHERE true`, all `INSERT`s, `EXPLAIN ANALYZE <write>`, and side-effecting functions | `lib/sql.tsx:129-193`; `useConnectionForm.ts:8,11` | Confirmed |
| TN-009 | Read-only profiles block data and DDL writes (every bypass attempt failed) but still allow `VACUUM`, `REINDEX`, `CHECKPOINT`, `pg_terminate_backend`, and `COPY … TO PROGRAM` as superuser | `driver-postgres/src/lib.rs:440-466` | Confirmed |
| TN-010 | Signing key and passphrase are repository-level secrets, readable by any workflow without the `release` approval. `SECURITY.md:96` says the key is "held offline", which is false | `gh secret list`; `release.yml:39-43` | Confirmed |
| TN-011 | The signing key is in the environment of the whole release build, so any dependency's build script could read it | `release.yml:224-231` | High-confidence |
| TN-012 | Health-panel data (`pg_stat_statements` text) and search terms are written to the on-disk cache, on production too. the second pass found those entry types in a real cache file (types counted, contents not read) | `pg.rs:1667-1705`, `1729` | Confirmed |
| TN-013 | Password redaction in saved SQL misses `$$…$$`, `E'…'`, doubled quotes and a comment before the literal; on production the statement always reaches the audit log | `pg.rs:1079-1116` | Confirmed |
| TN-014 | Docs say result rows are "in memory only", but large results spill unencrypted to a temp file. The spill arrived in pull request 46 without a docs update. Reviewers rated it P1 and P3; settled at P2 | `PRIVACY.md:31`; `docs/site/security.html:145` | Confirmed |
| TN-015 | The website advertises things the code doesn't do: read-only by default, run selected text, grid filter, configurable retention and settings | `docs/site/index.html:89,129,183`; `docs.html` | Confirmed |
| TN-016 | Opening an SSH tunnel has no timeout: against a silent host, Connect was still pending after 45 s with no cancel path | `crates/ssh-core/src/lib.rs:132-148` | Confirmed |
| TN-017 | Freed result memory was not returned to the system in the test harness, though the comments in `trim.rs` and the changelog say it is. Not a leak (bounded at 58 MB); the real app was not measured | `apps/desktop/src-tauri/src/trim.rs` | Confirmed (harness) |
| TN-018 | Query parameters bind only to integer, float, boolean and text placeholders; `"007"` becomes a number and large decimals lose digits | `driver-postgres/src/lib.rs:2411-2497`; `lib/sql.tsx:217-238` | Confirmed |
| TN-019 | JSON values are altered: keys reordered, duplicates dropped, large numbers rounded; JSON `null` looks like SQL NULL | `driver-postgres/src/lib.rs:2365-2370` | Confirmed |
| TN-020 | `interval`, `timetz`, `money`, ranges, infinity timestamps and multi-dimensional arrays render as hex; `24:00:00` renders as `00:00:00` | `driver-postgres/src/lib.rs:2324-2401` | Confirmed |
| TN-021 | Row edits silently truncate values for `varchar(n)`, `char(n)` and `bit(n)` | `lib/dml.ts:221-234` | Confirmed |
| TN-022 | A column aliased to the primary-key name is treated as the key | `lib/dml.ts:157-203` | Confirmed |
| TN-023 | CSV import: leading zeros lost, non-UTF-8 input accepted silently, blank lines become all-NULL rows, an unterminated quote swallows the rest of the file | `lib/csv.ts:46-189` | Confirmed (parser) |
| TN-024 | A typed `BEGIN` is invisible to disconnect, profile switch and update install; only window-close asks the server | `App.tsx:414-420`, `457-460` | Confirmed |
| TN-025 | Errors are swallowed in several paths: explorer load failure shows "Loading…" forever, grid page failures show placeholders, and a failed modal chunk blanks the whole window (no error boundary) | `App.tsx:379-387`; `Grid.tsx:319-334`; `overlays/lazy.tsx` | Confirmed |
| TN-026 | A running import can be dismissed with Escape when focus is outside the dialog | `App.tsx:1328-1333` | Confirmed (jsdom) |
| TN-027 | Production audit rows are written after the statement finishes, and write failures are discarded silently | `pg.rs:1158-1232` | High-confidence |
| TN-028 | The release SBOM set omits the desktop app crate | `release.yml:331` (`-maxdepth 3`) | Confirmed |
| TN-029 | Build-from-source instructions need a signing key only CI has; three different install commands across docs | `README.md:368-373` | High-confidence |

### Lower severity (P3), in brief
- A killed backend is not recognised as a lost connection until the next statement.
- A statement timeout is recorded as "cancelled".
- `row_limit` and `timeout_ms` are accepted and ignored, so a truncated million-row query streams every row (8–25 s).
- Keychain entries from tested-but-unsaved passwords are never removed.
- SSH supports only unencrypted key files.
- Release assets are mutable.
- `e2e/` has 27 known npm vulnerabilities (test-only).
- A stale `cargo deny` ignore entry.
- Accessibility gaps: most dialogs unnamed, tabs and menus without roles, no announcement of query results, light-theme contrast below AA.
- Grid loses keyboard focus after End on wide results.
- Stale numbers in docs and comments.
- Two roadmaps that contradict each other.

### Withdrawn or downgraded in the second pass
- **TN-006:** P1 → P2 (mitigated by the correct environment display).
- **TN-014:** reviewers disagreed (P1 vs P3); settled at P2.
- **TN-015:** P1 → P2 (documentation, no data risk).
- **"Sync commands run on the main thread":** kept as Potential only; not validated in the running app.

## C. Memory and performance report

Measured through the real driver against PostgreSQL 18, release builds, three runs each:

| Scenario | Stored / seen | Peak memory | After drop |
|---|---|---|---|
| Idle app, not connected (measured in the running app before the audit) | — | 105 MB total, of which backend 29 MB | — |
| 100,000 narrow rows | 20,000 / 100,000 | 3.7–3.9 MB | 3.5 MB |
| 1,000,000 narrow rows | 20,000 / 1,000,000 | 3.8 MB | 3.6 MB |
| 1,000,000 rows × 50 columns | 20,000 / 1,000,000 | 6.4–6.5 MB | 4.7–5.3 MB |
| Mixed: long strings, Unicode, NULLs, jsonb, 2 MB bytea | 20,000 / 20,000 | 16.3–16.5 MB | 15.4–15.7 MB |
| 1 MB incompressible text × 300 | 134 / 300 | 40.7–46.0 MB | 23–37 MB |
| 900 KB random bytea × 200 | 74 / 200 | 58.2 MB | 43.0 MB |
| 100 sequential queries | — | no growth (5.8 → 6.4 MB) | 16 → 16 file descriptors |
| 100 connect/disconnect cycles | — | 2.1 → 2.7 MB | 0 sessions left on the server |

- **Backend baseline:** 2.1 MB connected, in the test harness.
- **Wide benchmark** (200 columns): 19.2–19.9 MB peak, first sort 43–114 ms.
- **Cancel:** a streaming 50-million-row query cancelled in 815 ms and the session was reusable.
- **Spill:** read back intact; with the temp directory missing, the store fell back to memory with no data lost.
- **In the app** (measured before the audit): 150 MB connected and idle, 205–229 MB across 15 big-query runs, no leak, idle CPU about zero.

**Gaps:**
- No 1 GB CSV import, large export or 2-hour soak was run.
- No JavaScript-heap breakdown and no p50/p95 latencies.
- The harness used a replica of the app's row sink.

## D. Security threat model

| Adversary | Controls in place | Residual risk |
|---|---|---|
| Malicious database server | No `innerHTML` or `eval` anywhere; identifiers quoted; values bound; row, byte and cell caps; CSV formula neutralisation | Plaintext-auth downgrade in `prefer` mode; TN-012 |
| Malicious SSH endpoint | Fails closed: pinned fingerprint or known_hosts only, no trust-on-first-use | TN-016 hang; loopback port reachable by local processes |
| Compromised update host | Payload signature checked against a compiled-in key; update is user-initiated | Can serve an old signed build; mutable assets |
| Malicious contribution or dependency | Actions pinned to commits; read-only default token; `cargo deny`; required checks | TN-010, TN-011; zero required approvals |
| Untrusted imported file | Parsed in the page with no file access; values bound | Memory use on a huge file; TN-023 |
| Local attacker (other OS user) | Data folder 0700, files 0600 (verified); passwords only in the keychain | Windows relies on profile permissions; same-user is out of scope |

**What the WebView can do if compromised:**
- It can run any SQL on the connected database.
- It can read history and the audit log.
- It can connect to any host.
- It cannot read or write arbitrary files, run shell commands, or retrieve a stored password.

## E. Open-source readiness

| Item | Status |
|---|---|
| Licence, CODE_OF_CONDUCT, SECURITY, CONTRIBUTING, PR template, visible CI, versioning policy, screenshots, quick start | Pass |
| README clarity (430 lines, install at line 207), install instructions, issue templates, changelog, roadmap, support policy, Dependabot, discussions (enabled, empty) | Partial |
| Demo video, release notes for beta.11/12, first issues (zero issues ever), architecture doc | Fail |
| Windows and Linux runtime behaviour, macOS Intel, installers, updater end to end | Not verified |

**Platform evidence:**
- Linux `.deb` is the best verified: a full automated run of the shipped artifact.
- Windows `.msi` only confirms that a window opens.
- macOS bundles are never launched in CI.
- The stated "macOS 10.15+" is probably wrong given the CSS features used.

**Positioning:** the tagline "asks before it writes" holds only on connections you tag prod or staging, and only for a narrow class of statements (TN-008). Competitor comparisons came from the reviewer's memory, not current documentation, so they are left out as unverified. The clearest differentiators found in the code are server-enforced read-only that is re-checked per statement, reviewed row edits, and the plan analyser.

## F. Remediation roadmap

- **Before broader adoption:** TN-001 to TN-005, TN-008 (at minimum, wording that matches what is enforced), TN-010, TN-014, TN-015.
- **Before stable 1.0:** TN-006, TN-007, TN-011, TN-012, TN-013, TN-016, TN-018 to TN-024, an error boundary (TN-025), and one real end-to-end update test.
- **Next 30 days:** TN-026 to TN-029; the accessibility names and roles; a stateful fake backend for tests; the ignored live test added to CI.
- **Next 90 days:** property tests for the formatter, CSV parser, guard and formula neutralisation; e2e on pull requests; PostgreSQL 14/16/18 in the matrix; an architecture doc.
- **Long term:** run selection and multi-statement scripts, persisted tabs, grid filter, signing and notarization.

## G. Quick wins
- Read the `COMMIT` reply tag (TN-001).
- Wrap the SSH connect in a timeout (TN-016).
- Move the two secrets into the `release` environment and fix the "held offline" sentence (TN-010).
- Correct `PRIVACY.md` and the site's false lines (TN-014, TN-015).
- Change `-maxdepth 3` to `4` (TN-028).
- Ask the server about an open transaction in the three paths that don't (TN-024).
- Block Escape while an import is writing (TN-026).

## H. Strengths to preserve
- **Read-only enforcement:** the app asks the server before every statement; none of the mode-flip attempts got a write through.
- **Row edits:** old values in the WHERE clause, exactly one row must be affected, and a savepoint inside the user's own transaction.
- **Bounded results at two levels:** batches capped by rows and bytes, and a store capped by rows and bytes.
- **Export:** the page never names a file path.
- **Trust defaults:** TLS `verify-full` by default with no plaintext fallback; SSH with no accept-any.
- **Cancel:** independent of the session lock, with a bounded wait on disconnect.
- **Exact numerics:** exact `numeric` decoding, and `int8` past 2^53 sent as text.
- **Supply chain:** commit-pinned actions and required checks.
- **Honest docs:** "known, not a vulnerability" and honest-limits sections.

## I. Missing evidence
- **The running app:** real WebView focus and undo behaviour, IPC copies, and whether freed memory returns.
- **Transport:** TLS against a live TLS server; SSH beyond the hang case.
- **Large-scale runs:** 1 GB import, large export, 2-hour soak.
- **Platforms:** Windows, Linux and macOS Intel at runtime; installers and their signatures.
- **Updater:** never exercised end to end.
- **Benchmarks:** the README's import and index-advisor numbers have no script in the repo.
- **Other:** competitor capabilities; PostgreSQL versions other than 18.

## J. Final verdict: BETA READY WITH CONDITIONS

- **Why it is not "not ready":** the core is sound and measured, with bounded memory, no leaks, fail-closed transport and server-enforced read-only.
- **Why it is not ready for broader adoption:** a safety-positioned tool currently has a Commit that can lie (TN-001), an edit that can hit the wrong table (TN-002), a plan button that can delete rows (TN-003), a formatter that changes data (TN-004), and a published build that predates its own documented fixes (TN-005).
