# Contributing to TupleNest

TupleNest is an MIT-licensed, local-first PostgreSQL IDE. Contributions are
welcome — code, bug reports, docs fixes, and "this felt wrong and I can't say
why" are all useful. This guide is what you need to get from a clone to a
merged change.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Its
short version: be decent, assume good faith, criticise code not people.

## Ways to contribute

- **Report a bug.** An imperfect report beats no report. If you can, say what
  you did, what happened, and what you expected. A reproduction is a gift, not
  a requirement.
- **Fix docs.** If the README, the website, or a doc says something the code
  doesn't do, that's a real bug — open a PR or an issue.
- **Send code.** For anything beyond a small fix, open an issue first so we can
  agree on the approach before you spend an evening on it.
- **Report a security issue privately.** Do *not* open a public issue. Use
  [GitHub Security Advisories](https://github.com/talaatmagdyx/TupleNest/security/advisories/new)
  or see [SECURITY.md](SECURITY.md).

## Project layout

- `apps/desktop/` — the Tauri app: a React/TypeScript frontend (`src/`) and a
  Rust backend (`src-tauri/`).
- `crates/` — the Rust workspace: `driver-api`, `driver-postgres`,
  `connection-core`, `result-stream`, `metadata-cache`, `credential-store`,
  `ssh-core`, `workspace-store`, `telemetry`.
- `docs/` — plans, the release runbook, and the GitHub Pages site (`docs/site/`).

## Development setup

You'll need **Rust** (stable), **Node 22**, **npm**, and the
[Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS
(Xcode Command Line Tools on macOS; MSVC + WebView2 on Windows; webkit2gtk +
build-essential on Linux).

```bash
git clone https://github.com/talaatmagdyx/TupleNest
cd TupleNest/apps/desktop
npm install
npm run tauri dev      # run the app in development
```

Some tests talk to a real database. Point them at a local PostgreSQL with the
`TUPLENEST_TEST_PG_*` environment variables (host, port, db, user, password);
tests that need a server skip cleanly when it isn't configured.

## The gates a change has to pass

CI runs these; run them locally before opening a PR so there are no surprises.

**Rust**

```bash
cargo fmt --all
cargo clippy --all-targets -- -D warnings
cargo test
```

**Frontend** (from `apps/desktop/`)

```bash
npm run typecheck
npm run lint
NODE_ENV=test npm run test:coverage
npm run build
```

The suite is large on purpose — roughly 1,800 automated tests (about 1,661
frontend, 157 Rust). The frontend has a coverage floor; a change that drops it
fails CI. If a legitimate change lowers the floor, move the number in
`vitest.config.ts` and say why in the commit — don't delete the block.

## The testing philosophy (please read this one)

A test that cannot fail is worse than no test, because it looks like coverage
while proving nothing. For anything security- or safety-relevant, include a
**negative control**: show the test failing when the fix is removed, and say so
in the PR. Several bugs in this project's history were "1,600 passing tests had
nothing to say about it" — the whole point is to not repeat that.

## Rules that aren't negotiable

- **Never log, print, or commit credentials.** Passwords live only in the OS
  keychain; the app database stores an opaque reference. Don't add a code path
  that puts a secret in a log, a settings file, or the WebView.
- **Every driver change must pass the driver contract tests.**
- **Don't weaken a safety guardrail to make a feature easier.** Read-only,
  destructive-statement checks, TLS verify modes, and SSH host-key
  verification are load-bearing.
- **Keep claims honest.** If the docs or the website would now overstate what
  the code does, fix them in the same PR.

## Pull requests

1. Branch from `main`.
2. Keep the PR focused; one logical change is easier to review and revert.
3. Make sure all the gates above pass.
4. Write a commit message that explains *why*, not just *what* — this
   repository's history is meant to be readable.
5. Open the PR against `main`. A maintainer will review; expect questions, and
   feel free to push back.

## Questions

Not sure where something goes, or whether an idea is wanted? Open a
[Discussion](https://github.com/talaatmagdyx/TupleNest/discussions) — asking
first is always fine.
