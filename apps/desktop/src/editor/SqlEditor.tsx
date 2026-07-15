import { useCallback, useEffect, useRef, useState } from "react";
import { tokenizeSQL } from "../lib/sql";
import { caretPosition } from "../lib/caret";
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

  const close = useCallback(() => setPop(null), []);

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
    if (!pop) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setPop({ ...pop, sel: (pop.sel + 1) % pop.items.length });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setPop({ ...pop, sel: (pop.sel - 1 + pop.items.length) % pop.items.length });
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
  useEffect(() => {
    const ta = taRef.current;
    if (!ta || !p.catalog) return;
    const t = setTimeout(() => {
      const cursor = ta.selectionStart;
      if (p.onPrefetchTables) {
        const want = tablesToPrefetch(ta.value, cursor, p.catalog!.searchPath);
        if (want.length) p.onPrefetchTables(want);
      }
      if (p.onPrefetchSchema) {
        const s = schemaToPrefetch(ta.value, cursor, p.catalog!);
        if (s) p.onPrefetchSchema(s);
      }
    }, 150);
    return () => clearTimeout(t);
  }, [p.sql, p.catalog, p.onPrefetchTables, p.onPrefetchSchema]);

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
          value={p.sql}
          spellCheck={false}
          disabled={p.disabled}
          onChange={(e) => {
            p.onChange(e.target.value);
            requestAnimationFrame(() => openAt(false));
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setTimeout(close, 120)}
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
