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
 * build`. Building from source on the runner would test the source;
 * installing the .deb or the .msi and driving that tests the thing a user
 * downloads, including the packaging around it.
 *
 * This runs on Linux. It is not a Linux-only suite by preference — Windows is
 * genuinely not drivable this way. There, `tauri-driver` goes through
 * msedgedriver, which needs the WebView2 remote-debugging port, and Tauri
 * only opens that with the `devtools` feature: on in debug builds, off in
 * release. Against the shipped binary msedgedriver has nothing to attach to
 * and reports `session not created: DevToolsActivePort file doesn't exist`,
 * which reads like a crash and is not one. The Windows leg of the workflow
 * checks that the installed app launches and opens a window instead.
 *
 * Two things were tried for Windows before that was understood, and both were
 * wrong: matching msedgedriver to the Edge browser (not installed on the
 * runner) and then to the WebView2 Runtime (already an exact match, and it
 * still failed). The version was never the problem.
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

export const config = {
  specs: ["./specs/**/*.e2e.js"],

  hostname: "127.0.0.1",
  port: 4444,


  // One at a time. Two instances would race for the driver port and, more to
  // the point, for the single workspace SQLite file in the OS app-data
  // directory — these tests write real connection profiles into it.
  maxInstances: 1,
  // `tauri:options.application` is how tauri-driver is told which binary to
  // launch.
  capabilities: [{ maxInstances: 1, "tauri:options": { application } }],

  reporters: ["spec"],
  framework: "mocha",
  // Generous: the first launch on a cold Windows runner has to initialise
  // WebView2, and on Linux xvfb plus webkit startup is not instant. A tight
  // timeout here produces flakes that look like product bugs.
  mochaOpts: { ui: "bdd", timeout: 120000 },
  waitforTimeout: 20000,
  logLevel: "warn",

  // Spawn the driver the specs talk to; the matching msedgedriver is already
  // first on PATH on Windows.
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

let tauriDriver;
let exiting = false;

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
