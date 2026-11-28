import React, { createContext, useContext, useEffect, useId, useRef, useState } from "react";
import { enterKey, kbd } from "../lib/platform";
import { SHORTCUTS } from "../lib/shortcuts";
import { BrandMark, OfflineIcon, WarnIcon } from "../lib/icons";
import { prettyJson } from "../lib/text";
import { guardReason, guardTarget } from "../lib/sql";
import { BUILD_SHA } from "../lib/build";

/* ---------- shared ---------- */

/** Everything Tab can reach inside a container, in tab order. `tabindex="-1"`
 *  is excluded on every kind, not only the generic one: a roving tablist and
 *  the palette's listbox park their inactive buttons at -1, and counting those
 *  as the trap's first or last stop let Tab walk out of the modal past them. */
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]",
]
  .map((s) => `${s}:not([tabindex="-1"])`)
  .join(", ");

/** The id of the enclosing dialog's title. `ModalHead` and `DialogTitle` put
 *  it on their title element and the `Overlay` points `aria-labelledby` at it,
 *  so every dialog is named by the words already on screen. */
const TitleId = createContext<string | undefined>(undefined);

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
  /** Accessible name, for a dialog with no visible title (the palette).
   *  Everything else is named by its `ModalHead` or `DialogTitle`, through
   *  `aria-labelledby` — a second, hand-typed name had already drifted from
   *  the title it was meant to repeat ("Schema intelligence" over a modal
   *  headed "SQL intelligence"). */
  label?: string;
  /** A confirmation that interrupts a decision in progress — the transaction
   *  prompt, the destructive-statement guard. Announced as `alertdialog`, so a
   *  screen reader reads it out at once rather than waiting to be explored. */
  alert?: boolean;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
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
      role={p.alert ? "alertdialog" : "dialog"}
      aria-modal="true"
      aria-label={p.label}
      aria-labelledby={p.label ? undefined : titleId}
      onKeyDown={onKeyDown}
      onClick={(e) => {
        if (e.target === e.currentTarget) p.onClose();
      }}
    >
      <TitleId.Provider value={titleId}>{p.children}</TitleId.Provider>
    </div>
  );
}

/** The title row of a full modal. Its title names the dialog. */
export function ModalHead(p: {
  title: React.ReactNode;
  actions?: React.ReactNode;
  onClose: () => void;
  /** For a modal that must not be dismissed mid-operation (an import). */
  closeDisabled?: boolean;
}) {
  const id = useContext(TitleId);
  return (
    <div className="modal-head">
      <span className="t" id={id}>
        {p.title}
      </span>
      {/* Commands belong here rather than among a modal's controls: this row
          cannot wrap, so they stay put however many options sit below. */}
      {p.actions && <span className="head-acts">{p.actions}</span>}
      {/* The glyph is decorative — without a label a screen reader announces
          this button as "times". */}
      <button className="x" onClick={p.onClose} aria-label="Close" title="Close" disabled={p.closeDisabled}>
        <span aria-hidden>×</span>
      </button>
    </div>
  );
}

/** The heading of a compact `.modal.dialog` prompt. Its text names the dialog. */
export function DialogTitle(p: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div className="d-title" id={useContext(TitleId)} style={p.style}>
      {p.children}
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

/** How each item type is headed in the list. */
const PALETTE_GROUPS: Record<string, string> = {
  Action: "Commands",
  Table: "Tables",
  Snippet: "Saved queries",
  Connection: "Connections",
  Recent: "Recent",
  Assistant: "Assistant",
};
/** With nothing typed, the commands lead — the list is a menu then. Once a
 *  query is typed it is usually a name, so the tables and saved queries it
 *  matches lead instead. */
const ORDER_IDLE = ["Action", "Connection", "Snippet", "Table", "Recent"];
const ORDER_SEARCH = ["Table", "Snippet", "Action", "Connection", "Recent"];

/** The filtered items, grouped by type in display order. */
export function groupPalette(items: PaletteItem[], q: string): { type: string; items: PaletteItem[] }[] {
  const filtered = items.filter((x) => x.label.toLowerCase().includes(q.toLowerCase()));
  const order = q.trim() ? ORDER_SEARCH : ORDER_IDLE;
  const types = [...order, ...new Set(filtered.map((x) => x.type).filter((t) => !order.includes(t)))];
  return types
    .map((type) => ({ type, items: filtered.filter((x) => x.type === type) }))
    .filter((g) => g.items.length > 0);
}

export function Palette(p: {
  items: PaletteItem[];
  q: string;
  idx: number;
  onQ: (q: string) => void;
  onIdx: (i: number) => void;
  onPick: (it: PaletteItem) => void;
  onClose: () => void;
  /** Offered as the last entry whenever something is typed: hands the text
   *  to the assistant panel. */
  onAsk?: (q: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => inputRef.current?.focus(), []);
  const q = p.q.trim();
  const ask: PaletteItem[] =
    p.onAsk && q
      ? [{ icon: "?", label: `Ask the assistant: “${q}”`, type: "Assistant", exec: () => p.onAsk?.(q) }]
      : [];
  const groups = [...groupPalette(p.items, p.q), ...(ask.length ? [{ type: "Assistant", items: ask }] : [])];
  const filtered = groups.flatMap((g) => g.items);
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
  // Combobox + listbox: focus never leaves the input, so the highlighted row
  // is announced through aria-activedescendant rather than by moving focus.
  const listId = useId();
  const optId = (i: number) => `${listId}-${i}`;
  return (
    <Overlay onClose={p.onClose} label="Command palette">
      <div className="modal palette">
        <div className="pal-input">
          <span className="muted" aria-hidden>
            ⌕
          </span>
          <input
            ref={inputRef}
            // The ⌕ glyph beside it is decorative, so without this a screen
            // reader announces the palette's only control as "text box".
            aria-label="Search commands and tables"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={filtered[idx] ? optId(idx) : undefined}
            value={p.q}
            placeholder="Type a command or search tables…"
            onChange={(e) => {
              p.onQ(e.target.value);
              p.onIdx(0);
            }}
            onKeyDown={onKey}
          />
        </div>
        <div className="pal-list" role="listbox" id={listId} aria-label="Commands and tables">
          {groups.map((g) => {
            const headId = `${listId}-h-${g.type}`;
            return (
              // A group per heading, labelled by it, so a screen reader says
              // "Tables" on entering the first table rather than reading a
              // heading out of the option order.
              <div key={g.type} role="group" aria-labelledby={headId}>
                <div className="pal-head" id={headId} role="presentation">
                  {PALETTE_GROUPS[g.type] ?? g.type}
                </div>
                {g.items.map((x) => {
                  const i = filtered.indexOf(x);
                  return (
                    <button
                      key={i}
                      id={optId(i)}
                      role="option"
                      aria-selected={i === idx}
                      // Out of the tab order: the input is the palette's one
                      // stop, and the arrows move the highlight.
                      tabIndex={-1}
                      className={`pal-item ${i === idx ? "on" : ""}`}
                      onClick={() => p.onPick(x)}
                    >
                      <span className={`pic t-${x.type.toLowerCase()}`} aria-hidden>
                        {x.icon}
                      </span>
                      <span className="plabel">{x.label}</span>
                      <span className="ptype">{x.type}</span>
                      {x.kbd && <span className="kbd">{x.kbd}</span>}
                    </button>
                  );
                })}
              </div>
            );
          })}
          {filtered.length === 0 && (
            <div className="pal-empty" role="option" aria-selected="false" aria-disabled="true">
              No matches
            </div>
          )}
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
    <Overlay onClose={p.onStay} center alert>
      <div className="modal dialog">
        <DialogTitle>
          <span className="tx-chip" aria-hidden>
            <span className="pulse" /> TX
          </span>
          You have an open transaction
        </DialogTitle>
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
        <DialogTitle>Bind query parameters</DialogTitle>
        <p style={{ marginBottom: 12 }}>
          This query has {p.count} placeholder{p.count > 1 ? "s" : ""}. Each value is sent as you type it and
          read by the server for its placeholder&apos;s type, like a quoted literal. Leave a box empty, or type{" "}
          <span className="mono">null</span>, for NULL.
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
        <DialogTitle>{p.title}</DialogTitle>
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

export function Guard(p: { sql: string; env?: string | null; onCancel: () => void; onRun: () => void }) {
  // The same judgement that opened this dialog, so it says why it opened.
  // It used to say "Statement has no WHERE clause … this UPDATE will affect
  // every row" for whatever it was asked about: a DROP TABLE, a DO block, a
  // DELETE inside EXPLAIN ANALYZE.
  // No env given means production, as it always has for this dialog.
  const env = p.env === undefined ? "prod" : p.env;
  const where = env === "prod" ? "production" : env ? env : "this";
  const reason = guardReason(p.sql, env) ?? {
    verb: "statement",
    why: "It was flagged as one to confirm.",
  };
  // The worst cases on production and staging — every row, or the object
  // itself — want the name typed back before the button wakes up. A click is
  // a reflex; typing `orders` is a decision about `orders`.
  const target = guardTarget(p.sql, env);
  const [typed, setTyped] = useState("");
  const confirmed = !target || typed.trim() === target.name;
  return (
    <Overlay onClose={p.onCancel} center alert>
      <div className="modal dialog guard">
        <div className="danger-strip" aria-hidden />
        <div className="d-head">
          <span className="d-icon danger" aria-hidden>
            <WarnIcon size={20} />
          </span>
          <DialogTitle>
            Confirm this {reason.verb} on {where === "this" ? "this connection" : where}
          </DialogTitle>
        </div>
        <p>
          <b className="d-why">{reason.why}</b> On {where === "this" ? "this" : `a ${where}`} connection this cannot be undone.
        </p>
        <pre className="d-code">{p.sql.trim().slice(0, 400)}</pre>
        {target && (
          <label className="d-confirm">
            <span>
              Type <b className="mono">{target.name}</b> to confirm
            </span>
            <input
              className="mono"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
            />
          </label>
        )}
        <div className="d-actions end">
          {/* The way out is the default: focused on open, so Enter backs out. */}
          <button className="btn primary" autoFocus onClick={p.onCancel}>
            Don&apos;t run it
          </button>
          <button className="btn danger outline" disabled={!confirmed} onClick={p.onRun}>
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
    <Overlay onClose={p.onClose} center alert>
      <div className="modal dialog connlost">
        <span className="d-icon warn" aria-hidden>
          <OfflineIcon size={22} />
        </span>
        <DialogTitle>Connection lost</DialogTitle>
        <p>{p.detail || "The session was closed. Reconnect to continue — nothing was re-run."}</p>
        <div className="d-actions end">
          <button className="btn" onClick={p.onClose}>
            Dismiss
          </button>
          <button className="btn primary" autoFocus onClick={p.onReconnect}>
            Reconnect
          </button>
        </div>
      </div>
    </Overlay>
  );
}

/* ---------- settings ---------- */

export type SettingsSection = "general" | "assistant" | "mcp" | "shortcuts" | "about";

/** One setting: a label and its help on the left, its control on the right. */
function SettingRow(p: { title: string; help: string; children: React.ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-text">
        <div className="st">{p.title}</div>
        <div className="sd">{p.help}</div>
      </div>
      {p.children}
    </div>
  );
}

export function Settings(p: {
  theme: "dark" | "light";
  onTheme: (t: "dark" | "light") => void;
  /** Settings › Assistant (settings/AssistantSettings). A slot, like `mcp`,
   *  so this dialog makes no backend calls. */
  children?: React.ReactNode;
  /** The MCP server section (settings/McpSection). A slot rather than a
   *  child component so this dialog stays free of backend calls. */
  mcp?: React.ReactNode;
  /** Which section is showing when the dialog opens. */
  section?: SettingsSection;
  /** For the About section. */
  version?: string;
  os?: string;
  onCheckUpdates?: () => Promise<void>;
  onClose: () => void;
} & HelpActions) {
  const nav: { id: SettingsSection; label: string }[] = [
    { id: "general", label: "General" },
    ...(p.children ? [{ id: "assistant" as const, label: "Assistant" }] : []),
    ...(p.mcp ? [{ id: "mcp" as const, label: "MCP server" }] : []),
    { id: "shortcuts", label: "Shortcuts" },
    { id: "about", label: "About" },
  ];
  const [picked, setPicked] = useState<SettingsSection>(p.section ?? "general");
  // A section whose slot was not given falls back to General rather than an
  // empty pane.
  const section = nav.some((n) => n.id === picked) ? picked : "general";
  return (
    <Overlay onClose={p.onClose}>
      <div className="modal settings-modal">
        <ModalHead title="Settings" onClose={p.onClose} />
        <div className="set-layout">
          <nav className="set-nav" aria-label="Settings sections">
            {nav.map((n) => (
              <button
                key={n.id}
                className={`set-nav-btn ${section === n.id ? "on" : ""}`}
                aria-current={section === n.id ? "page" : undefined}
                onClick={() => setPicked(n.id)}
              >
                {n.label}
              </button>
            ))}
          </nav>
          <div className="modal-body set-body">
            {section === "general" && (
              <>
                <div className="set-group">
                  <h3 className="set-h">Appearance</h3>
                  <SettingRow title="Theme" help="Dark or light. Switch any time with the shortcut too.">
                    <div className="seg" style={{ width: 160 }}>
                      <button
                        className={p.theme === "dark" ? "on" : ""}
                        aria-pressed={p.theme === "dark"}
                        onClick={() => p.onTheme("dark")}
                      >
                        Dark
                      </button>
                      <button
                        className={p.theme === "light" ? "on" : ""}
                        aria-pressed={p.theme === "light"}
                        onClick={() => p.onTheme("light")}
                      >
                        Light
                      </button>
                    </div>
                  </SettingRow>
                </div>
                <div className="set-group">
                  <h3 className="set-h">Results</h3>
                  <SettingRow title="Default row limit" help="Applied to explorer select statements.">
                    <span className="set-value">100</span>
                  </SettingRow>
                </div>
                <div className="set-group">
                  <h3 className="set-h">Privacy and updates</h3>
                  <SettingRow title="History retention" help="Favorites always survive.">
                    <span className="set-value">newest 1,000</span>
                  </SettingRow>
                  {/* A statement, not a switch: there is no telemetry code, so
                      a toggle would only suggest there is something to turn on. */}
                  <SettingRow title="Telemetry" help="TupleNest has no telemetry and collects no usage data.">
                    <span className="set-value">none</span>
                  </SettingRow>
                </div>
              </>
            )}
            {section === "assistant" && p.children}
            {section === "mcp" && p.mcp}
            {section === "shortcuts" && (
              <div className="set-group">
                <h3 className="set-h">Keyboard shortcuts</h3>
                <ShortcutList grid />
              </div>
            )}
            {section === "about" && (
              <AboutBody
                version={p.version ?? ""}
                os={p.os ?? ""}
                onCheckUpdates={p.onCheckUpdates}
                onTour={p.onTour}
                onNews={p.onNews}
              />
            )}
          </div>
        </div>
      </div>
    </Overlay>
  );
}

/* ---------- about ---------- */

/** Where the About box is willing to send you. Kept next to the component so
 *  it is obvious these must stay in step with the `opener:allow-open-url`
 *  scope in capabilities/default.json — a URL that isn't in both is a runtime
 *  rejection, not a compile error. */
export const ABOUT_LINKS = {
  author: "https://github.com/talaatmagdyx",
  claude: "https://claude.com",
  /** About's "Changelog", and What's new's "Full changelog". */
  changelog: "https://github.com/talaatmagdyx/TupleNest/blob/main/CHANGELOG.md",
  issues: "https://github.com/talaatmagdyx/TupleNest/issues",
} as const;

/**
 * Hands a URL to the system browser.
 *
 * Not an <a href>: this webview *is* the app, so following a link in it
 * replaces the UI with a web page and leaves no way back — there is no
 * chrome, no back button. `openUrl` sends it to the real browser instead.
 */
export async function openExternal(url: string): Promise<void> {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } catch {
    /* No browser, or the URL is outside the capability scope. An About box is
       not worth an error dialog — the handle is written out in full next to
       the link, so it stays copyable either way. */
  }
}

/** Help: the first-run tour and the release notes, again. */
type HelpActions = { onTour?: () => void; onNews?: () => void };

/** What the About dialog and Settings › About both show. */
function AboutBody(
  p: { version: string; os: string; sha?: string; onCheckUpdates?: () => Promise<void> } & HelpActions,
) {
  const sha = p.sha ?? BUILD_SHA;
  const osLabel = { macos: "macOS", windows: "Windows", linux: "Linux" }[p.os] ?? p.os;
  const [checking, setChecking] = useState(false);
  return (
    <div className="about-body">
      <div className="about-hero">
        <BrandMark size={64} />
        <div className="about-name">TupleNest</div>
        {/* No engine named on purpose. It speaks Postgres today and the plan
            is for it not to stop there — a tagline outlives the release that
            made it true. */}
        <div className="about-tag">A home for your tuples. Careful by default.</div>
        <div className="about-chips">
          {/* Mono: a version is a string to be read exactly and quoted back in
              a bug report, not prose. */}
          <span className="about-ver mono">
            Version {p.version || "—"}
            {p.os ? ` · ${osLabel}` : ""}
          </span>
          {sha && (
            <span className="about-ver mono" title="The commit this build was made from">
              {sha}
            </span>
          )}
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

      <div className="about-actions">
        <button className="btn" onClick={() => void openExternal(ABOUT_LINKS.changelog)}>
          Changelog
        </button>
        <button className="btn" onClick={() => void openExternal(ABOUT_LINKS.issues)}>
          Report a problem
        </button>
        {p.onNews && (
          <button className="btn" onClick={p.onNews}>
            What&apos;s new
          </button>
        )}
        {p.onTour && (
          <button className="btn" onClick={p.onTour}>
            Show the welcome tour
          </button>
        )}
        {p.onCheckUpdates && (
          <button
            className="btn primary"
            disabled={checking}
            onClick={async () => {
              setChecking(true);
              try {
                await p.onCheckUpdates?.();
              } finally {
                setChecking(false);
              }
            }}
          >
            {checking ? "Checking…" : "Check for updates"}
          </button>
        )}
      </div>

      <p className="about-foot">
        Not affiliated with Microsoft, JetBrains, Anthropic or the PostgreSQL Global Development Group.
        PostgreSQL is a trademark of the PostgreSQL Community Association.
      </p>
    </div>
  );
}

export function About(p: {
  version: string;
  os: string;
  /** The commit; the build's own when not given. */
  sha?: string;
  onCheckUpdates?: () => Promise<void>;
  onClose: () => void;
} & HelpActions) {
  return (
    <Overlay onClose={p.onClose}>
      <div className="modal about" style={{ width: 460 }}>
        <ModalHead title="About TupleNest" onClose={p.onClose} />
        <div className="modal-body">
          <AboutBody
            version={p.version}
            os={p.os}
            sha={p.sha}
            onCheckUpdates={p.onCheckUpdates}
            onTour={p.onTour}
            onNews={p.onNews}
          />
        </div>
      </div>
    </Overlay>
  );
}

/* ---------- keyboard cheatsheet ---------- */

/* The list itself lives in lib/shortcuts, next to the matching that decides
   what each key does. This screen's whole job is saying which keys exist, so
   it is the last place that should keep its own copy of the answer. */

/** Every shortcut and its keys, from lib/shortcuts. Shared by the cheatsheet
 *  and Settings › Shortcuts so the two cannot disagree. */
function ShortcutList(p: { grid?: boolean }) {
  return (
    <div className={p.grid ? "sc-grid" : undefined}>
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
  );
}

export function Cheatsheet(p: { onClose: () => void }) {
  return (
    <Overlay onClose={p.onClose}>
      <div className="modal" style={{ width: 420 }}>
        <ModalHead title="Keyboard shortcuts" onClose={p.onClose} />
        <div className="modal-body">
          <ShortcutList />
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
  // Re-indented, not re-serialized: see `prettyJson`.
  const pretty = prettyJson(p.text);
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
