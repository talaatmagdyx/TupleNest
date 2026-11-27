# Development

## Build from source

You need:

- **Rust stable.** Install it with [rustup](https://rustup.rs). A Homebrew
  `rustc` ignores `rust-toolchain.toml`.
- **Node 22+.**
- The [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your
  OS.

```sh
git clone https://github.com/talaatmagdyx/TupleNest
cd TupleNest/apps/desktop
npm ci --include=dev                 # --include=dev: NODE_ENV=production would drop vite and vitest
npm run tauri dev                    # run in development
npm run build:app -- --bundles app   # a local app bundle; no updater signing key needed
```

The bundle lands in `target/release/bundle/`.

## Tests

```sh
cargo test --workspace                 # Rust
cd apps/desktop && npm test            # frontend (vitest)
```

Tests that need a live PostgreSQL or sshd are ignored by default.
[CONTRIBUTING.md](../../CONTRIBUTING.md) lists the environment variables that
turn them on. [dev-sshd.md](dev-sshd.md) sets up a userland sshd for the
tunnel tests.

## In this folder

| File | What it covers |
|---|---|
| [releasing.md](releasing.md) | Cutting a release, signing keys, the release environment |
| [windows-manual-check.md](windows-manual-check.md) | The manual check of a Windows build that CI can't drive |
| [dev-sshd.md](dev-sshd.md) | A local sshd for the SSH tunnel tests |
| [design-requirements.md](design-requirements.md) | The original design requirements |
| [phase-0-plan.md](phase-0-plan.md), [phase-1-plan.md](phase-1-plan.md) | The plans the project was built from, kept for their history |
