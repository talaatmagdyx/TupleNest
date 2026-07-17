# Releasing TupleNest

## How a release is built

Push a `v*` tag. `.github/workflows/release.yml` builds every platform on its own
runner and opens a draft GitHub release with the installers attached:

| Runner | Produces |
| --- | --- |
| `macos-latest` → `aarch64-apple-darwin` | `.app`, `.dmg` (Apple Silicon) |
| `macos-latest` → `x86_64-apple-darwin` | `.app`, `.dmg` (Intel) |
| `ubuntu-22.04` | `.deb`, `.rpm`, `.AppImage` |
| `windows-latest` | `.msi`, `.exe` (NSIS) |

A Tauri app cannot be usefully cross-compiled — Windows needs MSVC and WebView2,
Linux needs webkit2gtk, macOS needs the Apple toolchain — so there is no script
that builds all four from one machine, and there is no point writing one. The
matrix is the release process.

Ubuntu **22.04**, not `latest`: the glibc on the build machine is the oldest one
the binary will run on. Building on a newer Ubuntu silently drops support for
older distros.

### Secrets the workflow expects

| Secret | Needed for | Without it |
| --- | --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | updater artifacts, every platform | the build fails **after** producing the installers |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | as above | the build fails at signing — the key is passphrase-protected, so this is **not** optional |
| `APPLE_*` (see below) | notarizing the macOS builds | mac builds are ad-hoc signed; Gatekeeper warns |

Windows installers are unsigned unless you add an Authenticode certificate;
SmartScreen will warn on first run. That needs a code-signing cert (an EV one to
avoid the reputation wait) and is the Windows equivalent of the Apple account
below — the same kind of problem, the same kind of money.

---

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

It is passphrase-protected (key id `C35ED434C8AECC1B`). The first keypair was
not, and this note used to tell you to fix that before shipping — which is now
done, before anything shipped, because it could not have been done after.

> **If you lose this private key *or its passphrase*, existing installs can
> never be updated again.** Back both up somewhere durable and separate from
> this laptop (password manager / offline copy). The passphrase is not a
> recovery mechanism for the key; losing either loses both.

### Checking the passphrase is real

The file header reads `rsign encrypted secret key` **whether or not there is a
passphrase** — minisign writes it either way, so reading the key tells you
nothing. The first keypair had that header and no password. Test it instead:

```sh
cd apps/desktop
npx tauri signer sign -f ~/.tuplenest-keys/tuplenest.key -p "" /tmp/probe.txt
```

This must **fail** with `Wrong password for that key`. If it succeeds, the key
is unprotected regardless of what the header says. (Delete the probe and any
`.sig` afterwards.)

Two flags to avoid when generating: `-p <PASSWORD>` puts the passphrase in your
shell history and in `ps`, and `--ci` skips the prompt — which yields an empty
passphrase and a file that still claims to be encrypted. `--ci` also triggers
off a `CI` environment variable, so check `echo $CI` is empty first. That is the
likeliest way the first key ended up unprotected.

To sign update artifacts during a build:

```sh
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tuplenest-keys/tuplenest.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD='your passphrase'
```

Both are required now — the build fails without the second, rather than
producing an unsigned update. In CI they are repository secrets (see the table
above); locally, prefer reading the passphrase from your password manager over
leaving it in a shell profile.

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

`plugins.updater.endpoints` points at the release itself:

```
https://github.com/talaatmagdyx/TupleNest/releases/latest/download/latest.json
```

There is no server to run and no domain to keep alive. `tauri-action` builds
that `latest.json` from the per-platform `.sig` files and uploads it beside the
installers (`includeUpdaterJson: true` in the release workflow), so it looks
like this without anyone writing it:

```json
{
  "version": "1.3.0",
  "notes": "What changed",
  "pub_date": "2026-07-15T00:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "<contents of the .sig file>",
      "url": "https://github.com/talaatmagdyx/TupleNest/releases/download/v1.3.0/TupleNest_1.3.0_aarch64.app.tar.gz"
    }
  }
}
```

**Releases are created as drafts, and a draft is not `latest`.** So the URL
above 404s — and every installed copy sees no update — until you press Publish.
That is the intended sequence rather than a bug: the release becomes public and
becomes visible to the updater at the same moment. It does mean a draft release
is never a live test of the updater; the first real test is the first publish.

The app verifies that signature against the public key baked into the binary, so
a compromised release host still cannot push code to your users. This is what
makes hosting on someone else's domain acceptable: GitHub can serve the bytes,
but only the holder of the private key can make the app accept them.

## Safety behaviour

- The update check runs once at startup and never blocks the UI.
- A failed check (offline, no endpoint, dev build) is swallowed — no dialog.
- **Updating is refused while a transaction is open**, so an in-flight
  transaction is never lost to a relaunch.

## 4. Rolling back a bad release

Write this down before you need it, not while you need it.

The updater has **no downgrade path**. Tauri compares versions and installs
only what is newer, so you cannot push 1.2.0 to fix 1.3.0. Everything below
follows from that.

### If it is still a draft

Nothing has shipped. Delete the draft release and the tag:

```sh
gh release delete v1.3.0 --yes
git push --delete origin v1.3.0
git tag -d v1.3.0
```

### If it is published — stop the bleeding first

`latest.json` is what installed copies read. Removing it is the fastest way to
stop new machines taking the update; it takes effect on the next check.

```sh
# Un-publish. The previous release becomes `latest` again.
gh release edit v1.3.0 --draft

# Or, if you want the release page to stay up but the updater to go quiet:
gh release delete-asset v1.3.0 latest.json
```

An installed copy that already updated stays on the bad version. There is no
mechanism to pull it back, which is the whole reason to publish deliberately.

### Then ship forward, never back

Fix, bump to a version **higher** than the bad one (1.3.1, not 1.2.x), tag, and
publish. Anyone who took 1.3.0 gets 1.3.1 on their next check; anyone who did
not goes straight from 1.2.x to 1.3.1.

If the bad version must be made unusable rather than merely superseded, that is
a code change in 1.3.1 — a startup check — not a release operation. Prefer not
to need it.

### What is not recoverable

- **A lost signing key.** Nothing you publish afterwards will be accepted by
  any existing install. Back it up somewhere that is not this laptop.
- **A leaked signing key.** An attacker who also controls a network path can
  sign updates your users will accept. Rotating the key does not help existing
  installs — their public key is baked into the binary they already have. They
  would have to download a new build by hand, which means telling them.

### Rehearse it

Publish a `v0.0.1-rollback-drill` prerelease, un-publish it, and confirm
`releases/latest/download/latest.json` goes back to what it was. Ten minutes
now, versus finding out during an incident.
