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
 * `@wdio/tauri-service` owns the WebDriver layer. Spawning `tauri-driver` by
 * hand works on Linux and fails on Windows: there, the app runs in WebView2
 * and is driven by `msedgedriver.exe`, which must match the installed Edge
 * *major version*. A mismatched driver does not say so — it reports
 * `session not created: DevToolsActivePort file doesn't exist`, which reads
 * like the app crashed. The service detects the Edge version from the
 * registry and downloads the matching driver, which is the whole reason it is
 * here rather than a hand-rolled spawn.
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

  services: [
    [
      "tauri",
      {
        // Windows only, and on by default — stated explicitly because it is
        // the fix for the failure described above, not an incidental setting.
        autoDownloadEdgeDriver: true,
        tauriDriverPort: 4444,
      },
    ],
  ],

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
};
