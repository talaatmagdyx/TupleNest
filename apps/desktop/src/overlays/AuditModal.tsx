import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ModalHead, Overlay } from "./Overlays";

type AuditEntry = {
  connectionKey: string;
  environment?: string | null;
  sqlText: string;
  at: number;
  /** Who sent it: null is this window, "MCP · <client>" an AI tool. */
  actor?: string | null;
};

type Who = "all" | "you" | "mcp";

const FILTERS: { id: Who; label: string }[] = [
  { id: "all", label: "All" },
  { id: "you", label: "You" },
  { id: "mcp", label: "MCP · AI tools" },
];

const matches = (r: AuditEntry, w: Who) => w === "all" || (w === "mcp") === !!r.actor;

/** Prod audit trail (Phase 6): full SQL text of every statement run on a
 *  prod-tagged connection — and on prod or staging by an AI tool through MCP —
 *  always retained even though history omits it. Written before the statement
 *  runs, so the log has no outcome to show: only who, where and what. */
export default function AuditModal(p: { onClose: () => void }) {
  const [rows, setRows] = useState<AuditEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [who, setWho] = useState<Who>("all");
  useEffect(() => {
    // async/await rather than .then().catch(), to match MonitorModal and the
    // rest of the app. (This shape does not, as I first assumed, make the
    // failure path testable — see the note in AuditModal.test.tsx.)
    void (async () => {
      try {
        setRows(await invoke<AuditEntry[]>("audit_list", { limit: 300 }));
      } catch (e) {
        setErr(String(e));
      }
    })();
  }, []);
  const shown = (rows ?? []).filter((r) => matches(r, who));
  return (
    <Overlay onClose={p.onClose}>
      <div className="modal audit-modal">
        <ModalHead title="Audit log" onClose={p.onClose} />
        <div className="audit-intro">
          <span className="page-sub">
            Statements on production, written before they run. Includes what AI tools sent through MCP.
          </span>
          <div className="chip-filters" role="group" aria-label="Filter by sender">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                className={`fchip ${who === f.id ? "on" : ""}`}
                aria-pressed={who === f.id}
                onClick={() => setWho(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
        <div className="modal-body audit-body">
          {err && <div className="error-box">{err}</div>}
          {rows && rows.length === 0 && (
            <div className="center-note" style={{ padding: 40 }}>
              No audited statements yet. Every statement sent on a prod connection is recorded here in full, before
              it runs.
            </div>
          )}
          {rows && rows.length > 0 && (
            <table className="page-table">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Who</th>
                  <th scope="col">Connection</th>
                  <th scope="col">Statement</th>
                  <th scope="col">Environment</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r, i) => (
                  <tr key={i}>
                    <td className="nowrap muted">{new Date(r.at * 1000).toLocaleString()}</td>
                    <td className="nowrap">
                      <span className="who">
                        <span className={`hp-dot ${r.actor ? "info" : "ok"}`} aria-hidden />
                        {r.actor ?? "You"}
                      </span>
                    </td>
                    <td className="nowrap">{r.connectionKey}</td>
                    <td className="mono audit-sql">{r.sqlText}</td>
                    <td>
                      <span className={`tchip ${r.environment === "staging" ? "warn" : "bad"}`}>
                        {(r.environment ?? "prod").toUpperCase()}
                      </span>
                    </td>
                  </tr>
                ))}
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={5} className="center-note">
                      Nothing from this sender.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </Overlay>
  );
}
