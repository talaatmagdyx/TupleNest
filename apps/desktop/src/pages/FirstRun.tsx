import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SEEN_VERSION_KEY, notesFor, startupDialog } from "../lib/whatsnew";
import { ABOUT_LINKS, DialogTitle, Overlay, openExternal } from "../overlays/Overlays";

/** Help/About asks for one of these again; `n` makes a repeat a new request. */
export type FirstRunRequest = { kind: "news"; n: number } | null;

const setting = (key: string) => invoke<unknown>("settings_get", { key });
const remember = (key: string, value: unknown) => invoke("settings_set", { key, value }).catch(() => {});

/**
 * The what's-new dialog: once after the version changes, and again from
 * About.
 */
export default function FirstRun(p: { version: string; request: FirstRunRequest }) {
  const [open, setOpen] = useState<"news" | null>(null);
  const [handled, setHandled] = useState(0);
  // A request from About, adjusted during render rather than in an effect.
  if (p.request && p.request.n !== handled) {
    setHandled(p.request.n);
    setOpen(p.request.kind);
  }

  useEffect(() => {
    if (!p.version) return;
    let live = true;
    void (async () => {
      try {
        const seen = await setting(SEEN_VERSION_KEY);
        const show = startupDialog(p.version, typeof seen === "string" ? seen : null);
        // A first launch, or a version with no notes: nothing to say, and
        // this version now counts as seen.
        if (show !== "news" && seen !== p.version) await remember(SEEN_VERSION_KEY, p.version);
        if (live && show) setOpen((cur) => cur ?? show);
      } catch {
        // No settings, no dialog: never block the app on a welcome.
      }
    })();
    return () => {
      live = false;
    };
  }, [p.version]);

  if (open === "news")
    return (
      <WhatsNew
        version={p.version}
        onClose={() => {
          setOpen(null);
          void remember(SEEN_VERSION_KEY, p.version);
        }}
      />
    );
  return null;
}

export function WhatsNew(p: { version: string; onClose: () => void }) {
  const notes = notesFor(p.version);
  return (
    <Overlay onClose={p.onClose} center>
      <div className="modal dialog whatsnew">
        <span className="wn-badge">Updated to {p.version}</span>
        <DialogTitle>What&apos;s new</DialogTitle>
        <div className="wn-list">
          {notes.length === 0 && <p>Fixes and small improvements. The changelog has the details.</p>}
          {notes.map((n) => (
            <div key={n.title} className="wn-item">
              <span className={`wn-icon ${n.tone}`} aria-hidden>
                {n.icon}
              </span>
              <div>
                <div className="wn-title">{n.title}</div>
                <div className="wn-text">{n.text}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="d-actions">
          <button className="btn" onClick={() => void openExternal(ABOUT_LINKS.changelog)}>
            Full changelog
          </button>
          <div className="grow" />
          <button className="btn primary" autoFocus onClick={p.onClose}>
            Got it
          </button>
        </div>
      </div>
    </Overlay>
  );
}
