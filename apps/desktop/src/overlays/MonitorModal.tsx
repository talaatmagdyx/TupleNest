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
export default function MonitorModal(p: {
  onToast: (t: string) => void;
  onClose: () => void;
  /** Environment of the live connection: a kill on prod earns more friction. */
  env?: string | null;
}) {
  const [data, setData] = useState<Activity | null>(null);
  /** The backend a Kill is waiting on confirmation for. */
  const [confirmKill, setConfirmKill] = useState<Session | null>(null);
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
    /* `refresh` sets state only after awaiting `pg_activity`; the rule cannot
       see past the await. Reading the server on open is the point of this
       effect. */
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
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
      void refresh();
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
                    {/* Cancel stops a query; Kill drops someone's whole
                        session, uncommitted work and all. Only one of those
                        deserves to be a single click. */}
                    <button
                      className="btn rollback"
                      style={{ height: 22, padding: "0 8px", fontSize: 11 }}
                      onClick={() => setConfirmKill(s)}
                    >
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
      {confirmKill && (
        <KillPrompt
          session={confirmKill}
          env={p.env ?? null}
          onCancel={() => setConfirmKill(null)}
          onConfirm={() => {
            const pid = confirmKill.pid;
            setConfirmKill(null);
            void act(pid, true);
          }}
        />
      )}
    </Overlay>
  );
}

/**
 * Confirmation for `pg_terminate_backend`.
 *
 * Terminate was a single unguarded click on any pid in the list. The app knows
 * perfectly well when it is talking to production — it already hides query text
 * from history there — and it applied no more friction to killing a production
 * backend than to killing a local one.
 *
 * The dialog names the victim rather than asking an abstract "are you sure?":
 * the pid alone is not a thing anyone recognises, and the row is what makes
 * "wait, that's not the one I meant" possible.
 */
function KillPrompt(p: {
  session: Session;
  env: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const prod = p.env === "prod";
  const [typed, setTyped] = useState("");
  // On prod, a click is too cheap. Typing the pid forces the eye onto the
  // number that is actually about to be killed.
  const armed = !prod || typed.trim() === String(p.session.pid);
  return (
    <Overlay onClose={p.onCancel} center>
      <div className="modal" style={{ width: 460 }}>
        <ModalHead title={prod ? "Terminate a PRODUCTION backend" : "Terminate backend"} onClose={p.onCancel} />
        <div className="modal-body">
          <p style={{ fontSize: 12.5, marginBottom: 10 }}>
            This ends the session immediately and rolls back whatever it had open. Any uncommitted
            work in it is lost, and the person running it is not asked.
          </p>
          <div className="kv-row">
            <span className="kl">Process</span>
            <span className="mono">{p.session.pid}</span>
          </div>
          <div className="kv-row">
            <span className="kl">User</span>
            <span className="mono">{p.session.user ?? "—"}</span>
          </div>
          <div className="kv-row">
            <span className="kl">Application</span>
            <span className="mono">{p.session.application || "—"}</span>
          </div>
          <div className="kv-row">
            <span className="kl">Running</span>
            <span className="mono" style={{ maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis" }}>
              {p.session.query || "idle"}
            </span>
          </div>
          {prod && (
            <div className="field" style={{ marginTop: 12 }}>
              <label htmlFor="kill-confirm">Type the process id to confirm</label>
              <input
                id="kill-confirm"
                className="mono"
                autoFocus
                value={typed}
                placeholder={String(p.session.pid)}
                onChange={(e) => setTyped(e.target.value)}
              />
            </div>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <button className="btn rollback" disabled={!armed} onClick={p.onConfirm}>
              Terminate pid {p.session.pid}
            </button>
            <button className="btn" onClick={p.onCancel}>
              Don&apos;t terminate
            </button>
          </div>
        </div>
      </div>
    </Overlay>
  );
}
