#!/usr/bin/env bash
#
# Set TAURI_SIGNING_PRIVATE_KEY_PASSWORD — verified against the key first.
#
# The first v0.1.0-beta.1 build failed on all four platforms with:
#
#     failed to decode secret key: incorrect updater private key password:
#     Wrong password for that key
#
# ...after every platform had finished compiling and bundling. The secret did
# not match the key. This script makes that impossible to repeat: it proves the
# passphrase can actually sign with the key BEFORE it uploads anything, so a
# typo or a stray newline fails here, in two seconds, instead of twelve minutes
# into four parallel builds.
#
# The passphrase is read with `read -s`: not echoed, not in argv (so not in
# `ps`), and never written to disk. Set it with this rather than by hand and it
# cannot pick up a trailing newline — the usual cause, because
# `echo pass | gh secret set` sends the newline too.
#
# Usage:   ./scripts/set-signing-secret.sh
#
set -euo pipefail

KEY="${TUPLENEST_KEY:-$HOME/.tuplenest-keys/tuplenest.key}"
REPO="${TUPLENEST_REPO:-talaatmagdyx/TupleNest}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

command -v gh >/dev/null || { echo "gh is not installed."; exit 1; }
[ -f "$KEY" ] || { echo "No key at $KEY — set TUPLENEST_KEY, or generate one:"; \
                   echo "    cd apps/desktop && npx tauri signer generate -w $KEY"; exit 1; }

printf 'Passphrase for %s: ' "$KEY"
read -rs PASS
printf '\n'
[ -n "$PASS" ] || { echo "Empty. An unprotected key is what SEC-06 was about — see docs/releasing.md."; exit 1; }

# Prove it. The probe file must exist first: `signer sign` checks the password
# before it opens the file, so a missing file fails with "No such file" — a
# failure that looks exactly like success to anyone reading only the exit code.
probe="$(mktemp -t tn_probe.XXXXXX)"
echo preflight > "$probe"
cleanup() { rm -f "$probe" "$probe.sig"; }
trap cleanup EXIT

echo "Verifying the passphrase against the key…"
if ! (cd "$HERE/apps/desktop" && npx tauri signer sign -f "$KEY" -p "$PASS" "$probe") >/tmp/tn_setsecret.log 2>&1; then
  echo
  echo "✗ That passphrase cannot sign with this key:"
  sed -e 's/^/    /' /tmp/tn_setsecret.log | head -4
  rm -f /tmp/tn_setsecret.log
  echo
  echo "Either the passphrase is wrong, or the key is not the one you think."
  echo "To start over — this replaces the key, so the public key in"
  echo "tauri.conf.json must be updated to match (ask Claude, or copy"
  echo "$KEY.pub into plugins.updater.pubkey):"
  echo "    cd apps/desktop && npx tauri signer generate -w $KEY -f"
  exit 1
fi
rm -f /tmp/tn_setsecret.log
echo "✓ Passphrase verified — it signs with this key."

# printf, not echo: no trailing newline. The newline is the bug this script
# exists to prevent.
printf %s "$PASS" | gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD -R "$REPO"
unset PASS
echo "✓ TAURI_SIGNING_PRIVATE_KEY_PASSWORD set on $REPO."
echo
gh secret list -R "$REPO"
echo
echo "The release preflight will re-check this on every platform before compiling."
