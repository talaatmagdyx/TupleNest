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

/** Character offset under a viewport point.
 *
 *  Exact because the editor is monospace with `white-space: pre`: one logical
 *  line is always one row of `lineHeight`, and every column is `charWidth`
 *  wide. Used to extend a selection while auto-scrolling past the edge, where
 *  the pointer sits still and the browser reports nothing.
 */
export function offsetAt(ta: HTMLTextAreaElement, clientX: number, clientY: number): number {
  const rect = ta.getBoundingClientRect();
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
