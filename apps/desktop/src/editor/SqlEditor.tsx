import { useCallback, useEffect, useRef, useState } from "react";
import { tokenizeSQL, toggleLineComment } from "../lib/sql";
import { matchShortcut } from "../lib/shortcuts";
import { caretPosition, offsetAt } from "../lib/caret";
import {
  getCompletions,
  schemaToPrefetch,
  tablesToPrefetch,
  type Catalog,
  type CompletionItem,
} from "../lib/complete";

type Props = {
  sql: string;
  disabled: boolean;
  height: number;
  onChange: (sql: string) => void;
  /** Schema knowledge for completion. Omit to disable completion. */
  catalog?: Catalog;
  /** Asked to load columns for tables the statement mentions. */
  onPrefetchTables?: (tables: { schema: string; name: string }[]) => void;
  /** Asked to load the object list for a schema the user just qualified. */
  onPrefetchSchema?: (schema: string) => void;
};

type PopupState = {
  items: CompletionItem[];
  sel: number;
  from: number;
  to: number;
  left: number;
  top: number;
};

const KIND_GLYPH: Record<string, string> = {
  column: "C", table: "T", view: "V", schema: "S", function: "ƒ", keyword: "K",
};

/** Overlay editor from the HUD design: highlighted <pre> under a
 *  transparent <textarea> with an accent caret, plus a line gutter.
 *  Adds schema-aware completion (⌃Space, or auto as you type). */
export default function SqlEditor(p: Props) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [pop, setPop] = useState<PopupState | null>(null);
  const lines = p.sql.split("\n");

  /** The textarea is the only scroller; the highlight layer and the gutter are
   *  overflow:hidden and follow it. Without this they stay pinned and the text
   *  simply stops rendering past the first screenful. */
  const syncScroll = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    if (preRef.current) {
      preRef.current.scrollTop = ta.scrollTop;
      preRef.current.scrollLeft = ta.scrollLeft;
    }
    if (gutterRef.current) gutterRef.current.scrollTop = ta.scrollTop;
  }, []);

  // Keep them aligned when the text changes height (paste, format, tab switch)
  // rather than only on user scroll.
  useEffect(() => {
    syncScroll();
  }, [p.sql, p.height, syncScroll]);

  /** Auto-scroll while drag-selecting past an edge.
   *
   *  The browser won't do this for us here: its drag-autoscroll looks for a
   *  scrollable *ancestor*, and the editor deliberately has none (the frame is
   *  overflow:hidden so the gutter can't drag the layout around). So a drag
   *  below the last visible line just stopped dead.
   *
   *  While the pointer sits outside the box we scroll it ourselves and extend
   *  the selection to the offset under the pointer — the pointer isn't moving,
   *  so no mousemove fires and the browser would never update it. In-bounds
   *  dragging is left entirely to native behaviour.
   */
  const onMouseDown = useCallback(
    (e: React.MouseEvent<HTMLTextAreaElement>) => {
      const ta = taRef.current;
      if (!ta || e.button !== 0) return;

      let anchor: number | null = null;
      // Read the anchor after the browser has placed the caret for this click.
      requestAnimationFrame(() => {
        anchor = ta.selectionStart;
      });

      let px = e.clientX;
      let py = e.clientY;
      const onMove = (ev: MouseEvent) => {
        px = ev.clientX;
        py = ev.clientY;
      };

      const EDGE = 14; // band from the edge where scrolling kicks in
      const SPEED = 0.45; // px of scroll per px of overshoot, per frame
      const MAX = 28; // cap so a fast flick doesn't rocket to the end

      let raf = 0;
      const tick = () => {
        const r = ta.getBoundingClientRect();
        let dy = 0;
        if (py > r.bottom - EDGE) dy = Math.min((py - (r.bottom - EDGE)) * SPEED, MAX);
        else if (py < r.top + EDGE) dy = Math.max((py - (r.top + EDGE)) * SPEED, -MAX);

        if (dy !== 0) {
          const before = ta.scrollTop;
          ta.scrollTop += dy;
          if (ta.scrollTop !== before) {
            syncScroll();
            if (anchor !== null) {
              const head = offsetAt(ta, px, py);
              ta.setSelectionRange(Math.min(anchor, head), Math.max(anchor, head), anchor <= head ? "forward" : "backward");
            }
          }
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);

      const stop = () => {
        cancelAnimationFrame(raf);
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", stop);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", stop);
    },
    [syncScroll]
  );

  const close = useCallback(() => setPop(null), []);

  /**
   * The blur close is deferred so that clicking an item in the popup lands
   * before the popup goes away. That timer has to be cancelled on unmount:
   * left running, it calls `setPop` on a component that no longer exists —
   * closing a tab or a modal while the editor has focus is enough to hit it.
   */
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (blurTimer.current) clearTimeout(blurTimer.current);
    },
    []
  );

  const openAt = useCallback(
    (force: boolean) => {
      const ta = taRef.current;
      if (!ta || !p.catalog) return;
      const cursor = ta.selectionStart;
      if (cursor !== ta.selectionEnd) return close();

      // Read from the DOM, not from `p.sql`: this runs inside the rAF fired by
      // onChange, before React has re-rendered, so the prop is still one
      // keystroke behind. The textarea is authoritative here.
      const text = ta.value;
      const r = getCompletions(text, cursor, p.catalog);
      // Auto-mode: only surface once there's something typed, to avoid a popup
      // flashing on every space. ⌃Space always shows.
      const typed = r.to > r.from;
      const afterDot = cursor > 0 && text[cursor - 1] === ".";
      if (!force && !typed && !afterDot) return close();
      if (r.items.length === 0) return close();

      const { left, top, lineHeight } = caretPosition(ta, cursor);
      setPop({
        items: r.items,
        sel: 0,
        from: r.from,
        to: r.to,
        // Caret coords are relative to the text, so both scroll offsets have
        // to come back out — long lines scroll horizontally now.
        left: left - ta.scrollLeft,
        top: top + lineHeight - ta.scrollTop,
      });
    },
    [p.catalog, close]
  );

  const accept = useCallback(
    (item: CompletionItem) => {
      if (!pop) return;
      const text = taRef.current?.value ?? p.sql;
      const insert = item.insert ?? item.label;
      const next = text.slice(0, pop.from) + insert + text.slice(pop.to);
      const caret = pop.from + insert.length;
      p.onChange(next);
      close();
      requestAnimationFrame(() => {
        const ta = taRef.current;
        if (ta) {
          ta.focus();
          ta.setSelectionRange(caret, caret);
        }
      });
    },
    [pop, p, close]
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === " " && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      openAt(true);
      return;
    }
    // Editor-scoped bindings still come from lib/shortcuts, so the cheatsheet
    // knows about them. Everything below this point is popup navigation, which
    // is not a shortcut anyone needs told about.
    const mod = e.metaKey || e.ctrlKey;
    if (matchShortcut(e.nativeEvent, mod, false) === "toggleComment") {
      e.preventDefault();
      const ta = taRef.current;
      if (!ta) return;
      const next = toggleLineComment(ta.value, ta.selectionStart, ta.selectionEnd);
      p.onChange(next.sql);
      // The value arrives on the next render, so the selection has to be put
      // back after it — setting it now would apply to the old text.
      requestAnimationFrame(() => {
        ta.setSelectionRange(next.selectionStart, next.selectionEnd);
      });
      return;
    }
    if (!pop) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      // Move from the *current* selection, not the one this handler closed
      // over: holding the key fires faster than React re-renders, and two
      // presses against the same stale `pop` compute the same index — the
      // list stops moving until you let go.
      setPop((s) => (s ? { ...s, sel: (s.sel + 1) % s.items.length } : s));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setPop((s) => (s ? { ...s, sel: (s.sel - 1 + s.items.length) % s.items.length } : s));
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      accept(pop.items[pop.sel]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };

  // Keep the highlighted row scrolled into view.
  useEffect(() => {
    if (!pop || !listRef.current) return;
    const el = listRef.current.children[pop.sel] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [pop]);

  // Ask the host to load metadata this statement needs but the explorer hasn't
  // lazily opened: columns for referenced tables, and the object list for a
  // schema the user just qualified (`some_schema.`).
  const { sql: pSql, catalog, onPrefetchTables, onPrefetchSchema } = p;
  useEffect(() => {
    const ta = taRef.current;
    if (!ta || !catalog) return;
    const t = setTimeout(() => {
      const cursor = ta.selectionStart;
      if (onPrefetchTables) {
        const want = tablesToPrefetch(ta.value, cursor, catalog.searchPath);
        if (want.length) onPrefetchTables(want);
      }
      if (onPrefetchSchema) {
        const s = schemaToPrefetch(ta.value, cursor, catalog);
        if (s) onPrefetchSchema(s);
      }
    }, 150);
    return () => clearTimeout(t);
  }, [pSql, catalog, onPrefetchTables, onPrefetchSchema]);

  // Metadata arrives asynchronously. If it lands while the caret is still
  // parked where we had nothing to offer, surface the popup now.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta || document.activeElement !== ta) return;
    openAt(false);
  }, [p.catalog, openAt]);

  return (
    <div className="editor-frame" style={{ height: p.height }}>
      <div className="gutter" ref={gutterRef}>
        {lines.map((_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <div className="editor-rel">
        <pre className="editor-pre" ref={preRef}>
          {tokenizeSQL(p.sql)}
        </pre>
        <textarea
          ref={taRef}
          className="editor-ta"
          /* The highlight layer below is decorative and aria-hidden, so this
             is the only thing a screen reader can announce. Unlabelled, it is
             "text box" — in an app whose whole point is the thing you type
             here. */
          aria-label="SQL editor"
          value={p.sql}
          spellCheck={false}
          disabled={p.disabled}
          onChange={(e) => {
            p.onChange(e.target.value);
            requestAnimationFrame(() => openAt(false));
          }}
          onKeyDown={onKeyDown}
          onMouseDown={onMouseDown}
          onBlur={() => {
            blurTimer.current = setTimeout(close, 120);
          }}
          onScroll={() => {
            syncScroll();
            close();
          }}
        />
        {pop && (
          <div className="cmp-pop" style={{ left: pop.left, top: pop.top }}>
            <div className="cmp-list" ref={listRef}>
              {pop.items.map((it, i) => (
                <div
                  key={`${it.kind}:${it.label}`}
                  className={`cmp-item ${i === pop.sel ? "on" : ""}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    accept(it);
                  }}
                  onMouseEnter={() => setPop((s) => (s ? { ...s, sel: i } : s))}
                >
                  <span className={`cmp-kind k-${it.kind}`}>{KIND_GLYPH[it.kind] ?? "•"}</span>
                  <span className="cmp-label">{it.label}</span>
                  {it.detail && <span className="cmp-detail">{it.detail}</span>}
                </div>
              ))}
            </div>
            <div className="cmp-foot">
              <span>↑↓ navigate</span>
              <span>⏎ accept</span>
              <span>esc dismiss</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
