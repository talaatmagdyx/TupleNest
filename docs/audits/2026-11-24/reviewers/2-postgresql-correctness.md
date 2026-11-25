The audit is complete: `tuplenest_audit_pg` is dropped and the repo working tree is untouched. HEAD moved from 5335453 to 63b9505 during the audit (not by me); the only difference is `.github/workflows/pages.yml`, so every file:line below still holds.

Paths below are relative to `/Users/talaatmagdyx/work_talaat/TupleNest`. Scratch artefacts are in `docs/audits/2026-11-24/evidence/audit-pg/`.

## (a) Commands and tests run

| What | Outcome |
|---|---|
| `TUPLENEST_TEST_PG_DB=tuplenest_audit_pg cargo test --offline -p tuplenest-driver-postgres --test live_pg -- --ignored` | 49 passed, 0 failed |
| Scratch crate `probe/` (depends on `driver-api` and `driver-postgres` by path), suites `types`, `params`, `tx`, `kill`, `ro`, `misc` against PostgreSQL 18.0 | All ran; outputs in `types.out`, `params_tx.out`, `kill_ro.out` |
| Scratch vitest file `fe/probe.test.ts` with its own config, importing the repo's `sql.tsx`, `dml.ts`, `csv.ts`, `nodes.ts` | 4 tests ran; output in `fe.out` |
| `psql` session: wrong-schema row edit, explicit-cast truncation, BC date and `24:00` references | Ran; results quoted below |

The ctx_shell allowlist refused `createdb` and `uptime`, so those and later commands ran through the native shell. Load average was about 113 during the run.

## (b) Findings

No P0. Three P1, re-checked against the code and kept.

### F1. Commit reports success when PostgreSQL rolled the transaction back
- **Category:** Transactions. **Severity:** P1. **Confidence:** Confirmed.
- **Where:** `crates/driver-postgres/src/lib.rs:416-438` (`end_transaction`), `:1266-1268`; `apps/desktop/src/App.tsx:910-912` (toast "COMMIT"), `:973-983` ("Committed & disconnected").
- **Evidence:** `begin()`, `INSERT INTO txt VALUES (1,'kept?')`, `SELECT 1/0` (22012), then `commit()` returned `Ok(())`; the table had 0 rows afterwards. Same result after cancelling `pg_sleep(20)` inside a transaction holding an uncommitted insert, and a statement timeout aborts the transaction the same way.
- **Expected vs actual:** expected Commit to fail or say "rolled back"; actual is a success toast, and the close-window path says "Committed & disconnected".
- **Impact:** the user believes work is committed when it is gone. A cancel or timeout as the last action before Commit is a realistic path. A typed `COMMIT` shows "0 row(s) affected" with the same blindness.
- **Root cause:** `COMMIT` on an aborted transaction returns command tag `ROLLBACK` with no error; `batch_execute` discards the tag.
- **Recommendation:** in `end_transaction("COMMIT")`, read the command tag via `simple_query` and return an error when it is `ROLLBACK`.
- **Verification test:** live test: begin, insert, failing statement, `commit()` must be `Err`.

### F2. Row edits can be written to a different schema than the one the grid read
- **Category:** Row editing. **Severity:** P1. **Confidence:** Confirmed for the SQL and its effect; the UI path itself is code evidence.
- **Where:** `apps/desktop/src/lib/dml.ts:162-171`; `apps/desktop/src/lib/nodes.ts:185-189` (`defaultSearchPath` returns `["public"]`); `apps/desktop/src/App.tsx:663`. Nothing in the app reads the server's `search_path`.
- **Reproduction:** `public.users` and `tenant_b.users` both hold id 1 with `status='active'`. With `SET search_path = tenant_b, public`, `SELECT id, name, status FROM users` shows Bob (tenant_b). The UPDATE `dml.ts` builds targets `"public"."users"`; executed, it returned `UPDATE 1`, changed Alice (public) to `suspended`, and left tenant_b untouched.
- **Impact:** a wrong-row write that passes the "exactly 1 row" check whenever the edited column's old value matches, which is common for status, flag and NULL columns. Triggers are a role- or database-level `search_path`, or a typed `SET search_path`. When `public` has no such table, the fallback at `dml.ts:163` picks the first schema whose columns happen to be loaded. The review dialog does show the qualified name.
- **Recommendation:** resolve the target on the server, for example `to_regclass` of the reference as written, or `current_schemas(true)` fetched per result. Refuse editing when it disagrees with the catalog.
- **Verification test:** live test with two same-named tables and a non-default `search_path`; the edit must refuse or hit the table that was read.

### F3. A result column aliased to the primary-key name is treated as the key
- **Category:** Row editing. **Severity:** P2. **Confidence:** Confirmed at function level.
- **Where:** `apps/desktop/src/lib/dml.ts:157-203` (columns matched by output name only).
- **Evidence:** `select parent_id as id, name from users` and `select id + 1 as id, name from users` both return `editable: true` with `pk` index 0. `select id, upper(name) as name` marks `name` writable.
- **Impact:** the UPDATE is keyed on another column's value. The old-value test usually turns this into a false "row changed" refusal, but it lands on the wrong row when values coincide. No row-delete path exists in the UI (`buildDelete` is unused), which limits it.
- **Recommendation:** require each key and writable column to be a bare column reference in the select list, or reject any `AS`/expression in it.

### F4. Row edits silently truncate values for `varchar(n)`, `char(n)` and `bit(n)`
- **Category:** Row editing. **Severity:** P2. **Confidence:** Confirmed.
- **Where:** `apps/desktop/src/lib/dml.ts:221-234` (`$n::text::<type>`).
- **Evidence:** `buildUpdate` emits `SET "name" = $1::text::character varying(5)`. Run through the driver with `'abcdefghij'`: 1 row affected, stored `abcde`. The same value with plain assignment fails with 22001 "value too long". `char(3)` and `bit(4)` truncated the same way.
- **Root cause:** an explicit cast truncates under SQL rules; assignment does not.
- **Recommendation:** cast to the unmodified base type (`::varchar`, `::bpchar`, `::bit varying`) and let assignment enforce the length.
- Related: `timestamp(3) with time zone` fails the `SAFE_TYPE` regex (`dml.ts:210`) and falls back to an untyped bind, which fails with "error serializing parameter". That is safe, but such columns cannot be edited.

### F5. Opening an empty-string cell and pressing Enter stages `'' → NULL`
- **Category:** Row editing. **Severity:** P2. **Confidence:** High-confidence (code; `coerceValue("", text) → null` executed).
- **Where:** `apps/desktop/src/results/Grid.tsx:379-393`; `apps/desktop/src/lib/dml.ts:85-87`.
- **Detail:** a draft of `""` or `"null"` (any case) becomes SQL NULL, so an unchanged `''` cell compares as changed. An empty string or the literal text `null` cannot be written at all. The review dialog shows the change.
- **Recommendation:** treat an unchanged draft as unchanged, and offer an explicit "set NULL" action instead of magic strings.

### F6. The destructive-statement guard: what it catches and misses
- **Category:** Safety. **Severity:** P2 (claim versus behaviour). **Confidence:** Confirmed.
- **Where:** `apps/desktop/src/lib/sql.tsx:113-193`; `apps/desktop/src/hooks/useQuery.ts:110`.
- **Scope:** armed only when the environment is `prod` or `staging`. On dev, test or untagged connections, `DROP TABLE users` and `DELETE FROM users` run with no prompt. The comment at `useQuery.ts:41` says only prod arms it; staging does too.
- **Caught (prod):** DELETE/UPDATE with no WHERE at their own nesting level, including inside CTEs, `PREPARE`, `EXPLAIN ANALYZE`, and behind a commented-out `-- where`; DROP, TRUNCATE, ALTER, CREATE, GRANT, REVOKE, REINDEX, VACUUM, CLUSTER; DO, CALL, MERGE; `COPY … FROM`.
- **Not caught (prod):**
  - `DELETE … WHERE true` / `WHERE 1=1` and any other always-true WHERE.
  - Every INSERT, including `INSERT … SELECT`.
  - `EXPLAIN ANALYZE DELETE … WHERE …`, which executes the delete.
  - `SELECT purge_all()`, `SELECT pg_terminate_backend(…)`, `SELECT lo_unlink(…)`, `SELECT setval(…)`, `SELECT dblink_exec(…)`.
  - `SELECT … INTO newtable`, `COPY … TO PROGRAM '…'`, `REFRESH MATERIALIZED VIEW`, `COMMENT`, `LOCK TABLE`, `EXECUTE p`, `REASSIGN OWNED`, `SET ROLE`.
- **False positives (safe direction):** `UPDATE t SET "where" = 1`, and a WHERE that exists only inside a subquery or dollar-quoted text.
- **Multi-statement input:** the editor sends the whole text as one extended-protocol statement, so `BEGIN; DROP TABLE p; COMMIT` and `SELECT 1; SELECT 2` are rejected by PostgreSQL with 42601. An embedded COMMIT cannot run. This is PostgreSQL-enforced, but it also means scripts cannot be run at all.
- **Recommendation:** the code comment ("seatbelt light, not the seatbelt") is honest; make the tagline and docs equally specific, and add INSERT…SELECT, `EXPLAIN ANALYZE <dml>` and SELECT INTO to the prompt list.

### F7. Read-only profiles block data writes but not side effects
- **Category:** Safety. **Severity:** P2. **Confidence:** Confirmed.
- **Where:** `crates/driver-postgres/src/lib.rs:440-466`, `:562-567`, `:614-637`.
- **Holds (all refused, table unchanged):**
  - INSERT, UPDATE, DELETE, TRUNCATE after each of `SET default_transaction_read_only = off`, `SET SESSION CHARACTERISTICS … READ WRITE`, `set_config(…)` and `RESET ALL`.
  - Writes inside `BEGIN READ WRITE`, `BEGIN` + `SET TRANSACTION READ WRITE`, `BEGIN` + `SET transaction_read_only = off`, and `COMMIT AND CHAIN`.
  - DO and CALL, including behind a leading comment.
  - Data-modifying CTEs, `nextval`, `EXPLAIN ANALYZE DELETE`, `SELECT INTO`, `CREATE TEMP TABLE AS`, `lo_create`, `SELECT FOR UPDATE`, and `EXECUTE` of a prepared INSERT.
- **Still allowed on a read-only profile:** `VACUUM`, `ANALYZE`, `REINDEX TABLE`, `CLUSTER`, `CHECKPOINT`, `NOTIFY`, `pg_advisory_lock`, `pg_stat_reset()`, and `pg_terminate_backend(pid)` (it killed a second session). As superuser, `COPY (SELECT 1) TO PROGRAM 'touch …'` created a file on the server host.
- **Root cause:** PostgreSQL's read-only transaction mode forbids table writes, not maintenance commands, admin functions or program execution.
- **Recommendation:** document read-only as "no data or DDL writes", recommend a least-privilege role, and optionally refuse VACUUM, REINDEX, CLUSTER, `COPY … PROGRAM` and the admin functions by first keyword as an extra layer.

### F8. Query parameters bind only to integer, float, boolean and text placeholders
- **Category:** Parameters. **Severity:** P2. **Confidence:** Confirmed.
- **Where:** `crates/driver-postgres/src/lib.rs:2411-2497`; `apps/desktop/src-tauri/src/pg.rs:742-757`; `apps/desktop/src/lib/sql.tsx:217-238`.
- **Evidence:** `WHERE n = $1` (numeric) fails with Int, Float or Text. `ts > $1`, `d = $1` and `u = $1` fail with Text. An Int against a text column fails. NULL binds only to text placeholders. `SELECT $1` with a number fails. All surface as "Driver error: error serializing parameter 0". Exact bigint text to `int8` works; out-of-range ints are rejected rather than wrapped.
- **`coerceParam` alters input:** `"007"` and `"00501"` become numbers; `"12345678901234567890.123456789"` becomes `12345678901234567000`; `""` and `"null"` become NULL.
- **`paramCount` miscounts:** it counts `$n` inside dollar-quoted bodies, quoted identifiers, block comments and names like `a$2`. `CREATE FUNCTION … AS $$ SELECT $1 + 1 $$` gets a parameter prompt and then fails with "expected 0 parameters but got 1", so such functions cannot be created from the editor.
- **Recommendation:** bind all parameters as text with unknown type so the server parses them like literals; count placeholders on `maskLiterals` output.

### F9. JSON values are altered before display and export
- **Category:** Type fidelity. **Severity:** P2. **Confidence:** Confirmed.
- **Where:** `crates/driver-postgres/src/lib.rs:2365-2370`; `apps/desktop/src-tauri/src/pg.rs:838`, `:1420`.
- **Evidence:** `json` `{"b":1,"a":2,"a":3}` renders `{"a":3,"b":1}` (keys reordered, duplicate dropped). `12345678901234567890123` renders `1.2345678901234568e+22` in both `json` and `jsonb`; `1.10` renders `1.1`; `1E2` renders `100.0`; a 25-digit decimal is cut to 17. psql returns the jsonb number exactly.
- **JSON null:** `'null'::jsonb` is written to the grid row as `null`, identical to SQL NULL. A jsonb string `"abc"` is indistinguishable from text `abc`.
- **Recommendation:** pass the wire text through unparsed for `json`, strip only the version byte for `jsonb`, and wrap JSON cells so a JSON `null` differs from SQL NULL.

### F10. Several common types render as hex or as a wrong value
- **Category:** Type fidelity. **Severity:** P2. **Confidence:** Confirmed.
- **Where:** `crates/driver-postgres/src/lib.rs:2324-2401`.
- **Wrong value:** `'24:00:00'::time` renders `00:00:00`. BC dates render as `-0043-03-15` for `0044-03-15 BC`, a notation PostgreSQL itself rejects on input.
- **Hex dump:** `interval` (including `now() - now()`), `timetz`, `infinity` timestamps and dates, dates beyond chrono's range, `money`, ranges, `macaddr`, `bit`, `point`, `regclass`, `pg_lsn`, `tsvector`, `numeric[]`, `date[]`, any multi-dimensional array. `void` renders `\x`.
- **Minor:** `float4` 0.1 shows `0.10000000149011612`; float arrays print `inf` where PostgreSQL prints `Infinity`; `timestamptz` is always shown in UTC.
- **Correct:** `int8` to the limits, `numeric` (30+30 digits, NaN, ±Infinity, trailing zeros), NULL versus `''` versus `'NULL'`, 1-D text arrays with quoting and NULL elements, uuid, bytea, enums, domains, xml, Unicode.
- **Recommendation:** ask the server for text format on types without a native decoder; that fixes every hex case and `24:00:00` at once.

### F11. CSV import accepts malformed or non-UTF-8 input and changes values without warning
- **Category:** CSV import. **Severity:** P2. **Confidence:** Confirmed for the parser/inference results, including the `TextDecoder` behaviour under Node; the insert-level consequences (all-NULL rows, dropped or padded fields) are code evidence — no end-to-end UI import was run.
- **Where:** `apps/desktop/src/lib/csv.ts:46-150`, `:164-189`, `:272-275`; `apps/desktop/src/overlays/ImportModal.tsx:36`.
- **Leading zeros:** columns `00501` and `0123456789` are inferred as `int8`, so the zeros are lost. The type is changeable in the dialog but that is the default.
- **Encoding:** a Latin-1 `José` imports as `Jos�`; a UTF-16 file imports as garbage columns. The decoder is non-fatal and nothing is reported.
- **Blank lines:** `a,b\n1,2\n\n3,4` yields a row `[""]`, which inserts as an all-NULL row.
- **Ragged rows:** short rows are padded with NULL, and extra fields are dropped (`r[ci] ?? ""`).
- **Bad quoting:** an unterminated quote swallows the rest of the file into one field; `"x"y` becomes `xy`. Neither is an error.
- **Carriage returns:** CR-only line endings collapse the file into the header; a bare CR inside an unquoted field is deleted.
- **Recommendation:** decode with `{fatal: true}` and detect a UTF-16 BOM; reject rows whose field count differs from the header; error on EOF inside quotes; skip blank lines; infer `text` for integers with leading zeros.

### F12. Disconnect and profile switch do not ask about a typed `BEGIN`
- **Category:** Transactions. **Severity:** P3. **Confidence:** High-confidence.
- **Where:** `apps/desktop/src/App.tsx:414-420`, `:457-460` check only the UI flag; the window-close handler at `:950-957` asks the server.
- **Related (Confirmed):** the Begin button while a typed `BEGIN` is open returns OK (PostgreSQL only warns), and one Rollback then discards both.
- **Recommendation:** use `serverInTransaction()` in both paths, as close already does.

### F13. A backend killed mid-query is not recognised as a lost session
- **Category:** Connection. **Severity:** P3. **Confidence:** Confirmed at driver level.
- **Where:** `crates/driver-postgres/src/lib.rs:2565`; `apps/desktop/src-tauri/src/pg.rs:1290`.
- **Evidence:** 57P01 maps to "Database error", not Network, and `is_broken()` was false immediately after. The next statement returns "Connection closed" and the session is then dropped. A kill while idle is detected at once.
- **Recommendation:** map SQLSTATE class 57P0x and 08 to Network.

### F14. Smaller items
- **Export, P3, High-confidence:** NULL and `''` both export as an empty unquoted CSV field (`apps/desktop/src-tauri/src/export.rs:124-126`, `:141-147`), while the importer distinguishes them, so `''` becomes NULL on a round trip.
- **Export, P3, Documentation:** row-cap truncation is disclosed in the grid header, status line and a toast, but not in the file. Cells over 1 MiB are exported with the marker text as if it were data.
- **Connection, Documentation:** there is no "require" mode. `prefer` uses TLS without verification and silently falls back to plaintext. `verify-ca` needs a CA file and ignores the hostname. `verify-full` is the default in both backend and form. No tested mode accepts any certificate while requiring TLS.
- **Connection, Potential:** through an SSH tunnel the driver connects to `127.0.0.1`, so `verify-full` checks the certificate against that name rather than the real host (`apps/desktop/src-tauri/src/pg.rs:664-672`). Not tested.
- **History, P3, Confirmed:** a statement timeout is recorded and shown as "Query cancelled" (`pg.rs:1296`, `lib.rs:2534`).

## (c) Safety claim → enforcement

| Claim | Enforced by |
|---|---|
| Read-only profile blocks data and DDL writes | PostgreSQL (`transaction_read_only`), re-asserted by the app before every statement; DO/CALL refused by app prefix check |
| Read-only profile has no side effects | Not enforced (VACUUM, REINDEX, CLUSTER, CHECKPOINT, `pg_terminate_backend`, `COPY TO PROGRAM`) |
| Prompt before destructive statements | App logic only, prod and staging only, pattern-based (F6) |
| Prompt on dev, test or untagged connections | Not enforced |
| UPDATE/DELETE without WHERE is stopped | App logic only; `WHERE true` passes |
| One statement per run, no embedded COMMIT | PostgreSQL (extended protocol rejects multiple commands) |
| Row edit touches exactly one row, unchanged since load | PostgreSQL affected-row count plus app-built WHERE; the target table is app-guessed (F2, F3) |
| Row edits and imports are all-or-nothing | PostgreSQL transaction or savepoint |
| App never commits or rolls back the user's own transaction | App logic, using server-reported state |
| Commit means committed | Not enforced (F1) |
| Statement timeout | PostgreSQL (`SET statement_timeout`); the user can change it |
| TLS verify modes never fall back to plaintext | Driver config (`SslMode::Require`) plus rustls verifier |
| SSH host key is verified | App (pinned fingerprint or known_hosts; unknown keys and host certificates fail closed) |
| CSV formula neutralisation | App logic (`export.rs`) |
| Prod SQL kept out of history, audit kept | App logic |

## (d) Strengths worth preserving

- **Read-only re-assertion:** `ensure_read_only` asks the server before every statement instead of filtering SQL text (`lib.rs:440-466`); none of the mode-flip attempts in F7 got a write through.
- **Server-truth transaction state:** `server_in_transaction` treats 25P02 as open (`lib.rs:385-403`). Import and row edits join a typed `BEGIN` through a savepoint and never end the user's transaction (`useRowEdits.ts:101-175`, `ImportModal.tsx:166-227`).
- **Optimistic concurrency:** the UPDATE carries old values with `IS NOT DISTINCT FROM` and the affected-row count must be 1 (`dml.ts:236-277`, `useRowEdits.ts:145-154`), backed by a live test.
- **Exact numerics:** `numeric` is decoded exactly with bounded allocation (`lib.rs:2010-2097`); `int8` past 2^53 travels as text (`pg.rs:812-817`); integer binds are range-checked (`lib.rs:2449-2457`).
- **Honest fallback:** unknown types show hex rather than a plausible wrong string (`lib.rs:2131-2204`). The right instinct, though F10 shows the cost.
- **Formula neutralisation:** covers `= + - @ TAB CR`, exempts plain numbers, and applies to headers too (`export.rs:160-197`).
- **Bind limits:** `batchRows` keeps inserts within 65,535 parameters; 32,768 and 65,535 binds both succeeded through the driver.
- **Import atomicity:** a new table is always created inside one transaction, and Cancel rolls back.
- **Transport:** `verify-full` by default, no plaintext fallback under verify modes, `verify-ca` restricted to the user's CA, and no accept-any SSH host-key policy (`tls.rs`, `ssh-core/src/lib.rs:43-100`).
- **Bounded results:** 20,000 rows / 128 MB / 1 MiB per cell, each disclosed in the grid.

## (e) Not validated

- **No UI run:** the Tauri app was never launched. Guard dialog, review modal, import dialog, close prompt and toasts were assessed from code and from function-level tests only.
- **TLS:** no TLS-enabled server was available. Mode behaviour comes from code and the repo's passing TLS tests; `prefer` falling back to plaintext and `verify-full` through a tunnel were not exercised.
- **SSH:** tunnel lifecycle and host-key rejection were not exercised.
- **Import edge cases:** import interrupted by app quit, partial file-read failure, and cancel mid-batch were reasoned from code (single transaction, so a server-side rollback), not run. Very large payloads per batch were not measured.
- **Result limits:** the 128 MB byte budget, behaviour when sorting a truncated result, and export of more than 20,000 rows were covered by code review and the repo's own unit tests, not run end-to-end.
- **Other gaps:** connection loss from a real network drop (only `pg_terminate_backend`), PostgreSQL versions other than 18.0, non-UTF-8 server encodings, extension types such as `citext` and `hstore`.
