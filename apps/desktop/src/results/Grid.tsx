import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * Virtualized result grid (Phase 1).
 *
 * Rows live in the Rust backend (bounded RowStore); this component fetches
 * fixed-size blocks around the visible window via `pg_rows` and renders
 * only what is on screen, with spacer rows preserving scroll geometry.
 */

const ROW_H = 24; // px, must match .vgrid row height
const BLOCK = 200; // rows per fetch
const OVERSCAN = 12; // extra rows above/below the viewport

export type GridColumn = { name: string; dbType: string };

type Props = {
  columns: GridColumn[];
  /** Rows available for paging in the backend store. */
  storedRows: number;
  /** Bump to reset caches when a new result replaces the old one. */
  epoch: number;
};

export default function Grid({ columns, storedRows, epoch }: Props) {
  const [blocks, setBlocks] = useState<Record<number, unknown[][]>>({});
  const [scrollTop, setScrollTop] = useState(0);
  const pending = useRef<Set<number>>(new Set());
  const viewRef = useRef<HTMLDivElement | null>(null);
  const [viewH, setViewH] = useState(320);

  // New result: drop caches and jump back to the top.
  useEffect(() => {
    setBlocks({});
    pending.current.clear();
    setScrollTop(0);
    if (viewRef.current) viewRef.current.scrollTop = 0;
  }, [epoch]);

  useEffect(() => {
    if (viewRef.current) setViewH(viewRef.current.clientHeight);
  }, []);

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const count = Math.ceil(viewH / ROW_H) + OVERSCAN * 2;
  const last = Math.min(storedRows, first + count);

  // Fetch any missing blocks covering [first, last).
  useEffect(() => {
    if (storedRows === 0 || last <= first) return;
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
  }, [first, last, blocks, storedRows, epoch]);

  const rowAt = (i: number): unknown[] | null =>
    blocks[Math.floor(i / BLOCK)]?.[i % BLOCK] ?? null;

  const indices: number[] = [];
  for (let i = first; i < last; i++) indices.push(i);

  return (
    <div
      className="vgrid"
      ref={viewRef}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      <table className="grid vtable">
        <thead>
          <tr>
            <th className="rownum">#</th>
            {columns.map((c) => (
              <th key={c.name} title={c.dbType}>
                {c.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {first > 0 && (
            <tr aria-hidden style={{ height: first * ROW_H }}>
              <td colSpan={columns.length + 1} />
            </tr>
          )}
          {indices.map((i) => {
            const row = rowAt(i);
            return (
              <tr key={i} style={{ height: ROW_H }}>
                <td className="rownum">{i + 1}</td>
                {row === null ? (
                  <td className="loading-cell" colSpan={columns.length}>
                    …
                  </td>
                ) : (
                  row.map((cell, j) => (
                    <td key={j}>
                      {cell === null ? (
                        <em className="muted">null</em>
                      ) : typeof cell === "object" ? (
                        JSON.stringify(cell)
                      ) : (
                        String(cell)
                      )}
                    </td>
                  ))
                )}
              </tr>
            );
          })}
          {last < storedRows && (
            <tr aria-hidden style={{ height: (storedRows - last) * ROW_H }}>
              <td colSpan={columns.length + 1} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
