#!/usr/bin/env bash
#
# Create the self-signed code-signing certificate macOS builds are signed with,
# so every version of TupleNest has the same identity.
#
# Why: a build with no certificate is ad-hoc signed, and each one gets a new
# signature. The keychain remembers which app saved a password by that
# signature, so after every update macOS asks "TupleNest wants to use your
# confidential information stored in app.tuplenest.desktop" and wants the
# login password. Signed with one certificate, every build matches the same
# designated requirement (bundle id + this certificate), and after one last
# "Always Allow" the prompt does not come back.
#
# This does NOT replace an Apple Developer ID: Gatekeeper still warns on first
# launch, and nothing is notarized. It only fixes the keychain prompt.
#
# What it does, run once on your Mac:
#   1. makes a 10-year certificate and key with code-signing usage, in a
#      folder only you can read (default ~/.tuplenest-keys/macos-signing/);
#   2. imports it into your login keychain, usable by codesign only, so local
#      builds can sign with it (macOS may ask for your login password here);
#   3. sets the three secrets on the `release` environment, so CI signs the
#      macOS bundles with it.
#
# The .p12 password is read with `read -s` and never written to disk or argv
# (except openssl's -passout, which reads it from an environment variable).
#
# Usage:  ./scripts/make-macos-cert.sh
#
set -euo pipefail

NAME="${TUPLENEST_CERT_NAME:-TupleNest Self-Signed}"
DIR="${TUPLENEST_CERT_DIR:-$HOME/.tuplenest-keys/macos-signing}"
REPO="${TUPLENEST_REPO:-talaatmagdyx/TupleNest}"
# The system LibreSSL writes a .p12 the macOS Security framework can import;
# OpenSSL 3's default AES-256 encoding is refused by older macOS.
OPENSSL=/usr/bin/openssl

command -v gh >/dev/null || { echo "gh is not installed."; exit 1; }
[ -e "$DIR/cert.p12" ] && { echo "$DIR/cert.p12 already exists; delete it first to make a new one."; exit 1; }

read -r -s -p "Choose a password for the .p12 file: " P12_PASS; echo
[ -n "$P12_PASS" ] || { echo "An empty password is not accepted by 'security import'."; exit 1; }
export P12_PASS

umask 077
mkdir -p "$DIR"
cat > "$DIR/cert.cnf" <<EOF
[req]
distinguished_name = dn
prompt = no
x509_extensions = ext
[dn]
CN = $NAME
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
EOF

"$OPENSSL" req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -config "$DIR/cert.cnf" -keyout "$DIR/key.pem" -out "$DIR/cert.pem" 2>/dev/null
"$OPENSSL" pkcs12 -export -name "$NAME" -inkey "$DIR/key.pem" -in "$DIR/cert.pem" \
  -out "$DIR/cert.p12" -passout env:P12_PASS
rm -f "$DIR/key.pem"
echo "Certificate: $DIR/cert.p12 (SHA-1 $("$OPENSSL" x509 -in "$DIR/cert.pem" -noout -fingerprint -sha1 | cut -d= -f2))"

# -T: only codesign may use the key without asking.
security import "$DIR/cert.p12" -k "$HOME/Library/Keychains/login.keychain-db" \
  -P "$P12_PASS" -T /usr/bin/codesign >/dev/null
echo "Imported into the login keychain for codesign."

base64 < "$DIR/cert.p12" | tr -d '\n' | gh secret set APPLE_CERTIFICATE --env release --repo "$REPO"
printf %s "$P12_PASS" | gh secret set APPLE_CERTIFICATE_PASSWORD --env release --repo "$REPO"
printf %s "$NAME" | gh secret set APPLE_SIGNING_IDENTITY --env release --repo "$REPO"
unset P12_PASS
echo
echo "Done. Release builds now sign macOS bundles as \"$NAME\"."
echo "Local builds:  APPLE_SIGNING_IDENTITY=\"$NAME\" npm run build:app"
echo "Keep $DIR/cert.p12 and its password: a new certificate means one more keychain prompt for everyone."
