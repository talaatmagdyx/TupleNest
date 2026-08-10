/** Caret pixel position inside a <textarea>.
 *
 *  The editor uses `white-space: pre-wrap`, so a long logical line can occupy
 *  several visual rows — fixed char-width math would drift. Instead we mirror
 *  the textarea into a hidden div with identical text metrics and measure where
 *  a marker span lands. Coordinates are relative to the textarea's padding box
 *  and do NOT account for scrollTop (callers subtract it).
 */

const COPIED = [
  "boxSizing", "width", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
  "fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing", "lineHeight",
  "textTransform", "wordSpacing", "whiteSpace", "overflowWrap", "wordBreak", "tabSize",
] as const;

export type CaretPos = { left: number; top: number; lineHeight: number };

export function caretPosition(ta: HTMLTextAreaElement, index: number): CaretPos {
  const style = window.getComputedStyle(ta);
  const mirror = document.createElement("div");

  for (const prop of COPIED) {
    mirror.style[prop] = style[prop];
  }
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.top = "0";
  mirror.style.left = "-9999px";
  mirror.style.height = "auto";
  mirror.style.overflow = "hidden";

  mirror.textContent = ta.value.slice(0, index);

  const marker = document.createElement("span");
  // A non-empty marker so it always has a box; the remainder keeps wrapping honest.
  marker.textContent = ta.value.slice(index) || ".";
  mirror.appendChild(marker);

  document.body.appendChild(mirror);
  const left = marker.offsetLeft;
  const top = marker.offsetTop;
  document.body.removeChild(mirror);

  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4;
  return { left, top, lineHeight };
}

/** Width of one character, measured once per font string.
 *  Only valid for a monospace font — which the editor always uses. */
const charWidthCache = new Map<string, number>();

export function charWidth(ta: HTMLTextAreaElement): number {
  const style = window.getComputedStyle(ta);
  const key = `${style.fontSize} ${style.fontFamily} ${style.fontWeight}`;
  const hit = charWidthCache.get(key);
  if (hit) return hit;

  const probe = document.createElement("span");
  probe.style.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize}/${style.lineHeight} ${style.fontFamily}`;
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.whiteSpace = "pre";
  probe.textContent = "0".repeat(100);
  document.body.appendChild(probe);
  const w = probe.getBoundingClientRect().width / 100;
  document.body.removeChild(probe);

  const out = w || parseFloat(style.fontSize) * 0.6;
  charWidthCache.set(key, out);
  return out;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/**
 * Character offset under a viewport point.
 *
 * Used to extend a selection while auto-scrolling past the edge, where the
 * pointer sits still and the browser reports nothing.
 *
 * Measured, not calculated. The editor wraps, so a logical line can be any
 * number of rows tall and the old row = floor(y / lineHeight) arithmetic
 * indexed the wrong line the moment anything wrapped. Instead the text is
 * mirrored and a Range asks the layout engine directly where each character
 * sits, then a binary search walks to the point — reading order increases
 * monotonically with offset, which is what makes the search valid.
 *
 * `measuredOffsetAt` returns null when the environment reports no geometry at
 * all (jsdom, or a detached node); `offsetAt` then falls back to the monospace
 * arithmetic, which is right for unwrapped text and better than nothing.
 */
function measuredOffsetAt(ta: HTMLTextAreaElement, x: number, y: number): number | null {
  const text = ta.value;
  if (text === "") return 0;

  const style = window.getComputedStyle(ta);
  const mirror = document.createElement("div");
  for (const prop of COPIED) {
    mirror.style[prop] = style[prop];
  }
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.top = "0";
  mirror.style.left = "-9999px";
  mirror.style.height = "auto";
  const node = document.createTextNode(text);
  mirror.appendChild(node);
  document.body.appendChild(mirror);

  try {
    const origin = mirror.getBoundingClientRect();
    const range = document.createRange();
    // jsdom has no layout engine and does not implement this at all.
    if (typeof range.getClientRects !== "function") return null;
    /** Rect of the character at `i`, relative to the mirror's border box. */
    const rectAt = (i: number): DOMRect | null => {
      range.setStart(node, i);
      range.setEnd(node, Math.min(i + 1, text.length));
      const r = range.getClientRects()[0];
      return r ?? null;
    };

    const probe = rectAt(0);
    // No layout engine: every rect is a zero-sized box at the origin, and a
    // binary search over those would just return garbage confidently.
    if (!probe || (probe.width === 0 && probe.height === 0)) return null;

    // True when the character at `i` starts before the point in reading order.
    const before = (i: number): boolean => {
      const r = rectAt(i);
      if (!r) return true;
      const top = r.top - origin.top;
      const left = r.left - origin.left;
      if (top + r.height <= y) return true;
      if (top > y) return false;
      return left + r.width / 2 <= x;
    };

    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (before(mid)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  } finally {
    document.body.removeChild(mirror);
  }
}

export function offsetAt(ta: HTMLTextAreaElement, clientX: number, clientY: number): number {
  const box = ta.getBoundingClientRect();
  const measured = measuredOffsetAt(
    ta,
    clientX - box.left + ta.scrollLeft,
    clientY - box.top + ta.scrollTop,
  );
  if (measured !== null) return measured;

  const rect = box;
  const style = window.getComputedStyle(ta);
  const padTop = parseFloat(style.paddingTop) || 0;
  const padLeft = parseFloat(style.paddingLeft) || 0;
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4;
  const cw = charWidth(ta);

  const y = clientY - rect.top + ta.scrollTop - padTop;
  const x = clientX - rect.left + ta.scrollLeft - padLeft;

  const lines = ta.value.split("\n");
  const row = clamp(Math.floor(y / lineHeight), 0, lines.length - 1);
  const col = clamp(Math.round(x / cw), 0, lines[row].length);

  let offset = 0;
  for (let i = 0; i < row; i++) offset += lines[i].length + 1; // +1 for the newline
  return offset + col;
}
