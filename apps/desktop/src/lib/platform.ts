/**
 * Which keys this machine actually has.
 *
 * The shortcut handlers accept either modifier (`e.metaKey || e.ctrlKey`), so
 * the bindings have always worked everywhere. The *labels* did not: every hint
 * in the UI was written `⌘K`, which is a key a Windows or Linux keyboard does
 * not have. The app told those users to press something that does not exist.
 *
 * Read synchronously from the user agent rather than from `app_get_info`, which
 * is IPC and therefore async: a label cannot wait for a round trip, and a hint
 * that flickers from `Ctrl` to `⌘` on mount is worse than either.
 */

export function isMac(): boolean {
  // `navigator.platform` is deprecated but is still the most reliable signal in
  // a webview; the UA string is the documented fallback.
  const p = typeof navigator === "undefined" ? "" : `${navigator.platform} ${navigator.userAgent}`;
  return /mac|iphone|ipad/i.test(p);
}

/**
 * The OS, named the way `std::env::consts::OS` names it on the Rust side, so
 * the two agree: "macos" | "windows" | "linux".
 *
 * The backend reports the same thing over `app_get_info`, but that is IPC, and
 * this drives layout — the titlebar's traffic-light inset. Waiting a round trip
 * for it would paint one frame with the window controls sitting on top of the
 * connection name, then jump. Read it synchronously instead.
 */
export function osName(): "macos" | "windows" | "linux" {
  if (isMac()) return "macos";
  const p = typeof navigator === "undefined" ? "" : `${navigator.platform} ${navigator.userAgent}`;
  return /win/i.test(p) ? "windows" : "linux";
}

/** The primary modifier, as this keyboard prints it. */
export const modKey = (): string => (isMac() ? "⌘" : "Ctrl");
/** Shift. Apple prints a glyph; everyone else spells it. */
export const shiftKey = (): string => (isMac() ? "⇧" : "Shift");
/** Alt / Option. */
export const altKey = (): string => (isMac() ? "⌥" : "Alt");
/** Control proper — the completion popup binds ⌃Space on every platform. */
export const ctrlKey = (): string => (isMac() ? "⌃" : "Ctrl");
/** Return. */
export const enterKey = (): string => (isMac() ? "↵" : "Enter");

/**
 * A shortcut written the way this machine reads it.
 *
 *   kbd("mod", "K")        → "⌘K"        on macOS, "Ctrl+K" elsewhere
 *   kbd("mod", "shift", "F") → "⌘⇧F"     on macOS, "Ctrl+Shift+F" elsewhere
 *
 * macOS runs the glyphs together, which is the platform convention; everywhere
 * else the parts are joined with `+`, which is theirs.
 */
export function kbd(...parts: string[]): string {
  const mac = isMac();
  const named: Record<string, string> = {
    mod: modKey(),
    shift: shiftKey(),
    alt: altKey(),
    ctrl: ctrlKey(),
    enter: enterKey(),
  };
  const out = parts.map((p) => named[p] ?? p);
  return mac ? out.join("") : out.join("+");
}
