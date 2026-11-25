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
npm ci                 # exact lockfile; plain `npm install` drops devDependencies under NODE_ENV=production
npm run tauri dev      # run the app in development
```

Tests that need a real PostgreSQL or sshd are `#[ignore]`d, so the default
`cargo test --workspace` and `npm test` need neither. To run them, point them at
a disposable server and add `-- --include-ignored`:

```bash
docker run --rm -d -p 5432:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17-alpine
TUPLENEST_TEST_PG_HOST=localhost TUPLENEST_TEST_PG_USER=postgres \
  cargo test -p tuplenest-driver-postgres -- --include-ignored
```

| Variable | Needed for |
| --- | --- |
| `TUPLENEST_TEST_PG_HOST`, `_PORT`, `_DB`, `_USER` | every live PostgreSQL test (use a server that trusts local connections) |
| `TUPLENEST_TEST_PG_SSL_CA` | the TLS tests: a server with `ssl=on` whose certificate (SAN `localhost`) this CA signed. Unset, they skip. `ci.yml` shows how CI makes one. |
| `TUPLENEST_TEST_PG_PLAINTEXT`, `_PLAINTEXT_PORT` | the "refuses a plaintext server" tests, against an `ssl=off` server |

| `TUPLENEST_TEST_SSHD_DIR` | the SSH tunnel tests: a real sshd, set up as in [`docs/dev-sshd.md`](docs/dev-sshd.md) (the `live-ssh` job in `ci.yml` is the reference) |

One exception on Linux: `live_os_keychain_contract` (credential-store) talks
to the real Secret Service, so without a running keyring daemon it fails
rather than skips. CI starts `gnome-keyring` for it (see `ci.yml`); locally,
skip it with `cargo test --workspace -- --skip live_os_keychain_contract`.

### Building a real .app locally

`npm run tauri dev` is for iterating: it serves the UI from a Vite dev server,
so the app goes blank the moment that server stops. To get something you can
actually launch and keep, build the bundle instead.

Releases ship signed updater artifacts, which need a key only CI has. A local
build doesn't need them:

```bash
npm run build:app -- --bundles app   # bundles without updater artifacts, so no key
```

The result lands in `target/release/bundle/`. Testing auto-update itself is
the one case that needs a key; generate a throwaway one with
`npx tauri signer generate -w /tmp/tn-local.key -p ""` and export it as
`TAURI_SIGNING_PRIVATE_KEY` (with an empty `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`).

**If two copies are installed, check the build stamp.** The status bar shows
the commit and build time of the bundle that window is running (a trailing `+`
means it was built with uncommitted changes). An installed release and a local
build look identical otherwise, and chasing a fix in the wrong window is a
genuinely expensive way to spend an afternoon.

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

The suite is large on purpose — over 2,000 frontend tests and about 250 Rust
tests (a quarter of them live tests that need a server). The frontend has a coverage floor; a change that drops it
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
