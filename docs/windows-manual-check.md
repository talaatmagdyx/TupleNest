# Windows manual check

Twelve steps, about fifteen minutes, on a real Windows machine.

## Why this exists

CI installs the `.msi`, launches the binary and asserts a window opens. It
stops there, and not by omission: `tauri-driver` reaches a Windows app through
msedgedriver, which needs the WebView2 remote-debugging port. Tauri opens that
port with the `devtools` feature — automatic in debug builds, absent in
release. Driving a debug build would test a binary nobody ships; enabling
devtools in a release build so a test can pass would hand users a debugging
surface to keep CI green. Neither is worth it, so the UI on Windows is checked
by hand.

Everything below is therefore something no automated check in this repository
covers. Where a step exercises a Windows-specific code path rather than shared
logic, it says so — those are the ones worth doing carefully.

## Before you start

- A Windows 10 or 11 machine, ideally one that has never run TupleNest.
- A PostgreSQL server you can reach. Local is fine.
- The `.msi` from the release you are checking:
  <https://github.com/talaatmagdyx/TupleNest/releases>

Record the release tag and your Windows version — a result is only useful if
you can say what it was a result *about*.

---

## Install

**1. Checksum the download.**
```powershell
Get-FileHash .\TupleNest_0.1.0_x64_en-US.msi -Algorithm SHA256
```
Compare against `SHA256SUMS` on the release page. It should match exactly.
Stop if it doesn't.

**2. Run the installer.**
Expect a SmartScreen warning — the installers are unsigned, and this is
documented on the download page. "More info" → "Run anyway".

☐ The warning appears and is dismissible
☐ Install completes without a further prompt

**3. On Windows 10 only — WebView2.**
Windows 11 bundles the WebView2 Runtime; Windows 10 usually does not, and the
installer downloads it, so the machine needs internet during install. If you
are on Windows 10 without it, confirm the install still succeeds.

☐ Installed without a manual WebView2 step

---

## First launch

**4. Start it from the Start menu**, not from a terminal — that is how a user
will, and it exercises the shortcut the installer wrote.

☐ A window appears within a few seconds
☐ The window is *painted* — sidebar, editor, status bar — not white or blank
☐ The status bar names the build (commit and date) at the bottom right

A blank window here means WebView2 initialised badly. That is the single most
important thing on this page: it is the failure CI cannot see past.

**5. Look at the empty state.** No connections yet.

☐ The connection list offers "New connection" rather than looking broken
☐ No error toast on a clean first run

---

## Connect — the Windows-specific path

Steps 6 and 7 are the ones that most justify this document. Saving a password
writes to **Windows Credential Manager** through a different implementation
than macOS Keychain or the Linux Secret Service, and only the Linux one is
covered by an automated end-to-end test.

**6. Create a connection.** Fill host, port, database, username and a real
password. Set TLS to match your server — `prefer` for a local one without a
certificate. Press **Test** first.

☐ Test reports the server version, not merely "ok"
☐ Then **Save & Connect** connects

**7. Confirm the password actually persisted.**
Quit TupleNest completely, reopen it, and connect again *without* retyping the
password.

☐ It connects — the password came back out of Credential Manager
☐ Optional: it appears under Control Panel → Credential Manager → Windows
  Credentials

If this fails, the credential store is broken on Windows and nothing else on
this page matters as much.

---

## Use it

**8. Run a query.** `select 42 as answer;` then Ctrl+Enter.

☐ A grid appears with the column `answer` and a cell reading `42`
☐ The footer reports 1 row and a duration

The cell is worth looking at specifically: under a headless display the
virtualized grid renders its header and no cells, so CI cannot assert this.

**9. Browse the schema tree.** Expand a schema, then a table.

☐ Schemas list
☐ Columns and types appear under a table

**10. Import a CSV.** Any file will do; a large one is more interesting.

☐ Preview says "first 500 rows sampled"
☐ Progress advances as a percentage of the file
☐ The final count matches the file's real row count

**11. Generate a migration.** Command palette (Ctrl+K) → "Compare schemas…",
pick two schemas that differ, press **Compare**, then **Generate migration**.

☐ It opens on the *Schema diff* pane, not Find usages
☐ The header says "bring `<left>` in line with `<right>`"
☐ Statements name the **left** schema
☐ `DROP` statements come back commented out, badged *destructive*

**12. Uninstall.** Settings → Apps → TupleNest.

☐ Removes cleanly
☐ `C:\Program Files\TupleNest` is gone

---

## Reporting

Open an issue with the release tag, your Windows version, which boxes failed,
and the app's own log if anything misbehaved:

```
%APPDATA%\app.tuplenest.desktop\logs
%APPDATA%\app.tuplenest.desktop\crashes
```

(The folder is the bundle identifier, not the product name. Paste the path into
Explorer's address bar.)

A step that failed is more useful than a page of ticks. If everything passed,
that is worth saying too — it is the first time anyone has confirmed the
Windows build is usable rather than merely launchable.
