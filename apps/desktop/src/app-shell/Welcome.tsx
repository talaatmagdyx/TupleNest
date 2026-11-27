import type { ConnectionRecord } from "../ipc/types";
import { BrandMark } from "../lib/icons";
import { envMeta } from "../lib/sql";

type Props = {
  saved: ConnectionRecord[];
  onNew: () => void;
  onOpen: (c: ConnectionRecord) => void;
};

/** Saved profiles listed under the cards. More than this is the sidebar's job. */
const RECENT = 5;

/**
 * The main area before the first connection: what to do next, and the saved
 * profiles to do it with.
 *
 * Only actions the app really has are offered. The design also shows "Paste a
 * connection URL" and "Open a .sql file"; neither exists yet, and a card that
 * does nothing is worse than no card.
 */
export default function Welcome(p: Props) {
  const recent = p.saved.slice(0, RECENT);
  return (
    <section className="welcome" aria-labelledby="welcome-title">
      <div className="welcome-hero">
        <BrandMark size={56} />
        <h1 id="welcome-title">Connect to a database</h1>
        <p>Pick a saved connection, or add one. Nothing runs until you press Run.</p>
      </div>
      <div className="welcome-actions">
        <button className="welcome-card primary" onClick={p.onNew}>
          <span className="wc-title">New connection</span>
          <span className="wc-text">PostgreSQL: host, port, database and user.</span>
        </button>
      </div>
      {recent.length > 0 && (
        <div className="welcome-recent">
          <h2 className="welcome-label" id="welcome-recent">
            Saved connections
          </h2>
          <ul aria-labelledby="welcome-recent">
            {recent.map((c) => {
              const m = envMeta(c.environment);
              return (
                <li key={c.id}>
                  <button className="welcome-row" onClick={() => p.onOpen(c)}>
                    <span className="pg-avatar" aria-hidden>
                      PG
                    </span>
                    <span className="wr-name">{c.name}</span>
                    <span className="wr-host mono">
                      {c.host}:{c.port}/{c.database}
                    </span>
                    <span className="grow" />
                    <span className="env-pill" style={{ color: m.color, background: m.bg }}>
                      {c.environment ?? "dev"}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
