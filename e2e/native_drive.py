"""Drive the installed app with real keystrokes on Windows and macOS.

The Linux smoke test drives the app through WebDriver. There is no WebDriver
for a release build on Windows (WebView2's debugging port is off) or for
WKWebView on macOS, so on those two the smoke test only checked that a window
opened. This goes further with what both platforms do offer: keystrokes sent
to the app's window, and the app's own records on disk.

What it does:

  1. Starts the app once so it creates its store, stops it, and adds one
     connection profile to that store pointing at the PostgreSQL on this
     machine. (Typing a profile into the form would need the mouse.)
  2. Starts the app again and, through the command palette, connects to that
     profile and runs the query that is in the editor.
  3. Takes a screenshot.
  4. Passes only if the app's history holds that query as a success with one
     row, and its log says a session was opened. Both are written by the
     backend after a real round trip, so they cannot be there unless the
     keystrokes reached the app, the palette worked, the connection was made
     and the query ran.

Standard library only. Usage: native_drive.py <path to the app binary>
"""

import os
import platform
import sqlite3
import subprocess
import sys
import time

WINDOWS = platform.system() == "Windows"
PROFILE = "smoke"
QUERY = "select now(), version()"  # the text a new editor tab starts with


def data_dir() -> str:
    if WINDOWS:
        return os.path.join(os.environ["APPDATA"], "app.tuplenest.desktop")
    return os.path.expanduser("~/Library/Application Support/app.tuplenest.desktop")


def start(binary: str) -> subprocess.Popen:
    return subprocess.Popen([binary], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def stop(proc: subprocess.Popen) -> None:
    proc.terminate()
    try:
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        proc.kill()


def send(pid: int, keys: list[str]) -> None:
    """Send keystrokes to the app. Each item is `text:<chars>`, `palette`, or `enter`."""
    if WINDOWS:
        # SendKeys: ^ is Ctrl, {ENTER} is Enter. The palette is Ctrl+K here.
        script = [
            "Add-Type -AssemblyName Microsoft.VisualBasic",
            "Add-Type -AssemblyName System.Windows.Forms",
            f"[Microsoft.VisualBasic.Interaction]::AppActivate({pid})",
            "Start-Sleep -Milliseconds 800",
        ]
        for k in keys:
            if k == "palette":
                script.append('[System.Windows.Forms.SendKeys]::SendWait("^k")')
            elif k == "enter":
                script.append('[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")')
            else:
                script.append(f'[System.Windows.Forms.SendKeys]::SendWait("{k[5:]}")')
            script.append("Start-Sleep -Milliseconds 900")
        subprocess.run(["powershell", "-NoProfile", "-Command", "; ".join(script)], check=True)
    else:
        lines = [
            'tell application "System Events"',
            f"  set frontmost of (first process whose unix id is {pid}) to true",
            "  delay 0.8",
        ]
        for k in keys:
            if k == "palette":
                lines.append('  keystroke "k" using command down')
            elif k == "enter":
                lines.append("  key code 36")
            else:
                lines.append(f'  keystroke "{k[5:]}"')
            lines.append("  delay 0.9")
        lines.append("end tell")
        subprocess.run(["osascript", "-e", "\n".join(lines)], check=True)


def screenshot(path: str) -> None:
    try:
        if WINDOWS:
            ps = (
                "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; "
                "$b = [System.Windows.Forms.SystemInformation]::VirtualScreen; "
                "$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height; "
                "$g = [System.Drawing.Graphics]::FromImage($bmp); "
                "$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size); "
                f"$bmp.Save('{path}')"
            )
            subprocess.run(["powershell", "-NoProfile", "-Command", ps], check=True)
        else:
            subprocess.run(["screencapture", "-x", path], check=True)
        print(f"screenshot: {path}")
    except (subprocess.CalledProcessError, OSError) as e:
        print(f"screenshot failed (not fatal): {e}")


def history(db: str) -> list[tuple]:
    con = sqlite3.connect(db)
    try:
        return con.execute(
            "select sql_text, status, rows_returned, coalesce(error_text, '') from query_history order by started_at"
        ).fetchall()
    finally:
        con.close()


def log_text() -> str:
    out = []
    logs = os.path.join(data_dir(), "logs")
    for name in sorted(os.listdir(logs)) if os.path.isdir(logs) else []:
        with open(os.path.join(logs, name), encoding="utf-8", errors="replace") as f:
            out.append(f.read())
    return "\n".join(out)


def main() -> int:
    binary = sys.argv[1]
    db = os.path.join(data_dir(), "tuplenest.db")

    # 1. Let the app create its store, then add the profile.
    first = start(binary)
    deadline = time.time() + 40
    while not os.path.exists(db) and time.time() < deadline:
        time.sleep(1)
    time.sleep(4)
    stop(first)
    if not os.path.exists(db):
        print("::error::the app did not create its store")
        return 1
    con = sqlite3.connect(db)
    now = int(time.time())
    con.execute("delete from connections")
    con.execute(
        "insert into connections (id, name, driver, environment, read_only, host, port, database, username, "
        "tls_mode, created_at, updated_at, statement_timeout_ms) values (?, ?, 'postgres', 'dev', 0, ?, ?, ?, ?, "
        "'disabled', ?, ?, 0)",
        (
            "smoke-profile",
            PROFILE,
            "127.0.0.1",
            int(os.environ.get("PGPORT", "5432")),
            os.environ["PGDATABASE"],
            os.environ["PGUSER"],
            now,
            now,
        ),
    )
    con.execute("delete from query_history")
    con.commit()
    con.close()

    # 2. Start it for real and drive it.
    app = start(binary)
    try:
        time.sleep(15)
        if app.poll() is not None:
            print(f"::error::the app exited with {app.returncode} before it could be driven")
            return 1
        screenshot("native-1-started.png")
        send(app.pid, ["palette", f"text:Connect to {PROFILE}", "enter"])
        time.sleep(6)
        screenshot("native-2-connected.png")
        send(app.pid, ["palette", "text:Run query", "enter"])

        # 4. The app's own records.
        rows: list[tuple] = []
        deadline = time.time() + 30
        while time.time() < deadline:
            rows = history(db)
            if any(r[0] == QUERY and r[1] == "success" for r in rows):
                break
            time.sleep(1)
        time.sleep(2)
        screenshot("native-3-ran.png")
    finally:
        stop(app)

    print("history:", rows)
    opened = "session opened" in log_text()
    print("log says a session was opened:", opened)
    ok = [r for r in rows if r[0] == QUERY and r[1] == "success" and r[2] == 1]
    if not opened:
        print("::error::the app never opened a database session: the keystrokes did not connect it")
        return 1
    if not ok:
        print("::error::the query is not in the app's history as a one-row success")
        return 1
    print("PASS: connected through the palette and ran a query that returned one row")
    return 0


if __name__ == "__main__":
    sys.exit(main())
