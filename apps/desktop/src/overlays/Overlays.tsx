import React, { useEffect, useRef } from "react";
import { enterKey, kbd } from "../lib/platform";
import { SHORTCUTS } from "../lib/shortcuts";
import { BrandMark } from "../lib/icons";

/* ---------- shared ---------- */

/** Everything focusable inside a container, in tab order. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The shared modal shell.
 *
 * Every overlay in the app goes through here, so the dialog semantics live here
 * once rather than 28 times. Before, this was a `div` with a click handler:
 *
 *  - Screen readers were told nothing. No `role="dialog"`, no `aria-modal`, so
 *    it was announced as a group of buttons floating in the page, with the
 *    background still readable as though nothing had happened.
 *  - Tab walked straight out of the modal into the page behind it, and there
 *    was no way to tell you had left.
 *  - Focus was never returned to whatever opened the modal, so dismissing one
 *    dropped you at the top of the document.
 *  - Escape worked only in the components that happened to implement it.
 */
export function Overlay(p: {
  children: React.ReactNode;
  onClose: () => void;
  center?: boolean;
  /** Accessible name. Modals with a `ModalHead` get one from its title; the
   *  bare dialogs pass their own. */
  label?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const restoreTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    // Remember where focus came from, and give it back on the way out —
    // otherwise dismissing a dialog strands a keyboard user at the top of the
    // document with no idea where they were.
    restoreTo.current = document.activeElement as HTMLElement | null;
    const node = ref.current;
    if (node && !node.contains(document.activeElement)) {
      const first = node.querySelector<HTMLElement>(FOCUSABLE);
      // Components that autofocus a specific field have already done so; this
      // only catches the ones that would otherwise leave focus outside.
      first?.focus();
    }
    return () => restoreTo.current?.focus?.();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      p.onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const node = ref.current;
    if (!node) return;
    // No visibility filter. The obvious one — `offsetParent !== null` — is a
    // layout question, and the selector already excludes the things that
    // actually matter (disabled, tabindex="-1"). A modal rendering focusable
    // but invisible controls is a bug in that modal, not something to paper
    // over here.
    const items = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    // Wrap at the ends. Without this, Tab leaves for the page behind, which is
    // inert to the eye and very much not inert to the keyboard.
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    /*
     * The role sits on the backdrop, and the children are its direct
     * descendants. The previous shape wrapped them in a `display: contents`
     * div, which was needed to keep the flex layout — but an element with
     * `display: contents` generates no box, and browsers have a long history
     * of dropping such elements out of the accessibility tree entirely.
     * WebKitGTK, which is what Linux runs, kept that behaviour longest. A
     * `role="dialog"` nobody can hear is not worth the risk when the backdrop
     * will carry it just as well.
     *
     * Closing on backdrop click is then a target check rather than
     * `stopPropagation` on a wrapper: only a click that landed on the backdrop
     * itself, not one that bubbled up from the modal, dismisses it.
     */
    <div
      ref={ref}
      className={`overlay ${p.center ? "center" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={p.label}
      onKeyDown={onKeyDown}
      onClick={(e) => {
        if (e.target === e.currentTarget) p.onClose();
      }}
    >
      {p.children}
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
            // The ⌕ glyph beside it is decorative, so without this a screen
            // reader announces the palette's only control as "text box".
            aria-label="Search commands and tables"
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
          {/* ↑↓ and esc are on every keyboard; ↵ is Apple's way of writing a
              key that says "Enter" on a PC. */}
          <span>{enterKey()} select</span>
          <span>esc dismiss</span>
        </div>
      </div>
    </Overlay>
  );
}

/* ---------- transaction close prompt ---------- */

export function TxPrompt(p: {
  /** Reached by closing the window rather than by disconnecting. Same
   *  decision, different door — but "Stay connected" is the wrong words for
   *  someone who just pressed Quit. */
  closing?: boolean;
  onCommit: () => void;
  onRollback: () => void;
  onStay: () => void;
}) {
  const verb = p.closing ? "quit" : "disconnect";
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
          {p.closing
            ? "Quitting now will not automatically commit or roll back — the server decides, and it will roll back. Choose what happens to your work."
            : "Disconnecting now will not automatically commit or roll back. Choose how to close the session."}
        </p>
        <div className="d-actions">
          <button className="btn commit" onClick={p.onCommit}>
            Commit &amp; {verb}
          </button>
          <button className="btn rollback" onClick={p.onRollback}>
            Rollback &amp; {verb}
          </button>
          <button className="btn" onClick={p.onStay}>
            {p.closing ? "Don't quit" : "Stay connected"}
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
            {/* The label was a sibling with no htmlFor, so a screen reader read
                the box as unlabelled and clicking `$1` did not focus it. */}
            <label htmlFor={`param-${i}`}>${i + 1}</label>
            <input
              id={`param-${i}`}
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
  /** Optional: the palette can reach About directly, so Settings offers it
   *  rather than owning it — this is just where people look for it. */
  onAbout?: () => void;
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
          {p.onAbout && (
            <div className="section-row">
              <div>
                <div className="st">About TupleNest</div>
                <div className="sd">Version, credits and licences.</div>
              </div>
              <button className="btn" onClick={p.onAbout}>
                About
              </button>
            </div>
          )}
        </div>
      </div>
    </Overlay>
  );
}

/* ---------- about ---------- */

/** Where the About box is willing to send you. Kept next to the component so
 *  it is obvious these two must stay in step with the `opener:allow-open-url`
 *  scope in capabilities/default.json — a URL that isn't in both is a runtime
 *  rejection, not a compile error. */
export const ABOUT_LINKS = {
  author: "https://github.com/talaatmagdyx",
  claude: "https://claude.com",
} as const;

/**
 * Hands a URL to the system browser.
 *
 * Not an <a href>: this webview *is* the app, so following a link in it
 * replaces the UI with a web page and leaves no way back — there is no
 * chrome, no back button. `openUrl` sends it to the real browser instead.
 */
async function openExternal(url: string): Promise<void> {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } catch {
    /* No browser, or the URL is outside the capability scope. An About box is
       not worth an error dialog — the handle is written out in full next to
       the link, so it stays copyable either way. */
  }
}

export function About(p: { version: string; os: string; onClose: () => void }) {
  const osLabel = { macos: "macOS", windows: "Windows", linux: "Linux" }[p.os] ?? p.os;
  return (
    <Overlay onClose={p.onClose}>
      <div className="modal about" style={{ width: 460 }}>
        <ModalHead title="About TupleNest" onClose={p.onClose} />
        <div className="modal-body">
          <div className="about-hero">
            <BrandMark size={44} />
            <div className="about-id">
              <div className="about-name">TupleNest</div>
              {/* No engine named on purpose. It speaks Postgres today and the
                  plan is for it not to stop there — a tagline outlives the
                  release that made it true. */}
              <div className="about-tag">A home for your tuples. Careful by default.</div>
              {/* Mono: a version is a string to be read exactly and quoted back
                  in a bug report, not prose. */}
              <div className="about-ver mono">
                Version {p.version || "—"}
                {p.os ? ` · ${osLabel}` : ""}
              </div>
            </div>
          </div>

          <div className="about-rows">
            <div className="about-row">
              <span className="al">Created by</span>
              <span className="av">
                Talaat Magdy
                <button
                  className="about-link"
                  onClick={() => void openExternal(ABOUT_LINKS.author)}
                  title="Open github.com/talaatmagdyx in your browser"
                >
                  github.com/talaatmagdyx
                </button>
              </span>
            </div>
            <div className="about-row">
              <span className="al">Built with</span>
              <span className="av">
                Claude
                <button
                  className="about-link"
                  onClick={() => void openExternal(ABOUT_LINKS.claude)}
                  title="Open claude.com in your browser"
                >
                  claude.com
                </button>
              </span>
            </div>
            <div className="about-row">
              <span className="al">Interface</span>
              <span className="av">Inspired by Visual Studio Code</span>
            </div>
            <div className="about-row">
              <span className="al">Built on</span>
              <span className="av">Tauri · Rust · React · JetBrains Mono</span>
            </div>
          </div>

          <p className="about-foot">
            Not affiliated with Microsoft, JetBrains, Anthropic or the PostgreSQL Global Development
            Group. PostgreSQL is a trademark of the PostgreSQL Community Association.
          </p>
        </div>
      </div>
    </Overlay>
  );
}

/* ---------- keyboard cheatsheet ---------- */

/* The list itself lives in lib/shortcuts, next to the matching that decides
   what each key does. This screen's whole job is saying which keys exist, so
   it is the last place that should keep its own copy of the answer. */

export function Cheatsheet(p: { onClose: () => void }) {
  return (
    <Overlay onClose={p.onClose}>
      <div className="modal" style={{ width: 420 }}>
        <ModalHead title="Keyboard shortcuts" onClose={p.onClose} />
        <div className="modal-body">
          {SHORTCUTS.map((sc) => (
            <div key={sc.id} className="kv-row">
              <span className="kl">
                {sc.label}
                {sc.note && <span className="kn"> — {sc.note}</span>}
              </span>
              <span className="kbd">{kbd(...sc.keys)}</span>
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
