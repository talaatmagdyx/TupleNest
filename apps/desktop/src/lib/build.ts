/** Which build is this?
 *
 *  `vite.config.ts` replaces these at build time. They are read through
 *  `typeof` rather than referenced directly because nothing defines them under
 *  vitest, and touching an undeclared identifier throws where `typeof` does
 *  not — a status bar is not worth a blank window.
 */
declare const __BUILD_SHA__: string;
declare const __BUILD_TIME__: string;

export const BUILD_SHA: string = typeof __BUILD_SHA__ === "string" ? __BUILD_SHA__ : "";
export const BUILD_TIME: string = typeof __BUILD_TIME__ === "string" ? __BUILD_TIME__ : "";

/**
 * The short label for the status bar: `a1b2c3d · 2026-07-20 03:45`.
 *
 * Returns "" when there is nothing truthful to show — a checkout without git
 * history, or a test run. An empty label is hidden entirely rather than
 * rendered as "unknown", which would be noise on every screenshot.
 */
export function buildLabel(sha: string = BUILD_SHA, time: string = BUILD_TIME): string {
  if (!sha && !time) return "";
  if (!sha) return time;
  if (!time) return sha;
  return `${sha} · ${time}`;
}
