#!/usr/bin/env python3
"""Verify a Tauri updater signature against the pubkey in tauri.conf.json.

    verify-updater-sig.py <file> <signature> <pubkey>

<signature> is the `.sig` file (or the `signature` string from latest.json),
<pubkey> is `plugins.updater.pubkey` from tauri.conf.json. Both are base64 of a
minisign text file, which is how Tauri stores them. Exits 0 only when the
file's signature and the trusted-comment signature both verify under that key.

Standard library only, so it runs unchanged on the Linux, Windows and macOS
smoke runners, none of which ship minisign. Ed25519 below is the RFC 8032
reference verification. The Smoke workflow checks this script against the real
`minisign` binary on Linux and makes sure it rejects a tampered file, so it
cannot quietly turn into a check that always passes.
"""

import base64
import hashlib
import sys

P = 2**255 - 19
Q = 2**252 + 27742317777372353535851937790883648493
D = -121665 * pow(121666, P - 2, P) % P
SQRT_M1 = pow(2, (P - 1) // 4, P)


def _add(a, b):
    x = (a[1] - a[0]) * (b[1] - b[0]) % P
    y = (a[1] + a[0]) * (b[1] + b[0]) % P
    c = 2 * a[3] * b[3] * D % P
    d = 2 * a[2] * b[2] % P
    e, f, g, h = y - x, d - c, d + c, y + x
    return (e * f % P, g * h % P, f * g % P, e * h % P)


def _mul(s, pt):
    acc = (0, 1, 1, 0)
    while s:
        if s & 1:
            acc = _add(acc, pt)
        pt = _add(pt, pt)
        s >>= 1
    return acc


def _x(y, sign):
    if y >= P:
        return None
    x2 = (y * y - 1) * pow(D * y * y + 1, P - 2, P) % P
    if x2 == 0:
        return None if sign else 0
    x = pow(x2, (P + 3) // 8, P)
    if (x * x - x2) % P:
        x = x * SQRT_M1 % P
    if (x * x - x2) % P:
        return None
    return P - x if (x & 1) != sign else x


def _point(b):
    n = int.from_bytes(b, "little")
    y, sign = n & ((1 << 255) - 1), n >> 255
    x = _x(y, sign)
    return None if x is None else (x, y, 1, x * y % P)


_GY = 4 * pow(5, P - 2, P) % P
G = (_x(_GY, 0), _GY, 1, _x(_GY, 0) * _GY % P)


def ed25519_verify(pub, msg, sig):
    a, r = _point(pub), _point(sig[:32])
    s = int.from_bytes(sig[32:], "little")
    if a is None or r is None or s >= Q:
        return False
    h = int.from_bytes(hashlib.sha512(sig[:32] + pub + msg).digest(), "little") % Q
    lhs, rhs = _mul(s, G), _add(r, _mul(h, a))
    return (lhs[0] * rhs[2] - rhs[0] * lhs[2]) % P == 0 and (lhs[1] * rhs[2] - rhs[1] * lhs[2]) % P == 0


def _lines(b64_or_text):
    text = b64_or_text.strip()
    if not text.startswith("untrusted comment:"):
        text = base64.b64decode(text).decode()
    return [line for line in text.splitlines() if line.strip()]


def main(path, sig_arg, pubkey_arg):
    try:
        with open(sig_arg) as f:
            sig_arg = f.read()
    except OSError:
        pass  # Not a path: the signature string itself, as in latest.json.
    pk = base64.b64decode(_lines(pubkey_arg)[1])
    sig_lines = _lines(sig_arg)
    sig = base64.b64decode(sig_lines[1])
    trusted = sig_lines[2]
    global_sig = base64.b64decode(sig_lines[3])
    if pk[:2] != b"Ed" or len(pk) != 42:
        sys.exit("pubkey is not a minisign Ed25519 key")
    if sig[2:10] != pk[2:10]:
        sys.exit(f"signed by key {sig[2:10][::-1].hex().upper()}, expected {pk[2:10][::-1].hex().upper()}")
    with open(path, "rb") as f:
        data = f.read()
    if sig[:2] == b"ED":  # prehashed, which is what `tauri signer` writes
        data = hashlib.blake2b(data).digest()
    elif sig[:2] != b"Ed":
        sys.exit(f"unknown signature algorithm {sig[:2]!r}")
    if not ed25519_verify(pk[10:], data, sig[10:]):
        sys.exit(f"BAD signature for {path}")
    if not trusted.startswith("trusted comment: "):
        sys.exit("signature has no trusted comment")
    if not ed25519_verify(pk[10:], sig[10:] + trusted[len("trusted comment: "):].encode(), global_sig):
        sys.exit(f"BAD trusted-comment signature for {path}")
    print(f"OK {path} — {trusted}")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    main(*sys.argv[1:])
