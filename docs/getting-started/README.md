# Getting started

## Install

Download from the [releases page](https://github.com/talaatmagdyx/TupleNest/releases).
Every platform is built from the same source by the release workflow in CI.

| Platform | Files | Notes |
|---|---|---|
| **macOS** 10.15+ | `.dmg` for Apple Silicon or Intel | Drag TupleNest into Applications and launch it from there |
| **Windows** 10+ | `.exe` (NSIS) or `.msi` | WebView2 is installed if it is missing |
| **Linux** (glibc 2.35+) | `.AppImage`, `.deb`, `.rpm` | Needs `webkit2gtk-4.1`. Saving passwords needs a keyring daemon such as GNOME Keyring or KWallet |

## First launch

The installers are not yet signed with an Apple Developer ID or a Windows
code-signing certificate, and the macOS builds are not notarized. Both need
paid certificates. Until then the OS warns once:

- **macOS** may say the app "is damaged" or can't be checked. That is
  Gatekeeper's message for a quarantined app without a trusted signature. Do
  not move it to the Trash. Remove the quarantine flag and open it again:

  ```sh
  xattr -dr com.apple.quarantine /Applications/TupleNest.app
  ```

- **Windows** SmartScreen shows "Windows protected your PC". Choose
  **More info → Run anyway**.

Because the OS can't vouch for the file, check it yourself (next section).

## Verify a download

Each release publishes a `SHA256SUMS` file. Every installer except the macOS
`.dmg` also has a minisign signature (`.sig`), which is the key the updater
checks. To check a file against the published checksum:

```sh
shasum -a 256 -c SHA256SUMS --ignore-missing
```

Releases after v0.1.0-beta.11 also carry a GitHub build-provenance
attestation. It proves the file was built by this repository's release
workflow:

```sh
gh attestation verify <downloaded-file> --repo talaatmagdyx/TupleNest
```

## Updates

At each start-up the app asks GitHub for `latest.json` on the latest *stable*
release. If a newer version exists, it offers to install it. The update is
signed, and the app checks the signature before installing. GitHub sees your
IP address and an ordinary request; no identifier is sent.

Every release so far is a pre-release, and pre-releases are never offered as
updates. While TupleNest is in beta, install a new version by downloading it.

## Your first connection

1. Choose **New connection**.
2. Pick **PostgreSQL** (host, port, database, user; TLS `verify-full` by
   default) or **SQLite** (a file path).
3. Set the environment: `dev`, `test`, `staging` or `prod`. `staging` and
   `prod` turn on the confirmations, and `prod` also turns on the audit log
   and keeps SQL out of history.
4. Tick **Read-only** if you only need to read. The database enforces it.
5. Connect, open a table from the sidebar or write a query, and press
   <kbd>⌘↵</kbd>.

Next: the [user guide](../user-guide/README.md).
