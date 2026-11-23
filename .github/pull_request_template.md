## What and why

<!-- One or two sentences. Link the issue if there is one. -->

## How it was checked

- [ ] `cargo fmt --all -- --check` and `cargo clippy --workspace --all-targets -- -D warnings`
- [ ] `cargo test --workspace`
- [ ] `npm run lint`, `npm run typecheck`, `npm run test:coverage` (in `apps/desktop`)
- [ ] A test that fails without this change, for any fix

<!-- Anything you could not test (a platform, a live server), say so here. -->
