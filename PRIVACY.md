# Privacy

**Nothing you do in TupleNest leaves your computer, except to the databases you
connect to, one update check, and — only if you set it up and then ask it
something — the assistant's model.** There is no account, no sign-in, no
analytics endpoint, and no server run by this project. The app talks to the
databases you point it at, and — once, at startup — GitHub, to ask whether a
newer release exists. That check sends no data about you or your work, and it
currently cannot be turned off. The assistant is off until you add a provider
in Settings › Assistant; what it sends, and when, is spelled out under
[The assistant](#the-assistant). The MCP server, for AI tools you run
yourself, is off for every connection until you turn it on; see
[The MCP server](#the-mcp-server).

This document says where things are kept so you can go and look, or delete
them.

## What is stored, and where

`<data>` is the OS application-data directory: `~/Library/Application
Support/app.tuplenest.desktop` on macOS, `%APPDATA%\app.tuplenest.desktop` on
Windows, `~/.local/share/app.tuplenest.desktop` on Linux.

| What | Where | Notes |
|---|---|---|
| **Anthropic API key** (if you add one) | OS keychain | Stored the same way as database passwords: the value in the keychain, an opaque `tn-secret-*` reference in the SQLite settings. The window never receives the key or the reference back. Removing the provider in Settings › Assistant deletes the keychain entry. |
| **Assistant settings** | `<data>` SQLite | Whether Ollama is on, its URL, whether a non-local Ollama is allowed, whether Ollama cloud models are allowed, the default model. **Assistant conversations are not stored** — they live in the panel until you clear it or close the app. |
| **Passwords and SSH key passphrases** | OS keychain | Keychain / Credential Manager / Secret Service. Never in the files below — the SQLite table has no password or passphrase column, only opaque references. |
| **Connection profiles** | `<data>` SQLite | Host, port, database, username, TLS mode, SSH settings (including the key file's path, not the key). Not the password or the key's passphrase. |
| **Query history** | `<data>` SQLite | Newest 1,000. **On prod-tagged connections the SQL text is not recorded** — only timing, row counts, and status. On other environments the SQL is stored with a best-effort scrub of secret literals (`PASSWORD '…'`, `IDENTIFIED BY '…'`, `key=…`, connection-string URLs → `[REDACTED]`). Add a `-- tuplenest:no-history` comment to a statement to skip its history row entirely. When a query fails, only a reduced error is stored (title, SQLSTATE, category); the server's DETAIL/HINT — which can quote row values like `Key (email)=(…)` — is shown on screen but **not** written to disk. |
| **Production audit log** | `<data>` SQLite | Separate from history and deliberately the opposite trade: on prod-tagged connections the SQL is **retained in full** (secret literals still scrubbed) so there is a record of what was run against production. This is an accountability record: `-- tuplenest:no-history` does **not** suppress it. If you do not want it, do not tag the connection prod. Each row is written before its statement is sent, so it records what was submitted, including statements that then failed or were cut off; if the row cannot be written, the statement is not sent. |
| **Cached schema** | `<data>` SQLite | The shape of the database, so the explorer works offline: schema, table, column, constraint, type and routine names, with what describes them (column types and defaults, comments, enum labels, partition bounds). Not row data, and not query text: health figures, server activity, index usage, object sizes and search terms are live-only and are never stored. |
| **Snippets, layout, settings** | `<data>` SQLite | Includes each connection's MCP access (off, read only, read and write). |
| **Dashboards** | `<data>` SQLite | Names, the connection, the refresh interval, and each chart's title, kind and SQL. **Not their results**: a chart re-runs its query each time. |
| **Notebooks** | `<data>` SQLite | Text, SQL and chart cells, and **the last result of each SQL cell, up to 200 rows**, so a notebook reopens as you left it. This is row data on disk, unencrypted. Delete the notebook (or clear the cell) to remove it. Export to Markdown writes it where you choose. |
| **Backups** | wherever you choose; the list in `<data>` SQLite | `pg_dump` writes the file to the path you pick. The app records each run's connection, database, file path, status and size (the most recent runs), not the contents. |
| **Logs** | `<data>/logs/tuplenest.log.*` | One file a day, the last 14 kept. Session events — connected/disconnected, with host and database name — timings, row counts and redacted errors. **Never query text**, never passwords. |
| **Crash reports** | `<data>/crashes/*.txt` | Written locally on a panic. **Never uploaded.** Timestamp, thread, source location, panic message. Delete them freely. |
| **Exports** | wherever you choose | CSV/JSON/Markdown go only where the save dialog puts them. |

Row data from your database is held in memory while a result is on screen,
and is dropped when you run the next query, switch connection or close the
app. The exceptions are the ones you make: a notebook's SQL cells keep their
last 200 rows, and exports and backups are files you saved. A result keeps at most 20,000 rows or 128 MB, compressed. **One case
touches disk:** when the compressed rows pass 16 MB, the rest are written to
a temporary file in the operating system's temp directory. That file has no
name — it is unlinked the moment it is created (macOS, Linux) or marked
delete-on-close (Windows) — so it disappears when the result is dropped or the
app exits, including after a crash. It is compressed but **not encrypted**, so
for as long as such a result is open its rows exist on that disk. Results
under the threshold never leave memory.

Another place a stray value could otherwise reach disk — a database error whose DETAIL
quotes the offending row — is reduced before it is written to history, so the
persisted copy keeps the error's title, SQLSTATE and category but not the
value. The full detail still appears on screen for as long as the error is
shown.

The SQL redaction is **best-effort, not a guarantee.** It catches the common
secret shapes (`PASSWORD '…'` and `IDENTIFIED BY '…'` however the literal is
quoted, literals passed to `crypt`, `pgp_sym_encrypt` and their relatives,
`key=value`, connection strings), but a novel phrasing could slip a secret
through. For a statement you
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
3. **The assistant's model, only when you ask it something** (or press Test
   in Settings › Assistant). Either `api.anthropic.com`, over HTTPS with your
   own key, or the Ollama server whose URL you set — `http://localhost:11434`
   by default. A local Ollama model never leaves this computer; an Ollama
   *cloud* model does (it runs on `ollama.com`), and is only used once you
   opt in. See below.
4. **Nothing else.** Following a link in the About box hands the URL to your
   browser and is the only other outbound traffic, and only if you click it.
   Backup and restore run your own `pg_dump` and `pg_restore` against the
   database you picked; the MCP server talks to the AI tool that started it
   over stdin/stdout and opens no connection but to your databases.

## The assistant

The assistant does nothing until you add a provider in Settings › Assistant,
and sends nothing until you send a message, press Explain, press Fix with the
assistant, or press Test. Every request is made by the app's Rust core; the
window never makes one itself and never holds your key.

**What a request contains — and nothing else:**

- the message you typed, and the earlier messages and answers of the same panel
  conversation (the last six, each capped);
- the SQL in the active editor tab, for Ask, Explain and Fix (not for Write
  SQL), capped at 20,000 characters;
- for Fix only: the error's title, SQLSTATE and the server's message, hint and
  the names of the objects involved. The server's `DETAIL` and `CONTEXT`
  lines are **removed first**, because they can quote row values
  (`Key (email)=(…) already exists`);
- the names of the schemas, tables and views of the database you are
  connected to, with their column names and types, from the explorer's
  cache. Capped at 12,000 characters; tables your query names go first.
  Comments, index definitions, sizes and row estimates are not included.
  On a SQLite session the digest also says it is SQLite. Nothing is sent
  about a database you are not connected to.

**Never sent:** row data or any result cell, query history, the audit log,
the connection's host, port, user name or password, SSH settings, other
connections' schemas, or anything from another tab.

**When it goes:**

| Provider | Destination | Sent when |
|---|---|---|
| Claude (Anthropic API) | `https://api.anthropic.com/v1/messages`, with your key in the `x-api-key` header | You send a message, press Explain or Fix; Test sends a one-word request with no data of yours |
| Ollama | The URL you set: `http://localhost:11434` unless you change it; for a cloud model, Ollama passes the request on to `ollama.com` (only with **Allow Ollama cloud models** on) | You send a message, press Explain or Fix; Test lists the models (`/api/tags`) |

The Ollama URL must be on this computer (`localhost`, `127.0.0.0/8` or `::1`)
unless you turn on **Allow a server on another computer**; with it on, your
questions, the query and the table names go to that server. Redirects are
never followed, so a local server cannot pass the request on elsewhere.

**Ollama cloud models.** An Ollama signed in to ollama.com lists *cloud*
models (a name ending in `:cloud` or `-cloud`, or a `remote_host` such as
`https://ollama.com:443` in `/api/tags`) next to local ones. Ollama forwards
those requests to that host, so your question, the query and the table names
leave this computer even though the app only talks to `localhost`. TupleNest
marks them "cloud via ollama.com" wherever models are listed, never makes one
the default, and refuses to send to one — checked in the Rust core against
`/api/tags` before each request — until you turn on **Allow Ollama cloud
models** in Settings › Assistant. That choice is remembered and can be turned
off at any time. What ollama.com does with a request is governed by Ollama's
terms, not by this project.
Anthropic's handling of what you send is governed by your agreement with
Anthropic, not by this project.

Nothing the assistant suggests runs by itself. A suggestion goes into the
editor only when you press Insert into editor or Apply the fix, and runs only
when you press Run — through the same read-only check, production guard and
audit log as anything you type.

## The MCP server

`tuplenest-desktop mcp` lets an AI tool you run yourself (Claude Desktop,
Claude Code, Cursor) query your saved connections. It is the opposite of the
assistant in one respect, so it is spelled out here: **what a query returns
goes to that tool**, and from there to wherever the tool sends it, its own
model provider included. That is what MCP is for.

- **Every connection is off** until you choose *Read only* or *Read and
  write* for it in Settings › MCP server. An off connection is not listed,
  and naming it gets the same answer as a name that does not exist.
- **Read only** is the same server-enforced read-only session a read-only
  profile gets (SQLite's own read-only mode for a SQLite file). **Read and
  write** refuses everything the destructive-statement guard would ask
  about, and is not available on prod, staging or read-only connections.
- A tool gets at most 500 rows (or 1 MB) per query, marked when cut off.
  Passwords are read from the keychain by TupleNest and never returned.
- Statements are recorded in query history, and on prod and staging in the
  audit log before they run, with the sender as `MCP · <client>`.

## Deleting your data

- **Profiles, history, audit log, cache, dashboards, notebooks** — delete the
  `<data>` directory.
- **Passwords and SSH key passphrases** — these are the keychain's, not ours;
  remove entries named `tn-secret-*` in Keychain Access, Credential Manager, or
  Seahorse. Deleting a profile in the app removes its keychain entries too,
  and removing the Anthropic provider in Settings › Assistant removes the
  key's.
- **Logs** — delete `<data>/logs` (older than 14 days are deleted automatically).
- **Crash reports** — delete `<data>/crashes`.

Uninstalling the app does **not** remove the `<data>` directory or keychain
entries. That is deliberate — an uninstall that silently deleted your saved
connections would be worse — but it means the cleanup above is manual.

## Contact

Questions: <talaatmagdy75@gmail.com>. Security issues: see `SECURITY.md`.
