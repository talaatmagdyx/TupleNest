# Changelog

Notable changes to TupleNest. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

From a second audit, which re-tested every fix in 0.1.1-beta.12 rather than
trusting it.

### Safety
- Escape no longer dismisses a running import. The dialog refused the key
  itself, but only when focus was inside it; with focus on the page — after a
  click on the backdrop — the app-wide handler closed the dialog and the
  inserts carried on with no progress and no Cancel (audit TN-026).
- Disconnect, the connection switcher and the updater ask the server whether
  a transaction is open. They went by the app's own flag, which follows only
  the Begin button, so a transaction opened by typing `BEGIN` was dropped with
  its uncommitted work and no prompt. Closing the window already asked (audit
  TN-024).
- Switching connection clears what the previous one put on screen. Only
  Disconnect did; after the titlebar switcher or Save & Connect over a live
  session, the previous database's rows stayed in the grid — dev rows under
  the PRODUCTION banner — and an edit staged against them could be reviewed
  and applied to the new database (audit TN-007).
- Explain no longer executes a statement that writes. ANALYZE was switched on
  for anything starting with `SELECT` or `WITH`, and EXPLAIN ANALYZE runs what
  it explains: `WITH gone AS (DELETE … RETURNING id) SELECT …` deleted the
  rows, and `SELECT … INTO t` created the table. The whole statement is read
  now, not its first word. With ANALYZE ticked by hand on a prod or staging
  connection, a statement Run would stop for is refused (audit TN-003).
- A row edit can no longer land in a table the grid never showed.
  `select … from users` reads whichever `users` the session's `search_path`
  finds first, while the edit's target schema was a guess from the catalog
  (always `public` when it exists). With two same-named tables the UPDATE
  changed a row of the wrong one and still reported one row updated. Every
  such UPDATE now asks the server, in the same statement, whether the name the
  query used still means the table being written, and matches nothing if not
  (audit TN-002).
- A column the query renamed or computed is no longer taken for a table
  column: `select parent_id as id …` is not editable, because that `id` is not
  the key, and `upper(email) as email` is read-only (audit TN-022).
- A read-only profile no longer runs a `DO` block or `CALL` hidden behind a
  nested comment. The check that refuses them skipped a leading `/* … */` by
  stopping at the first `*/`, but PostgreSQL nests block comments, so
  `/* a /* b */ c */ DO $$ … $$` was read as starting with `c` and ran — and a
  DO block can commit, switch the session to read-write and write. Found while
  fixing TN-001 (audit follow-up TN-030).
- **Read-only profiles refuse `DO` and `CALL`.** Either can commit partway
  through and switch the session back to read-write, so one pasted block could
  delete rows on a profile marked read-only. `SET TRANSACTION` works again on
  read-only profiles, and the statement after a mode change is no longer
  refused by mistake.
- **Nothing runs inside the app's own write.** Cmd+Enter during Apply or an
  import used to run inside that transaction — committed with it, or silently
  rolled back with it.

### Correctness
- A row edit too long for its column is refused instead of being cut to
  fit. Edited values were cast to the column's full type, and an explicit cast
  to `varchar(5)`, `char(3)` or `bit(4)` truncates without an error: the edit
  stored a shortened value and reported one row updated. The cast now drops
  the length, so PostgreSQL's own assignment check applies (audit TN-021).
- Commit no longer reports success when PostgreSQL rolled the transaction
  back. After a statement in a transaction fails, is cancelled or times out,
  `COMMIT` is answered with `ROLLBACK` and no error; the app showed "COMMIT"
  with the work gone. The Commit button, "Commit & disconnect" and a `COMMIT`
  or `END` typed in the editor now say that nothing was committed (audit
  TN-001).
- Format SQL no longer rewrites what is inside a string, a comment or a
  quoted name. `'made from scratch and love, order by mail'` came back with
  uppercase keywords and line breaks in it, trailing spaces inside a
  multi-line string were trimmed, and `"from"` became `"FROM"`, a different
  column; Format then Run wrote different data than was typed (audit TN-004).
- **Row editing works on uuid keys, timestamps, decimals and NULLs**, and stays
  exact: values are sent as text and cast to the column's type. Editing a
  bigint above 2^53 no longer writes a different number.
- Commit and Rollback end a transaction you began by typing `BEGIN`, and
  closing the window asks about it. An import inside your transaction says it
  still needs a commit.
- A lost connection is noticed by Begin, Commit, Apply and Import, not only Run.
- The grid, its rows and exports stay in step after edits, imports and failed
  EXPLAINs. Numeric columns sort exactly. JSON export keeps same-named columns;
  NaN and Infinity show as values; spreadsheet-safe CSV leaves negative numbers
  numeric.

### Security
- The privacy policy, the security page and the website no longer claim what
  the code does not do: result rows are not "memory only" (a large result
  spills to an unnamed temporary file), the update-signing key is not "held
  offline" (it is a GitHub Actions secret), new profiles are not read-only by
  default, and running a selection, filtering the grid and configurable
  retention do not exist yet (audit TN-014, TN-015).
- Live-only answers are no longer written to the on-disk schema cache. The
  Health panel's results — including `pg_stat_statements`, which holds the
  text of statements run by every application on the server — search terms,
  index usage, object sizes and server activity were all stored in
  `metadata-cache.db`, on production connections too, and served back when the
  live request failed. Only the shape of the database is cached now, and
  entries of the other kinds left by earlier versions are removed at startup
  (audit TN-012).
- Passwords in SQL are redacted in every spelling before the statement is
  stored in history or the production audit log. The redactor looked for the
  next quote character, so `PASSWORD 'it''s-secret'` left `s-secret` on disk,
  and `$$…$$`, `E'…'`, `U&'…'` and a comment before the literal were not
  recognised at all. Literals passed to `crypt`, `pgp_sym_encrypt` /
  `pgp_sym_decrypt`, `encrypt` / `decrypt` and `hmac` are redacted too (audit
  TN-013).
- A stored password is bound to how its profile connects (TLS mode, CA file,
  SSH hop), not only where; a profile's environment and read-only flag come
  from the profile.
- Secrets in JSON shapes are redacted; logs keep 14 days.

### Performance and reliability
- Connecting through an SSH tunnel gives up after 20 seconds. There was no
  limit on the SSH handshake, so a bastion that accepted the connection and
  then said nothing left Connect and Test waiting forever, with no way to
  cancel (audit TN-016).
- A result keeps at most 20,000 rows (was 50,000). With result cells now 24
  bytes instead of 48, peak memory for a 200-column result is 19 MB (was 30),
  and a first sort or chart is about 2.5 times faster.
- Rarely used screens (EXPLAIN, plans, import, health, monitor, search and
  others) load when first opened: the main script is 379 KB (was 470), and the
  separate italic font is gone.
- The production-connection glow pulses three times and then holds, instead
  of repainting the whole window every frame.
- Numeric and array cells are read with fewer temporary strings.
- Stored rows are compressed in 8 KB blocks and, past 16 MB, kept in an
  anonymous temporary file that the system deletes when the app closes or
  crashes. 200 columns × 50,000 rows: peak 98 → 30 MB.
- A result keeps at most 50,000 rows or 128 MB of row text (was 100,000 and
  256 MB); rows past that are still counted.
- After a result is dropped, the allocator is asked to hand its memory back
  to the system (macOS and Linux). Measured since: on macOS it mostly
  declines, so this is a request and not a bound; the result caps are what
  bound memory (audit TN-017).
- Read batches are cut at 4 MB instead of 8 MB.
- The explorer tree draws only the rows on screen (2,000 tables: about 14,000
  page nodes down to under 300). Rows are a uniform 24px.
- The SQL editor re-renders only the lines an edit changed.
- Copy puts the text on the clipboard from the backend; it no longer passes
  through the window.
- A new row-returning query frees the previous result at its first batch, not
  when it finishes, so two full results are not held at once.
- Rows are written to their stored text directly, and a JSON cell's parsed
  tree is dropped as soon as it is read (wide-result ingest 379 → 291 ms).
- Moving the selection re-renders only the rows that changed, and a cell being
  edited survives scrolling away and back.
- History and audit lists read through indexes; the history and metadata
  databases use a smaller page cache and a bounded WAL file. Schema version 7.
- Very wide results draw only the columns on screen (200 columns: about 12,000
  cell nodes down to about 1,500), and the grid keeps 1,000 rows near the
  viewport instead of 4,200.
- An open transaction no longer re-renders the whole window once a second; the
  status bar keeps its own clock.
- Less copying per cell while reading, sorting and exporting rows; numeric
  sorts skip collation. The async runtime uses 2 to 4 threads, not one per core.
- Release builds use thin LTO and one codegen unit.
- One query can no longer exceed the result budget many times over: batches are
  cut by size, and bytea/json cells over 1 MB are not decoded (600 × 1 MB bytea:
  882 → 296 MB). Rows past the cap are counted, not decoded.
- Disconnect cancels and gives up after three tries instead of waiting forever;
  connections use TCP keepalives and a connect timeout.
- Results are kept as compact JSON text, one allocation per row, and the
  memory budget counts what they really use. 200 columns × 100,000 rows: all
  rows kept at 183 MB peak, where 37,334 rows took 447 MB before.
- The grid keeps only the rows near what is on screen; scrolling a large
  result no longer copies all of it into the window.
- Sorting runs in the backend over the stored result, off the main thread,
  and the grid pages the sorted rows. It used to copy up to 50,000 rows into
  the window to sort them there, and refused past that; now every stored row
  sorts (100,000 wide rows: about 0.2 s the first time, then instant).
  Text sorts by the Unicode Collation Algorithm, as the window's own sort
  did: `émile` beside `emile` rather than after `z`, `straße` beside
  `strasse`, and every script in its proper order.
- The chart is summed in the backend over every stored row; only the bars
  reach the window. It used to copy up to 50,000 rows in, and chart only those.
- Export and Copy are formatted in the backend, which writes each page straight
  into the file; rows no longer pass through the window at all. The output is
  byte-for-byte what it was, formula neutralization included — and those rules
  now exist in one place.
- Query history is written off the async runtime, so a slow disk no longer
  delays the query's result.

### Accessibility
- The schema tree is one tab stop with arrow-key navigation; toasts are
  announced reliably.

## [0.1.1-beta.12] — 2026-11-23

A safety and correctness release, from an end-to-end audit. Several places
where the promise — *asks before it writes* — was stronger than the mechanism
now hold. **The version number now rises with every release** (betas 1–11 all
reported 0.1.0). Betas are still published as GitHub pre-releases, which the
updater never sees (it reads `releases/latest`), so **install this beta by
downloading it** — the app will not offer it.

### Safety

- **Applying row edits no longer runs the editor's current SQL.** The re-read
  after Apply re-ran whatever the editor held, with the production guard
  skipped — type `DELETE FROM users`, apply an unrelated edit, and it ran. It
  now re-runs the query behind the grid, guard intact.
- **Read-only profiles can no longer be switched back to read-write** from the
  editor (`SET SESSION CHARACTERISTICS … READ WRITE`,
  `default_transaction_read_only`, `RESET ALL`, `BEGIN READ WRITE`). The driver
  re-checks the server's transaction mode before every statement.
- **Import and row edits respect a transaction you began by typing `BEGIN`.**
  They used to issue their own BEGIN and then commit or roll back your work.
  They now ask the server and work inside a savepoint. A cancelled import no
  longer writes its last pending batch.
- **The destructive-statement guard checks each UPDATE/DELETE's own WHERE**, so
  a data-modifying CTE or a WHERE inside a subquery no longer disarms it; `DO`,
  `CALL`, `MERGE` and `COPY … FROM` now ask on production.

### Security

- **`verify-ca` trusts only the CA file you give it** (now required), never the
  OS trust store. With the hostname unchecked, any publicly trusted certificate
  for any domain used to pass.
- **A saved password only goes to the server its profile names.** Moving a
  profile to another host or user asks for the password again.
- Release workflow: no persisted git credentials, secrets passed through
  `env:`, and a `release` environment that can require approval before the
  signing key is reachable.

### Correctness

- Integer parameters are range-checked instead of wrapped (65537 bound to a
  `smallint` used to become 1); bigints beyond 2^53 are shown, exported and
  edited exactly instead of rounded.
- After a failed COMMIT, the transaction state follows the server instead of
  leaving Commit and Rollback both failing.
- CSV import: wide files (over 131 columns) and long duplicate headers no
  longer fail; a quoted `""` imports as an empty string and a bare empty field
  as NULL, as `COPY … CSV` reads them.
- Query history no longer crashes on some non-ASCII SQL, and redacts secrets in
  it reliably.
- Disconnect and reconnect cancel a running query instead of waiting for it;
  Cancel during a reconnect reaches the running query.
- One query at a time; a late result after a disconnect is discarded; Run and
  EXPLAIN wait for a running export.

### Performance

- The 256 MB result budget now holds for wide and NULL-heavy results (a
  200-column, 100k-row result peaked at 1.1 GB; now truncated at ~430 MB peak).
  `bytea` columns load ~20× faster. Rows past the cap are counted, not
  converted.

### Accessibility

- The schema explorer and grid sorting work from the keyboard; Import, Review
  changes and Schema intelligence are proper dialogs with focus trapping; toasts
  are announced to screen readers.

[0.1.1-beta.12]: https://github.com/talaatmagdyx/TupleNest/releases/tag/v0.1.1-beta.12

## [0.1.0-beta.11] — 2026-08-29

Exporting a large result no longer freezes the app, and the editor stops
fighting long queries.

Both came from using it rather than testing it: a wide `ANY(ARRAY[...])`
query that ran off the right edge of the editor, and an export that hung
the window long enough to look crashed.

### Fixed

- **Exporting a large result froze the app.** Every part of it happened
  on the main thread in one unbroken stretch — fetch every row the store
  holds (up to 100,000), walk every cell building one string, then hand
  that string to the backend. The format pass never yielded, so from the
  first row to the last the window could not paint or take a click, and
  the document existed roughly three times over at the peak: the row
  arrays, the finished string, and the copy the IPC bridge escaped to
  carry it.

  Exports now stream. The save panel opens *first*, then rows are
  written a page at a time, so the window stays alive, the progress is
  visible, and cancelling costs nothing. A failure or a cancel deletes
  the partial file — a truncated CSV opens, parses, and is missing rows
  with nothing on its face to say so, which is worse than no file.

- **A running export could not be stopped.** It now has a progress bar
  and a Cancel button of its own. Cancellation is checked between pages,
  never mid-write, so the file never ends with half a row in it.

- **Copying a large result froze it too.** The clipboard takes one
  string or nothing, so that path cannot stream; it is capped at 10,000
  rows instead, and the count says when it capped.

- **A row count could hide what an export left out.** It reported
  missing rows only when the *result store* had overflowed, so rows
  dropped by a format cap — Markdown stops at 1,000 — were not
  mentioned. It now compares what was written against the true total.

- **`HOT` on a node that cost 0.3 ms.** The plan panel's hot-spot badge
  was a cost ranking with no wall-clock floor, so a query that finished
  in a fraction of a millisecond still got a full-width red bar telling
  you to go and look at it. It now honours the same 1 ms floor the
  bottleneck flag has always had. With `ANALYZE` off there are no
  timings to floor against and cost stands alone, as before.

### Added

- **The editor wraps long lines.** A 300-character `ANY(ARRAY[...])` no
  longer runs off the right edge, and the line numbers stay with their
  lines when a line wraps to several rows.

- **Tab indents, Shift-Tab outdents.** Tab previously did nothing but
  move focus out of the editor, so there was no way to indent a block.
  Escape still arms the next Tab to move focus, so the editor is not a
  keyboard trap.

- **Enter keeps the indentation**, adds a level after an opening
  bracket, and pushes a waiting closer onto its own line.

- **Brackets and quotes auto-close**, wrap a selection, and step over a
  closer rather than doubling it — without splitting a word, so `don't`
  does not become `don''t`.

- **Planning time is a headline insight when it dominates.** On a
  partitioned table the planner can spend far longer choosing a plan
  than the executor spends running it. That ratio was sitting quietly in
  the stats list while every insight above it described the smaller
  half of the query.

### Changed

- `DriverError` is now boxed at the trait boundary. It is deliberately
  rich — category, title, explanation, SQLSTATE, the server's own
  message, a query range, suggested actions — which is what puts a real
  diagnosis on screen instead of "Database error", and also what made
  every `Result` in the driver carry ~150 bytes of error.

## [0.1.0-beta.10] — 2026-07-29

The plan reader stops asserting things that are not true.

All four of these were found by looking at one real plan — a `select *
… limit 1` over a partitioned table — not by any test. The tests passed
throughout, because they asserted the *shape* of the output rather than
whether it was correct. That is the lesson worth carrying: an analysis
tool can be fully covered and still be confidently wrong.

### Fixed

- **An index was recommended for queries with nothing to index.** Any
  `Seq Scan` earned "an index matching its filter could avoid the full
  scan", whether or not the node had a filter. On a bare `select * …
  limit 1` there is no `WHERE` clause, so that sends you looking for a
  predicate that does not exist. Three separate code paths emitted it;
  all three now check for a `Filter`, `Index Cond` or `Recheck Cond`, and
  where there is none they say the true thing instead — the scan reads
  the whole table and narrowing the query is the only lever.

- **Pruned partitions were scored for row-estimate accuracy.** A branch
  the executor never reached reports 0 actual rows because it was
  skipped, not because it looked and found nothing. Comparing an estimate
  against that gave every pruned partition an alarming `EST 100k× OFF`
  badge. There is no actual count to compare against, so no verdict is
  offered.

- **The stale-statistics advice was wrong under a `LIMIT`.** The planner
  estimates the whole set and is never asked for it, so the shortfall is
  arithmetic rather than staleness — yet the panel said "its statistics
  may be stale (try ANALYZE on its table)" and would have sent you to
  ANALYZE a perfectly healthy table. It now names the `LIMIT` as the
  cause and states that the discrepancy is expected.

- **Ratios are written at a readable magnitude** — `1.5M×` rather than
  `×1499292`. Whether the planner was 1,499,292× or 1.5M× out changes
  nothing about what you do next, and the extra digits are false
  precision you have to count before they mean anything.

### Notes

One of the tests covering the index advice had been passing for the wrong
reason: its fixture had no filter, so it was asserting the buggy
behaviour. It now carries one, which is what it always meant to test.

## [0.1.0-beta.9] — 2026-07-27

Three things that used to have a ceiling: the size of a file you could import,
the resolution of a plan comparison, and how far a schema diff got you.

### Added

- **CSV import streams the file instead of loading it.** Import read the whole
  file into one JavaScript string and then held every parsed row in component
  state, so it was bounded by RAM rather than by patience. The parser is now
  an incremental state machine: the obvious fix — split on newlines, parse each
  line — is wrong, because a quoted field may legally contain the delimiter, a
  newline, or both, so a read boundary can land inside a value. State is kept
  across chunks, and `parseCsv` is now that same machine fed a single chunk so
  the two cannot drift apart.

  Measured rather than asserted, on a 358 MB file of 6,000,001 rows: peak
  memory growth **15 MB** streaming, against heap exhaustion and a dead process
  on the old path.

  Because the row total is genuinely unknown until the file has been read, the
  UI stops claiming one — progress is percent-of-bytes, the preview says "first
  500 rows sampled", and the final count comes from what was actually inserted.
  Cancel now aborts a running import and rolls back, rather than only closing
  the dialog.

- **Plan comparison goes node by node.** It could tell you the query got 30%
  costlier and that a `Seq Scan` appeared, but not which node absorbed the
  time. Trees are now aligned and each node reports its own delta. Children
  pair by node type plus relation and index name; anything left over is
  reported as added or removed rather than force-matched to something it is
  not. Timings are excluded from the matching key — they are what is being
  compared, so they cannot also decide identity.

  Where two siblings look identical — an `Append` over matching partition scans
  — position is the only signal, and position is not evidence. Those pairs are
  labelled **ambiguous** rather than shown with the same confidence as the
  rest. Guessing silently there is exactly how the bottleneck badge landed on
  the wrong node in beta.5.

- **A schema diff can now write the migration.** Reviewable `ALTER` DDL, with
  three risk levels that mean something: *safe* (a new nullable column,
  dropping `NOT NULL`), *review* (a type change that rewrites the table under
  an `ACCESS EXCLUSIVE` lock, adding `NOT NULL`, a new table whose keys a
  column diff cannot know), and *destructive* — `DROP TABLE`, `DROP COLUMN` —
  which come back **already commented out**, so pasting the script whole cannot
  run them.

  TupleNest generates it and never executes it; there is no run button and
  there will not be one. Two places it declines to guess: a primary-key change
  needs the constraint's name, which a column diff does not carry, and a new
  table is only written out in full when the target's columns were loaded.

  Verified by round trip against a live PostgreSQL, taking the statements from
  the UI rather than writing them by hand: two schemas differing by an added
  column, a dropped column, a retyped column, an added table and a dropped
  table; the generated script applied to a copy of the left schema; the result
  re-diffed against the right. **Schemas are identical.**

  That round trip is the reason this entry is trustworthy and the earlier
  version of it was not. An earlier pass had claimed the same thing on the
  strength of statements assembled by hand, and it was wrong twice over — see
  *Fixed*.

### Fixed

- **The generated migration named the wrong schema.** A diff of `left → right`
  describes what *left* is missing, so its statements have to be addressed to
  left. They were addressed to right — the schema that already had the new
  column and never had the dropped one. Pasted and run, the script would have
  errored on the first `ADD COLUMN`. Every test covering the generator asserted
  the statement *kind* and none asserted the schema name, so all of them passed
  throughout. Found by applying the output to a real database.

- **An added `NOT NULL` column came back nullable**, because the column diff
  carried the type and not the nullability. The constraint is now a second,
  *review*-level statement rather than being folded into the `ADD COLUMN`:
  `ADD COLUMN ... NOT NULL` fails outright on a table that already has rows, so
  the honest form is add nullable, backfill, then `SET NOT NULL`. Found by the
  same round trip — it was the one difference left after applying the script.

- **An import left the explorer stuck on "Loading schemas…".** Finishing an
  import dropped the cached catalog without re-reading it, so the tree never
  came back and every schema picker in the app — Schema diff included — was
  empty until you reconnected.

- **"Compare schemas…" and "Compare EXPLAIN plans…" both opened on find-usages.**
  Three palette commands share one modal, and all three landed on its first
  pane regardless of which you picked.

- The suggested index statement no longer breaks mid-word (`CREATE INDEX ON o`
  / `rders`), and a duplicated character in an internal pattern that CodeQL
  flagged is gone. Neither changed behaviour; both were the shape a real
  mistake takes.

## [0.1.0-beta.8] — 2026-07-25

The plan analyzer stops describing the problem and writes the statement that
fixes it.

### Added

- **The plan analyzer now writes the index, not just the advice.** When a plan
  scans a table sequentially to apply a filter, or an already-indexed scan
  discards a lot of rows to a residual filter, the analyzer reads that filter's
  columns and produces a runnable `CREATE INDEX` statement with a copy button —
  equality columns first, then a single range column, the one ordering a btree
  can actually seek on. It stays silent where a plain composite index is the
  wrong answer rather than guessing: an `OR` between predicates, a cast on the
  column, a join condition, or an inequality. The heading is hedged on purpose —
  these are candidates to verify by re-running EXPLAIN after building them, not
  a promise the planner will use them, because the advisor reads the filter, not
  the table's data distribution.

- **Expression indexes for filters a plain column index can't serve.** When the
  filter tests a function of a column (`lower(email) = …`), the advisor emits
  the matching `CREATE INDEX ON t ((expression))`, preserving the expression
  exactly — down to a literal argument like the `'@'` in
  `split_part(email, '@', 2)` — because the planner uses an expression index
  only when it matches the query verbatim.

  `CREATE INDEX` rejects any expression that is not `IMMUTABLE`, and volatility
  belongs to the resolved overload rather than the name: `date_trunc('day', ts)`
  is immutable on a `timestamp` and stable on a `timestamptz`, because only the
  second has to ask what the session's time zone is. So the advisor reads the
  column's actual type — from the catalog the editor already loads for
  autocomplete — and decides. `booked_at::date` and `date_trunc('day', booked_at)`
  on a plain `timestamp` are offered; the identical filters on a `timestamptz`
  are not. With no catalog to hand (the paste-a-plan window has a plan but no
  connection) it falls back to offering only what is immutable whatever the
  types are.

  Both the cast table and the function list were generated by querying
  `pg_cast` and `pg_proc` rather than written from memory — which removed four
  names that look obviously pure: `date_trunc`, `to_char`, `concat`, and
  `length`, whose two-argument encoding form is stable.

  Every suggestion is verified end to end against a live PostgreSQL 18 on a
  600k-row table: build what the advisor proposes, re-run `EXPLAIN`, and confirm
  the planner actually abandons the sequential scan. 17 of 17 cases behave as
  designed — 1.9× to 1461× faster where an index is offered, silence where one
  cannot be built.

## [0.1.0-beta.7] — 2026-07-21

The editor works before you connect, and two controls a screen reader could
not name now have names.

### Fixed

- **Two controls a screen reader read as unlabelled now have names.** The
  command palette's search box announced only as "text box", and each query
  parameter field (`$1`, `$2`, …) had a visible label that was not tied to it,
  so a screen reader missed it and clicking the label did not focus the field.
  Both are fixed; an audit confirmed these were the only two controls in the
  app lacking an accessible name, and a stale note claiming the connection form
  was unlabelled — it is fully labelled — was corrected.

- **The SQL editor is usable before you connect.** It was disabled until a
  connection was up, which meant drafting a query, searching it with ⌘F,
  commenting it with ⌘/ or formatting it were all impossible in exactly the
  state where you would do them — including two features shipped one release
  earlier. Only running a query needs a server now; the Run button and the
  "Not connected" note already say so.

## [0.1.0-beta.6] — 2026-07-21

The editor grows the two things it was missing, and a safety feature that
existed but could not be switched on.

### Added

- **A query timeout you can actually set.** PostgreSQL's `statement_timeout`
  has been implemented in the driver since Phase 0, with a live test proving
  the server cancels a five-second sleep after 250 ms — but the value was
  hard-coded to 0 on the way through the app, so the feature existed and was
  unreachable. It is now a per-connection setting, in seconds, next to the
  read-only toggle.

  Empty or 0 still means no limit, which is PostgreSQL's own meaning and the
  right default for an IDE: a query that is *supposed* to take an hour is a
  normal thing to run here. It is worth setting on a production profile, where
  the alternative is noticing.

  This is the server's own timer, so it fires even if the app is busy, the
  webview is wedged, or you have walked away — which a client-side timeout
  cannot do.

- **Find and replace in the editor (⌘F).** Match count as you type, step with
  Enter or the arrows, Shift+Enter to go back, a case toggle, replace, and
  replace all. The needle is literal text rather than a regular expression:
  half the characters people search for in SQL — `(`, `)`, `.`, `*`, `$`, `[`
  — are regex syntax, so a pattern box would need escaping for the common case
  and serve the rare one.

- **Comment and uncomment lines with ⌘/.** Line comments rather than block
  comments, because PostgreSQL nests block comments and toggling those
  correctly means tracking depth. The marker goes in at the shallowest
  indentation in the selection so a block keeps its shape, a half-commented
  block comments fully rather than half-uncommenting, and a selection that
  started at a line start still covers whole lines afterwards.

### Changed

- **The keyboard shortcuts are described in one place now.** The key handler,
  the in-app cheatsheet and the website each kept their own list, and all three
  disagreed: the app bound ⌘⇧L, ⌘O, ⌘B and ⌘P while the cheatsheet — the screen
  whose whole job is saying which keys exist — mentioned none of them, and the
  website listed two that were never bound to anything. Press `?` and you now
  see all eleven, with the conditions attached to the two that have them.

  A test reads the handler's source and fails if it finds a key comparison of
  its own, because the failure that matters is not a wrong row in the table —
  it is a binding added somewhere else that the cheatsheet never hears about.

## [0.1.0-beta.5] — 2026-07-21

The plan reader tells the truth about what it was given.

### Fixed

- **A pasted plan and the same plan in `FORMAT JSON` now produce identical
  results.** Cross-validating against a second PostgreSQL major found five
  disagreements between the two, two of them structural. A `SubPlan`'s body was
  attaching to whichever node happened to precede it rather than to the node
  enclosing it — which moved its time to the wrong node and badged the wrong one
  as the bottleneck. A `CTE Scan` at the top of a plan was swallowed as if it
  were a `CTE` label. A `HashAggregate` that spilled to disk was never flagged
  at all on the JSON path — the one used for every query run inside the app —
  because the server files an aggregate's batch count under a different key than
  a hash node's. The text format also packs parallel-awareness, partial mode,
  join type and the write operation into the printed node name where JSON keeps
  each in its own field, so the same plan drew different node names depending on
  which format it arrived in.

### Added

- **A pasted plan that is only *part* of a plan now says so.** A fragment parses
  perfectly well, and that is the danger: the analysis looks exactly as
  confident as one from a whole plan while its percentages are measured against
  the wrong total. Two cases are detected — a paste whose top was cut off, and
  one that stops mid-line — and each is explained in terms of what it does to
  the numbers on screen. Orphaned nodes are no longer adopted into the first one
  either; inventing a parent hands it their time.
- The File menu reaches the plan analyser. It is the one feature that works with
  no connection at all, so it is also the one nobody thinks to look for in a
  sidebar built around a database. (macOS and Windows; the platform default has
  no File menu on Linux, and the rail and palette reach it everywhere.)

## [0.1.0-beta.4] — 2026-07-20

Query plans: understanding them, and analysing one you were sent.

### Added

- **Analyse a plan you paste — no connection, nothing leaves the machine.**
  TupleNest now reads PostgreSQL's *text* EXPLAIN output, the indented tree
  people actually copy out of psql, a ticket, or a colleague's message, as well
  as `FORMAT JSON`. It detects which as you type and runs the same analysis it
  runs on its own queries: self-time bottleneck, disk sorts, hash spills, rows
  read and discarded, disk-vs-cache reads, row misestimates, loop counts, and
  the JIT and trigger time that no plan node accounts for.

  The reason to build it is privacy, not convenience. The usual way to get a
  plan analysed is to paste it into a website — which hands a third party your
  table names, index names, filter conditions and sometimes literal values out
  of production. This does the same job locally, and works against a server this
  app is not allowed to connect to at all.

  Open it from the activity rail (the clipboard icon) or the command palette.
  It is deliberately available while disconnected, unlike the monitor and
  diagram beside it.

  The text parser was validated against the server itself: the same ten queries
  were captured as both `FORMAT TEXT` and `FORMAT JSON` from a live PostgreSQL
  18 — a parallel scan, an external-merge disk sort, a hash spill, a nested loop
  repeating 20,000 times, a never-executed branch, a CTE, a SubPlan/InitPlan, a
  trigger, a filter discarding rows, and a plain scan — then both parsed and
  compared. All ten agree on node count, tree depth, loops, rows, estimates,
  rows removed, blocks touched, temp blocks, flags, statistics and insights.

### Fixed

- **Hostnames, role names and key paths are no longer rewritten by macOS.**
  With "capitalize words automatically" on, a typed `postgres` became `Postgres`
  the moment the field lost focus. PostgreSQL role names are case-sensitive, so
  the connection then failed at the authentication stage and looked exactly like
  a wrong password — with nothing on screen to say the text had been edited
  after it was typed. Found by using the app, not by a test.
- **The statistics panel says why it is empty.** Choosing a non-JSON EXPLAIN
  format left a bare "—" where an explanation belonged.

### Changed

- **The status bar identifies the build it is running** — commit and build time,
  with a trailing `+` when built from a tree with uncommitted changes. An
  installed release and a local build are otherwise identical on screen, and
  telling them apart had already cost an afternoon of debugging a fix inside a
  window that could not have contained it.
- `CONTRIBUTING.md` gains a "Building a real .app locally" section: `tauri dev`
  serves the UI from a dev server and goes blank when that server stops, and
  `tauri build` refuses without a signing key because releases always ship
  updater artifacts. Both surprise a first-time clone.

- **Richer EXPLAIN ANALYZE plan view.** The plan now highlights the real
  bottleneck by *self-time* — a node's wall time minus its children's — rather
  than only the costliest sequential scan. That points at the busy node whatever
  its type: a sort, an index scan, or a table read.

  Self-time is computed carefully, which is where most plan viewers go wrong.
  A nested loop's inner side really does run once per outer row, so its loops
  are multiplied; but a node under a `Gather` reports one "loop" per parallel
  worker, and those run *at the same time*, so multiplying there would charge a
  leaf more milliseconds than the whole query took. Workers are divided back
  out, so the numbers add up to the execution time.

  Each node is checked for the things you would otherwise hunt for by eye, and
  badged when found:

  - rows read and then thrown away by a filter — the clearest "this wants an
    index" signal a plan can give
  - sorts that spilled to disk and hashes that spilled to multiple batches
  - blocks served from disk rather than cache, attributed to the node that
    actually read them (PostgreSQL reports buffers cumulatively, so a naive
    reading blames every parent of the scan)
  - row estimates that missed by 10× or more
  - nodes executed a very large number of times
  - nodes the executor never reached, labelled instead of left blank

  Time that no node accounts for is surfaced too: **JIT compilation** and
  **trigger** time both sit outside the plan tree, and a statement can spend
  most of its wall clock there. An ordered list of insights turns all of it into
  next steps — add an index, raise `work_mem`, run `ANALYZE`, reconsider the
  join.

  Verified against live PostgreSQL 18 across eight plans: parallel aggregate,
  a filter discarding 299,999 of 300,000 rows, a nested loop repeating 300,000
  times, an external-merge disk sort, a hash spill, a never-executed branch, and
  a trigger that took 8.2 ms of a 10.1 ms statement. JIT is covered by unit
  tests only — the server used for verification reports `jit=on` but is built
  without LLVM, so it never emits JIT timings.

### Changed

- Development dependencies modernised: React 19, Vite 8, ESLint 10, and the
  GitHub Actions group (including `tauri-action` v1, validated on a real
  four-platform release build). No user-facing behaviour change.

## [0.1.0-beta.3] — 2026-07-19

The security-review response: the release blockers (TLS, numeric DoS, CSV
injection) from PR 1, plus the data/local/desktop hardening from PR 2 & PR 3.

### Security — data, local and desktop hardening (PR 2 & PR 3)

- **On-disk stores, logs and crash reports are now owner-only.** The app-data
  directory is locked to `0700` and the SQLite DBs (and WAL/SHM) to `0600` on
  Unix, so another local user can no longer read connection profiles, history,
  the schema cache, or logs. (Windows relies on the user-profile ACL.)
- **Stored SQL is scrubbed of secret literals** (`PASSWORD '…'`,
  `IDENTIFIED BY '…'`, `key=…`, connection-string URLs), and a
  `-- tuplenest:no-history` comment skips a statement's history row entirely.
  Best-effort, documented as such in PRIVACY.md.
- **A single huge cell can no longer spike memory** — rendered values are
  capped at 1 MiB with a truncation marker, and `bytea`/unknown values are
  bounded before hex-encoding.
- **Keychain entries are no longer orphaned** on every Test/connect — a held
  reference is reused, and a tested credential is adopted on Save.
- **Exports go through a Rust command that owns the save dialog and the write**,
  so the WebView has no filesystem-write permission at all (the `fs` plugin was
  removed). CSP tightened with `object-src 'none'`, `base-uri 'none'`,
  `frame-ancestors 'none'`.
- **Auto-update anti-rollback floor** — the app refuses an update advertised
  below a compiled-in minimum; `docs/releasing.md` documents the residual
  (an unsigned version manifest; account/release integrity is the real anchor).
- **Release-build logging** caps chatty transport/crypto crates to `warn` so
  they cannot write connection detail to the on-disk log.
- **Deterministic fuzz** over the numeric and raw-value decoders (300k+ inputs)
  guards the malicious-server DoS surface.

### Security — release blockers from the security review (PR 1)

- **TLS is now actually required in the verify modes (CRITICAL).** The client
  never set `ssl_mode`, so it defaulted to `prefer` — a server or on-path
  attacker could strip TLS to plaintext even under `verify-full`, silently.
  `verify-ca`/`verify-full` now map to `require` and refuse plaintext; proven
  against a real `ssl=off` server with a negative control. The connection form
  also warns when `prefer` is chosen for a remote host.
- **A malicious server can no longer OOM the app via a `numeric` value (HIGH).**
  The wire `dscale` was read as a signed int and cast to a huge loop bound;
  it's now read unsigned and clamped, with digit/render-size ceilings, so a
  crafted value is a bounded error instead of a hang.
- **CSV export neutralizes spreadsheet formula injection (HIGH).** Cells that
  start with `= + - @` (or TAB/CR) are prefixed so Excel/Sheets/LibreOffice
  treat them as text, not formulas. On by default; a "Spreadsheet-safe CSV"
  toggle in the Export menu allows raw output.
- **All third-party GitHub Actions pinned to commit SHAs**, and CI runs with a
  least-privilege `contents: read` token — closing a supply-chain path to the
  release signing key.
- **Failed-query history no longer persists row values.** The server's DETAIL
  (which can quote a row, e.g. an email) is still shown on screen but only a
  reduced error — title, SQLSTATE, category — is written to disk, matching
  PRIVACY.md.

### Fixed

- **A failed query now shows the server's full report, not two words.** The
  driver collected the SQLSTATE, message, `DETAIL`, `HINT`, `CONTEXT` and the
  constraint/table names — and the IPC boundary flattened all of it to the
  short title, so an unmapped failure reached the screen as exactly
  "Database error". Reported by a beta user. The error box now shows the whole
  psql-style report (selectable, so it can be pasted into an issue); the
  status bar keeps the one-line title with the SQLSTATE. Proven against a
  live server: a `GENERATED ALWAYS` identity violation (SQLSTATE 428C9 —
  unmapped) now renders its message, Detail *and* Hint instead of nothing.

## [0.1.0-beta.2] — 2026-07-18

One real bug, found by the first macOS tester within an hour of beta.1 — which
is exactly what betas are for.

### Fixed

- **The window close button did nothing.** Not "didn't quit the app" — nothing:
  no close, no error, no log line. The close guard ends in
  `getCurrentWindow().destroy()`, and the Tauri capability file granted only
  `core:default`, which covers the read-only window commands and not
  `allow-destroy`. The ACL rejected the call and the rejection was swallowed
  inside `@tauri-apps/api`, so 1,600+ passing tests had nothing to say about
  it. One granted permission is the whole fix.
- The same missing permission silently broke the open-transaction close prompt:
  **"Commit & quit" and "Rollback & quit" could never actually quit.** Both
  paths are now verified against a live database, including that no
  transaction is left dangling server-side afterwards.

### Added

- A test that scans the frontend for every `getCurrentWindow()` call and
  asserts the capability file grants it — the class of gap (TypeScript call,
  JSON permission, nothing watching the seam) this bug lived in. Verified by
  removing the permission and watching it fail.

### Docs

- README rewritten: sixty-second quick start, the real keyboard map, an honest
  "what TupleNest is not (yet)" section, and the receipts behind the safety
  claims.
- Corrected what a Windows code-signing certificate actually buys: a standard
  (OV) cert does not stop the SmartScreen warning — reputation is per-file and
  resets each release; only EV skips the wait. The old text called it "the same
  funding problem as Apple notarization", which would have wasted money.
  `docs/releasing.md` now also carries Azure Artifact Signing's eligibility
  gate (orgs US/CA/EU/UK; individuals US/CA only).

Installers keep the `0.1.0` filenames — the app version is unchanged; the tag
is the release identity. If you have beta.1: download beta.2 and reinstall.
Auto-update cannot deliver this (pre-releases are never `latest`, so the
updater's check 404s by design).

## [0.1.0-beta.1] — 2026-07-18

First public release. The goal is not to prove the product is finished — it is
to put it in front of real users, because "is the UX intuitive" and "does it
work on your machine" are questions no test suite can answer. Please file
what you find: bugs and *feelings* alike (there is an issue template for each).

### Added since the review rounds

- Real `verify-ca` TLS mode: chain verified, hostname knowingly skipped — the
  mode SSH tunnels actually need. Previously it silently behaved as
  `verify-full`.
- Unknown column types are decoded from what the type *is*, never guessed from
  the bytes: enums render as labels, `money` as money or visibly-raw hex —
  never as a plausible wrong number.
- Explorer node ids are reversible: tables and schemas with dots, pipes or
  colons in their names no longer confuse the tree.
- Markdown export escapes cells completely (backslash before pipe), including
  headers, and survives multi-line values.
- The toast dismiss timer is cleared on unmount (was a setState-after-unmount).

### Known limitations, stated up front

- macOS builds are not notarized; Windows installers are unsigned. First launch
  needs one extra click. Funding problem, not a trust problem — see the README
  for the stronger check (`gh attestation verify`).
- CSV import reads the whole file into memory.
- The row cap counts rows and bytes, but 100k wide rows is still a lot of RAM.
- Nobody has lived with this yet. That is what you are for.

### Fixed — from the pre-launch review

Findings from a pre-release audit of the safety claims. Several were things the
app promised and did not do.

- **The open transaction now has an owner.** One PostgreSQL session serves every
  query tab, so a transaction opened in tab A was joined by tab B's statements —
  and pressing Commit in tab B committed tab A's uncommitted work. The
  transaction records the tab that opened it; committing or rolling back from
  anywhere else is refused and names the owner.
- **Row edits check what the server actually did.** `rowsAffected` came back from
  every write and was thrown away, so an `UPDATE` that matched zero rows —
  because another session had deleted the row — committed and reported "Applied
  1 statement". Each statement must now touch exactly one row or the whole set
  rolls back.
- **Row edits inside your own transaction use a savepoint.** Previously a failure
  on the second statement left the first applied inside your transaction, which
  we could not undo without discarding your unrelated work.
- **The destructive-statement guard no longer trusts raw text.** It matched
  `\bwhere\b` against unmasked SQL, so `DELETE FROM users -- where` — a
  commented-out `WHERE`, exactly the near-miss the guard exists for — disarmed
  it. It now masks comments and strings first, finds the real leading keyword
  past any comment, understands CTE-led `DELETE`/`UPDATE`, covers
  `DROP`/`TRUNCATE`/`ALTER`/`GRANT`, and guards staging as well as prod.
- **`maskLiterals` understands PostgreSQL.** Dollar-quoted strings (`$$ … $$`,
  `$tag$ … $tag$`) were not handled at all, so a function body split statements
  at its own semicolons and a lone apostrophe inside one swallowed the rest of
  the query. Nested block comments and `E''` backslash escapes are handled too.
- **Read-only profiles do something.** The flag was collected, carried into
  `ConnectionConfig`, and then hard-coded to `false`. Sessions now issue
  `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`, so refusal is
  PostgreSQL's job rather than ours to guess at. There is a toggle for it.
- **Terminating a backend asks first.** It was one unguarded click on any pid.
  The dialog names the pid, user, application and running query; on prod you
  type the pid to confirm.
- **Closing the window with an open transaction prompts.** Disconnect and
  profile-switch prompted; ⌘Q silently dropped the session and rolled back. The
  listener existed only in the test mock.
- **Generated and identity columns are read-only.** The catalog never read
  `attgenerated`/`attidentity`, so a `GENERATED ALWAYS AS … STORED` column was
  offered for editing and the write failed at the server.
- **The grid footer counts the real total.** It read "of 100,000" for a
  five-million-row result, turning the truncation cap into the answer.

### Added

- `SECURITY.md`, `PRIVACY.md`, this changelog.
- CI runs the contract tests against real PostgreSQL 13, 15 and 17, with TLS
  enabled. 24 tests — cancellation, the 100k-row streaming checksum, TLS
  fails-closed, read-only enforcement — were `#[ignore]`d and had never run in
  CI.
- Read-only connection profiles.

### Changed

- README claims corrected against the implementation: "never blow up memory"
  (the cap counts rows, not bytes), "can prove" (the editability check is
  syntactic), "only the macOS Keychain" (three platforms), "full RFC-4180"
  (BOM handling is not RFC-4180), and "tested cancellation" (now true — the
  tests run).

## [0.1.0] — planned (shipped so far as betas 1–11)

First public release. PostgreSQL only.

- Saved profiles with OS-keychain credentials, TLS (disabled/prefer/verify-ca/
  verify-full), SSH tunnels with host-key pinning.
- Schema explorer, streaming virtualized grid, SQL editor with formatting,
  parameter binding and schema-aware autocomplete.
- Staged row editing with a reviewed diff, transactions, query history and a
  production audit log.
- Activity/lock/database monitoring, backend cancel and terminate.
- ER diagrams, find-usages and rename, schema diff, EXPLAIN plan comparison.
- CSV import, SQL snippets, signed auto-update.

[0.1.0-beta.8]: https://github.com/talaatmagdyx/TupleNest/releases/tag/v0.1.0-beta.8
[0.1.0-beta.7]: https://github.com/talaatmagdyx/TupleNest/releases/tag/v0.1.0-beta.7
[0.1.0-beta.6]: https://github.com/talaatmagdyx/TupleNest/releases/tag/v0.1.0-beta.6
[0.1.0-beta.5]: https://github.com/talaatmagdyx/TupleNest/releases/tag/v0.1.0-beta.5
[0.1.0-beta.4]: https://github.com/talaatmagdyx/TupleNest/releases/tag/v0.1.0-beta.4
[0.1.0-beta.3]: https://github.com/talaatmagdyx/TupleNest/releases/tag/v0.1.0-beta.3
[0.1.0-beta.2]: https://github.com/talaatmagdyx/TupleNest/releases/tag/v0.1.0-beta.2
[0.1.0-beta.1]: https://github.com/talaatmagdyx/TupleNest/releases/tag/v0.1.0-beta.1
