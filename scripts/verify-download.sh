#!/usr/bin/env bash
# verify-download.sh FILE... — check downloaded release artifacts before
# installing them. Run from the directory that holds them and SHA256SUMS.
#
# For each FILE, three independent checks, each answering a different question:
#
#   SHA256SUMS   are these the bytes the Release workflow published?
#   updater .sig would the updater accept them? Verified against the pubkey in
#                tauri.conf.json, the key every installed copy carries. Only
#                where a .sig exists: the .dmg has none (the updater uses the
#                .app.tar.gz instead), and a dev build's staged files have none.
#   attestation  did they come out of release.yml in this repository, from the
#                tag's commit? Signed by Sigstore, so it holds even if someone
#                with write access to the release replaced both a file and
#                SHA256SUMS.
#
# Needs: GH_TOKEN, GH_REPO, TAG; RUN_ID for a dev build. No secrets.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
pubkey=$(jq -r .plugins.updater.pubkey "$here/../apps/desktop/src-tauri/tauri.conf.json")
case "$(uname -s)" in
  MINGW* | MSYS*) py=python ;; # Windows: `python3` there is the Store stub
  *) py=python3 ;;
esac
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }

# A dev build is dispatched from a branch, so its provenance names no tag.
attest_args=(--repo "$GH_REPO" --signer-workflow "$GH_REPO/.github/workflows/release.yml")
[ -z "${RUN_ID:-}" ] && attest_args+=(--source-ref "refs/tags/$TAG")

for f in SHA256SUMS "$@"; do
  echo "== $f"
  if [ "$f" != SHA256SUMS ]; then
    line=$(awk -v f="$f" '$2 == f || $2 == "*" f' SHA256SUMS)
    [ -n "$line" ] || { echo "::error::$f is not listed in SHA256SUMS"; exit 1; }
    printf '%s\n' "$line" | sha256 -c -

    if [ -f "$f.sig" ]; then
      "$py" -I "$here/verify-updater-sig.py" "$f" "$f.sig" "$pubkey"
    else
      echo "no updater signature for $f (none is published for it, or this is a dev build) — skipped"
    fi
  fi

  # SHA256SUMS itself is a provenance subject, so a rewritten checksum file
  # cannot vouch for a rewritten installer.
  gh attestation verify "$f" "${attest_args[@]}" --format json \
    --jq '.[0].verificationResult.signature.certificate | "attested: \(.buildSignerURI)"'
done
