import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  DbColumn,
  DbConstraint,
  DbIndex,
  DbObject,
  DbPartition,
  DbRoutine,
  DbType,
} from "../ipc/types";
import { DbIcon, SearchIcon } from "../lib/icons";
import { groupId, schemaId, tableKey } from "../lib/nodes";

/**
 * Schema tree.
 *
 * Objects are grouped by kind, and partitions hang under their parent rather
 * than beside it. On a real schema here that is the difference between 4,196
 * top-level rows — 4,170 of them `_y2024q1`-style partitions — and 48.
 * Partitioning is multi-level (channel, then quarter), so partitions recurse.
 *
 * Windowed: the visible tree is flattened into one array of row descriptors
 * and only the rows near the viewport are in the DOM, between two spacers.
 * An open group of thousands of tables costs a screenful of nodes, not
 * thousands — and a toggle re-renders that screenful, not the schema.
 */

export type NodeKey = string;

type Props = {
  schemas: string[] | null;
  /** Why the schemas did not load, and a way to ask again. */
  loadError?: string | null;
  onRetry?: () => void;
  metaCached: boolean;
  connected: boolean;
  /** Expanded state, keyed by node id. */
  open: Record<NodeKey, boolean>;
  onToggle: (key: NodeKey) => void;

  objects: Record<string, DbObject[]>;
  columns: Record<string, DbColumn[]>;
  indexes: Record<string, DbIndex[]>;
  constraints: Record<string, DbConstraint[]>;
  partitions: Record<string, DbPartition[]>;
  types: Record<string, DbType[]>;
  routines: Record<string, DbRoutine[]>;

  onInsertSelect: (schema: string, name: string) => void;
  onDescribe: (schema: string, name: string) => void;
  /** Show everything the server knows about one object. */
  onDetails: (schema: string, name: string, kind: string) => void;
  /** Bounds, sizes and gaps for a partitioned table. */
  onPartitions: (schema: string, table: string) => void;
  onConnect?: () => void;
};

const KINDS: { kind: string; label: string; ch: string; color: string }[] = [
  { kind: "table", label: "Tables", ch: "T", color: "var(--tn-accent)" },
  { kind: "view", label: "Views", ch: "V", color: "var(--tn-purple)" },
  { kind: "matview", label: "Materialized views", ch: "M", color: "var(--tn-purple)" },
  { kind: "foreign", label: "Foreign tables", ch: "F", color: "var(--tn-warning)" },
  { kind: "sequence", label: "Sequences", ch: "S", color: "var(--tn-success)" },
];

const fmtBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
};

/** Every row is exactly this tall, so a row's offset is its index times this. */
const ROW_H = 24;
/** Rows kept rendered beyond each edge of the viewport. */
const OVERSCAN = 10;
/** Viewport height assumed until the tree has been measured (and under
 *  jsdom, which reports 0). */
const FALLBACK_H = 600;

/** One visible row. `depth` is the indent; `nav` rows are the focusable
 *  treeitems the arrow keys move between; rows that expand carry `open` and
 *  the `nodeKey` that toggles them. */
type FlatRow = { id: string; depth: number; nav: boolean } & (
  | { t: "schema"; open: boolean; nodeKey: NodeKey; schema: string; count?: number }
  | { t: "group"; open: boolean; nodeKey: NodeKey; label: string; badge?: string | number }
  | { t: "table"; open: boolean; nodeKey: NodeKey; schema: string; o: DbObject }
  | { t: "seq"; schema: string; o: DbObject }
  | { t: "note"; text: string }
  | { t: "col"; c: DbColumn }
  | { t: "idx"; schema: string; ix: DbIndex }
  | { t: "con"; cn: DbConstraint }
  | { t: "type"; ty: DbType }
  | { t: "routine"; r: DbRoutine }
);

type TreeData = Pick<
  Props,
  "schemas" | "objects" | "columns" | "indexes" | "constraints" | "partitions" | "types" | "routines"
>;

/** The tree as the eye sees it: one entry per visible row, top to bottom. */
function flatten(d: TreeData, open: Record<NodeKey, boolean>, f: string): FlatRow[] {
  const out: FlatRow[] = [];
  const match = (name: string) => !f || name.toLowerCase().includes(f);
  const note = (id: string, depth: number, text: string) =>
    out.push({ t: "note", id, depth, nav: false, text });
  /** Pushes an expandable header and says whether it is open. */
  const group = (id: string, nodeKey: NodeKey, depth: number, label: string, badge?: string | number) => {
    const isOpen = !!open[nodeKey];
    out.push({ t: "group", id, depth, nav: true, open: isOpen, nodeKey, label, badge });
    return isOpen;
  };

  /** A table — or a partition, which is also a table — and its children. */
  const table = (schema: string, o: DbObject, depth: number, path: string) => {
    const key = tableKey(schema, o.name);
    const id = `${path}/t:${key}`;
    /* A sequence has no columns, no indexes and no constraints — giving it the
       expandable table shape would only promise three empty groups. It has
       exactly one interesting thing to say, so clicking it says it. */
    if (o.kind === "sequence") {
      out.push({ t: "seq", id, depth, nav: true, schema, o });
      return;
    }
    const nodeKey = `t:${key}`;
    const isOpen = !!open[nodeKey];
    out.push({ t: "table", id, depth, nav: true, open: isOpen, nodeKey, schema, o });
    if (!isOpen) return;

    const cols = d.columns[key];
    if (group(`${id}/c`, `c:${key}`, depth + 1, "Columns", cols?.length)) {
      if (cols === undefined) note(`${id}/c/…`, depth + 2, "loading…");
      else for (const c of cols) out.push({ t: "col", id: `${id}/c/${c.name}`, depth: depth + 2, nav: false, c });
    }

    const idx = d.indexes[key];
    if (group(`${id}/i`, `i:${key}`, depth + 1, "Indexes", idx?.length)) {
      if (idx === undefined) note(`${id}/i/…`, depth + 2, "loading…");
      else if (idx.length === 0)
        /* "none" on a partitioned table reads like a bug. It isn't: this
           database creates indexes on the leaves rather than on the parent,
           so the parent really has none. Say which. */
        note(`${id}/i/…`, depth + 2, o.isPartitioned ? "none on this level — defined on the partitions" : "none");
      else
        for (const ix of idx) out.push({ t: "idx", id: `${id}/i/${ix.name}`, depth: depth + 2, nav: false, schema, ix });
    }

    const cons = d.constraints[key];
    if (group(`${id}/k`, `k:${key}`, depth + 1, "Constraints", cons?.length)) {
      if (cons === undefined) note(`${id}/k/…`, depth + 2, "loading…");
      else if (cons.length === 0) note(`${id}/k/…`, depth + 2, "none");
      else for (const cn of cons) out.push({ t: "con", id: `${id}/k/${cn.name}`, depth: depth + 2, nav: false, cn });
    }

    if (o.isPartitioned && group(`${id}/p`, `p:${key}`, depth + 1, "Partitions", o.partitionCount)) {
      const parts = d.partitions[key];
      if (parts === undefined) note(`${id}/p/…`, depth + 2, "loading…");
      else
        for (const pt of parts)
          if (match(pt.name))
            table(
              schema,
              {
                name: pt.name,
                kind: "table",
                comment: pt.bounds,
                // Straight from the server. Deriving this from already-loaded
                // partitions was circular: the node only appeared once opened,
                // so it never appeared.
                isPartitioned: pt.isPartitioned,
                partitionCount: pt.partitionCount,
              },
              depth + 2,
              `${id}/p`
            );
    }
  };

  for (const schema of d.schemas ?? []) {
    const sid = schemaId(schema);
    const objs = d.objects[schema];
    const isOpen = !!open[sid];
    out.push({ t: "schema", id: sid, depth: 0, nav: true, open: isOpen, nodeKey: sid, schema, count: objs?.length });
    if (!isOpen) continue;

    if (objs === undefined) note(`${sid}/…`, 1, "loading…");
    else
      for (const { kind, label } of KINDS) {
        const all = objs.filter((o) => o.kind === kind);
        if (all.length === 0) continue;
        const items = all.filter((o) => match(o.name));
        const gk = groupId(schema, kind);
        if (!group(gk, gk, 1, label, f ? `${items.length}/${all.length}` : all.length)) continue;
        if (items.length === 0) note(`${gk}/…`, 2, "no match");
        else for (const o of items) table(schema, o, 2, gk);
      }

    /* Enums live here. They were invisible before, despite being on the table
       you look at most. */
    const types = d.types[schema];
    if (types !== undefined && types.length > 0) {
      const gk = groupId(schema, "types");
      if (group(gk, gk, 1, "Types & enums", types.length))
        for (const ty of types)
          if (match(ty.name)) out.push({ t: "type", id: `${gk}/${ty.name}`, depth: 2, nav: false, ty });
    }

    const routines = d.routines[schema];
    if (routines !== undefined && routines.length > 0) {
      const gk = groupId(schema, "routines");
      if (group(gk, gk, 1, "Functions", routines.length))
        for (const r of routines)
          if (match(r.name))
            out.push({ t: "routine", id: `${gk}/${r.name}(${r.args ?? ""})`, depth: 2, nav: false, r });
    }
  }
  return out;
}

/** The slice of `total` rows to render for a scroll offset and viewport. */
const windowOf = (scrollTop: number, viewH: number, total: number): [number, number] => {
  const count = Math.ceil(viewH / ROW_H) + OVERSCAN * 2;
  // Clamped so a tree that just shrank under a deep scroll shows its tail
  // rather than nothing, until the browser pulls the scroll offset back.
  const first = Math.max(0, Math.min(Math.floor(scrollTop / ROW_H) - OVERSCAN, total - count));
  return [first, Math.min(total, first + count)];
};

const pad = (depth: number) => 8 + depth * 13;

function Row(p: {
  idx: number;
  depth: number;
  open?: boolean;
  arrow?: boolean;
  icon?: React.ReactNode;
  label: React.ReactNode;
  badge?: React.ReactNode;
  title?: string;
  act?: React.ReactNode;
  className?: string;
  onClick?: () => void;
  onDoubleClick?: () => void;
}) {
  return (
    <div
      className={`tree-row ${p.className ?? ""}`}
      style={{ paddingLeft: pad(p.depth), height: ROW_H }}
      title={p.title}
      // Where this row sits in the flattened tree: how the keyboard handler
      // finds its place without walking the DOM.
      data-i={p.idx}
      // Keyboard and screen readers: each row is a focusable treeitem. Space
      // is the click (expand, select); Enter is the double-click (open,
      // insert), falling back to the click where a row has only that.
      role="treeitem"
      aria-level={p.depth + 1}
      aria-expanded={p.arrow ? !!p.open : undefined}
      // Roving focus: rows are reached with the arrow keys, not Tab — one tab
      // stop for the whole tree instead of one per table (thousands, on a big
      // schema). The tree hands focus to a row; see `onTreeKey`.
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return; // a button inside the row
        if (e.key === " ") {
          e.preventDefault();
          p.onClick?.();
        } else if (e.key === "Enter") {
          e.preventDefault();
          (p.onDoubleClick ?? p.onClick)?.();
        }
      }}
      onClick={p.onClick}
      onDoubleClick={p.onDoubleClick}
    >
      <span className={`caret ${p.open ? "open" : ""}`} style={{ visibility: p.arrow ? "visible" : "hidden" }}>
        ▶
      </span>
      {p.icon}
      <span className="tl">{p.label}</span>
      {p.badge}
      {p.act}
    </div>
  );
}

const Chip = ({ ch, color }: { ch: string; color: string }) => (
  <span className="obj-ic" style={{ color }}>
    {ch}
  </span>
);

const NOTE_STYLE: React.CSSProperties = {
  height: ROW_H,
  lineHeight: `${ROW_H - 6}px`,
  overflow: "hidden",
  whiteSpace: "nowrap",
  textOverflow: "ellipsis",
};

export default function ExplorerTree(p: Props) {
  const [filter, setFilter] = useState("");
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(FALLBACK_H);
  const treeRef = useRef<HTMLDivElement | null>(null);
  /** Id of the row that last had focus: where Tab lands, and where the arrow
   *  keys resume from once that row has scrolled out of the window. */
  const lastId = useRef<string | null>(null);
  /** Row index to focus once it has been rendered. */
  const pending = useRef<number | null>(null);
  /** Focus is parked on the tree itself because its row left the window. */
  const parked = useRef(false);

  const f = filter.trim().toLowerCase();
  const rows = useMemo(
    () =>
      flatten(
        {
          schemas: p.schemas,
          objects: p.objects,
          columns: p.columns,
          indexes: p.indexes,
          constraints: p.constraints,
          partitions: p.partitions,
          types: p.types,
          routines: p.routines,
        },
        p.open,
        f
      ),
    [p.schemas, p.objects, p.columns, p.indexes, p.constraints, p.partitions, p.types, p.routines, p.open, f]
  );
  const [first, last] = windowOf(scrollTop, viewH, rows.length);

  useEffect(() => {
    const el = treeRef.current as HTMLDivElement;
    const measure = () => setViewH(el.clientHeight || FALLBACK_H);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);

  // A row that was outside the window when it was asked to take focus.
  useLayoutEffect(() => {
    if (pending.current === null) return;
    treeRef.current?.querySelector<HTMLElement>(`[data-i="${pending.current}"]`)?.focus();
    pending.current = null;
  });

  /** Focus row `i`, scrolling it into the window first if it is not there. */
  const focusRow = (el: HTMLElement, i: number) => {
    const top = i * ROW_H;
    const h = el.clientHeight || FALLBACK_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + h) el.scrollTop = top + ROW_H - h;
    setScrollTop(Math.floor(el.scrollTop / ROW_H) * ROW_H);
    const node = el.querySelector<HTMLElement>(`[data-i="${i}"]`);
    if (node) node.focus();
    else pending.current = i;
  };

  /** The WAI-ARIA tree keys: Up/Down move, Right opens (or steps in), Left
   *  closes (or steps out to the parent), Home/End jump to the ends. */
  const onTreeKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const target = e.target as HTMLElement;
    // On the tree itself, focus is parked: carry on from the row last used.
    const i =
      target === el
        ? rows.findIndex((r) => r.id === lastId.current)
        : target.dataset.i === undefined
          ? -1 // a button inside a row
          : Number(target.dataset.i);
    if (i === -1) return;
    const cur = rows[i];
    /** The nearest focusable row from `from`, exclusive, going `dir`. */
    const step = (from: number, dir: 1 | -1) => {
      for (let j = from + dir; j >= 0 && j < rows.length; j += dir) if (rows[j].nav) return j;
      return i;
    };
    switch (e.key) {
      case "ArrowDown":
        focusRow(el, step(i, 1));
        break;
      case "ArrowUp":
        focusRow(el, step(i, -1));
        break;
      case "Home":
        focusRow(el, step(-1, 1));
        break;
      case "End":
        focusRow(el, step(rows.length, -1));
        break;
      case "ArrowRight":
        if ("open" in cur && !cur.open) p.onToggle(cur.nodeKey);
        else if ("open" in cur) focusRow(el, step(i, 1));
        else return;
        break;
      case "ArrowLeft": {
        if ("open" in cur && cur.open) {
          p.onToggle(cur.nodeKey);
          break;
        }
        // Step out: the nearest row above with a lower level is the parent.
        for (let j = i - 1; j >= 0; j--) {
          if (rows[j].nav && rows[j].depth < cur.depth) {
            focusRow(el, j);
            break;
          }
        }
        break;
      }
      default:
        return;
    }
    e.preventDefault();
  };

  const renderRow = (r: FlatRow, i: number) => {
    const leaf = { paddingLeft: pad(r.depth), height: ROW_H };
    switch (r.t) {
      case "schema":
        return (
          <Row
            key={r.id}
            idx={i}
            depth={0}
            arrow
            open={r.open}
            icon={
              <span style={{ color: "var(--tn-ts)", display: "inline-flex" }}>
                <DbIcon />
              </span>
            }
            label={<span style={{ fontWeight: 600, color: "var(--tn-tp)" }}>{r.schema}</span>}
            badge={r.count !== undefined ? <span className="count">{r.count}</span> : undefined}
            onClick={() => p.onToggle(r.nodeKey)}
          />
        );
      case "group":
        return (
          <Row
            key={r.id}
            idx={i}
            depth={r.depth}
            arrow
            open={r.open}
            label={<span className="grp">{r.label}</span>}
            badge={r.badge !== undefined ? <span className="count">{r.badge}</span> : undefined}
            onClick={() => p.onToggle(r.nodeKey)}
          />
        );
      case "seq":
        return (
          <Row
            key={r.id}
            idx={i}
            depth={r.depth}
            icon={<Chip ch="S" color="var(--tn-success)" />}
            label={r.o.name}
            title={`${r.o.comment ?? r.o.name}\n\nClick for last value, range, increment and owning column.`}
            className="clickable"
            onClick={() => p.onDetails(r.schema, r.o.name, "sequence")}
          />
        );
      case "table": {
        const { o, schema } = r;
        const meta = KINDS.find((k) => k.kind === o.kind) ?? KINDS[0];
        return (
          <Row
            key={r.id}
            idx={i}
            depth={r.depth}
            arrow
            open={r.open}
            icon={<Chip ch={meta.ch} color={meta.color} />}
            label={o.name}
            title={o.comment ?? o.name}
            badge={
              o.isPartitioned ? (
                <button
                  type="button"
                  className="part-badge act"
                  title={`${o.partitionCount} direct partitions — click for bounds, sizes and gaps`}
                  aria-label={`${o.partitionCount} partitions of ${o.name}: bounds, sizes and gaps`}
                  onClick={(e) => {
                    e.stopPropagation();
                    p.onPartitions(schema, o.name);
                  }}
                >
                  {o.partitionCount}
                </button>
              ) : undefined
            }
            act={
              <span className="hover-act">
                <button
                  type="button"
                  className="det-btn"
                  title="Details — size, rows, partitioning, owner"
                  onClick={(e) => {
                    e.stopPropagation();
                    p.onDetails(schema, o.name, o.kind);
                  }}
                >
                  ⓘ
                </button>
              </span>
            }
            onClick={() => p.onToggle(r.nodeKey)}
            onDoubleClick={() => p.onInsertSelect(schema, o.name)}
          />
        );
      }
      case "note":
        return (
          <div key={r.id} className="note" style={{ ...NOTE_STYLE, paddingLeft: pad(r.depth) }}>
            {r.text}
          </div>
        );
      case "col":
        return (
          <div key={r.id} className="tree-row leaf" style={leaf}>
            <span className="cn">{r.c.name}</span>
            <span className="ct">{r.c.dbType}</span>
            {r.c.primaryKey && <span className="pk">PK</span>}
          </div>
        );
      case "idx": {
        const { ix } = r;
        return (
          <div
            key={r.id}
            className="tree-row leaf clickable"
            style={leaf}
            title={`${ix.definition}\n\nClick for size, scans and tuples read.`}
            onClick={() => p.onDetails(r.schema, ix.name, "index")}
          >
            <span className="cn">{ix.name}</span>
            {ix.isPrimary && <span className="pk">PK</span>}
            {ix.isUnique && !ix.isPrimary && <span className="uq">UNIQUE</span>}
            {!ix.isValid && <span className="dead">INVALID</span>}
            {/* The number that matters on a schema with 8,885 indexes. */}
            {ix.scans === 0 && ix.isValid && !ix.isPrimary && (
              <span className="dead" title="Never scanned since the stats were last reset">
                UNUSED
              </span>
            )}
            <span className="ct">{fmtBytes(ix.bytes)}</span>
          </div>
        );
      }
      case "con":
        return (
          <div key={r.id} className="tree-row leaf" style={leaf} title={r.cn.definition ?? r.cn.kind}>
            <span className="cn">{r.cn.name}</span>
            {!r.cn.isValid && <span className="dead">NOT VALID</span>}
            <span className="ct">{r.cn.kind}</span>
          </div>
        );
      case "type":
        return (
          <div key={r.id} className="tree-row leaf" style={leaf} title={r.ty.labels ?? r.ty.kind}>
            <Chip ch="E" color="var(--tn-warning)" />
            <span className="cn">{r.ty.name}</span>
            <span className="ct">{r.ty.labels ?? r.ty.kind}</span>
          </div>
        );
      case "routine":
        return (
          <div
            key={r.id}
            className="tree-row leaf"
            style={leaf}
            title={`${r.r.name}(${r.r.args ?? ""}) → ${r.r.returns ?? "void"} · ${r.r.language}`}
          >
            <Chip ch="ƒ" color="var(--tn-success)" />
            <span className="cn">{r.r.name}</span>
            <span className="ct">{r.r.returns ?? r.r.kind}</span>
          </div>
        );
    }
  };

  return (
    <>
      <div className="side-head">
        <span className="label">Explorer</span>
        {p.metaCached ? (
          <span className="src-chip cached">CACHED</span>
        ) : p.connected ? (
          <span className="src-chip live">
            <span className="dot" style={{ background: "var(--tn-success)" }} />
            live
          </span>
        ) : null}
      </div>
      {p.schemas !== null && (
        <div className="filter-box">
          <span className="muted" style={{ display: "inline-flex" }}>
            <SearchIcon />
          </span>
          <input
            placeholder="Filter objects…"
            spellCheck={false}
            autoComplete="off"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      )}
      <div
        className="tree"
        role="tree"
        aria-label="Database objects"
        ref={treeRef}
        tabIndex={0}
        onFocus={(e) => {
          const el = e.currentTarget;
          const target = e.target as HTMLElement;
          if (target !== el) {
            // A row took focus (keys or a click): remember it.
            if (target.dataset.i !== undefined) lastId.current = rows[Number(target.dataset.i)].id;
            return;
          }
          if (parked.current) {
            parked.current = false;
            return;
          }
          // Tabbing into the tree lands on the row last used, or the first.
          if (rows.length > 0) focusRow(el, Math.max(0, rows.findIndex((r) => r.id === lastId.current)));
        }}
        onKeyDown={onTreeKey}
        onScroll={(e) => {
          // Snapped to a row: the same value is no state change, so a scroll
          // re-renders when the window moves, not on every pixel.
          const el = e.currentTarget;
          const top = Math.floor(el.scrollTop / ROW_H) * ROW_H;
          // The focused row is about to leave the window, and focus would be
          // dropped with its node. Park it on the tree, where the arrow keys
          // still arrive and resume from that row.
          const focused = el.querySelector<HTMLElement>("[data-i]:focus");
          if (focused) {
            const [nf, nl] = windowOf(top, viewH, rows.length);
            const i = Number(focused.dataset.i);
            if (i < nf || i >= nl) {
              parked.current = true;
              el.focus({ preventScroll: true });
            }
          }
          setScrollTop(top);
        }}
      >
        {p.schemas === null && p.connected && !p.loadError && <div className="note">Loading schemas…</div>}
        {p.schemas === null && p.connected && p.loadError && (
          <div className="explorer-empty" role="alert">
            <p>Could not load the schemas: {p.loadError}</p>
            {p.onRetry && (
              <button className="btn" onClick={p.onRetry}>
                Retry
              </button>
            )}
          </div>
        )}
        {p.schemas === null && !p.connected && (
          <div className="explorer-empty">
            <p>Not connected.</p>
            {p.onConnect && (
              <button className="btn" onClick={p.onConnect}>
                New connection
              </button>
            )}
          </div>
        )}
        {first > 0 && <div role="presentation" style={{ height: first * ROW_H }} />}
        {rows.slice(first, last).map((r, k) => renderRow(r, first + k))}
        {last < rows.length && <div role="presentation" style={{ height: (rows.length - last) * ROW_H }} />}
      </div>
    </>
  );
}
