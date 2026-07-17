# Changelog

Notable changes to TupleNest. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/).

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

[Unreleased]: https://github.com/talaatmagdyx/TupleNest/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/talaatmagdyx/TupleNest/releases/tag/v0.1.0
