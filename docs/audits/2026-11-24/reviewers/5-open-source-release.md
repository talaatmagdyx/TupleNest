**Scope note:** local checkout is 5335453; remote `main` moved to 63b9505 during the audit (PR #48, a Pages workflow change only). Nothing in the repo or on GitHub was modified; scratch scripts are in `docs/audits/2026-11-24/evidence/audit-oss/`.

## (a) What I ran / read

- **Docs read:** README, PRIVACY, SECURITY, CONTRIBUTING, CODE_OF_CONDUCT, CHANGELOG, THIRD-PARTY-NOTICES, `docs/ROADMAP.md`, `docs/releasing.md` (first 140 lines), `docs/windows-manual-check.md` (partly), and site pages index, download, features, security, docs, roadmap.
- **Not read:** the rest of `releasing.md`, `dev-sshd.md`, `design-requirements.md` (grep only), the phase plans (grep only), `blog*.html`, `changelog.html` (grep only).
- **Config/CI read:** `ci.yml`, `release.yml`, `smoke.yml`, `pages.yml`, `dependabot.yml`, issue/PR templates, `tauri.conf.json`, capabilities, entitlements, `Cargo.toml`, `rust-toolchain.toml`, `vite.config.ts`.
- **Code read to ground claims:** `apps/desktop/src/lib/sql.tsx` (guard), `hooks/useQuery.ts`, `hooks/useConnectionForm.ts`, `overlays/Overlays.tsx` (Settings), `lib/version.ts`, `App.tsx` (run and updater), `crates/result-stream/src/lib.rs`, `crates/driver-postgres/src/lib.rs` (read-only, version floor), `src-tauri/src/pg.rs` (limits), `trim.rs`, and a `cfg(target_os)` sweep.
- **GitHub, read-only:** repo view, release list and assets, issues, PRs, labels, community profile, workflow runs, branch protection, environments, Dependabot alerts, discussions count, and one `curl -I` on `/releases/latest`.
- **Executed:** a relative-link/anchor checker over all `.md` and site `.html`; the frontend suite (2047 tests in 76 files pass on Node 23.9; startup crash on Node 21.7).
- **Not executed:** `cargo test`, clippy, any build, any installer.

## (b) Findings

**F1 — Published build lacks documented safety fixes; the fix release is an unpublished draft that is itself superseded**
- Category: Release. Severity: P1. Confidence: Confirmed.
- Where: `gh api …/releases`; `CHANGELOG.md:6-16`, `108-130`.
- Evidence:
  - The newest published release is v0.1.0-beta.11 (2026-08-29). v0.1.1-beta.12 has been `draft=true` since 2026-11-23.
  - `CHANGELOG.md:108` dates beta.12 as released. It fixes "Applying row edits no longer runs the editor's current SQL… with the production guard skipped" and read-only switch-back.
  - `[Unreleased]` then records that beta.12 still lets `DO`/`CALL` write on a read-only profile.
  - `main` is 28 commits past the beta.12 tag and 40 past beta.11.
  - Every release is a prerelease, so `releases/latest/download/latest.json` 404s and no installed copy is told.
- Impact: anyone downloading today gets a build whose known guard and read-only holes are described in the public changelog. Publishing the draft would ship a known read-only bypass.
- Recommendation: do not publish the beta.12 draft. Bump to 0.1.2, tag `v0.1.2-beta.13` from `main`, publish it, and mark the beta.12 changelog heading "tagged, never published". Consider publishing betas as non-prerelease until a stable channel exists, since every user is a beta user and it is the only way the updater can ever fire. Test one real update first.
- Verification: `gh api repos/talaatmagdyx/TupleNest/releases/latest` returns 200 with the new tag; a beta.11 install shows the update toast.

**F2 — "Row data is in memory only" is no longer true**
- Category: Privacy docs. Severity: P1. Confidence: Confirmed.
- Where: `PRIVACY.md:31-37`; `docs/site/security.html:145` ("Memory only — never written to disk"); `SECURITY.md` is silent.
- Evidence: `crates/result-stream/src/lib.rs:26-29` and `:122-127` — past 16 MB compressed, blocks go to `tempfile::tempfile()`, "compressed but NOT encrypted… in the OS temp directory". The changelog `[Unreleased]` says the same.
- Impact: a false statement in the privacy policy of a tool aimed at production data. Unlinked temp files are still recoverable from disk and are outside the 0700 data directory.
- Recommendation: one paragraph in PRIVACY and one row in `security.html` saying when results spill, that the file is unnamed, unencrypted and removed on close or crash. Add a "known, not a vulnerability" bullet in SECURITY.
- Verification: grep both files for "memory only".

**F3 — The website advertises behaviour the code does not have**
- Category: Docs accuracy. Severity: P1. Confidence: Confirmed by code reading.
- Evidence:
  - "Read-only by default on new profiles" (`index.html:89`) vs `useConnectionForm.ts:11` `readOnly: false`.
  - "Selected-query execution" (`index.html:183`) and "Select part of the query to run only the selection" (`docs.html:82`) vs `App.tsx:789-794`, which always sends the whole tab through `query_raw`. No statement splitting exists outside autocomplete.
  - "Sort & filter" (`index.html:129`) and "sort/filter/search, copy cell/row/selection" (`docs.html:103`): the grid has no filter or search.
  - Settings "editor and query preferences, history retention, export defaults, update behaviour, and keyboard shortcuts" (`docs.html:186`), "grid caps are configurable" (`docs.html:194`), "configurable retention" (`security.html:143`) vs `Overlays.tsx:406-470`: a theme switch, a telemetry toggle, two static labels and About. PRIVACY.md:8 correctly says the update check cannot be turned off.
  - `docs/ROADMAP.md:3` says "Phases 0 and 1 are done", but `phase-1-plan.md:99` and `:113` (current-statement/selection execution, multiple result sets) are not implemented.
- Impact: this breaks the project's own "every claim is checkable" promise, and CONTRIBUTING calls such mismatches "a real bug".
- Recommendation: delete or reword those lines; change ROADMAP to "Phase 1 mostly done; not yet: …".
- Verification: grep the phrases.

**F4 — "Asks before it writes" holds only on connections tagged prod or staging, and the default tag is dev**
- Category: Positioning vs guarantee. Severity: P2. Confidence: Confirmed.
- Where: `sql.tsx:129-130`, `:113`; `useConnectionForm.ts:8,11`.
- Evidence: `guardReason` returns null unless env is prod or staging. New profiles default to `environment: "dev"`, read-only off. `INSERT`, and `UPDATE`/`DELETE` with any `WHERE`, never prompt in any environment.
- Impact: a production database added without touching the environment picker gets no prompt for `DELETE FROM orders` — the README's opening scenario.
- Recommendation: the cheapest honest fix is copy: "asks before destructive statements on connections you mark prod or staging". A stronger fix is no default environment (force a choice) or guarding untagged non-localhost hosts.
- Verification: unit test `needsGuard("delete from t", "dev")`.

**F5 — README and website give contradictory macOS first-launch instructions**
- Category: Docs. Severity: P2. Confidence: High-confidence (not tested on a clean Mac).
- Where: `README.md:226-228` says right-click → Open is "the only" path; `download.html:124` and `docs.html:70` say it "does not work on macOS 15 and later" and the app shows as "damaged".
- Recommendation: make the README match the site and lead with the `xattr` command.

**F6 — Documented "build from source" command needs a signing key only CI has**
- Category: Contributor experience. Severity: P2. Confidence: High-confidence (not run).
- Where: `README.md:368-373`; `download.html:148-153`.
- Evidence: `tauri.conf.json` sets `createUpdaterArtifacts: true`; `release.yml:227-229` says the build fails at signing after producing installers; `CONTRIBUTING.md:76-81` gives the working command `npm run build:app -- --bundles app`.
- Also: three different install commands (README `npm install --include=dev`, CONTRIBUTING `npm ci`, site `npm install`), and the site's bundle path `src-tauri/target/…` disagrees with CONTRIBUTING's workspace-root `target/release/bundle`.
- Recommendation: use `npm ci` + `npm run build:app` everywhere.

**F7 — The release SBOM set omits the application crate**
- Category: Release / supply chain. Severity: P2. Confidence: Confirmed.
- Where: `release.yml:331` (`find . -maxdepth 3 -name '*.cdx.json'`).
- Evidence: `apps/desktop/src-tauri/` is depth 4. beta.11 and beta.12 assets list nine library-crate SBOMs and no desktop-app one, so the Tauri, wry and updater dependency closure is not described. `THIRD-PARTY-NOTICES.md:32` claims "one per Rust crate".
- Recommendation: `-maxdepth 4`, and assert the count equals the number of workspace members plus one.

**F8 — "macOS 10.15+" is unverified and probably wrong**
- Category: Cross-platform. Severity: P2. Confidence: Potential.
- Where: `tauri.conf.json:55`; `README.md:219`; `download.html`.
- Evidence: `vite.config.ts` sets no `build.target`; `styles.css` uses `:has()` (`:965`) and `color-mix()` (`:1017` and eight more lines). From memory, those need Safari 15.4 and 16.2. Builds and tests run only on `macos-latest`.
- Recommendation: state the floor you have actually run (probably macOS 13), or set a build target and test on an old VM.

**F9 — Stale numbers**
- Category: Docs. Severity: P2. Confidence: Confirmed.
- `features.html:89`: "Column sorting, client-side, up to 50,000 rows". Sorting is now in Rust over at most 20,000 rows (`pg.rs:949`).
- `index.html:105`: "1,949 frontend · 157 Rust". Actual: 2047 frontend tests ran; 235 Rust test attributes, 54 `#[ignore]`.
- `CONTRIBUTING.md:115`: "about 180 Rust".
- `README.md:55`: "v0.1.0 beta" while the manifests say 0.1.1.
- Code comments only: `App.tsx:1675` and `sql.tsx:65` still say 100,000.
- No stale 100,000 / 256 MB figure remains in README, PRIVACY, SECURITY or the site, and `design-requirements.md:45` is current. The 10,000-row clipboard cap (`main.rs:353`) is documented only in the changelog.

**F10 — Two roadmaps contradict each other**
- Category: Docs. Severity: P2. Confidence: Confirmed.
- `docs/ROADMAP.md:15-22` plans MySQL, SQL Server, MongoDB, an AI assistant, plugins and SSO. `roadmap.html:118,127` lists "Support for every database engine" under Not planned and says "No AI assistant is promised."
- Recommendation: keep the site's version and cut the repo file to a pointer.

**F11 — A slightly wrong toolchain gives opaque failures**
- Category: Contributor experience. Severity: P2. Confidence: Confirmed.
- On Node 21.7.3, `npx vitest run` dies with `ERR_INVALID_ARG_VALUE … styleText` from rolldown. `.nvmrc` says 22, but `package.json` has no `engines`.
- Rust has the opposite problem: CI floats on newest stable, and a new clippy lint already broke CI once (8c5e06a). A Homebrew `rustc`, as on this machine, ignores `rust-toolchain.toml`. CONTRIBUTING does not mention either.
- Recommendation: add `"engines": {"node": ">=22"}`, plus two lines in CONTRIBUTING ("run `rustup update stable` first; a clippy failure you cannot reproduce means your stable is older than CI's").

**F12 — Linux install commands on the site are wrong or incomplete**
- Category: Docs. Severity: P3. Confidence: High-confidence.
- `download.html:131`: `sudo dpkg -i tuplenest_*.deb` cannot match `TupleNest_0.1.0_amd64.deb` on a case-sensitive filesystem.
- The site omits the `.rpm`.
- `apt remove tuplenest` — package name unverified.
- `index.html:287`: "Universal / per-arch .dmg" — no universal build exists.

**F13 — Changelog and release-notes hygiene**
- Category: Release. Severity: P3. Confidence: Confirmed.
- Link references exist only for beta.1–8, so headings for 9–12 render as literal brackets.
- `[Unreleased]` reports the row cap twice (20,000 "was 50,000", then 50,000 "was 100,000").
- GitHub release bodies for beta.11 and the beta.12 draft are two boilerplate sentences.

**F14 — Community surface is empty or noisy**
- Category: OSS readiness. Severity: P3. Confidence: Confirmed.
- 0 issues ever, 0 discussions, 0 stars; a `good first issue` label exists with nothing on it.
- 8 open Dependabot PRs and 32 open alerts: 31 in `e2e/package-lock.json` dev tooling and one medium runtime alert (`glib`). `/e2e` is not grouped in `dependabot.yml`.
- Wiki is enabled; no evidence it is used.
- `bug_report.yml:14` gives a macOS-only path to the version ("Menu bar → TupleNest → About").
- No architecture doc, CODEOWNERS, FUNDING or SUPPORT file. SECURITY.md:78 calls signing "a funding problem" with no way to fund it.
- Recommendation: file five to eight real issues (two to three marked good first issue) from the F3 gaps, add one e2e group to Dependabot, turn off the wiki, and write a one-page `docs/ARCHITECTURE.md` from the README's "Under the hood" plus the `Cargo.toml` comments.

**F15 — Some quoted benchmark numbers cannot be reproduced from the repo**
- Category: Docs. Severity: P3. Confidence: Confirmed.
- The memory figures have an in-tree ignored bench with a documented command (`pg.rs:2525-2537`).
- "358 MB / 6M rows / ~15 MB" (`README.md:183`) and "17/17, 1.9×–1461×" (`README.md:134`) have no harness or script in the repo.
- Recommendation: commit the generator and script, or label them "one-off measurement, <date>, <machine>".

**F16 — Post-build verification gaps**
- Category: Release. Severity: P3. Confidence: Confirmed.
- `smoke.yml` runs only after `release: published` (or by hand), so it cannot gate a release.
- Smoke covers the `.deb` (full WebDriver run) and the `.msi` (window opens). Nothing runs the AppImage, `.rpm`, NSIS `.exe`, or either macOS bundle.
- `docs/windows-manual-check.md` is a good checklist, but I found no recorded result of it being run.
- Recommendation: dispatch Smoke against the draft tag before publishing and make it a line in `releasing.md`.

**F17 — Updater has never run end to end**
- Category: Release. Severity: P3. Confidence: High-confidence.
- The endpoint has 404'd for every release. `MIN_UPDATE_VERSION = "0.1.0"` (`version.ts:19`) sits below the current version, so the floor refuses nothing the plugin would not already refuse. `index.html:287` says "Auto-update ready".

**Smaller items**
- CI's Postgres matrix is 13, 15, 17; versions 14, 16 and 18 are not in it.
- Pages deploys failed twice in the last four completed runs (PR #48 addresses it; a fifth was still queued), so the live site may lag `docs/site`.

## (c) Documentation claims

| Claim | Verdict | Evidence |
|---|---|---|
| Result keeps ≤20,000 rows or 128 MB | True | `pg.rs:949,962` |
| Row data in memory only / never on disk | False | F2 |
| Read-only is server-enforced and re-checked per statement; DO/CALL refused | True on `main`; not in any published build | `driver-postgres/lib.rs:440-460`, `614-636`; F1 |
| Guard asks on prod and staging, masked text | True | `sql.tsx:129-160` |
| "Every destructive path asks first, refuses, or is server-enforced" | Partly | F4 |
| Read-only by default on new profiles | False | F3 |
| New profiles default to verify-full | True | `useConnectionForm.ts:20` |
| Run selected text | False | F3 |
| Grid sort & filter / search | Partly (sort only) | F3 |
| Sorting client-side up to 50,000 | False (stale) | F9 |
| Settings: retention, export defaults, update behaviour, shortcuts | False | F3 |
| PostgreSQL <13 refused with a reason | True | `driver-postgres/lib.rs:513-545` |
| Contract tests on PG 13/15/17 with TLS; real sshd | True | `ci.yml` |
| 2,000+ frontend tests | True | 2047 passed |
| Site test counts (1,949 / 157) | Stale | F9 |
| Default `cargo test` / `npm test` need no server | Partly | `npm test` verified; cargo not run; 54 `#[ignore]` |
| One update check at startup, cannot be disabled | True | `App.tsx:1462-1480`; no setting |
| Auto-update fails silently while all releases are prereleases | True | API 404 |
| Anti-rollback floor | Partly | F17 |
| Minisign `.sig` on every artifact except `.dmg`; SHA256SUMS; attestation | True for assets present; verification not run | release assets |
| SBOM "one per Rust crate" | False | F7 |
| Download buttons reach assets | True | `/releases/latest` returns 302 to `/releases` |
| macOS 10.15+ | Unverified | F8 |
| Right-click → Open works on macOS | Contradicted by the site | F5 |
| Linux glibc 2.35+, webkit2gtk-4.1, x86_64 only | Consistent with build | `release.yml` (ubuntu-22.04) |
| Windows: WebView2 auto-installs | Unverified | — |
| Freed memory returned to the OS (macOS, Linux) | True | `trim.rs` |
| Import 358 MB with ~15 MB growth; advisor 1.9×–1461× | Unverified | F15 |
| Telemetry toggle collects nothing | Not verified beyond the UI toggle | `App.tsx:330-332` |
| Phases 0 and 1 done | Partly | F3 |
| Internal links and anchors | All resolve | Only `../../issues/new…` and `../../discussions` flagged; these are GitHub-relative and fine |

External links (not crawled): github.com repo, actions, releases, tags beta.1–11, `releases.atom`, security advisories, discussions, issues; shields.io badges; keepachangelog.com; semver.org; tauri.app/start/prerequisites; contributor-covenant.org; explain.dalibo.com; claude.com; the Pages site.

## (d) Platform support

| Platform | Built in CI | Tested in CI | Manually verified per docs | Status |
|---|---|---|---|---|
| macOS arm64 (.dmg, .app.tar.gz) | Yes | Rust unit tests on `macos-latest`; bundle never launched | No record | Works on the dev machine (per docs); unsigned, not notarized |
| macOS x64 | Yes, cross-compiled | Binary never executed (README says so) | No record | Unverified |
| macOS universal | No | — | — | Not offered (site wording is wrong) |
| Windows x64 `.msi` | Yes | Rust tests; MSI installs and a window opens | Checklist exists; no recorded run | UI unverified |
| Windows x64 NSIS `.exe` | Yes | No | No | Unverified |
| Windows arm64 | No | — | — | Not supported (stated) |
| Linux x64 `.deb` (Ubuntu 22.04) | Yes | Full WebDriver smoke with live PG and keyring, last on beta.11 | — | Best-verified artifact |
| Linux x64 AppImage / `.rpm` | Yes | No | No | Unverified |
| Linux arm64 / musl | No | — | — | Not supported |
| Auto-update, any OS | Artifacts signed | Never exercised | No | Unverified |

Other platform notes:
- Keychain: per-OS `keyring` backends; the Linux Secret Service contract runs in CI.
- Postgres and SSH contract tests are Linux-only.
- Signing: none on any OS; the Apple signing path is wired but has never run.
- WebView differences are untested except WebKitGTK on 22.04.

## (e) Open-source readiness

| Item | Status |
|---|---|
| README clarity | Partial — strong voice, but 430 lines and install sits at line 207 |
| Description / topics | Pass |
| Screenshots | Pass (7 PNGs) |
| Demo GIF / video | Fail |
| Install | Partial (F5, F12) |
| Quick start | Pass |
| Licence | Pass (MIT, detected) |
| Third-party notices | Pass (one wrong SBOM sentence) |
| CONTRIBUTING | Pass (minus F11) |
| CODE_OF_CONDUCT | Pass |
| SECURITY | Pass (private reporting enabled; add F2) |
| Issue templates | Partial (bug + UX; no feature template; macOS-only version hint) |
| PR template | Pass |
| Discussions | Partial (enabled, empty) |
| Changelog | Partial (F13) |
| Release notes | Fail for beta.11/12 |
| Versioning policy | Pass (`releasing.md`, CI tag check) |
| Roadmap | Partial (F10) |
| Support policy | Partial (latest release only; no SUPPORT file) |
| Governance | Partial (single maintainer stated in SECURITY and CoC; enough) |
| Labels / first issues | Fail (label exists, zero issues) |
| CI visible | Pass (badges, required checks on `main`) |
| Architecture doc | Fail |
| Dependabot | Partial (F14) |
| CODEOWNERS / FUNDING | Absent (CODEOWNERS unnecessary; FUNDING worth one file) |

## (f) Positioning

Competitor statements are from memory and should be read as assumptions.

- **Clearest differentiator:** a narrow, testable safety model for PostgreSQL. It has server-enforced read-only that is re-checked per statement, a reviewed and PK-keyed row edit with a zero-row race refusal, tab-owned transactions, an environment-tinted window, and typed-pid termination on prod. Documentation that states its own limits is the second differentiator.
- **What incumbents already do (assumption):**
  - DataGrip and DBeaver have read-only connections, transaction-mode controls, connection colouring, and confirmations for `UPDATE`/`DELETE` without `WHERE`.
  - TablePlus and Beekeeper have environment colours and staged edits with a commit step.
  - pgAdmin has role, backup and server administration.
  - "Asks before destructive SQL" is therefore not unique as a feature; rigour and honesty are the differentiators.
- **Genuinely distinctive:**
  - The plan analyser: self-time, parallel accounting, an offline pasted-plan reader, candidate indexes that decline when unsure, and node-by-node diff with an "ambiguous" label.
  - A migration generator that never executes.
  - Staged connection diagnosis.
  - A prod audit log.
  - A small Tauri binary (6–11 MB installers) with no account.
- **Unlikely to drive adoption alone:** ER static view, one-click charts, health panels, SBOM/attestation (trust signals, not reasons to switch).
- **Present in code:** multiple editor tabs, searchable history with favourites, snippets, schema diff, ER, SSH (key file or password), four TLS modes, dark/light, CSV/JSON/Markdown export, CSV import, activity monitor.
- **Missing workflows that block daily use (checked in code):**
  - No run-selection, run-statement-at-cursor or multi-statement scripts.
  - One result per run; no multiple result sets or pinned results.
  - Tabs are not persisted across restart (`useQueryTabs.ts:26`), and I found no open/save of `.sql` files.
  - No grid filter or search.
  - One shared session per window.
  - A 20,000-row view cap.
  - Not checked in code: SSH agent or jump-host chains, client-certificate TLS, backup/restore, role management, SQL-INSERT or Excel export.
  - No other database engines.
- **Reasons to switch:** you work mostly on Postgres, touch production, and want a light tool with a first-rate EXPLAIN reader.
- **Reasons to uninstall in the first hour:** "damaged" or SmartScreen warnings, pasting a two-statement script and getting an error, losing tabs on quit, no result filter.
- **Where marketing exceeds the guarantee:** F4 (the guard needs a tag and covers a narrow statement class), F3, and the fact that the fixes behind the current safety claims are not in any published build (F1). The README's safety table is accurate; the tagline and site bullets overreach.

## (g) README outline for first-time visitors

1. Name, one-line tagline scoped to what is enforced, hero screenshot or a 20-second GIF, three badges.
2. Status box: beta, current version, platforms actually verified, unsigned.
3. What it is and who it is for (three bullets); what it is not (three bullets, moved up from line 188).
4. Install: one table of OS → file → first-launch command, linking to the site for dialogs.
5. First query in 60 seconds.
6. Safety model table (keep as is) plus a "what does not ask" line.
7. Feature list, short, linking to the site.
8. Verifying a download.
9. Build and test (correct commands; which tests need Postgres or sshd).
10. Architecture in ten lines, linking to `docs/ARCHITECTURE.md`.
11. Feedback, contributing, security, privacy, licence.

Move the tour grid, the index-advisor essay, "the receipts" and the keyboard table to the site or `docs/`.

## (h) Strengths worth preserving

- The "what is already known, and is not a vulnerability" section of SECURITY.md, the README's honest-limits section, and the PRIVACY storage table.
- The release pipeline: SHA-pinned actions, a protected `release` environment (2 rules), signing preflight, tag-vs-version check, attestation, `persist-credentials: false`, and comments that record why.
- Live contract tests against real PostgreSQL with self-minted TLS and a real sshd; the Linux keyring is tested, not skipped.
- The `.deb` smoke test installs the shipped artifact rather than building from source, and explains honestly why Windows stops at "window opens".
- Required status checks on `main`; private vulnerability reporting enabled.
- The negative-control testing rule, and deleting placeholder crates because "a directory named after a feature is a claim".

## (i) What I could not validate

- Anything on Windows or Linux at runtime; macOS Intel; macOS older than this machine's; the actual Gatekeeper and SmartScreen dialogs.
- Installers and their signatures: nothing was downloaded, `gh attestation verify` and minisign were not run, and the `.deb` package name is unknown.
- The updater end to end.
- `cargo test --workspace`, clippy, a release build, and the F6 build failure (inferred from the repo's own docs).
- Live Postgres and SSH tests locally.
- The import and index-advisor benchmark numbers.
- Whether the deployed Pages site matches `docs/site`.
- External links.
- Competitor capabilities (memory only).
- Telemetry "collects nothing" beyond the UI toggle.
