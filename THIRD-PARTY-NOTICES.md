# Third-party components

TupleNest is [MIT licensed](LICENSE). It ships three components that are not: the fonts below.

These notices used to live at the bottom of `LICENSE`, which had a cost worth
recording: GitHub identifies a licence by matching the whole file against known
licence texts, so the extra prose pushed the match below the threshold and the
repository reported **NOASSERTION** — no licence at all — while the README said
MIT. To anyone evaluating the project, "no licence" reads as *all rights
reserved*, which is the opposite of the intent. `LICENSE` is now the MIT text
and nothing else; the notices live here, where they change nothing about
detection.

## JetBrains Mono

- **Files:** `apps/desktop/src/assets/fonts/JetBrainsMono-var.woff2`
- **Copyright:** 2020 The JetBrains Mono Project Authors
- **Licence:** SIL Open Font License 1.1 — full text at
  [`apps/desktop/src/assets/fonts/OFL.txt`](apps/desktop/src/assets/fonts/OFL.txt),
  which sits beside the fonts because clause 2 of that licence requires the
  text to travel with them.

## Space Grotesk

- **Files:** `apps/desktop/src/assets/fonts/SpaceGrotesk-latin-var.woff2`,
  `apps/desktop/src/assets/fonts/SpaceGrotesk-latin-ext-var.woff2` (the Latin
  and Latin Extended subsets of the variable font, as published by Fontsource)
- **Copyright:** 2020 The Space Grotesk Project Authors
- **Licence:** SIL Open Font License 1.1 — full text at
  [`apps/desktop/src/assets/fonts/OFL-SpaceGrotesk.txt`](apps/desktop/src/assets/fonts/OFL-SpaceGrotesk.txt).

## Inter

- **Files:** `apps/desktop/src/assets/fonts/Inter-latin-var.woff2`,
  `apps/desktop/src/assets/fonts/Inter-latin-ext-var.woff2` (the Latin and
  Latin Extended subsets of the variable font, as published by Fontsource,
  `@fontsource-variable/inter` 5.3.0)
- **Copyright:** 2016 The Inter Project Authors
- **Licence:** SIL Open Font License 1.1 — full text at
  [`apps/desktop/src/assets/fonts/OFL-Inter.txt`](apps/desktop/src/assets/fonts/OFL-Inter.txt).

The OFL covers the font files only. It asks that the fonts not be sold on their
own and that this notice travel with them; it places no condition on the rest
of this software, nor on anything produced with it.

## Everything else

Rust crates and npm packages are dependencies, not shipped components, and
their licences are checked on every push: `cargo deny check licenses` fails the
build on anything outside the allowlist in [`deny.toml`](deny.toml). Every
release also carries CycloneDX SBOMs (`*.cdx.json`, one per Rust crate plus one
for the npm tree) listing every dependency and its licence.
