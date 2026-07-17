import { useState } from "react";
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

/**
 * Schema tree.
 *
 * Objects are grouped by kind, and partitions hang under their parent rather
 * than beside it. On a real schema here that is the difference between 4,196
 * top-level rows — 4,170 of them `_y2024q1`-style partitions — and 48.
 * Partitioning is multi-level (channel, then quarter), so partitions recurse.
 */

export type NodeKey = string;

type Props = {
  schemas: string[] | null;
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

function Row(p: {
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
      style={{ paddingLeft: 8 + p.depth * 13 }}
      title={p.title}
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

export default function ExplorerTree(p: Props) {
  const [filter, setFilter] = useState("");
  const f = filter.trim().toLowerCase();
  const match = (name: string) => !f || name.toLowerCase().includes(f);
  const isOpen = (k: NodeKey) => !!p.open[k];

  /** A table — or a partition, which is also a table — and its children. */
  const renderTable = (schema: string, o: DbObject, depth: number) => {
    const key = `${schema}.${o.name}`;
    const meta = KINDS.find((k) => k.kind === o.kind) ?? KINDS[0];
    const cols = p.columns[key];
    const idx = p.indexes[key];
    const cons = p.constraints[key];
    const parts = p.partitions[key];

    /* A sequence has no columns, no indexes and no constraints — giving it the
       expandable table shape would only promise three empty groups. It has
       exactly one interesting thing to say, so clicking it says it. */
    if (o.kind === "sequence") {
      return (
        <Row
          key={`t:${key}`}
          depth={depth}
          icon={<Chip ch="S" color="var(--tn-success)" />}
          label={o.name}
          title={`${o.comment ?? o.name}\n\nClick for last value, range, increment and owning column.`}
          className="clickable"
          onClick={() => p.onDetails(schema, o.name, "sequence")}
        />
      );
    }

    return (
      <div key={`t:${key}`}>
        <Row
          depth={depth}
          arrow
          open={isOpen(`t:${key}`)}
          icon={<Chip ch={meta.ch} color={meta.color} />}
          label={o.name}
          title={o.comment ?? o.name}
          badge={
            o.isPartitioned ? (
              <span
                className="part-badge act"
                title={`${o.partitionCount} direct partitions — click for bounds, sizes and gaps`}
                onClick={(e) => {
                  e.stopPropagation();
                  p.onPartitions(schema, o.name);
                }}
              >
                {o.partitionCount}
              </span>
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
          onClick={() => p.onToggle(`t:${key}`)}
          onDoubleClick={() => p.onInsertSelect(schema, o.name)}
        />
        {isOpen(`t:${key}`) && (
          <>
            <Row
              depth={depth + 1}
              arrow
              open={isOpen(`c:${key}`)}
              label={<span className="grp">Columns</span>}
              badge={cols ? <span className="count">{cols.length}</span> : undefined}
              onClick={() => p.onToggle(`c:${key}`)}
            />
            {isOpen(`c:${key}`) &&
              (cols === undefined ? (
                <div className="note" style={{ paddingLeft: 8 + (depth + 2) * 13 }}>
                  loading…
                </div>
              ) : (
                cols.map((c) => (
                  <div key={c.name} className="tree-row leaf" style={{ paddingLeft: 8 + (depth + 2) * 13 }}>
                    <span className="cn">{c.name}</span>
                    <span className="ct">{c.dbType}</span>
                    {c.primaryKey && <span className="pk">PK</span>}
                  </div>
                ))
              ))}

            <Row
              depth={depth + 1}
              arrow
              open={isOpen(`i:${key}`)}
              label={<span className="grp">Indexes</span>}
              badge={idx ? <span className="count">{idx.length}</span> : undefined}
              onClick={() => p.onToggle(`i:${key}`)}
            />
            {isOpen(`i:${key}`) &&
              (idx === undefined ? (
                <div className="note" style={{ paddingLeft: 8 + (depth + 2) * 13 }}>
                  loading…
                </div>
              ) : idx.length === 0 ? (
                <div className="note" style={{ paddingLeft: 8 + (depth + 2) * 13 }}>
                  {/* "none" on a partitioned table reads like a bug. It isn't:
                      this database creates indexes on the leaves rather than on
                      the parent, so the parent really has none. Say which. */}
                  {o.isPartitioned
                    ? "none on this level — defined on the partitions"
                    : "none"}
                </div>
              ) : (
                idx.map((ix) => (
                  <div
                    key={ix.name}
                    className="tree-row leaf clickable"
                    style={{ paddingLeft: 8 + (depth + 2) * 13 }}
                    title={`${ix.definition}\n\nClick for size, scans and tuples read.`}
                    onClick={() => p.onDetails(schema, ix.name, "index")}
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
                ))
              ))}

            <Row
              depth={depth + 1}
              arrow
              open={isOpen(`k:${key}`)}
              label={<span className="grp">Constraints</span>}
              badge={cons ? <span className="count">{cons.length}</span> : undefined}
              onClick={() => p.onToggle(`k:${key}`)}
            />
            {isOpen(`k:${key}`) &&
              (cons === undefined ? (
                <div className="note" style={{ paddingLeft: 8 + (depth + 2) * 13 }}>
                  loading…
                </div>
              ) : cons.length === 0 ? (
                <div className="note" style={{ paddingLeft: 8 + (depth + 2) * 13 }}>
                  none
                </div>
              ) : (
                cons.map((cn) => (
                  <div
                    key={cn.name}
                    className="tree-row leaf"
                    style={{ paddingLeft: 8 + (depth + 2) * 13 }}
                    title={cn.definition ?? cn.kind}
                  >
                    <span className="cn">{cn.name}</span>
                    {!cn.isValid && <span className="dead">NOT VALID</span>}
                    <span className="ct">{cn.kind}</span>
                  </div>
                ))
              ))}

            {o.isPartitioned && (
              <>
                <Row
                  depth={depth + 1}
                  arrow
                  open={isOpen(`p:${key}`)}
                  label={<span className="grp">Partitions</span>}
                  badge={<span className="count">{o.partitionCount}</span>}
                  onClick={() => p.onToggle(`p:${key}`)}
                />
                {isOpen(`p:${key}`) &&
                  (parts === undefined ? (
                    <div className="note" style={{ paddingLeft: 8 + (depth + 2) * 13 }}>
                      loading…
                    </div>
                  ) : (
                    parts
                      .filter((pt) => match(pt.name))
                      .map((pt) =>
                        renderTable(
                          schema,
                          {
                            name: pt.name,
                            kind: "table",
                            comment: pt.bounds,
                            // Straight from the server. Deriving this from
                            // already-loaded partitions was circular: the node
                            // only appeared once opened, so it never appeared.
                            isPartitioned: pt.isPartitioned,
                            partitionCount: pt.partitionCount,
                          },
                          depth + 2
                        )
                      )
                  ))}
              </>
            )}
          </>
        )}
      </div>
    );
  };

  const renderSchema = (schema: string) => {
    const objs = p.objects[schema];
    const types = p.types[schema];
    const routines = p.routines[schema];
    const open = isOpen(`s:${schema}`);

    return (
      <div key={schema}>
        <Row
          depth={0}
          arrow
          open={open}
          icon={
            <span style={{ color: "var(--tn-ts)", display: "inline-flex" }}>
              <DbIcon />
            </span>
          }
          label={<span style={{ fontWeight: 600, color: "var(--tn-tp)" }}>{schema}</span>}
          badge={objs ? <span className="count">{objs.length}</span> : undefined}
          onClick={() => p.onToggle(`s:${schema}`)}
        />
        {open && objs === undefined && <div className="note" style={{ paddingLeft: 21 }}>loading…</div>}
        {open &&
          objs !== undefined &&
          KINDS.map(({ kind, label }) => {
            const all = objs.filter((o) => o.kind === kind);
            if (all.length === 0) return null;
            const items = all.filter((o) => match(o.name));
            const gk = `g:${schema}:${kind}`;
            return (
              <div key={kind}>
                <Row
                  depth={1}
                  arrow
                  open={isOpen(gk)}
                  label={<span className="grp">{label}</span>}
                  badge={<span className="count">{f ? `${items.length}/${all.length}` : all.length}</span>}
                  onClick={() => p.onToggle(gk)}
                />
                {isOpen(gk) &&
                  (items.length === 0 ? (
                    <div className="note" style={{ paddingLeft: 34 }}>no match</div>
                  ) : (
                    items.map((o) => renderTable(schema, o, 2))
                  ))}
              </div>
            );
          })}

        {/* Enums live here. They were invisible before, despite being on the
            table you look at most. */}
        {open && types !== undefined && types.length > 0 && (
          <>
            <Row
              depth={1}
              arrow
              open={isOpen(`g:${schema}:types`)}
              label={<span className="grp">Types &amp; enums</span>}
              badge={<span className="count">{types.length}</span>}
              onClick={() => p.onToggle(`g:${schema}:types`)}
            />
            {isOpen(`g:${schema}:types`) &&
              types
                .filter((t) => match(t.name))
                .map((t) => (
                  <div key={t.name} className="tree-row leaf" style={{ paddingLeft: 34 }} title={t.labels ?? t.kind}>
                    <Chip ch="E" color="var(--tn-brand-a, #FFC24B)" />
                    <span className="cn">{t.name}</span>
                    <span className="ct">{t.labels ?? t.kind}</span>
                  </div>
                ))}
          </>
        )}

        {open && routines !== undefined && routines.length > 0 && (
          <>
            <Row
              depth={1}
              arrow
              open={isOpen(`g:${schema}:routines`)}
              label={<span className="grp">Functions</span>}
              badge={<span className="count">{routines.length}</span>}
              onClick={() => p.onToggle(`g:${schema}:routines`)}
            />
            {isOpen(`g:${schema}:routines`) &&
              routines
                .filter((r) => match(r.name))
                .map((r) => (
                  <div
                    key={`${r.name}(${r.args ?? ""})`}
                    className="tree-row leaf"
                    style={{ paddingLeft: 34 }}
                    title={`${r.name}(${r.args ?? ""}) → ${r.returns ?? "void"} · ${r.language}`}
                  >
                    <Chip ch="ƒ" color="var(--tn-success)" />
                    <span className="cn">{r.name}</span>
                    <span className="ct">{r.returns ?? r.kind}</span>
                  </div>
                ))}
          </>
        )}
      </div>
    );
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
      <div className="tree">
        {p.schemas === null && p.connected && <div className="note">Loading schemas…</div>}
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
        {(p.schemas ?? []).map(renderSchema)}
      </div>
    </>
  );
}
