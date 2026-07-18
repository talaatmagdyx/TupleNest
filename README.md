<div align="center">

<img src="docs/site/logo.png" width="110" alt="TupleNest logo" />

# TupleNest

### The PostgreSQL IDE that **asks before it writes.**

*Fast. Local. Safe by architecture. Simple on purpose.*

<br/>

[![Release](https://img.shields.io/github/v/release/talaatmagdyx/TupleNest?include_prereleases&label=release&color=e8590c)](https://github.com/talaatmagdyx/TupleNest/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/talaatmagdyx/TupleNest/total?color=e8590c)](https://github.com/talaatmagdyx/TupleNest/releases)
[![CI](https://github.com/talaatmagdyx/TupleNest/actions/workflows/ci.yml/badge.svg)](https://github.com/talaatmagdyx/TupleNest/actions/workflows/ci.yml)
[![CodeQL](https://github.com/talaatmagdyx/TupleNest/actions/workflows/codeql.yml/badge.svg)](https://github.com/talaatmagdyx/TupleNest/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

![Rust](https://img.shields.io/badge/Rust-000000?logo=rust&logoColor=white)
![Tauri 2](https://img.shields.io/badge/Tauri_2-24C8DB?logo=tauri&logoColor=black)
![React](https://img.shields.io/badge/React-087EA4?logo=react&logoColor=white)
![PostgreSQL 13+](https://img.shields.io/badge/PostgreSQL-13%2B-4169E1?logo=postgresql&logoColor=white)
![macOS](https://img.shields.io/badge/macOS-000000?logo=apple&logoColor=white)
![Windows](https://img.shields.io/badge/Windows-0078D4)
![Linux](https://img.shields.io/badge/Linux-FCC624?logo=linux&logoColor=black)

<br/>

**[⬇️ Download](https://github.com/talaatmagdyx/TupleNest/releases/latest)** ·
[🌐 Website](https://talaatmagdyx.github.io/TupleNest/) ·
[🚀 Quick start](#-sixty-seconds-to-your-first-query) ·
[🛡 Safety model](#-the-safety-model) ·
[⌨️ Keyboard](#%EF%B8%8F-the-keyboard) ·
[🧭 Honest limits](#-what-tuplenest-is-not-yet)

<br/>

<img src="docs/site/shots/hero.png" width="920" alt="TupleNest — query editor with a formatted SQL join and a streaming results grid, connected over verify-full TLS" />

</div>

<br/>

> It's 5 p.m. on a Friday. You type `DELETE FROM orders`, forget the `WHERE`,
> and your cursor is hovering over **Run** — on **production**.
>
> Most database tools run it. **TupleNest is built around the other answer.**

Every destructive path in the app **asks first, refuses with a reason, or is
enforced by PostgreSQL itself** — never by a client-side promise. And every one
of those guarantees has a test that executes the misuse and asserts the
refusal, so the claims on this page aren't copy. They're pinned behavior that
CI would catch regressing.

> ⚠️ **Early software, stated plainly.** This is a v0.1.0 beta — tested far
> more than it has been *used*. 1,600+ frontend tests, contract tests against
> live PostgreSQL 13/15/17, SSH tunnel tests against a real sshd. What it
> hasn't had is people living in it. **That's the part you'd be contributing.**

<br/>

## 🪶 Simple on purpose

<table>
<tr>
<td width="25%" align="center"><h3>0</h3><b>accounts</b><br/><sub>No sign-up, no license key, no cloud. Download, open, connect.</sub></td>
<td width="25%" align="center"><h3>60s</h3><b>to first query</b><br/><sub>One dialog between you and <code>SELECT</code>. Passwords go to the OS keychain, not a config file.</sub></td>
<td width="25%" align="center"><h3>1</h3><b>window</b><br/><sub>One window, one session, tabs inside it. No workspace files, no project setup.</sub></td>
<td width="25%" align="center"><h3>2</h3><b>network destinations</b><br/><sub>Your databases + one startup version check to GitHub. That's the <a href="PRIVACY.md">entire network story</a>.</sub></td>
</tr>
</table>

## 🚀 Sixty seconds to your first query

```
1 · Download  →  2 · Press ⌘O, fill host/db/user  →  3 · Test (staged probe)  →  4 · ⌘↵
```

The **Test** button runs a staged probe — `DNS ✓ TCP ✓ auth ✓ server version ✓` —
so when something is wrong you learn **which layer**, not just *"could not
connect"*.

> Nothing is code-signed yet, so your OS will object once on first launch.
> [Install](#-install) has the exact click-path through every dialog you'll see.

<br/>

## 👀 The tour

<table>
<tr>
<td width="50%" valign="top">
<img src="docs/site/shots/connection.png" alt="New connection dialog: environment picker (dev/test/staging/prod), TLS verify-full with CA file, and a staged connection test" />
<p align="center"><b>Connecting is a diagnosis, not a coin flip</b></p>
<sub>Pick dev / test / staging / <b>prod</b> and the whole window knows it — the frame tints, prod gets a banner, and dangerous verbs ask harder questions. TLS <code>verify-full</code> is the <i>default</i> and fails closed.</sub>
</td>
<td width="50%" valign="top">
<img src="docs/site/shots/complete.png" alt="Schema-aware autocomplete suggesting the books table mid-keystroke" />
<p align="center"><b>Autocomplete that has read your schema</b></p>
<sub>Tables after <code>FROM</code>. In-scope columns in <code>WHERE</code>. <code>alias.</code> → that table's columns. Comments and strings are masked <i>first</i>, so a table name in a comment never poisons suggestions.</sub>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<img src="docs/site/shots/explorer.png" alt="Schema explorer expanded to a table's columns beside live query results" />
<p align="center"><b>The schema is a place you walk around in</b></p>
<sub>Lazy tree of schemas → tables → columns / indexes / constraints, PK badges inline, backed by a cache that serves instantly — and keeps serving read-only when the connection drops.</sub>
</td>
<td width="50%" valign="top">
<img src="docs/site/shots/er-diagram.png" alt="ER diagram: authors, books, orders, order_items joined by their three foreign keys" />
<p align="center"><b>The picture and the receipts</b></p>
<sub>The ER view draws the foreign-key graph and names every constraint. Schema diff, find-usages, rename, and EXPLAIN plan comparison live one panel over.</sub>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<img src="docs/site/shots/monitor.png" alt="Server activity monitor: backends, DB size, cache hit, commits, rollbacks, blocked locks, session list" />
<p align="center"><b>Operate, not just query</b></p>
<sub>Backends, cache hit ratio, blocked locks, per-session state — with cancel and terminate. Terminating always asks. On prod, it makes you <b>type the pid</b>.</sub>
</td>
<td width="50%" valign="top">
<p align="center"><br/><br/><b>Results stream — they don't "load"</b></p>
<sub>The grid is virtualized and backpressured: bounded batches, a row cap <i>and</i> a byte budget, and a footer that tells the truth about truncation. A checksum test pins that nothing is lost or duplicated in transit.<br/><br/>One decoding rule with teeth: values are decoded from what the type <b>is</b>, never guessed from what the bytes look like. A <code>money</code> value renders as money or as visibly-raw hex — <b>never as a plausible wrong number</b>.</sub>
</td>
</tr>
</table>

<br/>

## 🛡 The safety model

Five layers — each one names **what actually enforces it**, because *"we're
careful"* is not an architecture:

| Layer | What it does | What enforces it |
|---|---|---|
| 🔒 **Read-only profiles** | Writes are refused | **PostgreSQL itself** (`SET SESSION CHARACTERISTICS … READ ONLY`) — the server, not a promise |
| ⚠️ **Destructive-statement guard** | No-`WHERE` `UPDATE`/`DELETE`, `DROP`, `TRUNCATE`, `ALTER`, `GRANT`… ask before running on prod *and* staging | SQL is masked (comments, strings, dollar-quotes) before matching — `-- where` can't disarm it. Best-effort by design: the seatbelt *light*, not the seatbelt |
| ✏️ **Safe row editing** | Only single-table SELECTs with the full primary key are editable; joins, CTEs, groups refused *with a reason* | You review the exact `UPDATE`s first. Parameter-bound, keyed by the full PK, guarded with `IS NOT DISTINCT FROM` — a racing edit affects 0 rows and is **refused**, not silently won |
| 🔁 **Transactions** | The tab that opened a transaction owns it | Committing from another tab is refused and names the owner. Closing mid-transaction always prompts |
| 📦 **Auto-update** | Payloads verified against a minisign key compiled into the binary | The release host only serves bytes — it never holds the key. Updating is refused mid-transaction |

**Every row has a test that executes the misuse and asserts the refusal** —
including thirteen adversarial bypass attempts on the guard, the comma-join
editability hole, and the zero-row concurrent write.

<br/>

## ⌨️ The keyboard

Press <kbd>?</kbd> anywhere for the in-app cheatsheet. <kbd>⌘</kbd> = <kbd>Ctrl</kbd> on Windows/Linux.

| | | | |
|---|---|---|---|
| <kbd>⌘↵</kbd> Run | <kbd>Esc</kbd> Cancel / close | <kbd>⌘K</kbd> Command palette | <kbd>⌘P</kbd> Object search |
| <kbd>⌘T</kbd> New tab | <kbd>⌘O</kbd> Connections | <kbd>⌘B</kbd> Sidebar | <kbd>⇧⌘F</kbd> Format SQL |
| <kbd>⇧⌘L</kbd> Dark ↔ light | <kbd>⌘C</kbd> Copy cell | | |

Full keyboard grid navigation with real `role="grid"` semantics · every modal
is a real `role="dialog"` with a focus trap · `prefers-reduced-motion`
respected.

<br/>

## 🧰 Everything else in the box

| | |
|---|---|
| **📝 Query work** | Format SQL · EXPLAIN / ANALYZE plan tab · `$1..$n` parameter binding · searchable history · **prod audit log** (full SQL of everything run on prod) · snippets in the palette · CSV/JSON export with an honest truncation note · one-click charts |
| **🗺 Schema work** | Global object search · column-by-column schema diff · find-usages & rename across tabs (unicode-aware) · EXPLAIN comparison with cost deltas + a *"new sequential scan"* regression flag · partition tree browsing |
| **🩺 Health** | Index health report · vacuum & bloat panel · `pg_stat_statements` top queries |
| **📥 Data in** | CSV import wizard — RFC-4180 parsing, type inference **you review before anything runs**, batched inserts in one transaction |
| **✨ Fit & finish** | Environment-reactive window frame — dev/staging/prod get different ambient colors, so *the wrong window is visibly the wrong window* · dark, dense, flat — deliberately an IDE, not a dashboard |

<br/>

## 🧭 What TupleNest is *not* (yet)

Marketing pages don't have this section — which is exactly why you should
trust a README that does.

- **One engine.** PostgreSQL 13+, done properly, before anything else is
  attempted. Need MySQL today? TupleNest isn't your tool today.
- **CSV import reads the whole file into memory.** Fine for real-world
  imports; not yet fine for the 10 GB one.
- **The statement guard is best-effort.** It survived thirteen bypass
  attempts, but it's the seatbelt light. Read-only profiles are the seatbelt —
  the *server* enforces those.
- **Nothing is code-signed.** Each OS objects once; the docs walk you through
  it, and the [attestation check](#-verifying-a-download) proves more than the
  dialogs do.
- **Saved passwords on Linux need a keyring daemon** (GNOME Keyring /
  KWallet). Connecting works without one; *saving* doesn't.

<br/>

## 📦 Install

**[Download the latest release](https://github.com/talaatmagdyx/TupleNest/releases/latest).**
Every platform builds from the same source on its own CI runner.

Nothing is code-signed yet, so **every OS objects once** — each dialog and its
exact click-path is below, written from what the first beta testers actually
hit.

<details>
<summary><b>🍎 macOS</b> — <code>.dmg</code> (Apple Silicon or Intel) · macOS 10.15+</summary>
<br/>

1. Open the `.dmg`.
2. **Drag TupleNest.app onto the Applications shortcut inside it** — this step
   *is* the install.
3. Eject the DMG, launch from Applications (not from the DMG).
4. First launch: **right-click → Open → Open**. Double-clicking shows
   "unidentified developer" with no way through; the right-click path is the
   only one that offers **Open**.

Or the whole thing in a terminal:

```sh
cp -R /Volumes/TupleNest/TupleNest.app /Applications/
xattr -dr com.apple.quarantine /Applications/TupleNest.app   # skips step 4
open -a TupleNest
```

**"You can't open TupleNest because it is in the Trash"** — the app isn't in
the Trash; your Dock/Launchpad icon points at an older copy you moved there.
Drag the dead icon off the Dock, install from the DMG, launch from
`/Applications` once.

**"TupleNest is damaged and can't be opened"** — not damage: Gatekeeper's
message for an unsigned app it quarantined. `xattr -dr com.apple.quarantine
/Applications/TupleNest.app`. The [attestation check](#-verifying-a-download)
is a stronger guarantee than the dialog you're dismissing.

</details>

<details>
<summary><b>🐧 Linux</b> — <code>.AppImage</code> (recommended), <code>.deb</code>, <code>.rpm</code> · glibc 2.35+</summary>
<br/>

**The AppImage is the fast path** — no root, no package manager:

```sh
chmod +x TupleNest_0.1.0_amd64.AppImage
./TupleNest_0.1.0_amd64.AppImage
```

The `.deb` / `.rpm` integrate with your menus, at the cost of root:

```sh
sudo apt install ./TupleNest_0.1.0_amd64.deb     # Debian/Ubuntu
sudo dnf install ./TupleNest-0.1.0-1.x86_64.rpm  # Fedora/RHEL
```

Needs `webkit2gtk-4.1`. **Saved passwords need a keyring daemon** (GNOME
Keyring / KWallet) — connecting works without one, saving doesn't.

**"Could not get lock /var/lib/dpkg/lock-frontend … (unattended-upgr)"** —
that's Ubuntu's automatic security updater holding the lock *legitimately*,
usually for 1–5 minutes. **Do not delete the lock file.** Use the AppImage, or
wait, or stop it gracefully:

```sh
sudo systemctl stop unattended-upgrades
sudo apt install ./TupleNest_0.1.0_amd64.deb
sudo systemctl start unattended-upgrades
```

</details>

<details>
<summary><b>🪟 Windows</b> — <code>.exe</code> (NSIS) or <code>.msi</code> · Windows 10+</summary>
<br/>

WebView2 installs automatically if missing.

The installer is unsigned, so SmartScreen shows **"Windows protected your
PC"** / **"Unknown publisher"**: click **More info → Run anyway**.

Why not just buy a certificate? Because it wouldn't do what you'd expect: a
standard certificate puts a real publisher name on the installer but the
warning *stays* until the file builds download reputation — which resets every
release. Only an EV certificate skips the wait.
[Verify the download instead](#-verifying-a-download); it proves more than the
dialog does.

</details>

> **Auto-update** points at this repo's releases. While every release is a
> pre-release (all betas), the endpoint 404s and the check fails silently by
> design — upgrading means downloading the next build by hand.

<br/>

## ✅ Verifying a download

```sh
# catches a corrupted or truncated download
shasum -a 256 -c SHA256SUMS --ignore-missing

# proves this exact file came out of this repo's release workflow, at this commit
gh attestation verify TupleNest_0.1.0_aarch64.dmg --repo talaatmagdyx/TupleNest
```

Be clear about what each proves: `SHA256SUMS` sits *next to* the installer, so
it can't defend against a tampered release host — the **attestation** can,
because it's signed by GitHub's OIDC identity, not by anything in the release.
CycloneDX SBOMs (`*.cdx.json`) are attached for anyone auditing dependencies.

Auto-updates are separately signed with a **minisign key compiled into the
binary** — the release host only ever serves bytes.

<br/>

## 🔬 The receipts

The claims on this page are only as good as what checks them. What runs in CI,
on every push:

- **1,600+ frontend tests** — including a suite that *executes each documented
  misuse* (guard bypasses, editability holes, the racing edit, the cross-tab
  commit) and asserts the refusal.
- **Contract tests against live PostgreSQL 13, 15, 17** — a real server, real
  TLS with a CA the tests mint themselves, real cancellation. Not mocks.
- **SSH tunnel tests against a real sshd**, including fails-closed host-key
  paths.
- **A capability test born from a shipped bug:** beta.1's close button
  silently did nothing — one missing ACL permission, rejection swallowed.
  There's now a test cross-checking every window API call against the
  permissions file. This README tells you that story instead of hiding it,
  **because that's the deal here.**
- CodeQL · `cargo deny` (licenses + advisories) · typos · dependency pinning ·
  coverage gate.

<br/>

## 🏗 Under the hood

```
apps/desktop/   Tauri 2 shell — React/TypeScript frontend, Rust commands
crates/         driver-api · driver-postgres · connection-core · credential-store
                ssh-core · workspace-store · metadata-cache · result-stream · telemetry
docs/           plans, releasing runbook, landing page
```

Three rules hold the shape:

1. **The frontend never sees a password.** The credential store is an
   opaque-reference API over the OS keychain; secrets never cross IPC.
2. **Writes are never built by string concatenation.** Parameter binding,
   everywhere, no exceptions.
3. **Safety predicates are pure functions** with adversarial test corpora —
   because a safety check you can't unit-test is a safety *vibe*.

```sh
# build from source
cd apps/desktop
npm install --include=dev     # NOT plain npm install — see note
npm run tauri build
```

<details>
<summary><b>The <code>NODE_ENV</code> gotcha</b> (read before your first build)</summary>
<br/>

If your shell exports `NODE_ENV=production`, npm silently strips `vite`,
`vitest` and `typescript` from the install. Always install with
`--include=dev`. Do **not** "fix" it by exporting `NODE_ENV=development` —
Vite reads that at build time and bundles React's development build into the
release (≈ +400 kB, slower). Install with `--include=dev`; build with
`NODE_ENV` left at production.

</details>

```sh
# test suites
cargo test --workspace                                          # Rust
cd apps/desktop && npm test                                     # 1,600+ frontend
cargo test -p tuplenest-driver-postgres -- --include-ignored    # needs live PG
```

**Supported PostgreSQL: 13+.** Anything older is refused with a reason rather
than half-working — 13 is the oldest version the contract tests actually run
against.

More: [`SECURITY.md`](SECURITY.md) · [`PRIVACY.md`](PRIVACY.md) ·
[`CONTRIBUTING.md`](CONTRIBUTING.md) · [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) ·
[`docs/releasing.md`](docs/releasing.md) · [`CHANGELOG.md`](CHANGELOG.md) ·
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)

<br/>

## 💬 Feedback is the point

This is a beta because the questions that matter now can't be answered by a
test suite: is the editor comfortable, are the shortcuts findable, does it
break on your machine.

| | |
|---|---|
| 🐞 | **[Something broke](../../issues/new?template=bug_report.yml)** |
| 🤔 | **[Nothing broke — it just felt wrong](../../issues/new?template=ux_feedback.yml)** ← *the one that matters most* |
| 💬 | **[Discussions](../../discussions)** for anything shaped like a conversation |

<br/>

<div align="center">

**[MIT](LICENSE)** © [Talaat Magdy](https://github.com/talaatmagdyx) — one shipped component is not MIT, see [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)

<sub>Built with amazing help from <a href="https://claude.com">Claude</a> · design inspired by VS Code</sub>

<br/><br/>

**If the safety model resonates, ⭐ the repo — it tells us to keep going.**

</div>
