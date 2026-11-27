import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ChartView from "../charts/ChartView";
import { CHART_KINDS, type ChartKind } from "../lib/chart";
import { errText } from "../lib/text";
import { Overlay, ModalHead } from "../overlays/Overlays";
import type { QueryResult } from "../ipc/types";
import type { PageContext } from "./context";
import PageHeader from "./PageHeader";

export type DashboardChart = {
  id: string;
  dashboardId: string;
  title: string;
  kind: ChartKind;
  sqlText: string;
  position: number;
};

export type Dashboard = {
  id: string;
  name: string;
  connectionId: string | null;
  refreshSecs: number;
  charts: DashboardChart[];
};

/** Rows one chart keeps from a run; the backend enforces the same cap. */
export const CHART_ROWS = 1000;

export const REFRESH_OPTIONS: { secs: number; label: string }[] = [
  { secs: 0, label: "Refresh off" },
  { secs: 60, label: "Every minute" },
  { secs: 300, label: "Every 5 minutes" },
  { secs: 900, label: "Every 15 minutes" },
];

type Run = { columns: QueryResult["columns"]; rows: unknown[][]; at: Date } | { error: string };

const EDITOR = "__editor__";

/**
 * Dashboards: charts pinned from saved queries, re-run when the page opens
 * and, if asked, every 1, 5 or 15 minutes.
 *
 * Runs go through `pg_query_read`: detached (the grid's result is left
 * alone), at most a thousand rows, refused unless the query only reads, and
 * otherwise the normal path — the prod audit row, history. One after another,
 * on the one session.
 */
export default function DashboardsPage(p: { ctx: PageContext }) {
  const { ctx } = p;
  const [boards, setBoards] = useState<Dashboard[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [runs, setRuns] = useState<Record<string, Run>>({});
  const [naming, setNaming] = useState<{ creating: boolean; name: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [tick, setTick] = useState(0);

  const toast = ctx.toast;
  const load = useCallback(
    async (select?: string) => {
      try {
        const list = await invoke<Dashboard[]>("dashboard_list");
        setBoards(list);
        setActiveId((cur) => select ?? (list.some((b) => b.id === cur) ? cur : (list[0]?.id ?? null)));
      } catch (e) {
        setBoards([]);
        toast(`Dashboards did not load: ${errText(e)}`);
      }
    },
    [toast],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading on mount is what an effect is for
    void load();
  }, [load]);

  const board = boards?.find((b) => b.id === activeId) ?? null;
  const owner = board?.connectionId ? ctx.saved.find((c) => c.id === board.connectionId) : undefined;
  const runnable = !!board && ctx.live && (!board.connectionId || board.connectionId === ctx.liveProfile?.id);

  // Never auto-run anything but what the page is for: its own charts, on
  // open and on the interval, only while the right connection is live.
  useEffect(() => {
    if (!board || !runnable) return;
    let stop = false;
    const runAll = async () => {
      for (const c of board.charts) {
        if (stop) return;
        let run: Run;
        try {
          const r = await invoke<QueryResult>("pg_query_read", { sql: c.sqlText, maxRows: CHART_ROWS });
          run = { columns: r.columns, rows: r.rows ?? [], at: new Date() };
        } catch (e) {
          run = { error: errText(e) };
        }
        if (!stop) setRuns((rs) => ({ ...rs, [c.id]: run }));
      }
    };
    void runAll();
    const timer = board.refreshSecs > 0 ? setInterval(() => void runAll(), board.refreshSecs * 1000) : null;
    return () => {
      stop = true;
      if (timer) clearInterval(timer);
    };
  }, [board, runnable, tick]);

  /** Save `patch` over the open dashboard, or create one when `id` is null:
   *  it belongs to the connection that is live now, if any. */
  const save = async (patch: { id?: null; name?: string; refreshSecs?: number }) => {
    const fresh = { id: null, name: "", refreshSecs: 0, connectionId: ctx.liveProfile?.id ?? null };
    const b = { ...(patch.id === null || !board ? fresh : board), ...patch };
    try {
      const id = await invoke<string>("dashboard_save", {
        id: b.id,
        name: b.name,
        connectionId: b.connectionId,
        refreshSecs: b.refreshSecs,
      });
      await load(id);
    } catch (e) {
      ctx.toast(errText(e));
    }
  };

  const remove = async () => {
    if (!board) return;
    await invoke("dashboard_delete", { id: board.id });
    await load();
  };

  const removeChart = async (id: string) => {
    await invoke("dashboard_chart_delete", { id });
    await load(activeId ?? undefined);
  };

  return (
    <section className="page" aria-label="Dashboards">
      <PageHeader
        title={board?.name ?? "Dashboards"}
        onBack={ctx.back}
        meta={
          <>
            {boards && boards.length > 1 && (
              <select aria-label="Dashboard" value={activeId ?? ""} onChange={(e) => setActiveId(e.target.value)}>
                {boards.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            )}
          </>
        }
        sub={
          board ? (
            <>
              {board.charts.length} chart{board.charts.length === 1 ? "" : "s"}
              {owner ? ` · ${owner.name}` : ""} · each chart is a saved query
            </>
          ) : (
            "Saved queries pinned as charts."
          )
        }
        actions={
          <>
            {board && (
              <>
                <select
                  aria-label="Refresh"
                  value={board.refreshSecs}
                  onChange={(e) => void save({ refreshSecs: Number(e.target.value) })}
                >
                  {REFRESH_OPTIONS.map((o) => (
                    <option key={o.secs} value={o.secs}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <button className="btn" disabled={!runnable} onClick={() => setTick((t) => t + 1)}>
                  Refresh now
                </button>
                <button className="btn" onClick={() => setNaming({ creating: false, name: board.name })}>
                  Rename
                </button>
                <button className="btn" onClick={() => void remove()}>
                  Delete
                </button>
                <button className="btn primary" onClick={() => setAdding(true)}>
                  Add chart
                </button>
              </>
            )}
            <button className="btn" onClick={() => setNaming({ creating: true, name: "" })}>
              New dashboard
            </button>
          </>
        }
      />

      {naming !== null && (
        <form
          className="page-strip"
          onSubmit={(e) => {
            e.preventDefault();
            setNaming(null);
            void save(naming.creating ? { id: null, name: naming.name } : { name: naming.name });
          }}
        >
          <label>
            {naming.creating ? "New dashboard" : "Rename dashboard"}
            <input
              autoFocus
              value={naming.name}
              onChange={(e) => setNaming({ ...naming, name: e.target.value })}
            />
          </label>
          <button className="btn primary" type="submit">
            Save
          </button>
          <button className="btn" type="button" onClick={() => setNaming(null)}>
            Cancel
          </button>
        </form>
      )}

      {board && !runnable && (
        <div className="page-note" role="status">
          {!ctx.live
            ? "Connect to a database to run these charts."
            : `This dashboard runs on ${owner?.name ?? "another connection"}. Connect to it to refresh the charts.`}
        </div>
      )}

      {boards && !board && (
        <div className="page-empty">
          <div className="big">No dashboards yet</div>
          <p>A dashboard pins saved queries as charts and runs them again whenever you open it. Only queries that read can be pinned.</p>
        </div>
      )}

      {board && board.charts.length === 0 && (
        <div className="page-empty">
          <p>No charts yet. Add one from a saved query.</p>
        </div>
      )}

      {board && board.charts.length > 0 && (
        <div className="dash-grid">
          {board.charts.map((c) => {
            const run = runs[c.id];
            return (
              <article key={c.id} className={`dash-card ${c.kind === "number" ? "" : "wide"}`} aria-label={c.title}>
                <header>
                  <span className="dash-card-title">{c.title}</span>
                  <span className="page-sub">
                    {run && "at" in run ? `updated ${run.at.toLocaleTimeString()}` : runnable ? "running…" : ""}
                  </span>
                  <div className="grow" />
                  <button className="btn xs" aria-label={`Remove ${c.title}`} onClick={() => void removeChart(c.id)}>
                    Remove
                  </button>
                </header>
                {run && "error" in run && <div className="dash-error">{run.error}</div>}
                {run && "at" in run && <ChartView kind={c.kind} columns={run.columns} rows={run.rows} />}
              </article>
            );
          })}
        </div>
      )}

      {adding && board && (
        <AddChart
          ctx={ctx}
          dashboardId={board.id}
          onAdded={async () => {
            setAdding(false);
            await load(board.id);
          }}
          onClose={() => setAdding(false)}
        />
      )}
    </section>
  );
}

function AddChart(p: { ctx: PageContext; dashboardId: string; onAdded: () => void; onClose: () => void }) {
  const [source, setSource] = useState(p.ctx.snippets[0]?.id ?? EDITOR);
  const snippet = p.ctx.snippets.find((s) => s.id === source);
  const [title, setTitle] = useState(snippet?.name ?? "");
  const [kind, setKind] = useState<ChartKind>("bar");
  const [error, setError] = useState<string | null>(null);
  const sql = snippet ? snippet.body : p.ctx.currentSql;

  const pin = async () => {
    try {
      await invoke("dashboard_chart_add", { dashboardId: p.dashboardId, title, kind, sql });
      p.onAdded();
    } catch (e) {
      setError(errText(e));
    }
  };

  return (
    <Overlay onClose={p.onClose}>
      <div className="modal" style={{ width: 520 }}>
        <ModalHead title="Add chart" onClose={p.onClose} />
        <div className="modal-body">
          <div className="field">
            <label htmlFor="chart-source">Saved query</label>
            <select
              id="chart-source"
              value={source}
              onChange={(e) => {
                setSource(e.target.value);
                setTitle(p.ctx.snippets.find((s) => s.id === e.target.value)?.name ?? "");
                setError(null);
              }}
            >
              {p.ctx.snippets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
              <option value={EDITOR}>The query in the editor</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="chart-title">Title</label>
            <input id="chart-title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="field">
            <label id="chart-kind">Chart</label>
            <div className="seg" role="radiogroup" aria-labelledby="chart-kind">
              {CHART_KINDS.map((k) => (
                <button
                  key={k.kind}
                  type="button"
                  role="radio"
                  aria-checked={kind === k.kind}
                  className={kind === k.kind ? "on" : ""}
                  onClick={() => setKind(k.kind)}
                >
                  {k.label}
                </button>
              ))}
            </div>
          </div>
          <pre className="d-code">{sql.trim().slice(0, 400) || "(empty)"}</pre>
          {error && (
            <div className="dash-error" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="modal-foot">
          <span className="page-sub">Only a query that reads can be pinned.</span>
          <div className="grow" />
          <button className="btn" onClick={p.onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!sql.trim()} onClick={() => void pin()}>
            Pin chart
          </button>
        </div>
      </div>
    </Overlay>
  );
}
