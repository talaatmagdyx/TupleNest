# Launch kit (draft)

Drafts for a wider public launch. Nothing here has been posted. Every number
and claim below is one the repository backs up; the source is given where it
is not obvious. Keep it that way: no comparisons with other products, no
"fastest", no "most secure".

## Before posting anything

| Gate | State |
|---|---|
| Safety findings from phase 2 (TN-032, 035, 036, 037) fixed on `main` | Done: #115, #118, #117, #119 |
| **A release that contains those fixes** | **Not yet.** The latest, v0.1.0-beta.11, predates them; its read-only mode has the TN-032 hole. Launch posts must link a newer release |
| Independent check of that release (install it, run the read-only, guard and import cases in `docs/audits/2026-11-24/VERIFICATION.md` by hand) | Not yet |
| TN-033 (staging audit) and TN-034 (guard on dev) decided, docs matching the code | Open |
| Release checks: checksums, updater signatures, attestations, `latest.json` | Done: the Smoke workflow, #116 |
| Benchmarks reproducible from a clean build | Done: `docs/benchmarks/` |
| Signing and notarization | Out of scope for now. Say so plainly: macOS shows an "unidentified developer" warning and Windows SmartScreen may warn |
| Updates | Every release is a prerelease, so installed copies are never offered an update. Say "download the new version" in any follow-up |
| Screenshots | `docs/site/shots/`, demo data only |

## What to lead with

In this order, because it is what is different and it is verified:

1. **Read-only that the database enforces.** Not a UI toggle: the session is
   read-only on the server, and the app checks before every statement that it
   still is. Covered by live tests on PostgreSQL 13, 15 and 17.
2. **Production-aware.** Tag a connection `prod` and destructive statements
   need the database name typed back; statements are written to a local audit
   log before they run.
3. **Local-first, no telemetry.** There is no telemetry code. The update check
   is the only request the app makes by itself.
4. **AI on your terms.** Off until you add a provider (your own Anthropic key,
   or Ollama). It is never sent result rows. It can't run anything: you press
   Run.
5. **MCP server with per-connection access,** Off by default, Read only on
   prod.
6. **Small and native.** Rust core, Tauri. Window in about 0.3 s, about
   120 to 130 MB idle (`docs/benchmarks/`, M4 Pro).

Be upfront about: two engines today (PostgreSQL and SQLite), beta, unsigned
builds, no auto-update yet, one session shared by all tabs.

## Show HN

**Title:** Show HN: TupleNest – a PostgreSQL and SQLite client where read-only is enforced by the database

> I built TupleNest, an open-source (MIT) desktop SQL client for PostgreSQL
> and SQLite, written in Rust with Tauri.
>
> The thing I cared about most is not running the wrong statement on the
> wrong database. A read-only profile is read-only on the server, not just in
> the UI, and the app re-checks before every statement, because a
> `SET`/`RESET`/`BEGIN READ WRITE` can undo it. Connections can be tagged
> `prod`; there, a `DELETE` without a `WHERE` or a `DROP` needs the database
> name typed back, and each statement is written to a local audit log before
> it is sent.
>
> It is local-first with no telemetry. There is an optional assistant
> (bring your own Anthropic key, or Ollama), which is never sent result rows
> and cannot run anything itself, and an MCP server where each connection is
> Off until you allow it.
>
> It is a beta: builds are not signed yet, so macOS and Windows will warn.
> I would especially like to hear about ways around the read-only and
> production protections; the safety model and its known limits are written
> up in docs/security.
>
> https://github.com/talaatmagdyx/TupleNest

## Reddit

**r/PostgreSQL:** "An open-source client that treats read-only and prod as
things the server enforces". Lead with points 1 and 2, the `dblink` caveat
(a role without write privileges is the real guarantee), and ask for
break-it reports.

**r/sqlite:** "A desktop client that opens files read-only for real". SQLite
read-only mode plus `PRAGMA query_only`, schema explorer, CSV import that
stops rather than changing a value. Mention the large-schema numbers honestly:
a full schema walk of 10,000 tables is slow (`docs/benchmarks/`).

**r/rust:** "TupleNest: a Tauri 2 database client, Rust core, React UI". The
architecture (`docs/architecture/`), streaming results with a row cap, the
benchmark harness, and what Tauri was like for this.

Read each subreddit's self-promotion rules before posting; several want a
discussion post, not a link.

## Product Hunt

- **Tagline (60 chars):** The safety-first database workspace for Postgres and SQLite
- **Description:** Read-only that the database enforces, typed confirmations
  on production, an audit log written before each statement runs, and no
  telemetry. Open source, local-first, built in Rust.
- **Gallery:** `docs/site/og.png`, then `screen-query-3.jpg` (prod), `screen-explain.jpg`,
  `screen-mcp.jpg`, `screen-assist-2.jpg`, `screen-light.jpg`.

## LinkedIn

> I've released TupleNest, an open-source desktop client for PostgreSQL and
> SQLite. It is built around one idea: a database tool should make the
> dangerous statement hard to run by accident. Read-only profiles are
> enforced by the server, production connections ask you to type the name
> before destructive statements, and it never collects usage data. It is in
> beta, free, and MIT-licensed. Feedback welcome, especially on the safety
> model: https://github.com/talaatmagdyx/TupleNest

## After posting

- Answer security reports through `SECURITY.md`, not in threads.
- Turn repeated questions into FAQ entries on the site.
- Anything claimed in a reply should already be in the docs; if it is not,
  check it before saying it.
