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
 * The WebDriver layer is chosen per platform, because the two platforms have
 * genuinely different problems.
 *
 * On Linux, spawning `tauri-driver` by hand works, and is what runs here. It
 * drove the app through the full connect-and-query path on the first attempt.
 *
 * On Windows it does not: the app runs in WebView2 and is driven by
 * `msedgedriver.exe`, which must match the installed Edge *major version*. A
 * mismatch does not say so — it reports `session not created:
 * DevToolsActivePort file doesn't exist`, which reads like the app crashed.
 * `@wdio/tauri-service` reads the Edge version from the registry and fetches
 * the matching driver, so Windows goes through the service.
 *
 * Using the service on both would be tidier to look at and is not what the
 * evidence supports: introducing it on Linux replaced a mechanism that
 * already worked and left the run hanging. A test harness is not the place to
 * trade a working path for a uniform one.
 */
const WINDOWS = process.platform === "win32";

const platformDefault = () =>
  WINDOWS ? "C:\\Program Files\\TupleNest\\tuplenest-desktop.exe" : "/usr/bin/tuplenest-desktop";

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

  // Windows only. `external` keeps it driving the installed binary through
  // tauri-driver; the default `embedded` provider runs a WebDriver server
  // inside the app, which means compiling a plugin into it — a special build,
  // when the point of this suite is the artifact users download.
  services: WINDOWS
    ? [["tauri", { driverProvider: "external", autoDownloadEdgeDriver: true, tauriDriverPort: 4444 }]]
    : [],

  // One at a time. Two instances would race for the driver port and, more to
  // the point, for the single workspace SQLite file in the OS app-data
  // directory — these tests write real connection profiles into it.
  maxInstances: 1,
  // The binary goes in the capability, not the service options: this version
  // of the service reads `tauri:options.application` and ignores an
  // `application` passed alongside `autoDownloadEdgeDriver`.
  capabilities: [{ maxInstances: 1, "tauri:options": { application } }],

  reporters: ["spec"],
  framework: "mocha",
  // Generous: the first launch on a cold Windows runner has to initialise
  // WebView2, and on Linux xvfb plus webkit startup is not instant. A tight
  // timeout here produces flakes that look like product bugs.
  mochaOpts: { ui: "bdd", timeout: 120000 },
  waitforTimeout: 20000,
  logLevel: "warn",

  // Linux drives tauri-driver directly; on Windows the service owns it and
  // these hooks do nothing.
  beforeSession: () => {
    if (WINDOWS) return;
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
