import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ModalHead, Overlay } from "./Overlays";

type Session = {
  pid: number;
  user: string | null;
  database: string | null;
  application: string | null;
  clientAddr: string | null;
  state: string | null;
  waitType: string | null;
  waitEvent: string | null;
  seconds: number | null;
  query: string | null;
};
type Lock = {
  blockedPid: number;
  blockedUser: string | null;
  lockType: string;
  mode: string | null;
  object: string;
};
type Activity = {
  sessions: Session[];
  locks: Lock[];
  db: {
    backends: number;
    commits: number;
    rollbacks: number;
    blocksHit: number;
    blocksRead: number;
    tuplesReturned: number;
    tuplesFetched: number;
    size: string;
  };
};

/** Server monitoring dashboard (Phase 6): live sessions, blocking locks,
 *  and database stats with auto-refresh and cancel/terminate actions. */
export default function MonitorModal(p: { onToast: (t: string) => void; onClose: () => void }) {
  const [data, setData] = useState<Activity | null>(null);
  const [auto, setAuto] = useState(true);
  const [tab, setTab] = useState<"sessions" | "locks">("sessions");
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setData(await invoke<Activity>("pg_activity"));
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!auto) return;
    const id = setInterval(refresh, 2500);
    return () => clearInterval(id);
  }, [auto, refresh]);

  const act = async (pid: number, terminate: boolean) => {
    try {
      const ok = await invoke<boolean>("pg_admin_backend", { pid, terminate });
      p.onToast(ok ? `${terminate ? "Terminated" : "Cancelled"} pid ${pid}` : `pid ${pid} not affected`);
      refresh();
    } catch (e) {
      p.onToast(String(e).slice(0, 70));
    }
  };

  const hitRatio =
    data && data.db.blocksHit + data.db.blocksRead > 0
      ? ((data.db.blocksHit / (data.db.blocksHit + data.db.blocksRead)) * 100).toFixed(1)
      : "—";

  const stats: [string, string][] = data
    ? [
        ["Backends", String(data.db.backends)],
        ["DB size", data.db.size],
        ["Cache hit", `${hitRatio}%`],
        ["Commits", data.db.commits.toLocaleString()],
        ["Rollbacks", data.db.rollbacks.toLocaleString()],
        ["Blocked locks", String(data.locks.length)],
      ]
    : [];

  return (
    <Overlay onClose={p.onClose}>
      <div className="modal explain-modal" style={{ width: 900 }}>
        <ModalHead
          title={
            <span style={{ display: "inline-flex", gap: 10, alignItems: "center" }}>
              <span className="chip" style={{ color: "var(--tn-accent)", background: "var(--tn-as)" }}>
                MONITOR
              </span>
              Server activity
            </span>
          }
          onClose={p.onClose}
        />
        <div className="modal-body" style={{ maxHeight: "68vh" }}>
          {err && <div className="error-box">{err}</div>}
          <div className="meta-grid" style={{ gridTemplateColumns: "repeat(6, 1fr)" }}>
            {stats.map(([l, v]) => (
              <div key={l} className="meta-cell">
                <div className="ml">{l}</div>
                <div className="mv">{v}</div>
              </div>
            ))}
          </div>
          <div className="form-row" style={{ margin: "6px 0 10px" }}>
            <button className={`rtab ${tab === "sessions" ? "on" : ""}`} onClick={() => setTab("sessions")}>
              Sessions {data ? `(${data.sessions.length})` : ""}
            </button>
            <button className={`rtab ${tab === "locks" ? "on" : ""}`} onClick={() => setTab("locks")}>
              Blocking locks {data ? `(${data.locks.length})` : ""}
            </button>
            <div style={{ flex: 1 }} />
            <label className="muted" style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 11.5 }}>
              <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> auto-refresh
            </label>
            <button className="btn" onClick={refresh}>
              Refresh
            </button>
          </div>

          {tab === "sessions" && (
            <div className="mon-table">
              <div className="mon-head">
                <span style={{ width: 60 }}>pid</span>
                <span style={{ width: 90 }}>state</span>
                <span style={{ width: 70 }}>age</span>
                <span style={{ width: 110 }}>wait</span>
                <span style={{ flex: 1 }}>query</span>
                <span style={{ width: 120 }} />
              </div>
              {data?.sessions.length === 0 && <div className="note muted" style={{ padding: 12 }}>No other sessions.</div>}
              {data?.sessions.map((s) => (
                <div key={s.pid} className="mon-row">
                  <span style={{ width: 60 }} className="mono">{s.pid}</span>
                  <span style={{ width: 90 }}>
                    <span className={`state-badge ${s.state === "active" ? "act" : ""}`}>{s.state ?? "—"}</span>
                  </span>
                  <span style={{ width: 70 }} className="mono muted">
                    {s.seconds != null ? `${s.seconds}s` : "—"}
                  </span>
                  <span style={{ width: 110 }} className="mono muted" title={`${s.waitType ?? ""}/${s.waitEvent ?? ""}`}>
                    {s.waitEvent ?? "—"}
                  </span>
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} className="mono" title={s.query ?? ""}>
                    {s.query || <em className="muted">idle</em>}
                  </span>
                  <span style={{ width: 120, display: "flex", gap: 6 }}>
                    <button className="btn" style={{ height: 22, padding: "0 8px", fontSize: 11 }} onClick={() => act(s.pid, false)}>
                      Cancel
                    </button>
                    <button className="btn rollback" style={{ height: 22, padding: "0 8px", fontSize: 11 }} onClick={() => act(s.pid, true)}>
                      Kill
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}

          {tab === "locks" && (
            <div className="mon-table">
              <div className="mon-head">
                <span style={{ width: 80 }}>pid</span>
                <span style={{ width: 120 }}>user</span>
                <span style={{ width: 120 }}>lock type</span>
                <span style={{ width: 140 }}>mode</span>
                <span style={{ flex: 1 }}>object</span>
              </div>
              {data?.locks.length === 0 && <div className="note muted" style={{ padding: 12 }}>No blocking locks — healthy.</div>}
              {data?.locks.map((l, i) => (
                <div key={i} className="mon-row">
                  <span style={{ width: 80 }} className="mono">{l.blockedPid}</span>
                  <span style={{ width: 120 }} className="muted">{l.blockedUser ?? "—"}</span>
                  <span style={{ width: 120 }} className="mono">{l.lockType}</span>
                  <span style={{ width: 140 }} className="mono muted">{l.mode ?? "—"}</span>
                  <span style={{ flex: 1 }} className="mono">{l.object}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Overlay>
  );
}
