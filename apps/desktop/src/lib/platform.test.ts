import { afterEach, describe, expect, it, vi } from "vitest";
import { isMac, kbd, modKey, osName } from "./platform";

/** jsdom reports a Mac UA by default here; each test states the platform it
 *  means rather than relying on that. */
const platform = (value: string, ua = "") => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue(value);
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
};

afterEach(() => vi.restoreAllMocks());

describe("platform", () => {
  it("knows a Mac", () => {
    platform("MacIntel");
    expect(isMac()).toBe(true);
    expect(modKey()).toBe("⌘");
  });

  it("knows Windows", () => {
    platform("Win32");
    expect(isMac()).toBe(false);
    expect(modKey()).toBe("Ctrl");
  });

  it("knows Linux", () => {
    platform("Linux x86_64");
    expect(isMac()).toBe(false);
    expect(modKey()).toBe("Ctrl");
  });

  it("falls back to the user agent when platform is empty", () => {
    // `navigator.platform` is deprecated and some engines already return "".
    platform("", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
    expect(isMac()).toBe(true);
  });
});

describe("osName", () => {
  // These strings are the CSS selector `[data-tn-os="…"]` matches on, and they
  // are also what Rust's `std::env::consts::OS` returns — keep them in step.
  it("names macOS the way Rust does", () => {
    platform("MacIntel");
    expect(osName()).toBe("macos");
  });

  it("names Windows", () => {
    platform("Win32");
    expect(osName()).toBe("windows");
  });

  it("treats anything else as Linux", () => {
    platform("Linux x86_64");
    expect(osName()).toBe("linux");
  });
});

describe("kbd", () => {
  it("runs the glyphs together on macOS, the way the platform does", () => {
    platform("MacIntel");
    expect(kbd("mod", "K")).toBe("⌘K");
    expect(kbd("mod", "shift", "F")).toBe("⌘⇧F");
    expect(kbd("mod", "enter")).toBe("⌘↵");
  });

  it("spells the keys out and joins with + everywhere else", () => {
    // "⌘K" on Windows names a key the keyboard does not have.
    platform("Win32");
    expect(kbd("mod", "K")).toBe("Ctrl+K");
    expect(kbd("mod", "shift", "F")).toBe("Ctrl+Shift+F");
    expect(kbd("mod", "enter")).toBe("Ctrl+Enter");
  });

  it("passes plain keys through untouched", () => {
    platform("Win32");
    expect(kbd("Esc")).toBe("Esc");
    expect(kbd("ctrl", "Space")).toBe("Ctrl+Space");
  });
});
