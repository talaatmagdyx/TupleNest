# Changelog

Notable changes to TupleNest. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

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

## [0.1.0] — unreleased

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

[0.1.0-beta.3]: https://github.com/talaatmagdyx/TupleNest/releases/tag/v0.1.0-beta.3
[0.1.0-beta.2]: https://github.com/talaatmagdyx/TupleNest/releases/tag/v0.1.0-beta.2
[0.1.0-beta.1]: https://github.com/talaatmagdyx/TupleNest/releases/tag/v0.1.0-beta.1
