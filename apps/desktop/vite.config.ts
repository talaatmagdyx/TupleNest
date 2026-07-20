import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";

/**
 * Stamp the commit and build time into the bundle.
 *
 * "Which build am I looking at?" should be answerable at a glance rather than
 * by autopsy. Two copies of this app can easily be running at once — an
 * installed release and a local build — and on screen they are identical,
 * which has already cost real debugging time chasing a fix in a window that
 * could not possibly have contained it. A trailing `+` means the working tree
 * had uncommitted changes when the bundle was built.
 */
function sh(cmd: string): string {
  try {
    return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return ""; // a tarball checkout has no .git, and that is not an error
  }
}

const sha = process.env.TUPLENEST_BUILD_SHA || sh("git rev-parse --short HEAD");
const dirty = sha && sh("git status --porcelain") ? "+" : "";
const BUILD_SHA = sha ? `${sha}${dirty}` : "";
const BUILD_TIME = new Date().toISOString().slice(0, 16).replace("T", " ");

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  define: {
    __BUILD_SHA__: JSON.stringify(BUILD_SHA),
    __BUILD_TIME__: JSON.stringify(BUILD_TIME),
  },
});
