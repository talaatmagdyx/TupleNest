import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { fetchAllRows } from "../lib/sql";

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
  onInspect: (text: string) => void;
  onCopyable: (text: string | null) => void; // selected cell value for ⌘C
  onToast: (t: string) => void;
  onVisible?: (first: number, last: number) => void;
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

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export default function Grid(p: Props) {
  const [blocks, setBlocks] = useState<Record<number, unknown[][]>>({});
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(360);
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc" | null>(null);
  const [allRows, setAllRows] = useState<unknown[][] | null>(null);
  const [selCell, setSelCell] = useState<{ r: number; c: number } | null>(null);
  const pending = useRef<Set<number>>(new Set());
  const viewRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setBlocks({});
    pending.current.clear();
    setScrollTop(0);
    setSortCol(null);
    setSortDir(null);
    setAllRows(null);
    setSelCell(null);
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
      return String(x).localeCompare(String(y)) * dir;
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
    p.onCopyable(cellText(v));
    if ((col.dbType === "jsonb" || col.dbType === "json") && v !== null && v !== undefined) {
      p.onInspect(typeof v === "object" ? JSON.stringify(v) : String(v));
    }
  };

  const indices: number[] = [];
  for (let i = first; i < last; i++) indices.push(i);
  const totalW = 56 + p.columns.reduce((a, c) => a + colWidth(c), 0);

  return (
    <div className="vgrid" ref={viewRef} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
      <div className="g-head" style={{ minWidth: totalW }}>
        <div className="g-rownum" style={{ width: 56 }} />
        {p.columns.map((c, ci) => (
          <div key={ci} className="g-hcell" style={{ width: colWidth(c) }} onClick={() => sortBy(ci)}>
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
          <div key={i} className="g-row" style={{ minWidth: totalW }}>
            <div className="g-rownum" style={{ width: 56 }}>
              {i + 1}
            </div>
            {row === null ? (
              <div className="g-cell loading" style={{ width: totalW - 56 }}>
                …
              </div>
            ) : (
              p.columns.map((c, ci) => {
                const v = row[ci];
                const isSel = selCell && selCell.r === i && selCell.c === ci;
                return (
                  <div
                    key={ci}
                    className={`g-cell ${cellClass(c, v)} ${isSel ? "selcell" : ""}`}
                    style={{ width: colWidth(c) }}
                    title={cellText(v)}
                    onClick={() => select(i, ci, c, v)}
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
