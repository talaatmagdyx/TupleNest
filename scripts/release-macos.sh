#!/usr/bin/env bash
#
# Build, sign, notarize and staple a macOS release of TupleNest.
#
# Requires an Apple Developer account ($99/yr). Nothing here can be faked:
# without a real Developer ID certificate, Gatekeeper will always warn.
#
# Credentials (never hard-code these — export them, or keep them in CI secrets):
#
#   APPLE_SIGNING_IDENTITY  "Developer ID Application: Your Name (TEAMID)"
#   APPLE_ID                your Apple ID email
#   APPLE_PASSWORD          an app-specific password (appleid.apple.com →
#                           Sign-In and Security → App-Specific Passwords).
#                           NOT your Apple ID password.
#   APPLE_TEAM_ID           10-character team id
#
# Required, because bundle.createUpdaterArtifacts is on: without these the
# build fails at the signing step *after* producing the .app, which looks like
# it worked (see docs/releasing.md). The key path here said ~/.tauri/ and the
# docs said ~/.tuplenest-keys/; the docs were right.
#
#   TAURI_SIGNING_PRIVATE_KEY           contents of ~/.tuplenest-keys/tuplenest.key
#   TAURI_SIGNING_PRIVATE_KEY_PASSWORD  its password (empty unless you set one)
#
# To build without the key at all — which is what a contributor has — use
# `npm run build:app`, which turns the updater artifacts off.
#
# Usage:  ./scripts/release-macos.sh
#
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

die() { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }
info() { printf '\033[36m==>\033[0m %s\n' "$1"; }

# ---------------------------------------------------------------- preflight
for v in APPLE_SIGNING_IDENTITY APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID; do
  [[ -n "${!v:-}" ]] || die "\$$v is not set. See the header of this script."
done

if ! security find-identity -v -p codesigning | grep -q "$APPLE_SIGNING_IDENTITY"; then
  die "signing identity '$APPLE_SIGNING_IDENTITY' not found in the keychain.
       Download your 'Developer ID Application' certificate from
       developer.apple.com and double-click it to install."
fi

command -v xcrun >/dev/null || die "xcrun not found — install Xcode command line tools."

# --------------------------------------------------------------- build
info "Building signed release (tauri picks up the APPLE_* vars)…"
cd apps/desktop
# NODE_ENV must not be 'development' here or Vite bundles React's dev build.
NODE_ENV=production npm run tauri build
cd "$ROOT"

APP="$ROOT/target/release/bundle/macos/TupleNest.app"
[[ -d "$APP" ]] || die "expected app bundle at $APP"

# --------------------------------------------------------------- verify signature
info "Verifying code signature…"
codesign --verify --deep --strict --verbose=2 "$APP" \
  || die "code signature verification failed"

spctl --assess --type execute --verbose "$APP" \
  || info "spctl assessment not yet accepted — expected until notarization is stapled"

# --------------------------------------------------------------- notarize
DMG="$(find "$ROOT/target/release/bundle/dmg" -name 'TupleNest_*.dmg' | head -1)"
[[ -f "$DMG" ]] || die "no .dmg found to notarize"

info "Submitting $(basename "$DMG") to Apple for notarization (this can take several minutes)…"
xcrun notarytool submit "$DMG" \
  --apple-id "$APPLE_ID" \
  --password "$APPLE_PASSWORD" \
  --team-id "$APPLE_TEAM_ID" \
  --wait \
  || die "notarization failed — run 'xcrun notarytool log <submission-id>' for the reason"

info "Stapling the notarization ticket…"
xcrun stapler staple "$DMG" || die "stapling failed"
xcrun stapler staple "$APP" || true

# --------------------------------------------------------------- final check
info "Final Gatekeeper assessment…"
spctl --assess --type install --verbose "$DMG" || die "Gatekeeper still rejects the dmg"

info "Done: $DMG"
info "This build opens with no security warning on any Mac."
