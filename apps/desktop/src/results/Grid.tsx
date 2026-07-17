import { useEffect, useMemo, useRef, useState } from "react";
import { cellText } from "../lib/text";
import { invoke } from "@tauri-apps/api/core";
import { fetchAllRows } from "../lib/sql";
import { coerceValue, rowKey, type CellEdit, type EditTarget } from "../lib/dml";

/**
 * HUD result grid.
 * - Virtualized (fixed 24px rows, spacer divs, 200-row backend blocks).
 * - Click a header to sort: rows are pulled fully into memory (≤ 50k)
 *   and sorted client-side; a third click clears the sort.
 * - Click a cell to select it (⌘C copies); jsonb/json cells open the inspector.
 */

const ROW_H = 24;
const HEAD_H = 29;
const BLOCK = 200;
const OVERSCAN = 12;
const SORT_CAP = 50_000;

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
  if (/int|numeric|float|double|real|money/.test(t)) return "t-num";
  if (t.startsWith("timestamp") || t === "date" || t.startsWith("time")) return "t-time";
  return "";
}

export default function Grid(p: Props) {
  const [blocks, setBlocks] = useState<Record<number, unknown[][]>>({});
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(360);
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc" | null>(null);
  const [allRows, setAllRows] = useState<unknown[][] | null>(null);
  const [selCell, setSelCell] = useState<{ r: number; c: number } | null>(null);
  const [selRow, setSelRow] = useState<number>(-1);
  const [editing, setEditing] = useState<{ r: number; c: number } | null>(null);
  const [draft, setDraft] = useState("");
  const pending = useRef<Set<number>>(new Set());
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
    setSortCol(null);
    setSortDir(null);
    setAllRows(null);
    setSelCell(null);
    setSelRow(-1);
    setEditing(null);
  }

  useEffect(() => {
    pending.current.clear();
    p.onCopyable(null);
    if (viewRef.current) viewRef.current.scrollTop = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.epoch]);

  useEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    setViewH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const count = Math.ceil(viewH / ROW_H) + OVERSCAN * 2;
  const last = Math.min(p.storedRows, first + count);

  useEffect(() => {
    p.onVisible?.(Math.min(first + 1, p.storedRows), last);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [first, last, p.storedRows]);

  // Backend block fetch (only when not in memory mode)
  useEffect(() => {
    if (allRows || p.storedRows === 0 || last <= first) return;
    const b0 = Math.floor(first / BLOCK);
    const b1 = Math.floor((last - 1) / BLOCK);
    for (let b = b0; b <= b1; b++) {
      if (!(b in blocks) && !pending.current.has(b)) {
        pending.current.add(b);
        invoke<unknown[][]>("pg_rows", { offset: b * BLOCK, limit: BLOCK })
          .then((rows) => setBlocks((m) => ({ ...m, [b]: rows })))
          .catch(() => {})
          .finally(() => pending.current.delete(b));
      }
    }
  }, [first, last, blocks, allRows, p.storedRows]);

  const sorted = useMemo(() => {
    if (!allRows) return null;
    if (sortCol === null || !sortDir) return allRows;
    const ci = sortCol;
    const dir = sortDir === "asc" ? 1 : -1;
    return [...allRows].sort((a, b) => {
      const x = a[ci];
      const y = b[ci];
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      if (typeof x === "number" && typeof y === "number") return (x - y) * dir;
      return cellText(x).localeCompare(cellText(y)) * dir;
    });
  }, [allRows, sortCol, sortDir]);

  const rowAt = (i: number): unknown[] | null =>
    sorted ? sorted[i] ?? null : blocks[Math.floor(i / BLOCK)]?.[i % BLOCK] ?? null;

  const sortBy = async (ci: number) => {
    if (p.storedRows > SORT_CAP) {
      p.onToast(`Sorting is available up to ${SORT_CAP.toLocaleString()} rows`);
      return;
    }
    let rows = allRows;
    if (!rows) {
      p.onToast("Loading rows for sort…");
      rows = await fetchAllRows(p.storedRows, SORT_CAP);
      setAllRows(rows);
    }
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
      });
    }
    setEditing(null);
  };

  const indices: number[] = [];
  for (let i = first; i < last; i++) indices.push(i);
  const totalW = 56 + p.columns.reduce((a, c) => a + colWidth(c), 0);

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
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      <div className="g-head" role="row" style={{ minWidth: totalW }}>
        <div className="g-rownum" role="columnheader" aria-label="Row number" style={{ width: 56 }} />
        {p.columns.map((c, ci) => (
          <div
            key={ci}
            className="g-hcell"
            role="columnheader"
            aria-sort={sortCol === ci && sortDir ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
            style={{ width: colWidth(c) }}
            onClick={() => sortBy(ci)}
          >
            <span className={`cn ${sortCol === ci && sortDir ? "sorted" : ""}`}>{c.name}</span>
            <span className="ct">{c.dbType}</span>
            {sortCol === ci && sortDir && <span className="arrow">{sortDir === "asc" ? "▲" : "▼"}</span>}
          </div>
        ))}
      </div>
      {first > 0 && <div style={{ height: first * ROW_H }} />}
      {indices.map((i) => {
        const row = rowAt(i);
        return (
          <div
            key={i}
            className={`g-row ${i === selRow ? "sel" : ""}`}
            role="row"
            // 1-based, and the header is row 1 — this is the number a screen
            // reader reads out, so it has to match what the eye sees.
            aria-rowindex={i + 2}
            style={{ minWidth: totalW }}
            onClick={() => setSelRow(i)}
          >
            <div className="g-rownum" role="rowheader" style={{ width: 56 }}>
              {i + 1}
            </div>
            {row === null ? (
              <div className="g-cell loading" style={{ width: totalW - 56 }}>
                …
              </div>
            ) : (
              p.columns.map((c, ci) => {
                const original = row[ci];
                // Identity by primary key, not row position — the grid may be
                // sorted after an edit was staged.
                const rk = p.target ? rowKey(p.target.pk.map((k) => row[k.index])) : "";
                const key = `${rk}:${c.name}`;
                const isStaged = !!p.target && staged.has(key);
                const v = isStaged ? staged.get(key) : original;
                // Boolean, not `selCell && …`: that yields null when nothing is
                // selected, and `aria-selected` must be a real true/false.
                const isSel = !!selCell && selCell.r === i && selCell.c === ci;
                const isEditing = editing && editing.r === i && editing.c === ci;
                const canEdit = !!p.target?.writable[ci];

                if (isEditing) {
                  return (
                    <div key={ci} className="g-cell editing" style={{ width: colWidth(c) }}>
                      <input
                        autoFocus
                        className="g-edit"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={() => commitEdit(i, ci, original)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            commitEdit(i, ci, original);
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            setEditing(null);
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
                    ref={(el) => {
                      // Focus follows selection, but only once it is really the
                      // selected cell — otherwise every render steals focus.
                      if (isSel && el && document.activeElement !== el && viewRef.current?.contains(document.activeElement)) {
                        el.focus();
                      }
                    }}
                    style={{ width: colWidth(c) }}
                    title={
                      isStaged
                        ? `${cellText(original)} → ${cellText(v)} (pending)`
                        : canEdit
                          ? `${cellText(v)} — double-click to edit`
                          : cellText(v)
                    }
                    onClick={() => select(i, ci, c, v)}
                    onDoubleClick={() => beginEdit(i, ci, original)}
                  >
                    {cellText(v)}
                  </div>
                );
              })
            )}
          </div>
        );
      })}
      {last < p.storedRows && <div style={{ height: (p.storedRows - last) * ROW_H }} />}
      <div style={{ height: HEAD_H }} />
    </div>
  );
}
