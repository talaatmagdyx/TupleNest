import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SEEN_VERSION_KEY, TOUR_DONE_KEY, notesFor, startupDialog } from "../lib/whatsnew";
import { ABOUT_LINKS, DialogTitle, Overlay, openExternal } from "../overlays/Overlays";

/** Help/About asks for one of these again; `n` makes a repeat a new request. */
export type FirstRunRequest = { kind: "tour" | "news"; n: number } | null;

const setting = (key: string) => invoke<unknown>("settings_get", { key });
const remember = (key: string, value: unknown) => invoke("settings_set", { key, value }).catch(() => {});

/**
 * The first-run tour and the what's-new dialog.
 *
 * At most one shows at start-up, and never both: the tour on the first launch
 * only (until it is finished or skipped), else what's new once after the
 * version changes. Both can be opened again from About.
 */
export default function FirstRun(p: { version: string; request: FirstRunRequest }) {
  const [open, setOpen] = useState<"tour" | "news" | null>(null);
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
        const [done, seen, profiles] = await Promise.all([
          setting(TOUR_DONE_KEY),
          setting(SEEN_VERSION_KEY),
          invoke<unknown[]>("connection_list"),
        ]);
        const tourDone = done === true;
        const hasProfiles = Array.isArray(profiles) && profiles.length > 0;
        const show = startupDialog(p.version, {
          tourDone,
          version: typeof seen === "string" ? seen : null,
          hasProfiles,
        });
        // A new user has nothing to compare with, and a version with no notes
        // has nothing to say: either way this version now counts as seen.
        if (show !== "news" && seen !== p.version) await remember(SEEN_VERSION_KEY, p.version);
        // Someone upgrading, with connections already, is past their first
        // launch: the tour is not for them, now or later.
        if (!tourDone && hasProfiles) await remember(TOUR_DONE_KEY, true);
        if (live && show) setOpen((cur) => cur ?? show);
      } catch {
        // No settings, no dialog: never block the app on a welcome.
      }
    })();
    return () => {
      live = false;
    };
  }, [p.version]);

  if (open === "tour")
    return (
      <Tour
        onDone={() => {
          setOpen(null);
          void remember(TOUR_DONE_KEY, true);
        }}
      />
    );
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

export const TOUR_STEPS: { title: string; heading: string; points: string[] }[] = [
  {
    title: "Connect",
    heading: "Start with a connection",
    points: [
      "Add a PostgreSQL connection and tag it dev, test, staging or prod.",
      "Passwords go to the system keychain, never to a file. TLS is verified by default, and an SSH tunnel is one switch away.",
      "Test a connection before saving it: each step is checked and shown.",
    ],
  },
  {
    title: "Safe by default",
    heading: "TupleNest asks before it can hurt",
    points: [
      "Read-only connections are enforced by the database, not just the app.",
      "On prod and staging, risky writes stop and ask, and you type the table name for the worst ones.",
      "Every statement on production is written to the audit log before it runs.",
    ],
  },
  {
    title: "Assistant and MCP",
    heading: "Help that never runs anything",
    points: [
      "The assistant writes, explains and fixes SQL with your own key or a local model. What it suggests runs only when you press Run.",
      "AI tools can reach a connection through the MCP server only if you turn it on for that connection, read-only unless you say otherwise.",
      "Find all of this again under About › Show the welcome tour.",
    ],
  },
];

/** Three steps; Skip, Back and Next; arrow keys move, Escape skips. Done
 *  either way is done for good. */
export function Tour(p: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const last = step === TOUR_STEPS.length - 1;
  const s = TOUR_STEPS[step];
  // Focus follows the step to Next: Back is disabled on the first step, and
  // a disabled button that held focus drops it out of the dialog.
  const next = useRef<HTMLButtonElement | null>(null);
  useEffect(() => next.current?.focus(), [step]);
  return (
    <Overlay onClose={p.onDone} center>
      <div
        className="modal tour"
        onKeyDown={(e) => {
          if (e.key === "ArrowRight" && !last) setStep(step + 1);
          else if (e.key === "ArrowLeft" && step > 0) setStep(step - 1);
        }}
      >
        <div className="tour-side">
          <span className="tour-step">
            STEP {step + 1} OF {TOUR_STEPS.length}
          </span>
          <span className="tour-name">{s.title}</span>
          <div className="grow" />
          <div className="tour-dots" aria-hidden>
            {TOUR_STEPS.map((t, i) => (
              <span key={t.title} className={i === step ? "on" : ""} />
            ))}
          </div>
        </div>
        <div className="tour-body">
          <DialogTitle>{s.heading}</DialogTitle>
          <ul className="tour-points">
            {s.points.map((pt) => (
              <li key={pt}>
                <span className="tour-check" aria-hidden>
                  ✓
                </span>
                <span>{pt}</span>
              </li>
            ))}
          </ul>
          <div className="grow" />
          <div className="d-actions">
            <button className="btn" onClick={p.onDone}>
              Skip the tour
            </button>
            <div className="grow" />
            <button className="btn" disabled={step === 0} onClick={() => setStep(step - 1)}>
              Back
            </button>
            <button ref={next} className="btn primary" onClick={() => (last ? p.onDone() : setStep(step + 1))}>
              {last ? "Finish" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </Overlay>
  );
}
