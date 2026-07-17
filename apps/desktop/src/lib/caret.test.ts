import { beforeEach, describe, expect, it, vi } from "vitest";
import { caretPosition, charWidth, offsetAt } from "./caret";

/**
 * jsdom has no layout engine: offsetLeft/offsetTop/getBoundingClientRect all
 * report 0. So these tests cannot assert real pixel positions — anything that
 * looked like it did would be asserting jsdom's zeros, not the maths.
 *
 * What they do assert is everything that is not layout: the DOM mirror is
 * built and torn down, the font fallbacks fire, the cache works, and the
 * offset arithmetic (rows, columns, clamping) is correct given stubbed
 * metrics. The pixel behaviour is verified by using the editor.
 */

const mkTextarea = (value: string): HTMLTextAreaElement => {
  const ta = document.createElement("textarea");
  ta.value = value;
  document.body.appendChild(ta);
  return ta;
};

/** Stub getComputedStyle so the geometry is known and the real code paths run. */
const stubStyle = (over: Record<string, string> = {}) => {
  const base: Record<string, string> = {
    boxSizing: "border-box",
    width: "800px",
    paddingTop: "10px",
    paddingRight: "0px",
    paddingBottom: "0px",
    paddingLeft: "5px",
    borderTopWidth: "0px",
    borderRightWidth: "0px",
    borderBottomWidth: "0px",
    borderLeftWidth: "0px",
    fontFamily: "monospace",
    fontSize: "10px",
    fontWeight: "400",
    fontStyle: "normal",
    letterSpacing: "normal",
    lineHeight: "20px",
    textTransform: "none",
    wordSpacing: "0px",
    whiteSpace: "pre",
    overflowWrap: "normal",
    wordBreak: "normal",
    tabSize: "4",
    ...over,
  };
  vi.spyOn(window, "getComputedStyle").mockReturnValue(
    new Proxy(base, { get: (t, k) => t[k as string] ?? "" }) as unknown as CSSStyleDeclaration,
  );
};

beforeEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("caretPosition", () => {
  it("returns the line height from the computed style", () => {
    stubStyle();
    const ta = mkTextarea("hello world");
    expect(caretPosition(ta, 5).lineHeight).toBe(20);
  });

  it("derives a line height from font size when lineHeight is 'normal'", () => {
    // parseFloat("normal") is NaN — the fallback exists so the popup still
    // lands somewhere sane instead of at NaN.
    stubStyle({ lineHeight: "normal", fontSize: "10px" });
    const ta = mkTextarea("abc");
    expect(caretPosition(ta, 1).lineHeight).toBeCloseTo(14);
  });

  it("leaves no mirror element behind", () => {
    stubStyle();
    const ta = mkTextarea("some text here");
    const before = document.body.childElementCount;
    caretPosition(ta, 4);
    expect(document.body.childElementCount).toBe(before);
  });

  it("measures at the very end of the text without throwing", () => {
    stubStyle();
    const ta = mkTextarea("abc");
    expect(() => caretPosition(ta, 3)).not.toThrow();
  });

  it("measures inside an empty textarea", () => {
    stubStyle();
    const ta = mkTextarea("");
    expect(() => caretPosition(ta, 0)).not.toThrow();
  });

  it("returns numeric coordinates, never NaN", () => {
    stubStyle();
    const ta = mkTextarea("select * from t");
    const p = caretPosition(ta, 7);
    expect(Number.isFinite(p.left)).toBe(true);
    expect(Number.isFinite(p.top)).toBe(true);
  });
});

describe("charWidth", () => {
  it("falls back to a fraction of font size when measurement yields zero", () => {
    // Exactly the jsdom case: getBoundingClientRect().width is 0, so the
    // `w || fontSize * 0.6` branch is what actually runs in this environment.
    stubStyle({ fontSize: "10px", fontFamily: "unique-font-a" });
    expect(charWidth(mkTextarea("x"))).toBeCloseTo(6);
  });

  it("caches per font signature", () => {
    stubStyle({ fontSize: "20px", fontFamily: "unique-font-b" });
    const ta = mkTextarea("x");
    const first = charWidth(ta);
    const spy = vi.spyOn(document.body, "appendChild");
    const second = charWidth(ta);
    expect(second).toBe(first);
    // Second call is served from the cache, so it never probes the DOM again.
    expect(spy).not.toHaveBeenCalled();
  });

  it("treats a different font size as a different measurement", () => {
    stubStyle({ fontSize: "10px", fontFamily: "unique-font-c" });
    const a = charWidth(mkTextarea("x"));
    stubStyle({ fontSize: "30px", fontFamily: "unique-font-c" });
    const b = charWidth(mkTextarea("x"));
    expect(b).not.toBe(a);
    expect(b).toBeCloseTo(18);
  });
});

describe("offsetAt", () => {
  // charWidth resolves to 6 (10px * 0.6) and lineHeight to 20 under stubStyle,
  // with padding 10 top / 5 left and rect origin at 0,0 in jsdom.
  const ta = () => {
    const t = mkTextarea("abcdef\nghijkl\nmn");
    return t;
  };

  it("maps a point in the first row to a column", () => {
    stubStyle({ fontFamily: "off-1" });
    // x = 5 + 3*6 = 23 → col 3; y = 10 + 0 → row 0
    expect(offsetAt(ta(), 23, 10)).toBe(3);
  });

  it("adds one for each newline when computing a later row", () => {
    stubStyle({ fontFamily: "off-2" });
    // row 1 starts at offset 7 ("abcdef" + "\n"); col 2 → 9
    expect(offsetAt(ta(), 5 + 2 * 6, 10 + 20)).toBe(9);
  });

  it("clamps above the first line rather than returning a negative offset", () => {
    stubStyle({ fontFamily: "off-3" });
    expect(offsetAt(ta(), 5, -500)).toBe(0);
  });

  it("clamps below the last line to that line, not past the end", () => {
    stubStyle({ fontFamily: "off-4" });
    // Row clamps to 2 ("mn", offset 14); column clamps to its length.
    expect(offsetAt(ta(), 5, 10 + 9999)).toBe(14);
  });

  it("clamps a column past the end of a short line to that line's length", () => {
    stubStyle({ fontFamily: "off-5" });
    // Far right on row 2 ("mn", length 2) → 14 + 2
    expect(offsetAt(ta(), 5 + 999 * 6, 10 + 2 * 20)).toBe(16);
  });

  it("clamps a column left of the text to zero", () => {
    stubStyle({ fontFamily: "off-6" });
    expect(offsetAt(ta(), -999, 10)).toBe(0);
  });

  it("accounts for the textarea's scroll offset", () => {
    stubStyle({ fontFamily: "off-7" });
    const t = ta();
    t.scrollTop = 20; // scrolled down exactly one line
    expect(offsetAt(t, 5, 10)).toBe(7); // start of row 1
  });

  it("survives missing padding values", () => {
    stubStyle({ paddingTop: "", paddingLeft: "", fontFamily: "off-8" });
    expect(offsetAt(ta(), 0, 0)).toBe(0);
  });

  it("uses the font-size fallback when lineHeight is not a number", () => {
    stubStyle({ lineHeight: "normal", fontSize: "10px", fontFamily: "off-9" });
    // lineHeight becomes 14; row 1 begins at y = 10 + 14
    expect(offsetAt(ta(), 5, 10 + 14)).toBe(7);
  });
});
