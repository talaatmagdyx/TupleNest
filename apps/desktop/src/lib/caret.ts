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
