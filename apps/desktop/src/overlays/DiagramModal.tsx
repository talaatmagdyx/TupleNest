import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ModalHead, Overlay } from "./Overlays";

type FK = { name: string; from: string; to: string };

/** Lightweight ER diagram (Phase 2): tables as nodes on a circle, foreign
 *  keys as directed edges. Rendered as SVG from live pg_constraint data. */
export default function DiagramModal(p: { schema: string; onClose: () => void }) {
  const [fks, setFks] = useState<FK[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setFks(await invoke<FK[]>("pg_relationships", { schema: p.schema }));
      } catch (e) {
        setErr(String(e));
      }
    })();
  }, [p.schema]);

  const layout = useMemo(() => {
    if (!fks) return null;
    const tables = Array.from(new Set(fks.flatMap((f) => [f.from, f.to]))).sort();
    const W = 760;
    const H = 460;
    const cx = W / 2;
    const cy = H / 2;
    const R = Math.min(W, H) / 2 - 70;
    const pos = new Map<string, { x: number; y: number }>();
    tables.forEach((t, i) => {
      const a = (i / Math.max(1, tables.length)) * Math.PI * 2 - Math.PI / 2;
      pos.set(t, { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) });
    });
    return { tables, pos, W, H };
  }, [fks]);

  return (
    <Overlay onClose={p.onClose}>
      <div className="modal explain-modal" style={{ width: 820 }}>
        <ModalHead
          title={
            <span style={{ display: "inline-flex", gap: 9, alignItems: "center" }}>
              <span className="chip" style={{ color: "var(--tn-purple)", background: "rgba(157,123,255,.14)" }}>
                ER
              </span>
              Relationships · <span className="mono">{p.schema}</span>
            </span>
          }
          onClose={p.onClose}
        />
        <div className="modal-body" style={{ maxHeight: "70vh" }}>
          {err && <div className="error-box">{err}</div>}
          {!fks && !err && <div className="note muted">loading relationships…</div>}
          {fks && fks.length === 0 && (
            <div className="center-note" style={{ padding: 40 }}>
              No foreign keys in <span className="mono">{p.schema}</span>.
            </div>
          )}
          {layout && fks && fks.length > 0 && (
            <>
              <svg viewBox={`0 0 ${layout.W} ${layout.H}`} style={{ width: "100%", height: "auto" }}>
                <defs>
                  <marker id="er-arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
                    <path d="M0,0 L8,3 L0,6 Z" fill="var(--tn-accent)" />
                  </marker>
                </defs>
                {fks.map((f, i) => {
                  const a = layout.pos.get(f.from)!;
                  const b = layout.pos.get(f.to)!;
                  return (
                    <line
                      key={i}
                      x1={a.x}
                      y1={a.y}
                      x2={b.x}
                      y2={b.y}
                      stroke="var(--tn-accent)"
                      strokeOpacity={0.45}
                      strokeWidth={1.4}
                      markerEnd="url(#er-arrow)"
                    />
                  );
                })}
                {layout.tables.map((t) => {
                  const pt = layout.pos.get(t)!;
                  const w = Math.max(60, t.length * 7.5 + 16);
                  return (
                    <g key={t}>
                      <rect
                        x={pt.x - w / 2}
                        y={pt.y - 13}
                        width={w}
                        height={26}
                        rx={7}
                        fill="var(--tn-s2)"
                        stroke="var(--tn-bh)"
                      />
                      <text
                        x={pt.x}
                        y={pt.y + 4}
                        textAnchor="middle"
                        fontFamily="JetBrains Mono, monospace"
                        fontSize={11}
                        fill="var(--tn-tp)"
                      >
                        {t}
                      </text>
                    </g>
                  );
                })}
              </svg>
              <div className="sect-label">Foreign keys ({fks.length})</div>
              {fks.map((f) => (
                <div key={f.name} className="col-line" style={{ paddingLeft: 4 }}>
                  <span className="mono" style={{ color: "var(--tn-tp)", width: 220 }}>
                    {f.from}
                  </span>
                  <span style={{ color: "var(--tn-accent)" }}>→</span>
                  <span className="mono">{f.to}</span>
                  <span className="muted" style={{ marginLeft: "auto", fontSize: 10 }}>
                    {f.name}
                  </span>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </Overlay>
  );
}
