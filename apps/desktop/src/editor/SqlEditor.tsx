import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  findMatches,
  replaceAllMatches,
  replaceMatch,
  tokenizeSQL,
  toggleLineComment,
  type Match,
} from "../lib/sql";
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

type FindState = {
  query: string;
  replace: string;
  caseSensitive: boolean;
  /** Which match is current. Kept as an index rather than an offset so it
   *  survives the text changing under it during replace. */
  at: number;
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
  const [find, setFind] = useState<FindState | null>(null);
  const findRef = useRef<HTMLInputElement>(null);
  /** Set when the bar is opened, cleared once its box has been focused. */
  const justOpened = useRef(false);
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

  /* ---- find & replace ---- */

  // Memoised, and not only to save the scan: `step` and the replace handlers
  // close over this list, so a new array every render gives them stale
  // callbacks and the bar starts skipping presses.
  const matches: Match[] = useMemo(
    () => (find ? findMatches(p.sql, find.query, find.caseSensitive) : []),
    [find, p.sql],
  );
  const current = matches.length ? (((find?.at ?? 0) % matches.length) + matches.length) % matches.length : 0;

  /** Select a match in the textarea and scroll it into view.
   *
   *  Deliberately does not take focus: pressing Enter in the find box moves to
   *  the next match, and stealing focus after the first press means the second
   *  Enter goes to the editor and inserts a newline instead. Focus returns to
   *  the text when the bar is closed. */
  const revealMatch = useCallback((m: Match | undefined) => {
    const ta = taRef.current;
    if (!ta || !m) return;
    ta.setSelectionRange(m.start, m.end);
    // Textareas do not scroll a programmatic selection into view. Approximate
    // it by the line the match starts on rather than leaving it off-screen.
    const before = ta.value.slice(0, m.start).split("\n").length - 1;
    const lineHeight = ta.clientHeight / Math.max(1, Math.round(ta.clientHeight / 20));
    ta.scrollTop = Math.max(0, before * lineHeight - ta.clientHeight / 2);
  }, []);

  const step = useCallback(
    (by: number) => {
      if (!matches.length) return;
      const next = (current + by + matches.length) % matches.length;
      setFind((f) => (f ? { ...f, at: next } : f));
      revealMatch(matches[next]);
    },
    [matches, current, revealMatch],
  );

  const doReplace = useCallback(() => {
    const m = matches[current];
    if (!m || !find) return;
    const r = replaceMatch(p.sql, m, find.replace);
    p.onChange(r.sql);
    // Stay on the same index: after replacing, the match that followed has
    // shifted into this slot, so the next press continues down the file.
    setFind((f) => (f ? { ...f, at: current } : f));
  }, [matches, current, find, p]);

  const doReplaceAll = useCallback(() => {
    if (!find || !find.query) return;
    p.onChange(replaceAllMatches(p.sql, find.query, find.replace, find.caseSensitive));
    setFind((f) => (f ? { ...f, at: 0 } : f));
  }, [find, p]);

  const openFind = useCallback(() => {
    const ta = taRef.current;
    // Seed from the selection, which is what you have just after finding
    // something by eye.
    const selected = ta ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : "";
    setFind((f) => ({
      query: selected && !selected.includes("\n") ? selected : (f?.query ?? ""),
      replace: f?.replace ?? "",
      caseSensitive: f?.caseSensitive ?? false,
      at: 0,
    }));
    justOpened.current = true;
  }, []);

  /* Focus and select the find box once, on the commit that opened the bar.
   *
   * This was a `requestAnimationFrame` and that was a real bug, not just a
   * flaky test: if the frame landed between two keystrokes, `select()` picked
   * out everything typed so far and the next character replaced it. An effect
   * runs before paint and before any further input, so the selection can only
   * happen when there is nothing yet to lose. */
  useEffect(() => {
    if (!find || !justOpened.current) return;
    justOpened.current = false;
    findRef.current?.focus();
    findRef.current?.select();
  }, [find]);

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
    const shortcut = matchShortcut(e.nativeEvent, mod, false);
    if (shortcut === "find") {
      e.preventDefault();
      openFind();
      return;
    }
    if (shortcut === "toggleComment") {
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
        {find && (
          <div className="findbar" role="search" aria-label="Find and replace">
            <input
              ref={findRef}
              className="mono"
              aria-label="Find"
              placeholder="Find"
              value={find.query}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              onChange={(e) => setFind((f) => (f ? { ...f, query: e.target.value, at: 0 } : f))}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  step(e.shiftKey ? -1 : 1);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  const m = matches[current];
                  setFind(null);
                  const ta = taRef.current;
                  ta?.focus();
                  // Leave the caret on the match you stopped at, so closing
                  // the bar puts you where you were looking.
                  if (ta && m) ta.setSelectionRange(m.start, m.end);
                }
              }}
            />
            <span className="fb-count" aria-live="polite">
              {find.query === "" ? "" : matches.length === 0 ? "no matches" : `${current + 1} of ${matches.length}`}
            </span>
            <button className="btn xs" onClick={() => step(-1)} disabled={!matches.length} aria-label="Previous match">
              ↑
            </button>
            <button className="btn xs" onClick={() => step(1)} disabled={!matches.length} aria-label="Next match">
              ↓
            </button>
            <button
              className={`btn xs ${find.caseSensitive ? "on" : ""}`}
              aria-pressed={find.caseSensitive}
              onClick={() => setFind((f) => (f ? { ...f, caseSensitive: !f.caseSensitive, at: 0 } : f))}
              title="Match case"
            >
              Aa
            </button>
            <input
              className="mono"
              aria-label="Replace with"
              placeholder="Replace"
              value={find.replace}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              onChange={(e) => setFind((f) => (f ? { ...f, replace: e.target.value } : f))}
            />
            <button className="btn xs" onClick={doReplace} disabled={!matches.length}>
              Replace
            </button>
            <button className="btn xs" onClick={doReplaceAll} disabled={!matches.length}>
              All
            </button>
            <button
              className="btn xs"
              onClick={() => {
                const m = matches[current];
                setFind(null);
                const ta = taRef.current;
                ta?.focus();
                if (ta && m) ta.setSelectionRange(m.start, m.end);
              }}
              aria-label="Close find"
            >
              ✕
            </button>
          </div>
        )}
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
