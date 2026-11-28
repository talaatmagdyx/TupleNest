#!/usr/bin/env bash
# check-update-manifest.sh — is TAG's update actually deliverable?
#
# What an installed copy does to update: fetch latest.json from the endpoint in
# tauri.conf.json, pick the entry for its platform, download `url` (with
# `Accept: application/octet-stream`, which is what turns a GitHub API asset
# URL into the file rather than JSON about it) and check `signature` against
# the pubkey it was built with. This replays every one of those steps without
# the app, for every platform in the manifest.
#
# What it cannot do is the last mile: install the previous version, let it
# find this one, replace itself and restart. That needs a desktop session, a
# real older install and an app that can be told to check now and then
# observed restarting. None of that is available headless, so it is not
# attempted here and nothing here claims it.
#
# Needs: GH_TOKEN, GH_REPO, TAG. No secrets. Requires `minisign` on PATH, used
# to cross-check scripts/verify-updater-sig.py.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
conf="$here/../apps/desktop/src-tauri/tauri.conf.json"
pubkey=$(jq -r .plugins.updater.pubkey "$conf")
endpoint=$(jq -r '.plugins.updater.endpoints[0]' "$conf")
# The updater compares the app version, not the tag: v0.1.2-beta.13 -> 0.1.2,
# the same rule release.yml enforces.
want="${TAG#v}"; want="${want%%-*}"

work=$(mktemp -d)
cd "$work"
gh release download "$TAG" -p latest.json -O manifest.json

echo "== the release's latest.json"
jq -e --arg v "$want" '.version == $v' manifest.json >/dev/null ||
  { echo "::error::latest.json says version $(jq -r .version manifest.json), tag $TAG means $want"; exit 1; }
echo "version $want"
# The keys the updater looks up first ({os}-{arch}); the -deb, -msi and other
# installer-specific keys are checked below along with everything else.
for p in darwin-aarch64 darwin-x86_64 linux-x86_64 windows-x86_64; do
  jq -e --arg p "$p" '.platforms[$p] | (.url | length > 0) and (.signature | length > 0)' manifest.json >/dev/null ||
    { echo "::error::latest.json has no url and signature for $p"; exit 1; }
done

# minisign wants the bare key line, not the base64 of the whole file.
pk_line=$(printf %s "$pubkey" | base64 -d | sed -n 2p)
n=0
while read -r key url; do
  echo "== $key"
  # Unauthenticated, as an installed copy is.
  type=$(curl -sSfIL -H 'Accept: application/octet-stream' -o /dev/null -w '%{content_type}' "$url") ||
    { echo "::error::$key: $url does not resolve"; exit 1; }
  case "$type" in application/json*) echo "::error::$key: $url serves JSON, not the file"; exit 1 ;; esac
  echo "HEAD ok ($type)"

  file="asset-$(printf %s "$url" | sha256sum | cut -c1-16)"
  [ -f "$file" ] || curl -sSfL -H 'Accept: application/octet-stream' -o "$file" "$url"
  sig=$(jq -r --arg k "$key" '.platforms[$k].signature' manifest.json)
  python3 -I "$here/verify-updater-sig.py" "$file" "$sig" "$pubkey"
  # The same check by the reference implementation, so the script above
  # cannot drift into accepting what minisign would not.
  printf %s "$sig" | base64 -d > "$file.minisig"
  minisign -Vq -m "$file" -x "$file.minisig" -P "$pk_line"
  n=$((n + 1))
done < <(jq -r '.platforms | to_entries[] | "\(.key) \(.value.url)"' manifest.json)
echo "$n platform entries resolve and verify"

# And the verifier must say no. A check that cannot fail is not a check.
last=$(ls asset-* | grep -v minisig | head -1)
cp "$last" tampered && printf x | dd of=tampered bs=1 seek=4096 conv=notrunc 2>/dev/null
if python3 -I "$here/verify-updater-sig.py" tampered "$last.minisig" "$pubkey" 2>/dev/null; then
  echo "::error::verify-updater-sig.py accepted a tampered file"; exit 1
fi
echo "tampered file rejected"

echo "== the updater endpoint: $endpoint"
code=$(curl -sSL -o endpoint.json -w '%{http_code}' "$endpoint" || true)
if [ "$code" != 200 ]; then
  # GitHub's /releases/latest never points at a prerelease, and every tag with
  # a hyphen is published as one (release.yml). So while only betas exist the
  # endpoint has nothing to serve: no installed copy is offered an update.
  if [ "$(gh release view "$TAG" --json isPrerelease --jq .isPrerelease)" = true ]; then
    echo "::warning::the updater endpoint answers $code. $TAG is a prerelease, and GitHub's releases/latest never serves one, so installed copies are not offered it. The manifest above is valid; nothing delivers it."
    exit 0
  fi
  echo "::error::the updater endpoint answers $code for a full release"; exit 1
fi
served=$(jq -r .version endpoint.json)
if [ "$served" = "$want" ]; then
  cmp -s endpoint.json manifest.json || { echo "::error::the endpoint serves a different latest.json for $want than the release holds"; exit 1; }
  echo "the endpoint serves this release's latest.json"
else
  echo "the endpoint serves $served, not $want — expected only if a newer release is published"
fi
