# Security policy

TupleNest holds database credentials and opens connections to production
systems. If you find something wrong with how it does that, please tell us
before you tell the internet.

## Reporting a vulnerability

**Do not open a public issue.**

Use GitHub's private reporting:
[Security → Report a vulnerability](https://github.com/talaatmagdyx/TupleNest/security/advisories/new).

If that is unavailable, email **talaatmagdy75@gmail.com** with `TupleNest
security` in the subject.

Useful things to include, in rough order of usefulness: what an attacker gains,
the steps to reproduce, the version and OS, and whether it needs a malicious
database, a malicious SSH host, or a local attacker.

### What to expect

| | |
|---|---|
| Acknowledgement | within 3 working days |
| First assessment | within 10 working days |
| Fix or a plan | depends on severity; you will hear the reasoning either way |
| Credit | offered by default, declined on request |

This is a small project maintained by one person. Those are honest targets, not
a paid SLA.

## Supported versions

Only the latest release. There is no back-porting branch — 0.1.0 is the first
public version and the project is pre-1.0.

## What we consider a vulnerability

Things we want to hear about:

- A credential reaching anywhere other than the OS keychain — logs, the SQLite
  workspace, crash reports, IPC payloads, exported files, the WebView.
- TLS or SSH host-key verification accepting something it should refuse.
  `verify-ca` / `verify-full` and pinned host keys are meant to fail closed.
- A path from database *content* to code execution or to the filesystem — a
  malicious table name, column comment, or cell value that escapes the grid.
- A Tauri command that does more than its name suggests, or a capability
  broader than `capabilities/default.json` claims.
- The updater accepting an artifact not signed with our key.
- Row editing writing to something other than the reviewed row.

## What is already known, and is not a vulnerability

Reporting these is not useful; they are documented decisions.

- **The destructive-statement guard is best-effort.** It masks comments and
  strings before matching, but it is not a SQL parser, and `pg_query` will
  execute whatever the editor sends. It is a seatbelt light. Use a read-only
  profile if you need enforcement — that one is the server's job.
- **`RUSTSEC-2023-0071` (Marvin Attack)** is accepted, with reasoning in
  `deny.toml`. RSA private-key timing sidechannel via `russh`; no patched
  version exists. **Ed25519 SSH keys do not touch that code path — prefer
  them.**
- **macOS builds are not notarized and Windows builds are unsigned.** Stated in
  the README. This is a funding problem, not an oversight.
- **Crash reports are written to local disk unredacted** and never uploaded. A
  panic message from a third-party crate could in principle contain something
  sensitive.
- **One PostgreSQL session is shared by all query tabs.** `SET search_path` and
  temp tables are shared between tabs by design. The open transaction records
  which tab opened it and refuses to be committed from another.
- Anything requiring an attacker who already has local code execution as your
  user. At that point they have the keychain anyway.
