import { memo, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { cellText, errText } from "../lib/text";
import { isNumericType } from "../lib/chart";
import { invoke } from "@tauri-apps/api/core";
import { coerceValue, rowKey, type CellEdit, type EditTarget } from "../lib/dml";

/**
 * HUD result grid.
 * - Virtualized (fixed 24px rows, spacer divs, 200-row backend blocks).
 * - Click a header to sort: the backend sorts its store and pages rows out
 *   in that order, so the grid never holds more than the visible blocks;
 *   a third click clears the sort.
 * - Click a cell to select it (⌘C copies); jsonb/json cells open the inspector.
 */

const ROW_H = 24;
const HEAD_H = 29;
const BLOCK = 200;
const OVERSCAN = 12;
/** Blocks kept on each side of the one just fetched. Scrolling through 100k
 *  rows used to keep every block it passed — the whole result, in the
 *  WebView, on top of the copy Rust holds. 2 each way is 1,000 rows — forty
 *  screens of scroll-back before anything is fetched again, and on a
 *  200-column result a fifth of the cells 10 each way held. */
const KEEP_BLOCKS = 2;
/** Columns drawn either side of the visible ones. */
const COL_OVERSCAN = 3;
/** Horizontal scroll is tracked in steps this wide, so a sideways drag
 *  re-renders once per step rather than once per pixel. */
const COL_STEP = 64;
const NUM_W = 56;

/** The cache with only the blocks near `center`; far ones are fetched again
 *  if scrolled back to. */
export function keepNear<T>(m: Record<number, T>, center: number, keep = KEEP_BLOCKS): Record<number, T> {
  const out: Record<number, T> = {};
  for (const k in m) if (Math.abs(Number(k) - center) <= keep) out[k] = m[k];
  return out;
}

export type GridColumn = { name: string; dbType: string };

type Props = {
  columns: GridColumn[];
  storedRows: number;
  epoch: number;
  onInspect: (text: string, colName: string) => void;
  onCopyable: (text: string | null) => void; // selected cell value for ⌘C
  onToast: (t: string) => void;
  onVisible?: (first: number, last: number) => void;
  /** Set when this result maps to editable rows of one table. */
  target?: EditTarget | null;
  /** Staged, not-yet-applied cell changes. */
  edits?: CellEdit[];
  onStage?: (e: CellEdit) => void;
};

function colWidth(c: GridColumn): number {
  const n = c.dbType;
  if (n === "int4" || n === "int8" || n === "bigint" || n === "integer") return 90;
  if (n === "bool" || n === "boolean") return 64;
  if (n.startsWith("timestamp")) return 200;
  if (n === "numeric" || n.startsWith("numeric")) return 110;
  if (n === "jsonb" || n === "json") return 220;
  return 150;
}

function cellClass(c: GridColumn, v: unknown): string {
  if (v === null || v === undefined) return "t-null";
  const t = c.dbType;
  if (t === "jsonb" || t === "json") return "t-json";
  if (t === "bool" || t === "boolean") return v === true ? "t-true" : "t-null";
  if (isNumericType(t)) return "t-num";
  if (t.startsWith("timestamp") || t === "date" || t.startsWith("time")) return "t-time";
  return "";
}

type Handlers = {
  pick: (ri: number) => void;
  select: (ri: number, ci: number, col: GridColumn, v: unknown) => void;
  beginEdit: (ri: number, ci: number, v: unknown) => void;
  commitEdit: (ri: number, ci: number, original: unknown) => void;
  setDraft: (text: string) => void;
  cancelEdit: () => void;
};

type RowProps = {
  i: number;
  row: unknown[] | null;
  columns: GridColumn[];
  widths: number[];
  offs: number[];
  /** The drawn columns, `c0` up to but not including `c1`. */
  c0: number;
  c1: number;
  selected: boolean;
  /** The selected / edited column, on the one row that has it. */
  selCol: number | null;
  editCol: number | null;
  draft: string;
  target: EditTarget | null | undefined;
  staged: Map<string, unknown>;
  viewRef: RefObject<HTMLDivElement | null>;
  h: Handlers;
};

/**
 * One body row. Memoized, and every prop is a primitive or a reference that
 * outlives a render, so moving the selection re-renders the row it left and
 * the row it entered — not every row on screen.
 */
const Row = memo(function Row(p: RowProps) {
  const { i, row, target, widths, offs, selCol, editCol, draft, staged, viewRef, h } = p;
  const bodyW = offs[p.columns.length];
  const totalW = NUM_W + bodyW;
  const padL = offs[p.c0];
  const padR = bodyW - offs[p.c1];
  const colIdx: number[] = [];
  for (let c = p.c0; c < p.c1; c++) colIdx.push(c);
  // Identity by primary key, not row position — the grid may be
  // sorted after an edit was staged. Once per row, not per cell.
  const rk = row && target ? rowKey(target.pk.map((k) => row[k.index])) : "";
  return (
    <div
      className={`g-row ${p.selected ? "sel" : ""}`}
      role="row"
      // 1-based, and the header is row 1 — this is the number a screen
      // reader reads out, so it has to match what the eye sees.
      aria-rowindex={i + 2}
      style={{ minWidth: totalW }}
      onClick={() => h.pick(i)}
    >
      <div className="g-rownum" role="rowheader" style={{ width: NUM_W }}>
        {i + 1}
      </div>
      {row !== null && padL > 0 && <div aria-hidden="true" style={{ flex: "none", width: padL }} />}
      {row === null ? (
        <div className="g-cell loading" style={{ width: bodyW }}>
          …
        </div>
      ) : (
        colIdx.map((ci) => {
          const c = p.columns[ci];
          const original = row[ci];
          const key = `${rk}:${c.name}`;
          const isStaged = !!target && staged.size > 0 && staged.has(key);
          const v = isStaged ? staged.get(key) : original;
          const text = cellText(v);
          // Boolean, not `selCell && …`: that yields null when nothing is
          // selected, and `aria-selected` must be a real true/false.
          const isSel = selCol === ci;
          const isEditing = editCol === ci;
          const canEdit = !!target?.writable[ci];

          if (isEditing) {
            return (
              <div key={ci} className="g-cell editing" style={{ width: widths[ci] }}>
                <input
                  autoFocus
                  className="g-edit"
                  value={draft}
                  onChange={(e) => h.setDraft(e.target.value)}
                  onBlur={() => h.commitEdit(i, ci, original)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      h.commitEdit(i, ci, original);
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      h.cancelEdit();
                    }
                  }}
                />
              </div>
            );
          }
          return (
            <div
              key={ci}
              className={`g-cell ${cellClass(c, v)} ${isSel ? "selcell" : ""} ${
                isStaged ? "staged" : ""
              } ${canEdit ? "editable" : ""}`}
              role="gridcell"
              aria-colindex={ci + 2}
              aria-selected={isSel}
              aria-readonly={!canEdit}
              // The roving stop: exactly one cell is tabbable, so Tab
              // reaches the grid and the arrows move inside it.
              tabIndex={isSel ? 0 : -1}
              ref={
                // Focus follows selection, but only once it is really the
                // selected cell — otherwise every render steals focus.
                // Only the selected cell gets a ref at all.
                isSel
                  ? (el) => {
                      if (el && document.activeElement !== el && viewRef.current?.contains(document.activeElement)) {
                        el.focus();
                      }
                    }
                  : undefined
              }
              style={{ width: widths[ci] }}
              title={
                isStaged ? `${cellText(original)} → ${text} (pending)` : canEdit ? `${text} — double-click to edit` : text
              }
              onClick={() => h.select(i, ci, c, v)}
              onDoubleClick={() => h.beginEdit(i, ci, original)}
            >
              {text}
            </div>
          );
        })
      )}
      {row !== null && padR > 0 && <div aria-hidden="true" style={{ flex: "none", width: padR }} />}
    </div>
  );
});

export default function Grid(p: Props) {
  const [blocks, setBlocks] = useState<Record<number, unknown[][]>>({});
  const [scrollTop, setScrollTop] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [viewH, setViewH] = useState(360);
  const [viewW, setViewW] = useState(0);
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc" | null>(null);
  const [selCell, setSelCell] = useState<{ r: number; c: number } | null>(null);
  const [selRow, setSelRow] = useState<number>(-1);
  const [editing, setEditing] = useState<{ r: number; c: number } | null>(null);
  const [draft, setDraft] = useState("");
  const pending = useRef<Set<number>>(new Set());
  /** Bumped by every sort change, so a block fetched in the old order and
   *  arriving late is dropped instead of cached under the new one. */
  const sortGen = useRef(0);
  const viewRef = useRef<HTMLDivElement | null>(null);

  /** "rowKey:column" → staged value, for O(1) lookup while rendering.
   *  Keyed by primary key so sorting never repaints a pending value onto a
   *  different row. */
  const staged = useMemo(() => {
    const m = new Map<string, unknown>();
    for (const e of p.edits ?? []) m.set(`${e.rowKey}:${e.column}`, e.value);
    return m;
  }, [p.edits]);

  /**
   * A new result is a new grid.
   *
   * Adjusted during render, not in an effect: an effect commits first, so the
   * new result was painted once with the previous result's cached blocks, sort
   * and selection still in place — rows from the last query under the new one's
   * columns. React discards this render and re-runs before anything is shown.
   *
   * The DOM and the ref are touched in the effect below, where side effects
   * belong; only the state is adjusted here.
   */
  const [prevEpoch, setPrevEpoch] = useState(p.epoch);
  if (p.epoch !== prevEpoch) {
    setPrevEpoch(p.epoch);
    setBlocks({});
    setScrollTop(0);
    setScrollLeft(0);
    setSortCol(null);
    setSortDir(null);
    setSelCell(null);
    setSelRow(-1);
    setEditing(null);
  }

  /** The open editor, for a block that arrives after the render that asked for it. */
  const editingRef = useRef(editing);
  useEffect(() => {
    editingRef.current = editing;
  }, [editing]);

  useEffect(() => {
    sortGen.current++; // a page still in flight belongs to the previous result
    pending.current.clear();
    p.onCopyable(null);
    if (viewRef.current) {
      viewRef.current.scrollTop = 0;
      viewRef.current.scrollLeft = 0;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.epoch]);

  useEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const measure = () => {
      setViewH(el.clientHeight);
      setViewW(el.clientWidth);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const count = Math.ceil(viewH / ROW_H) + OVERSCAN * 2;
  const last = Math.min(p.storedRows, first + count);

  useEffect(() => {
    p.onVisible?.(Math.min(first + 1, p.storedRows), last);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [first, last, p.storedRows]);

  // A block that could not be fetched. Its rows stay placeholders, so
  // without this the grid looked as if it were still loading, for ever.
  const [pageError, setPageError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  // Backend block fetch, in the current sort order.
  useEffect(() => {
    if (p.storedRows === 0 || last <= first) return;
    const sort = sortCol !== null && sortDir ? { column: sortCol, desc: sortDir === "desc" } : null;
    const gen = sortGen.current;
    const b0 = Math.floor(first / BLOCK);
    const b1 = Math.floor((last - 1) / BLOCK);
    for (let b = b0; b <= b1; b++) {
      if (!(b in blocks) && !pending.current.has(b)) {
        pending.current.add(b);
        invoke<unknown[][]>("pg_rows", { offset: b * BLOCK, limit: BLOCK, sort })
          .then((rows) => {
            if (gen !== sortGen.current) return;
            setPageError(null);
            setBlocks((m) => {
              const next = keepNear({ ...m, [b]: rows }, b);
              // The row under an open editor stays cached however far the
              // view has moved: its cell is still drawn, and committing the
              // edit needs the row's key.
              const e = editingRef.current;
              const eb = e ? Math.floor(e.r / BLOCK) : -1;
              if (m[eb] && !next[eb]) next[eb] = m[eb];
              return next;
            });
          })
          .catch((e: unknown) => {
            if (gen === sortGen.current) setPageError(errText(e));
          })
          .finally(() => pending.current.delete(b));
      }
    }
    // `retry` is here to run this again; nothing in the body reads it.
  }, [first, last, blocks, p.storedRows, sortCol, sortDir, retry]);

  const rowAt = (i: number): unknown[] | null => blocks[Math.floor(i / BLOCK)]?.[i % BLOCK] ?? null;

  const sortBy = (ci: number) => {
    // A new order: every cached block is in the old one.
    sortGen.current++;
    pending.current.clear();
    setBlocks({});
    if (sortCol === ci) {
      if (sortDir === "asc") setSortDir("desc");
      else if (sortDir === "desc") {
        setSortDir(null);
        setSortCol(null);
      } else setSortDir("asc");
    } else {
      setSortCol(ci);
      setSortDir("asc");
    }
  };

  const select = (ri: number, ci: number, col: GridColumn, v: unknown) => {
    setSelCell({ r: ri, c: ci });
    setSelRow(ri);
    p.onCopyable(cellText(v));
    if ((col.dbType === "jsonb" || col.dbType === "json") && v !== null && v !== undefined) {
      p.onInspect(cellText(v), col.name);
    }
  };

  const beginEdit = (ri: number, ci: number, v: unknown) => {
    if (!p.target || !p.onStage || !p.target.writable[ci]) return;
    setEditing({ r: ri, c: ci });
    setDraft(v === null || v === undefined ? "" : cellText(v));
  };

  const commitEdit = (ri: number, ci: number, original: unknown) => {
    const t = p.target;
    if (!t || !p.onStage) return setEditing(null);
    const row = rowAt(ri);
    if (!row) return setEditing(null);

    const value = coerceValue(draft, p.columns[ci].dbType);

    // Compare the way the editor filled the box.
    //
    // This used to be `String(value) === String(original)`, which for a jsonb
    // cell compared the typed JSON against "[object Object]" — never equal. So
    // opening a jsonb cell and pressing Enter, changing nothing, staged an
    // UPDATE for it. `cellText` is what `beginEdit` puts in the box, so it is
    // what "unchanged" has to mean.
    //
    // Null is settled first: `cellText` renders it "null", and a text cell
    // holding the word "null" is not the same fact as an empty one.
    const vNull = value === null || value === undefined;
    const oNull = original === null || original === undefined;
    const same = value === original || (vNull && oNull) || (!vNull && !oNull && cellText(value) === cellText(original));
    if (!same) {
      const pkValues = t.pk.map((k) => row[k.index]);
      p.onStage({
        rowKey: rowKey(pkValues),
        pkValues,
        column: p.columns[ci].name,
        value,
        // What was on screen when the user decided to change it. This goes
        // into the UPDATE's WHERE, so the write only lands if the cell still
        // holds it — the difference between changing the row you looked at and
        // overwriting whatever happens to be there now.
        oldValue: original,
      });
    }
    setEditing(null);
  };

  /** The handlers the rows call, behind references that never change, so a
   *  render of the grid does not re-render every row. */
  const live = useRef({ select, beginEdit, commitEdit });
  useEffect(() => {
    live.current = { select, beginEdit, commitEdit };
  });
  const [h] = useState<Handlers>(() => ({
    pick: setSelRow,
    select: (...a) => live.current.select(...a),
    beginEdit: (...a) => live.current.beginEdit(...a),
    commitEdit: (...a) => live.current.commitEdit(...a),
    setDraft,
    cancelEdit: () => setEditing(null),
  }));

  // The rows in view — and the row being edited, and the row holding the
  // selected cell, wherever the view has gone: dropping either unmounts the
  // element that has the focus (the editor, or the cell the arrows move from),
  // and focus falls to <body>, where the grid's keys no longer reach. Each is
  // drawn in place, one row between two spacers, rather than by stretching
  // the window to reach it, which could be 100,000 rows.
  const pinned = new Set<number>();
  if (editing) pinned.add(editing.r);
  if (selCell && selCell.r < p.storedRows) pinned.add(selCell.r);
  const pins = [...pinned].sort((a, b) => a - b);
  const indices: number[] = pins.filter((r) => r < first);
  for (let i = first; i < last; i++) indices.push(i);
  for (const r of pins) if (r >= last) indices.push(r);

  /** Column widths and their running left edges (`offs[n]` is the full width). */
  const layout = useMemo(() => {
    const widths = p.columns.map(colWidth);
    const offs = [0];
    for (const w of widths) offs.push(offs[offs.length - 1] + w);
    return { widths, offs };
  }, [p.columns]);
  const { widths, offs } = layout;
  const nCols = p.columns.length;
  const bodyW = offs[nCols];
  const totalW = NUM_W + bodyW;

  // The columns in view. A 200-column result used to draw every cell of every
  // visible row — some 12,000 nodes — where a screen shows a dozen columns.
  // Cells outside the window are replaced by one spacer each side.
  let c0 = 0;
  while (c0 < nCols && offs[c0 + 1] <= scrollLeft) c0++;
  let c1 = c0;
  while (c1 < nCols && offs[c1] < scrollLeft + COL_STEP + viewW) c1++;
  c0 = Math.max(0, c0 - COL_OVERSCAN);
  c1 = Math.min(nCols, c1 + COL_OVERSCAN);

  const body: ReactNode[] = [];
  let next = 0;
  for (const i of indices) {
    if (i > next) body.push(<div key={`gap${next}`} style={{ height: (i - next) * ROW_H }} />);
    const sel = selCell?.r === i ? selCell.c : null;
    const ed = editing?.r === i ? editing.c : null;
    // The edited row's columns reach as far as its editor, and the selected
    // row's as far as its selected cell — for the same reason as the rows
    // above; one row of extra cells, not a screen of them. Without the
    // second, End on a wide result selected a column the window had not
    // reached yet: the new cell was not drawn, so it could not take the
    // focus, and the scroll that followed unmounted the cell that had it.
    let r0 = c0;
    let r1 = c1;
    for (const c of [ed, sel]) {
      if (c === null || c >= nCols) continue;
      r0 = Math.min(r0, c);
      r1 = Math.max(r1, c + 1);
    }
    body.push(
      <Row
        key={i}
        i={i}
        row={rowAt(i)}
        columns={p.columns}
        widths={widths}
        offs={offs}
        c0={r0}
        c1={r1}
        selected={i === selRow}
        selCol={sel}
        editCol={ed}
        draft={ed === null ? "" : draft}
        target={p.target}
        staged={staged}
        viewRef={viewRef}
        h={h}
      />,
    );
    next = i + 1;
  }
  if (next < p.storedRows) body.push(<div key={`gap${next}`} style={{ height: (p.storedRows - next) * ROW_H }} />);

  /*
   * Keyboard navigation.
   *
   * The grid was `div`s with onClick and nothing else: a keyboard user could
   * not select a cell, let alone edit one, and a screen reader was handed an
   * unlabelled pile of divs. For a database IDE the grid *is* the product, so
   * this was the largest gap in the app.
   *
   * Roving tabindex rather than making every cell tabbable: a 100,000-row
   * result would otherwise be 100,000 tab stops. One cell is in the tab order;
   * the arrows move within.
   */
  const move = (dr: number, dc: number) => {
    const cur = selCell ?? { r: first, c: 0 };
    const r = Math.max(0, Math.min(cur.r + dr, p.storedRows - 1));
    const c = Math.max(0, Math.min(cur.c + dc, p.columns.length - 1));
    const row = rowAt(r);
    setSelCell({ r, c });
    setSelRow(r);
    if (row) p.onCopyable(cellText(row[c]));
    // Follow the selection with the viewport, or arrowing past the fold moves
    // a selection nobody can see.
    const view = viewRef.current;
    if (view) {
      const top = r * ROW_H;
      const bottom = top + ROW_H;
      if (top < view.scrollTop) view.scrollTop = top;
      else if (bottom > view.scrollTop + view.clientHeight) {
        view.scrollTop = bottom - view.clientHeight;
      }
      // Sideways too: a column outside the drawn window has no cell to focus,
      // so the browser cannot bring it into view for us.
      if (dc !== 0) {
        const room = view.clientWidth - NUM_W;
        if (offs[c] < view.scrollLeft) view.scrollLeft = offs[c];
        else if (room > 0 && offs[c + 1] > view.scrollLeft + room) view.scrollLeft = offs[c + 1] - room;
      }
    }
  };

  const onGridKey = (e: React.KeyboardEvent) => {
    // While a cell editor is open the keys are its business.
    if (editing) return;
    const k = e.key;
    if (k === "ArrowDown") move(1, 0);
    else if (k === "ArrowUp") move(-1, 0);
    else if (k === "ArrowRight") move(0, 1);
    else if (k === "ArrowLeft") move(0, -1);
    // A page is what the viewport actually shows, not a fixed guess.
    else if (k === "PageDown") move(Math.max(1, Math.floor(viewH / ROW_H) - 1), 0);
    else if (k === "PageUp") move(-Math.max(1, Math.floor(viewH / ROW_H) - 1), 0);
    else if (k === "Home") move(0, -p.columns.length);
    else if (k === "End") move(0, p.columns.length);
    else if ((k === "Enter" || k === "F2") && selCell) {
      const row = rowAt(selCell.r);
      if (row) beginEdit(selCell.r, selCell.c, row[selCell.c]);
    } else return;
    e.preventDefault();
  };

  return (
    <div
      className="vgrid"
      ref={viewRef}
      role="grid"
      aria-rowcount={p.storedRows}
      aria-colcount={p.columns.length}
      aria-label="Query results"
      onKeyDown={onGridKey}
      onScroll={(e) => {
        // Snapped to a row / a column step: the same value is no state change,
        // so a scroll re-renders when the window moves, not on every pixel.
        const el = e.currentTarget;
        setScrollTop(Math.floor(el.scrollTop / ROW_H) * ROW_H);
        setScrollLeft(Math.floor(el.scrollLeft / COL_STEP) * COL_STEP);
      }}
    >
      <div className="g-head" role="row" style={{ minWidth: totalW }}>
        <div className="g-rownum" role="columnheader" aria-label="Row number" style={{ width: NUM_W }} />
        {p.columns.map((c, ci) => (
          <div
            key={ci}
            className="g-hcell"
            role="columnheader"
            aria-sort={sortCol === ci && sortDir ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
            style={{ width: widths[ci] }}
            tabIndex={0}
            onClick={() => sortBy(ci)}
            onKeyDown={(e) => {
              // Sorting was mouse-only. Stop the grid's own key handling from
              // treating this Enter as a cell edit.
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                sortBy(ci);
              }
            }}
          >
            <span className={`cn ${sortCol === ci && sortDir ? "sorted" : ""}`}>{c.name}</span>
            <span className="ct">{c.dbType}</span>
            {sortCol === ci && sortDir && <span className="arrow">{sortDir === "asc" ? "▲" : "▼"}</span>}
          </div>
        ))}
      </div>
      {/* After the header, and stuck just under it: placed before it, this
          bar sat on top of the column names for as long as it was shown. */}
      {pageError && (
        <div className="g-error" role="alert">
          <span>Some rows could not be loaded: {pageError}</span>
          <button className="btn" onClick={() => setRetry((n) => n + 1)}>
            Retry
          </button>
        </div>
      )}
      {body}
      <div style={{ height: HEAD_H }} />
    </div>
  );
}
