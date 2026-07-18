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

Windows installers are unsigned unless you add an Authenticode certificate, so
SmartScreen shows "Windows protected your PC" and an unknown publisher.

Read this before spending anything, because signing buys less here than the
Apple account below does:

- **A standard (OV) certificate does not stop the warning.** It puts a real
  publisher name on the installer, but SmartScreen keeps warning until the file
  earns download reputation. Reputation attaches to the file, so it resets on
  every release — which, at this project's release cadence, means most users
  keep seeing it anyway. Only an **EV** certificate is trusted on first run.
- **Azure Artifact Signing** (formerly Trusted Signing) is the cheap option at
  ~$10/month, and it is OV — same reputation wait. It also has an eligibility
  gate worth checking *first*: public-trust certificates are limited to
  organisations in the US, Canada, the EU and the UK, and to individual
  developers in the US and Canada only. If you are outside those, this option is
  closed regardless of budget.

So the honest ordering is: EV certificate (works immediately, costs the most and
usually requires a registered company), or stay unsigned and lean on the
published checksums, which prove more than the dialog does either way. What is
*not* on the table is paying a little and having the warning go away.

Checked July 2026 — Microsoft moves this around, so verify before buying:
<https://learn.microsoft.com/en-us/azure/artifact-signing/faq>

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

`tauri signer generate` writes the private key **world-readable** (`0644`), and
it stayed that way here until someone looked. Any process running as any user on
the machine could read it. Fix it, and check rather than assume:

```sh
chmod 700 ~/.tuplenest-keys && chmod 600 ~/.tuplenest-keys/tuplenest.key
stat -f '%Sp %N' ~/.tuplenest-keys/*        # expect -rw------- on the private key
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
echo probe > /tmp/probe.txt          # ← the file must exist; see below
npx tauri signer sign -f ~/.tuplenest-keys/tuplenest.key -p "" /tmp/probe.txt
rm -f /tmp/probe.txt /tmp/probe.txt.sig
```

Read the **error**, not the exit code. It must say:

```
incorrect updater private key password: Wrong password for that key
```

**Create the file first, and check which error you got.** Skip the `echo` and
the command still fails — with `failed to open data file /tmp/probe.txt` — and
a failure is what you were hoping for, so it reads as a pass. It is not. That
error means the key was unlocked and *then* the file was missing, which is what
an unprotected key does. Verified against a throwaway `--ci` key: no file →
"No such file or directory"; file present → signs happily. A check that reports
success when the thing it guards against is present is worse than no check.

If you see `Your file was signed successfully`, the key is unprotected
regardless of what its header says.

Two flags to avoid when generating. `-p <PASSWORD>` puts the passphrase in your
shell history and in `ps`. `--ci` skips the prompt and generates an unprotected
key — it does print `Warn Generating new private key without password`, but it
is one line in a wall of output and the resulting file still says
`rsign encrypted secret key`. **`--ci` also triggers off a `CI` environment
variable**, so it can happen without you typing it: check `echo $CI` is empty
first. That is the likeliest way the first key ended up unprotected.

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

### Anti-rollback: what protects against a forced downgrade, and what doesn't

The updater verifies the bundle's **minisign signature** and installs only a
**newer** version than the one running. Neither stops the sharpest rollback
attack: an attacker who controls the release host serves a `latest.json` that
advertises a high version but points the download at a genuine, still-signed
**old** build. The signature check passes (it is a real signed artifact) and
the version check passes (the advertised number is higher), so the user is
rolled back to an authentic-but-vulnerable build. This is possible because the
updater trusts the version string in `latest.json`, which is **unsigned**.

What is in place:

- **A compiled-in version floor** (`MIN_UPDATE_VERSION` in
  `apps/desktop/src/lib/version.ts`). The app refuses to offer any update whose
  advertised version is below it. Bump it whenever a release line must never be
  rolled back past. This stops an *honestly-advertised* downgrade; it does not
  stop the advertise-high/ship-old attack above, because there the advertised
  number is high.

- **The real trust anchor is the GitHub account and release-asset integrity.**
  Keep 2FA on; protect the release/tag; treat the signing-workflow Actions as
  load-bearing (they are SHA-pinned for this reason). If the account is
  compromised, the attacker can serve a validly-signed old build regardless of
  the floor — so account security *is* the anti-rollback control here.

- **Not yet done:** signing the version manifest itself (which would close the
  gap) is not supported by tauri-plugin-updater without a custom updater. If
  that becomes a priority, it is the correct fix; until then this section is the
  honest statement of the residual risk.

### What is not recoverable

- **A lost signing key.** Nothing you publish afterwards will be accepted by
  any existing install. Back it up somewhere that is not this laptop.
- **A leaked signing key.** An attacker who also controls a network path can
  sign updates your users will accept. Rotating the key does not help existing
  installs — their public key is baked into the binary they already have. They
  would have to download a new build by hand, which means telling them.

### Rehearse it

Ten minutes now, versus finding out during an incident.

**This drill used to say "publish a prerelease", which made it a test that could
not fail.** A prerelease is never `latest`, so
`releases/latest/download/latest.json` 404s before the drill and 404s after it —
you would watch the endpoint not change and call that a pass. While every
release is a prerelease (as now, through the betas), the updater path is inert
and there is nothing to rehearse; the endpoint returning 404 is the designed
state, not a fault.

So the drill only means something once a **normal, non-prerelease** release
exists — and then it is:

```sh
# 0. Precondition: a real release exists and IS latest.
gh release list --json tagName,isLatest -q '.[] | select(.isLatest)'
curl -sI -L https://github.com/talaatmagdyx/TupleNest/releases/latest/download/latest.json | head -1
#    -> expect 200, and note the version inside it

# 1. Publish the drill as a NORMAL release, so it actually takes `latest`.
#    Use a version BELOW the shipped one: installed copies compare versions and
#    refuse anything not newer, so nobody can be updated onto the drill.
gh release create v0.0.1-rollback-drill --title "rollback drill" --notes "temporary" --latest

# 2. Prove it moved. If this step does not change, the drill is not testing
#    anything and something is wrong with your assumptions, not the endpoint.
gh release list --json tagName,isLatest -q '.[] | select(.isLatest)'

# 3. Roll it back the way you would in an incident.
gh release edit v0.0.1-rollback-drill --draft

# 4. Prove it reverted to the previous release.
gh release list --json tagName,isLatest -q '.[] | select(.isLatest)'

# 5. Clean up.
gh release delete v0.0.1-rollback-drill --yes
git push --delete origin v0.0.1-rollback-drill 2>/dev/null || true
```

Steps 2 and 4 are the drill. Steps 1 and 3 are just the setup — if you skip the
proofs, you have rehearsed typing, not recovering.
