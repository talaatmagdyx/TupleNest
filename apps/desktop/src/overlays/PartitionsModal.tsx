import { useMemo } from "react";
import { ModalHead, Overlay } from "./Overlays";
import type { PartitionOverview } from "../ipc/types";
import { createPartitionSql, detachSql, dropPartitionSql, findGaps } from "../lib/partitions";

type Props = {
  schema: string;
  table: string;
  data: PartitionOverview | null;
  error: string | null;
  onOpenScript: (name: string, sql: string) => void;
  onClose: () => void;
};

export default function PartitionsModal(p: Props) {
  const gaps = useMemo(() => (p.data ? findGaps(p.data.items) : []), [p.data]);
  const rangeish = p.data?.strategy.toUpperCase() === "RANGE";

  return (
    <Overlay onClose={p.onClose}>
      <div className="modal health-modal">
        <ModalHead
          title={
            <span style={{ display: "inline-flex", gap: 9, alignItems: "center" }}>
              <span className="chip">PARTITIONS</span>
              <span className="mono" style={{ fontSize: 12.5, color: "var(--tn-tp)" }}>
                {p.schema}.{p.table}
              </span>
            </span>
          }
          onClose={p.onClose}
        />
        <div className="modal-body">
          {p.error && <div className="error-box">{p.error}</div>}
          {!p.error && !p.data && <div className="note muted">loading…</div>}
          {p.data && !p.data.partitioned && (
            <div className="empty-state">
              <div className="es-t">Not partitioned</div>
              <div className="es-b">This table stores its own rows.</div>
            </div>
          )}
          {p.data?.partitioned && (
            <>
              <div className="health-hero">
                <div>
                  <div className="hero-n">{p.data.items.length}</div>
                  <div className="hero-l">
                    direct partitions · {p.data.partitionKey}
                  </div>
                </div>
              </div>

              {rangeish && gaps.length > 0 && (
                <>
                  <p className="health-caveat warn">
                    {gaps.length} gap{gaps.length === 1 ? "" : "s"} in the range series. A row
                    landing in a gap fails to insert unless a DEFAULT partition catches it. Bounds
                    are compared as text, which is right for dates and integers and unreliable for
                    anything else — check before acting.
                  </p>
                  <div className="htable" style={{ marginBottom: 14 }}>
                    <div className="gap-row hhead">
                      <span>Missing range</span>
                      <span>After</span>
                      <span>Before</span>
                      <span />
                    </div>
                    {gaps.map((g, i) => (
                      <div className="gap-row" key={i}>
                        <span className="mono">
                          {g.from} → {g.to}
                        </span>
                        <span className="mono dim t-el">{g.after}</span>
                        <span className="mono dim t-el">{g.before}</span>
                        <span className="acts" style={{ opacity: 1 }}>
                          <button
                            className="btn sm"
                            onClick={() =>
                              p.onOpenScript(
                                "create-partition.sql",
                                createPartitionSql(p.schema, p.table, g, `gap${i + 1}`),
                              )
                            }
                          >
                            Fill…
                          </button>
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}

              <div className="htable">
                <div className="prow hhead">
                  <span>Partition</span>
                  <span>Bounds</span>
                  <span className="r">Rows</span>
                  <span className="r">Size</span>
                  <span />
                </div>
                {p.data.items.map((it) => (
                  <div className="prow" key={it.name}>
                    <span className="mono t-el">
                      {it.name}
                      {it.isPartitioned && (
                        <span className="part-badge" title={`${it.partitionCount} sub-partitions`}>
                          {it.partitionCount}
                        </span>
                      )}
                    </span>
                    <span className="mono dim t-el" title={it.bounds}>
                      {it.bounds}
                    </span>
                    <span className="r mono">
                      {it.rowsKnown ? it.rows.toLocaleString() : "—"}
                    </span>
                    <span className="r mono">{it.size}</span>
                    {/* Revealed on hover by CSS, but the column is always
                        reserved so nothing reflows and nothing gets clipped. */}
                    <span className="acts">
                      <button
                        className="btn sm"
                        onClick={() =>
                          p.onOpenScript("detach-partition.sql", detachSql(p.schema, it.name, p.table))
                        }
                      >
                        Detach…
                      </button>
                      <button
                        className="btn sm danger"
                        onClick={() =>
                          p.onOpenScript(
                            "drop-partition.sql",
                            dropPartitionSql(p.schema, it.name, it.rows),
                          )
                        }
                      >
                        Drop…
                      </button>
                    </span>
                  </div>
                ))}
              </div>
              <p className="health-caveat" style={{ marginTop: 12 }}>
                Every action here opens a script for you to read and run. Nothing on this screen
                executes DDL.
              </p>
            </>
          )}
        </div>
      </div>
    </Overlay>
  );
}
