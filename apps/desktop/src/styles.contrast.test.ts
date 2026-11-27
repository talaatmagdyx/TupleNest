import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Both themes' colours, held to WCAG 2.1 AA.
 *
 * Read from the stylesheet itself — the last block for each theme that sets
 * the surfaces is the one that wins the cascade — so a later tweak to a token
 * cannot quietly drop it back under the line.
 */
// Vitest runs from apps/desktop; under jsdom import.meta.url is not a file URL.
const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

function tokens(selector: RegExp): Record<string, string> {
  const blocks = [...css.matchAll(selector)].map((m) => m[1]);
  const palettes = blocks.filter((b) => b.includes("--tn-tp:"));
  const palette = palettes[palettes.length - 1];
  const out: Record<string, string> = {};
  for (const m of palette.matchAll(/--tn-([a-z0-9-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

type RGB = [number, number, number];
const hex = (h: string): RGB => {
  const s = h.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16)) as RGB;
};
const rgba = (v: string): { rgb: RGB; a: number } => {
  const m = v.match(/rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)/)!;
  return { rgb: [+m[1], +m[2], +m[3]], a: +m[4] };
};
const over = (fg: { rgb: RGB; a: number }, bg: RGB): RGB =>
  fg.rgb.map((c, i) => Math.round(c * fg.a + bg[i] * (1 - fg.a))) as RGB;
const lum = (c: RGB) => {
  const [r, g, b] = c.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: RGB, b: RGB) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const themes = {
  dark: tokens(/:root, \[data-tn-theme="dark"\]\s*\{([^}]*)\}/g),
  light: tokens(/\[data-tn-theme="light"\]\s*\{([^}]*)\}/g),
};
// Desk (the window), island (bg and s1, every panel) and raised (s2).
const surfaces = ["bg", "s1", "s2", "desk"] as const;
const textTokens = [
  "tp", "ts", "tm", "accent", "success", "danger", "warning", "purple",
  "syn-kw", "syn-str", "syn-num", "syn-comment",
];

describe.each(Object.entries(themes))("%s theme contrast", (_name, t) => {
  it.each(textTokens)("text token --tn-%s reaches 4.5:1 on every surface", (tok) => {
    for (const s of surfaces) expect(ratio(hex(t[tok]), hex(t[s]))).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    ["on-accent", "accent"],
    ["on-danger", "danger"],
    ["on-warn", "warning"],
  ])("--tn-%s text on --tn-%s (solid buttons and badges) reaches 4.5:1", (fg, bg) => {
    expect(ratio(hex(t[fg]), hex(t[bg]))).toBeGreaterThanOrEqual(4.5);
  });

  it("the control boundary reaches 3:1 on every surface", () => {
    for (const s of surfaces) expect(ratio(hex(t.bc), hex(t[s]))).toBeGreaterThanOrEqual(3);
  });

  it("the focus ring reaches 3:1 on every surface", () => {
    const f = rgba(t.focus);
    for (const s of surfaces) {
      const bg = hex(t[s]);
      expect(ratio(over(f, bg), bg)).toBeGreaterThanOrEqual(3);
    }
  });

  it("muted text stays readable on the selection tint", () => {
    const sel = over(rgba(t.as), hex(t.bg));
    expect(ratio(hex(t.tm), sel)).toBeGreaterThanOrEqual(4.5);
  });

  it("the active tab's accent text stays readable on the selection tint", () => {
    const sel = over(rgba(t.as), hex(t.bg));
    expect(ratio(hex(t.accent), sel)).toBeGreaterThanOrEqual(4.5);
  });

  // The tint is always laid over an island (the prod banner, the error box),
  // never straight onto the desk.
  it("danger text stays readable on its tint over an island", () => {
    const bg = over(rgba(t["danger-tint"]), hex(t.bg));
    expect(ratio(hex(t.danger), bg)).toBeGreaterThanOrEqual(4.5);
  });
});
