import os from "os";
import path from "path";
import { spawn } from "child_process";
import { existsSync } from "fs";

/**
 * WebdriverIO config for the TupleNest smoke tests.
 *
 * The point of these tests is narrow and specific: everything else in this
 * repo is verified on macOS, by hand or by vitest in jsdom. Neither of those
 * touches a Linux or Windows WebView. The failures that live here — a missing
 * shared library, a WebView2 that never initialises, a window that opens
 * blank — are invisible to a unit test and to the developer's own machine.
 *
 * So this deliberately drives the INSTALLED ARTIFACT, not a fresh `cargo
 * build`. Building from source on the runner would test the source; installing
 * the .deb or the .msi and driving that tests the thing a user downloads,
 * including the packaging around it.
 *
 * `TUPLENEST_BIN` is set by the workflow to wherever the installer put the
 * binary. It falls back to a local debug build so the suite can be run on a
 * developer's Linux box without a release in hand.
 */

const platformDefault = () =>
  process.platform === "win32"
    ? "C:\\Program Files\\TupleNest\\tuplenest-desktop.exe"
    : "/usr/bin/tuplenest-desktop";

const application = process.env.TUPLENEST_BIN || platformDefault();

if (!existsSync(application)) {
  throw new Error(
    `No TupleNest binary at ${application}. ` +
      `Set TUPLENEST_BIN to the installed binary, or install the release artifact first.`
  );
}

let tauriDriver;
let exiting = false;

export const config = {
  hostname: "127.0.0.1",
  port: 4444,
  specs: ["./specs/**/*.e2e.js"],

  // One at a time. Two instances would race for port 4444 and, more to the
  // point, for the single workspace SQLite file in the OS app-data directory —
  // these tests write real connection profiles into it.
  maxInstances: 1,
  capabilities: [{ maxInstances: 1, "tauri:options": { application } }],

  reporters: ["spec"],
  framework: "mocha",
  // Generous: the first launch on a cold Windows runner has to initialise
  // WebView2, and on Linux xvfb plus webkit startup is not instant. A tight
  // timeout here produces flakes that look like product bugs.
  mochaOpts: { ui: "bdd", timeout: 120000 },
  waitforTimeout: 20000,
  logLevel: "warn",

  beforeSession: () => {
    tauriDriver = spawn(path.resolve(os.homedir(), ".cargo", "bin", "tauri-driver"), [], {
      stdio: [null, process.stdout, process.stderr],
    });
    tauriDriver.on("error", (e) => {
      console.error("tauri-driver failed to start:", e);
      process.exit(1);
    });
    tauriDriver.on("exit", (code) => {
      // tauri-driver dying mid-run is not a test failure to be reported as a
      // timeout thirty seconds later — say what actually happened.
      if (!exiting) {
        console.error("tauri-driver exited early with code:", code);
        process.exit(1);
      }
    });
  },

  afterSession: () => stopDriver(),
};

function stopDriver() {
  exiting = true;
  tauriDriver?.kill();
}

// afterSession does not run if the session never started, so cover the exit
// paths too rather than leaving a driver process behind on the runner.
for (const sig of ["exit", "SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    stopDriver();
    if (sig !== "exit") process.exit();
  });
}
