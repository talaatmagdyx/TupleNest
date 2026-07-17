import { useMemo, useState } from "react";
import { ModalHead, Overlay } from "./Overlays";
import type {
  IndexHealth,
  IndexHealthItem,
  IndexVerdict,
  TableHealth,
  TopQueries,
} from "../ipc/types";
import { dropScript, fmtBytes, VERDICT_LABEL, VERDICT_ORDER } from "../lib/health";

export type HealthTab = "indexes" | "tables" | "queries";

type Props = {
  tab: HealthTab;
  onTab: (t: HealthTab) => void;
  indexes: IndexHealth | null;
  tables: TableHealth | null;
  queries: TopQueries | null;
  error: string | null;
  onOpenScript: (sql: string) => void;
  onClose: () => void;
};

const VERDICT_CLASS: Record<IndexVerdict, string> = {
  used: "v-used",
  keep: "v-keep",
  review: "v-review",
  candidate: "v-cand",
};

function IndexTab({ data, onOpenScript }: { data: IndexHealth | null; onOpenScript: (s: string) => void }) {
  const [only, setOnly] = useState<IndexVerdict | "all">("all");
  // `data?.items ?? []` inline is a new array on every render, which made both
  // memos below recompute every time — including sorting every index in the
  // database.
  const items = useMemo(() => data?.items ?? [], [data]);
  const shown = useMemo(
    () =>
      (only === "all" ? items : items.filter((i) => i.verdict === only))
        .slice()
        .sort((a, b) => VERDICT_ORDER.indexOf(a.verdict) - VERDICT_ORDER.indexOf(b.verdict) || b.bytes - a.bytes),
    [items, only],
  );
  const counts = useMemo(() => {
    const c: Record<string, { n: number; bytes: number }> = {};
    for (const i of items) {
      c[i.verdict] ??= { n: 0, bytes: 0 };
      c[i.verdict].n += 1;
      c[i.verdict].bytes += i.bytes;
    }
    return c;
  }, [items]);

  if (!data) return <div className="note muted">loading…</div>;

  const cands = items.filter((i) => i.verdict === "candidate");

  return (
    <>
      {/* The headline number is what's *recoverable*, not what's unscanned.
          Those differ by 4 GB here, and the difference is primary keys. */}
      <div className="health-hero">
        <div>
          <div className="hero-n">{fmtBytes(data.droppableBytes)}</div>
          <div className="hero-l">
            recoverable across {data.droppableIndexes} index{data.droppableIndexes === 1 ? "" : "es"}
          </div>
        </div>
        {cands.length > 0 && (
          <button className="btn primary" onClick={() => onOpenScript(dropScript(items))}>
            Generate DROP script
          </button>
        )}
      </div>

      <p className="health-caveat">
        Never scanned is not the same as unused. Statistics resets, read replicas, and rare
        month-end reports all look identical to zero here. Indexes backing a primary key or
        constraint are marked <b>KEEP</b> and are never proposed for dropping — they are scanned by
        the constraint machinery, not by the planner.
      </p>

      <div className="chip-row">
        <button className={`fchip ${only === "all" ? "on" : ""}`} onClick={() => setOnly("all")}>
          All {items.length}
        </button>
        {VERDICT_ORDER.filter((v) => counts[v]).map((v) => (
          <button key={v} className={`fchip ${VERDICT_CLASS[v]} ${only === v ? "on" : ""}`} onClick={() => setOnly(v)}>
            {VERDICT_LABEL[v]} {counts[v].n} · {fmtBytes(counts[v].bytes)}
          </button>
        ))}
      </div>

      <div className="htable">
        <div className="hrow hhead">
          <span>Table</span>
          <span>Columns</span>
          <span className="r">Scans</span>
          <span className="r">Partitions</span>
          <span className="r">Size</span>
          <span>Verdict</span>
        </div>
        {shown.map((i: IndexHealthItem, n) => (
          <div className="hrow" key={`${i.schema}.${i.table}.${i.columns}.${n}`} title={i.why}>
            <span className="mono t-el">
              {i.schema}.{i.table}
            </span>
            <span className="mono dim t-el">{i.columns}</span>
            <span className="r mono">{i.scans.toLocaleString()}</span>
            <span className="r mono dim">{i.members}</span>
            <span className="r mono">{i.size}</span>
            <span>
              <span className={`vchip ${VERDICT_CLASS[i.verdict]}`}>{VERDICT_LABEL[i.verdict]}</span>
            </span>
          </div>
        ))}
        {shown.length === 0 && <div className="note muted">Nothing in this category.</div>}
      </div>
    </>
  );
}

function TableTab({ data }: { data: TableHealth | null }) {
  if (!data) return <div className="note muted">loading…</div>;
  return (
    <>
      {data.neverAnalyzed > 0 && (
        <p className="health-caveat warn">
          {data.neverAnalyzed.toLocaleString()} of {data.totalTables.toLocaleString()} tables have
          never been analyzed. Postgres has no statistics for them, so every row estimate this app
          shows for them — including in Details and in query plans — is a guess, and the planner is
          guessing too. {data.neverVacuumed.toLocaleString()} have never been vacuumed.
        </p>
      )}
      {data.truncated && (
        <p className="health-caveat">
          Showing the {data.items.length} worst; the counts above cover all{" "}
          {data.totalTables.toLocaleString()}.
        </p>
      )}
      <div className="htable">
        <div className="hrow hhead t5">
          <span>Table</span>
          <span className="r">Live rows</span>
          <span className="r">Dead</span>
          <span>Last vacuum</span>
          <span>Last analyze</span>
        </div>
        {data.items.map((i, n) => (
          <div className="hrow t5" key={`${i.schema}.${i.table}.${n}`}>
            <span className="mono t-el">
              {i.schema}.{i.table}
            </span>
            <span className="r mono">{i.liveTuples.toLocaleString()}</span>
            <span className="r mono">
              {i.deadTuples.toLocaleString()}
              {i.deadPct >= 10 && <span className="vchip v-review" style={{ marginLeft: 6 }}>{i.deadPct}%</span>}
            </span>
            <span className={`mono dim ${i.vacuumed === "never" ? "bad" : ""}`}>{i.vacuumed}</span>
            <span className={`mono dim ${i.neverAnalyzed ? "bad" : ""}`}>{i.analyzed}</span>
          </div>
        ))}
      </div>
    </>
  );
}

function QueryTab({ data }: { data: TopQueries | null }) {
  if (!data) return <div className="note muted">loading…</div>;
  // Not an error — the extension needs a config change and a restart, which
  // this app cannot and should not do on the user's behalf.
  if (!data.available)
    return (
      <div className="empty-state">
        <div className="es-t">No query statistics available</div>
        <div className="es-b">{data.reason}</div>
        <pre className="es-code">{data.remedy}</pre>
      </div>
    );
  return (
    <div className="htable">
      <div className="hrow hhead t4">
        <span>Query</span>
        <span className="r">Calls</span>
        <span className="r">Total</span>
        <span className="r">Mean</span>
      </div>
      {data.items.map((q, n) => (
        <div className="hrow t4" key={`${q.queryId}.${n}`} title={q.query}>
          <span className="mono t-el">{q.query}</span>
          <span className="r mono">{q.calls.toLocaleString()}</span>
          <span className="r mono">{Math.round(q.totalMs).toLocaleString()} ms</span>
          <span className="r mono">{q.meanMs.toFixed(2)} ms</span>
        </div>
      ))}
    </div>
  );
}

export default function HealthModal(p: Props) {
  return (
    <Overlay onClose={p.onClose}>
      <div className="modal health-modal">
        <ModalHead title="Database health" onClose={p.onClose} />
        {/* .rtabs/.rtab are the app's existing tab classes. Inventing new
            names left these as bare <button>s wearing the OS default look. */}
        <div className="rtabs modal-tabs">
          {(["indexes", "tables", "queries"] as HealthTab[]).map((t) => (
            <button key={t} className={`rtab ${p.tab === t ? "on" : ""}`} onClick={() => p.onTab(t)}>
              {t === "indexes" ? "Indexes" : t === "tables" ? "Vacuum & bloat" : "Top queries"}
            </button>
          ))}
        </div>
        <div className="modal-body">
          {p.error && <div className="error-box">{p.error}</div>}
          {!p.error && p.tab === "indexes" && <IndexTab data={p.indexes} onOpenScript={p.onOpenScript} />}
          {!p.error && p.tab === "tables" && <TableTab data={p.tables} />}
          {!p.error && p.tab === "queries" && <QueryTab data={p.queries} />}
        </div>
      </div>
    </Overlay>
  );
}
