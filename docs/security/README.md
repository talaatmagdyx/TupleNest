# Security and the safety model

TupleNest has two layers of protection, with different strengths.

- **Enforced by the database:** read-only sessions, and the privileges of the
  role you connect as. A read-only profile pairs a database-enforced read-only
  session with the app's statement checks. That is much stronger than a
  disabled button, but only role privileges hold against everything. For
  example, an extension that opens its own connection, such as `dblink`, is not
  bound by the session's read-only mode.
- **Checks in the app:** the statement guard, type-the-name confirmations, the
  audit log, and transaction ownership. They are careful, tested, and
  best-effort. They make mistakes much less likely, but they aren't a security
  boundary.

**For production data that must not change, connect as a database role
without write privileges.** That is the only protection that holds whatever
the client does.

## Protections

| Protection | Layer | How it works | Limits |
|---|---|---|---|
| **Read-only profile (PostgreSQL)** | Database | The session is set read-only on the server (`SET SESSION CHARACTERISTICS … READ ONLY`) and its mode is re-checked before every statement. The app also sends only statements that read | PostgreSQL's read-only mode alone still allows `VACUUM`, `CHECKPOINT` or `COPY … TO PROGRAM`, and the read-only allowlist covers those. Neither stops a write made over a separate connection, such as through `dblink`; a role without write privileges does |
| **Read-only profile (SQLite)** | Database | The file is opened read-only, `PRAGMA query_only` is set before every statement, and a statement SQLite reports as writing is refused before it runs | |
| **Destructive-statement guard** | App | On `prod` and `staging`, the guard asks first for any of these. On every other connection it asks about the worst cases (the unbounded `UPDATE`/`DELETE`, `DROP` and `TRUNCATE`, also inside `EXPLAIN ANALYZE`), with one click to answer. Comments and strings are masked before matching. <ul><li>`UPDATE`/`DELETE` without a real `WHERE` (`WHERE 1=1` counts as none)</li><li>`DROP`, `TRUNCATE`, `ALTER`, `CREATE`</li><li>`GRANT`, `REVOKE`, `MERGE`, `DO`, `CALL`</li><li>`COPY … FROM`</li><li>`EXPLAIN ANALYZE` of any of the above</li></ul> | A function with side effects called from a `SELECT` is invisible to any client-side check |
| **Type the name** | App | On `prod` and `staging`, an unbounded `UPDATE`/`DELETE`, a `DROP` or a `TRUNCATE` keeps *Run anyway* disabled until you type the target's name | |
| **Audit before run** | App | On `prod` and `staging`, each statement, from the window or from MCP, is written to the local audit log before it is sent. If that write fails, the statement isn't sent | The log records what was submitted, not the outcome; the outcome is in history |
| **History without prod SQL** | App | On `prod`, no SQL text is stored in history. Elsewhere, common secret values are removed. `-- tuplenest:no-history` skips a statement | Doesn't apply to the audit log, which keeps prod and staging SQL by design |
| **Transaction ownership** | App | A transaction belongs to the tab that began it. Another tab can't commit it, and closing a tab mid-transaction asks | |
| **Reviewed row edits** | App | Grid edits become `UPDATE` statements you read before they are sent, keyed on the full primary key or `rowid` | |
| **Row limit** | App | A result keeps at most 20,000 rows, and a plain read stops there | |
| **TLS** | Connection | `verify-full` is the default for new PostgreSQL connections and fails closed | You can choose a weaker mode per connection |
| **SSH tunnels** | Connection | Host keys are verified. Key files with a passphrase work, with the passphrase kept in the keychain | |
| **Credentials** | Storage | Passwords, passphrases and API keys live in the OS keychain (Keychain, Credential Manager, Secret Service). The window gets opaque references only | On Linux this needs a running keyring daemon |
| **MCP access** | App + database | Off per connection by default. *Read only* uses a database-enforced read-only session. Statements the guard would ask about are refused | A client you enable receives the rows its queries return |

## Release integrity

| Item | Status |
|---|---|
| Signed update artifacts | Yes. Updates are signed, and the app checks the signature before installing |
| Checksums | Yes. `SHA256SUMS` with each release |
| Build provenance | Yes. A GitHub artifact attestation per file (`gh attestation verify`), for every release from v0.1.0-beta.1 |
| Checked after publishing | The Smoke workflow downloads each release on Linux, Windows and macOS and, before installing, checks each file against `SHA256SUMS`, its updater signature against the app's pubkey, and its attestation. It also checks that every entry in `latest.json` resolves and verifies. It does not test a real update from an older install |
| macOS signing | The release workflow signs with a project certificate. It isn't an Apple Developer ID, so Gatekeeper still warns |
| macOS notarization | No. Needs a paid Apple Developer account. The workflow notarizes as soon as one is configured |
| Windows code signing | No. Needs a code-signing certificate |

## Reporting and audits

- To report a vulnerability, see [SECURITY.md](../../SECURITY.md). Please don't
  open a public issue.
- [PRIVACY.md](../../PRIVACY.md) is the full data-handling policy.
- The audit of 24 November 2026, and what was fixed after it, is in
  [docs/audits/2026-11-24](../audits/2026-11-24/).
