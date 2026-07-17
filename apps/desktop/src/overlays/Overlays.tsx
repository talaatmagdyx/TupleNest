import React, { useEffect, useRef } from "react";

/* ---------- shared ---------- */

export function Overlay(p: {
  children: React.ReactNode;
  onClose: () => void;
  center?: boolean;
}) {
  return (
    <div className={`overlay ${p.center ? "center" : ""}`} onClick={p.onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ display: "contents" }}>
        {p.children}
      </div>
    </div>
  );
}

export function ModalHead(p: { title: React.ReactNode; actions?: React.ReactNode; onClose: () => void }) {
  return (
    <div className="modal-head">
      <span className="t">{p.title}</span>
      {/* Commands belong here rather than among a modal's controls: this row
          cannot wrap, so they stay put however many options sit below. */}
      {p.actions && <span className="head-acts">{p.actions}</span>}
      {/* The glyph is decorative — without a label a screen reader announces
          this button as "times". */}
      <button className="x" onClick={p.onClose} aria-label="Close" title="Close">
        <span aria-hidden>×</span>
      </button>
    </div>
  );
}

/* ---------- command palette ---------- */

export type PaletteItem = {
  icon: string;
  label: string;
  type: string;
  kbd?: string;
  /** Most of what the palette runs is async — connecting, running a query,
   *  committing. The palette does not wait for any of it: each one reports its
   *  own outcome through a toast or the status line. Saying `() => void` here
   *  was a lie the callers had to be cast around. */
  exec: () => void | Promise<void>;
};

export function Palette(p: {
  items: PaletteItem[];
  q: string;
  idx: number;
  onQ: (q: string) => void;
  onIdx: (i: number) => void;
  onPick: (it: PaletteItem) => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => inputRef.current?.focus(), []);
  const filtered = p.items.filter((x) => x.label.toLowerCase().includes(p.q.toLowerCase()));
  const idx = Math.max(0, Math.min(p.idx, filtered.length - 1));
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      p.onIdx(Math.min(idx + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      p.onIdx(Math.max(idx - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[idx]) p.onPick(filtered[idx]);
    } else if (e.key === "Escape") p.onClose();
  };
  return (
    <Overlay onClose={p.onClose}>
      <div className="modal palette">
        <div className="pal-input">
          <span className="muted">⌕</span>
          <input
            ref={inputRef}
            value={p.q}
            placeholder="Type a command or search tables…"
            onChange={(e) => {
              p.onQ(e.target.value);
              p.onIdx(0);
            }}
            onKeyDown={onKey}
          />
        </div>
        <div className="pal-list">
          {filtered.map((x, i) => (
            <button key={i} className={`pal-item ${i === idx ? "on" : ""}`} onClick={() => p.onPick(x)}>
              <span className="pic">{x.icon}</span>
              <span className="plabel">{x.label}</span>
              <span className="ptype">{x.type}</span>
              {x.kbd && <span className="kbd">{x.kbd}</span>}
            </button>
          ))}
          {filtered.length === 0 && <div className="pal-empty">No matches</div>}
        </div>
        <div className="pal-foot">
          <span>↑↓ navigate</span>
          <span>↵ select</span>
          <span>esc dismiss</span>
        </div>
      </div>
    </Overlay>
  );
}

/* ---------- transaction close prompt ---------- */

export function TxPrompt(p: {
  onCommit: () => void;
  onRollback: () => void;
  onStay: () => void;
}) {
  return (
    <Overlay onClose={p.onStay} center>
      <div className="modal dialog">
        <div className="d-title">
          <span className="tx-chip">
            <span className="pulse" /> TX
          </span>
          You have an open transaction
        </div>
        <p>
          Disconnecting now will not automatically commit or roll back. Choose how to close the
          session.
        </p>
        <div className="d-actions">
          <button className="btn commit" onClick={p.onCommit}>
            Commit &amp; disconnect
          </button>
          <button className="btn rollback" onClick={p.onRollback}>
            Rollback &amp; disconnect
          </button>
          <button className="btn" onClick={p.onStay}>
            Stay connected
          </button>
        </div>
      </div>
    </Overlay>
  );
}

/* ---------- query parameters prompt (Phase 3) ---------- */

export function ParamPrompt(p: {
  count: number;
  values: string[];
  onChange: (i: number, v: string) => void;
  onRun: () => void;
  onCancel: () => void;
}) {
  return (
    <Overlay onClose={p.onCancel} center>
      <div className="modal dialog" style={{ width: 460 }}>
        <div className="d-title">Bind query parameters</div>
        <p style={{ marginBottom: 12 }}>
          This query has {p.count} placeholder{p.count > 1 ? "s" : ""}. Values are typed
          automatically: <span className="mono">null</span>, <span className="mono">true</span>/
          <span className="mono">false</span>, numbers, else text.
        </p>
        {Array.from({ length: p.count }).map((_, i) => (
          <div key={i} className="field">
            <label>${i + 1}</label>
            <input
              className="mono"
              autoFocus={i === 0}
              value={p.values[i] ?? ""}
              onChange={(e) => p.onChange(i, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") p.onRun();
              }}
              placeholder="value (empty = null)"
            />
          </div>
        ))}
        <div className="d-actions" style={{ marginTop: 6 }}>
          <button className="btn primary" onClick={p.onRun}>
            Run with values
          </button>
          <button className="btn" onClick={p.onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </Overlay>
  );
}

/* ---------- name prompt ---------- */

/**
 * Ask for a single line of text.
 *
 * This exists because `window.prompt` does nothing in the webview: it returns
 * null without drawing anything, so the caller reads it as "cancelled" and the
 * feature silently never works. The dialog plugin has `ask` and `message` but
 * nothing that takes text, so the prompt has to be in-app.
 */
export function NamePrompt(p: {
  title: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const empty = p.value.trim().length === 0;
  return (
    <Overlay onClose={p.onCancel} center>
      <div className="modal dialog" style={{ width: 460 }}>
        <div className="d-title">{p.title}</div>
        <div className="field">
          <label htmlFor="name-prompt">{p.label}</label>
          <input
            id="name-prompt"
            autoFocus
            value={p.value}
            onChange={(e) => p.onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !empty) p.onSave();
              if (e.key === "Escape") p.onCancel();
            }}
          />
        </div>
        <div className="d-actions" style={{ marginTop: 6 }}>
          {/* A nameless snippet cannot be found again — it is not worth saving. */}
          <button className="btn primary" onClick={p.onSave} disabled={empty}>
            Save
          </button>
          <button className="btn" onClick={p.onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </Overlay>
  );
}

/* ---------- destructive statement guard ---------- */

export function Guard(p: { sql: string; onCancel: () => void; onRun: () => void }) {
  const verb = /^\s*delete/i.test(p.sql) ? "DELETE" : "UPDATE";
  return (
    <Overlay onClose={p.onCancel} center>
      <div className="modal dialog">
        <div className="d-title" style={{ color: "var(--tn-danger)" }}>
          ⚠ Statement has no WHERE clause
        </div>
        <p>
          This <b style={{ color: "var(--tn-tp)" }}>{verb}</b> will affect{" "}
          <b style={{ color: "var(--tn-danger)" }}>every row</b> it touches. On a production
          connection this cannot be undone.
        </p>
        <pre>{p.sql.trim().slice(0, 400)}</pre>
        <div className="d-actions">
          <button className="btn" onClick={p.onCancel}>
            Cancel
          </button>
          <button className="btn danger" onClick={p.onRun}>
            Run anyway
          </button>
        </div>
      </div>
    </Overlay>
  );
}

/* ---------- connection lost ---------- */

export function ConnLost(p: { detail: string; onReconnect: () => void; onClose: () => void }) {
  return (
    <Overlay onClose={p.onClose} center>
      <div className="modal dialog connlost">
        <div className="icon-wrap">⏻</div>
        <div className="d-title" style={{ justifyContent: "center" }}>
          Connection lost
        </div>
        <p>{p.detail || "The session was closed. Reconnect to continue — nothing was re-run."}</p>
        <div className="d-actions" style={{ justifyContent: "center" }}>
          <button className="btn primary" onClick={p.onReconnect}>
            Reconnect
          </button>
          <button className="btn" onClick={p.onClose}>
            Dismiss
          </button>
        </div>
      </div>
    </Overlay>
  );
}

/* ---------- settings ---------- */

export function Settings(p: {
  theme: "dark" | "light";
  telemetry: boolean;
  onTheme: (t: "dark" | "light") => void;
  onTelemetry: (v: boolean) => void;
  onClose: () => void;
}) {
  return (
    <Overlay onClose={p.onClose}>
      <div className="modal" style={{ width: 520 }}>
        <ModalHead title="Settings" onClose={p.onClose} />
        <div className="modal-body">
          <div className="section-row" style={{ borderTop: "none" }}>
            <div>
              <div className="st">Theme</div>
              <div className="sd">Dark ships first; light is a token swap.</div>
            </div>
            <div className="seg" style={{ width: 160 }}>
              <button className={p.theme === "dark" ? "on" : ""} onClick={() => p.onTheme("dark")}>
                Dark
              </button>
              <button className={p.theme === "light" ? "on" : ""} onClick={() => p.onTheme("light")}>
                Light
              </button>
            </div>
          </div>
          <div className="section-row">
            <div>
              <div className="st">Default row limit</div>
              <div className="sd">Applied to explorer select statements.</div>
            </div>
            <span className="kbd" style={{ fontSize: 11 }}>
              100
            </span>
          </div>
          <div className="section-row">
            <div>
              <div className="st">History retention</div>
              <div className="sd">Favorites always survive.</div>
            </div>
            <span className="kbd" style={{ fontSize: 11 }}>
              newest 1,000
            </span>
          </div>
          <div className="section-row">
            <div>
              <div className="st">Anonymous telemetry</div>
              <div className="sd">No query text or data ever leaves the device.</div>
            </div>
            {/* The knob is the whole button, so without these a screen reader
                announces "button" — no name, and no way to tell on from off. */}
            <button
              className={`toggle ${p.telemetry ? "on" : ""}`}
              role="switch"
              aria-checked={p.telemetry}
              aria-label="Anonymous telemetry"
              onClick={() => p.onTelemetry(!p.telemetry)}
            >
              <span className="knob" aria-hidden />
            </button>
          </div>
        </div>
      </div>
    </Overlay>
  );
}

/* ---------- keyboard cheatsheet ---------- */

const SHORTCUTS: [string, string][] = [
  ["Run query", "⌘ ↵"],
  ["Command palette", "⌘ K"],
  ["New query tab", "⌘ T"],
  ["Format SQL", "⌘ ⇧ F"],
  ["Copy selected cell", "⌘ C"],
  ["Cancel running query", "Esc"],
  ["Close overlay", "Esc"],
  ["This cheatsheet", "?"],
];

export function Cheatsheet(p: { onClose: () => void }) {
  return (
    <Overlay onClose={p.onClose}>
      <div className="modal" style={{ width: 420 }}>
        <ModalHead title="Keyboard shortcuts" onClose={p.onClose} />
        <div className="modal-body">
          {SHORTCUTS.map(([label, keys]) => (
            <div key={label} className="kv-row">
              <span className="kl">{label}</span>
              <span className="kbd">{keys}</span>
            </div>
          ))}
        </div>
      </div>
    </Overlay>
  );
}

/* ---------- update available toast ---------- */

export function UpdateToast(p: {
  version: string;
  notes: string;
  busy?: boolean;
  onUpdate: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="update-toast">
      <div className="ut-head">
        <span className="dot" style={{ background: "var(--tn-accent)" }} />
        <span style={{ fontWeight: 750, fontSize: 12.5 }}>Update available</span>
        <div style={{ flex: 1 }} />
        {/* Same as the modals' close: the glyph is decoration, and without a
            label this is announced as "times". */}
        <button
          className="x"
          aria-label="Dismiss"
          title="Dismiss"
          style={{ border: "none", background: "none", color: "var(--tn-tm)", cursor: "pointer" }}
          onClick={p.onDismiss}
        >
          <span aria-hidden>×</span>
        </button>
      </div>
      <p>
        TupleNest {p.version} is ready to install — <b style={{ color: "var(--tn-ts)" }}>{p.notes}</b>
      </p>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn primary" onClick={p.onUpdate} disabled={p.busy}>
          {p.busy ? "Updating…" : "Restart & update"}
        </button>
        <button className="btn" onClick={p.onDismiss} disabled={p.busy}>
          Later
        </button>
      </div>
    </div>
  );
}

/* ---------- JSON cell inspector ---------- */

export function Inspector(p: { text: string; colName?: string; onClose: () => void }) {
  let pretty = p.text;
  try {
    pretty = JSON.stringify(JSON.parse(p.text), null, 2);
  } catch {
    /* keep raw */
  }
  return (
    <Overlay onClose={p.onClose}>
      <div className="modal inspector">
        <ModalHead
          title={
            <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
              <span className="chip jsonb">JSONB</span> {p.colName ?? "cell value"}
            </span>
          }
          onClose={p.onClose}
        />
        <pre>{pretty}</pre>
      </div>
    </Overlay>
  );
}
