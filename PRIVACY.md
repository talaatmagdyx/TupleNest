# Privacy

**Nothing you do in TupleNest leaves your computer.** There is no account, no
sign-in, no analytics endpoint, and no server run by this project. The app
talks to two things: the databases you point it at, and — once, at startup —
GitHub, to ask whether a newer release exists.

This document says where things are kept so you can go and look, or delete
them.

## What is stored, and where

`<data>` is the OS application-data directory: `~/Library/Application
Support/app.tuplenest.desktop` on macOS, `%APPDATA%\app.tuplenest.desktop` on
Windows, `~/.local/share/app.tuplenest.desktop` on Linux.

| What | Where | Notes |
|---|---|---|
| **Passwords** | OS keychain | Keychain / Credential Manager / Secret Service. Never in the files below — the SQLite table has no password column, only an opaque reference. |
| **Connection profiles** | `<data>` SQLite | Host, port, database, username, TLS mode, SSH settings. Not the password. |
| **Query history** | `<data>` SQLite | Newest 1,000. **On prod-tagged connections the SQL text is not recorded** — only timing, row counts, and status. On other environments the SQL is stored with a best-effort scrub of secret literals (`PASSWORD '…'`, `IDENTIFIED BY '…'`, `key=…`, connection-string URLs → `[REDACTED]`). Add a `-- tuplenest:no-history` comment to a statement to skip its history row entirely. When a query fails, only a reduced error is stored (title, SQLSTATE, category); the server's DETAIL/HINT — which can quote row values like `Key (email)=(…)` — is shown on screen but **not** written to disk. |
| **Production audit log** | `<data>` SQLite | Separate from history and deliberately the opposite trade: on prod-tagged connections the SQL is **retained in full** (secret literals still scrubbed) so there is a record of what was run against production. This is an accountability record: `-- tuplenest:no-history` does **not** suppress it. If you do not want it, do not tag the connection prod. |
| **Cached schema** | `<data>` SQLite | Table, column and index names, so the explorer works offline. Not row data. |
| **Snippets, layout, settings** | `<data>` SQLite | |
| **Crash reports** | `<data>/crashes/*.txt` | Written locally on a panic. **Never uploaded.** Timestamp, thread, source location, panic message. Delete them freely. |
| **Exports** | wherever you choose | CSV/JSON/Markdown go only where the save dialog puts them. |

Row data from your database is held **in memory only** while a result is on
screen, and is dropped when you run the next query or close the app. The one
place a stray value could otherwise reach disk — a database error whose DETAIL
quotes the offending row — is reduced before it is written to history, so the
persisted copy keeps the error's title, SQLSTATE and category but not the
value. The full detail still appears on screen for as long as the error is
shown.

The SQL redaction is **best-effort, not a guarantee.** It catches the common
secret shapes (`PASSWORD '…'`, `IDENTIFIED BY '…'`, `key=value`, connection
strings), but a novel phrasing could slip a secret through. For a statement you
know is sensitive, use `-- tuplenest:no-history` so it is never written at all,
or run it on a prod-tagged connection (which stores no history SQL). Do not
rely on redaction as a substitute for those.

## Telemetry

There is a telemetry toggle in Settings. It is **off by default and currently
collects nothing** — no code sends anything anywhere. It exists ahead of a
feature that does not yet exist. If that changes, it will be described here
first, it will stay opt-in, and it will never include query text or row data.

## The network

TupleNest makes exactly these connections:

1. **Your databases** — directly, or through an SSH tunnel you configured.
2. **`github.com`**, once at startup, to fetch `latest.json` and check for an
   update. This is an unauthenticated GET; GitHub will see your IP address, as
   any web request would. It does not include an install id or any identifier
   from this app. If the check fails, nothing happens and you are not nagged.
3. **Nothing else.** Following a link in the About box hands the URL to your
   browser and is the only other outbound traffic, and only if you click it.

## Deleting your data

- **Profiles, history, audit log, cache** — delete the `<data>` directory.
- **Passwords** — these are the keychain's, not ours; remove entries named
  `tn-secret-*` in Keychain Access, Credential Manager, or Seahorse. Deleting a
  profile in the app removes its keychain entry too.
- **Crash reports** — delete `<data>/crashes`.

Uninstalling the app does **not** remove the `<data>` directory or keychain
entries. That is deliberate — an uninstall that silently deleted your saved
connections would be worse — but it means the cleanup above is manual.

## Contact

Questions: <talaatmagdy75@gmail.com>. Security issues: see `SECURITY.md`.
