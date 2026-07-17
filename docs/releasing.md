# Releasing TupleNest (macOS)

There are **two independent signatures** in play. They solve different problems
and neither replaces the other:

| | Apple code signing + notarization | Tauri updater signing |
|---|---|---|
| Protects | first launch — Gatekeeper trusts the app | auto-updates — the app trusts the payload |
| Needs | Apple Developer account ($99/yr) | a minisign keypair (free, already generated) |
| Key | Developer ID certificate in your keychain | `~/.tuplenest-keys/tuplenest.key` |
| Without it | "unidentified developer" warning | updates are refused |

## 1. Apple code signing + notarization

**This is the part that needs your Apple Developer account.** Nothing else can
remove the Gatekeeper warning — not a workaround, not a config flag. An unsigned
build will always warn on machines other than the one that built it.

### One-time setup

1. Enrol at <https://developer.apple.com/programs/> ($99/yr).
2. In Xcode → Settings → Accounts, or on developer.apple.com, create a
   **Developer ID Application** certificate and install it (double-click the
   downloaded `.cer`).
3. Confirm it landed:

   ```sh
   security find-identity -v -p codesigning
   # → 1) ABC123… "Developer ID Application: Your Name (TEAMID)"
   ```

4. Create an **app-specific password** at <https://appleid.apple.com> →
   Sign-In and Security → App-Specific Passwords. This is *not* your Apple ID
   password.

### Each release

```sh
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="abcd-efgh-ijkl-mnop"   # app-specific password
export APPLE_TEAM_ID="TEAMID"

./scripts/release-macos.sh
```

The script refuses to continue if any credential is missing or the certificate
isn't in the keychain — it will not quietly produce an unsigned build. It
verifies the signature, submits to Apple, waits, staples the ticket, and runs a
final Gatekeeper assessment.

Hardened runtime entitlements live in `apps/desktop/src-tauri/entitlements.plist`
and are deliberately minimal: outbound network (databases, SSH) and
user-selected file read/write (CA certs, key files, CSV export). We do **not**
request `allow-unsigned-executable-memory` or `disable-library-validation`.

## 2. Updater signing

A keypair already exists:

```
~/.tuplenest-keys/tuplenest.key       ← private. Never commit. Back it up.
~/.tuplenest-keys/tuplenest.key.pub   ← public; already in tauri.conf.json
```

> **Note:** it was generated without a password for convenience. Before you ship
> publicly, regenerate it with one:
> `npx tauri signer generate -w ~/.tuplenest-keys/tuplenest.key`
> and paste the new public key into `plugins.updater.pubkey`.
>
> **If you lose this private key, existing installs can never be updated again.**
> Back it up somewhere durable (password manager / offline copy).

To sign update artifacts during a build:

```sh
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tuplenest-keys/tuplenest.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""   # if you set one, put it here
```

`bundle.createUpdaterArtifacts` is on, so the build emits a `.app.tar.gz` plus a
`.sig` next to the `.dmg`.

### Building without the key

Because those artifacts must be signed, a plain `npm run tauri build` **exits 1**
without `TAURI_SIGNING_PRIVATE_KEY` — which is everyone who is not doing a
release. The failure is easy to misread: the `.app` and `.dmg` are produced
first and only the signing step fails, so the bundles are sitting there looking
finished while the command reports failure.

For a local build, skip the updater artifacts:

```sh
cd apps/desktop && npm run build:app
```

That produces the same `.app` and `.dmg`, exits 0, and needs no key. Use the
key, or `scripts/release-macos.sh`, only when you are actually publishing an
update.

## 3. The update endpoint

`plugins.updater.endpoints` currently points at:

```
https://releases.tuplenest.app/{{target}}/{{arch}}/{{current_version}}
```

**That host does not exist yet** — until it does, the in-app check fails
silently by design (the user is never nagged about a failed check). Point it at
whatever you actually host; a GitHub Releases `latest.json` is the usual choice:

```json
{
  "version": "1.3.0",
  "notes": "What changed",
  "pub_date": "2026-07-15T00:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "<contents of the .sig file>",
      "url": "https://github.com/you/tuplenest/releases/download/v1.3.0/TupleNest_1.3.0_aarch64.app.tar.gz"
    }
  }
}
```

The app verifies that signature against the public key baked into the binary, so
a compromised release host still cannot push code to your users.

## Safety behaviour

- The update check runs once at startup and never blocks the UI.
- A failed check (offline, no endpoint, dev build) is swallowed — no dialog.
- **Updating is refused while a transaction is open**, so an in-flight
  transaction is never lost to a relaunch.
