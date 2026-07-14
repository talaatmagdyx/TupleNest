import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ModalHead, Overlay } from "./Overlays";

type AuditEntry = {
  connectionKey: string;
  environment: string | null;
  sqlText: string;
  at: number;
};

/** Prod audit trail (Phase 6): full SQL text of every statement run on a
 *  prod-tagged connection, always retained even though history omits it. */
export default function AuditModal(p: { onClose: () => void }) {
  const [rows, setRows] = useState<AuditEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    invoke<AuditEntry[]>("audit_list", { limit: 300 })
      .then(setRows)
      .catch((e) => setErr(String(e)));
  }, []);

  return (
    <Overlay onClose={p.onClose}>
      <div className="modal" style={{ width: 720 }}>
        <ModalHead
          title={
            <span style={{ display: "inline-flex", gap: 9, alignItems: "center" }}>
              <span className="chip" style={{ color: "var(--tn-danger)", background: "rgba(239,77,77,.14)" }}>
                AUDIT
              </span>
              Production statement log
            </span>
          }
          onClose={p.onClose}
        />
        <div className="modal-body" style={{ maxHeight: "68vh" }}>
          {err && <div className="error-box">{err}</div>}
          {rows && rows.length === 0 && (
            <div className="center-note" style={{ padding: 40 }}>
              No audited statements yet. Statements run on prod connections appear here in full.
            </div>
          )}
          {(rows ?? []).map((r, i) => (
            <div key={i} className="hist-row" style={{ alignItems: "flex-start" }}>
              <span className="hmeta" style={{ width: 130, flex: "none" }}>
                {new Date(r.at * 1000).toLocaleString()}
              </span>
              <span className="sqltxt mono" style={{ whiteSpace: "pre-wrap", overflow: "visible" }}>
                {r.sqlText}
              </span>
              <span className="hmeta" style={{ flex: "none" }}>
                {r.connectionKey}
              </span>
            </div>
          ))}
        </div>
      </div>
    </Overlay>
  );
}
