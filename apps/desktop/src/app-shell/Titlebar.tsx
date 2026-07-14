import type { ConnectionRecord } from "../ipc/types";
import { envMeta } from "../lib/sql";
import { GearIcon, SidebarIcon } from "../lib/icons";

type Props = {
  theme: "dark" | "light";
  connected: boolean;
  activeName: string;
  activeUserHost: string;
  activeEnv: string;
  saved: ConnectionRecord[];
  activeId: string | null;
  connMenu: boolean;
  onToggleConnMenu: () => void;
  onSelectProfile: (c: ConnectionRecord) => void;
  onNewConnection: () => void;
  onToggleSidebar: () => void;
  onOpenPalette: () => void;
  onToggleTheme: () => void;
  onOpenSettings: () => void;
};

export default function Titlebar(p: Props) {
  const em = envMeta(p.activeEnv);
  return (
    <header className="titlebar">
      <button className="icon-btn" title="Toggle sidebar" onClick={p.onToggleSidebar}>
        <SidebarIcon />
      </button>
      <div className="brand">
        <span className="brand-glyph" /> TupleNest
      </div>
      <div className="conn-switch">
        <button onClick={p.onToggleConnMenu}>
          <span
            className="dot"
            style={{
              background: p.connected ? (p.activeEnv === "prod" ? "#ef4d4d" : "#3fb950") : "#4a4f57",
              boxShadow: p.connected ? `0 0 8px ${p.activeEnv === "prod" ? "rgba(239,77,77,.5)" : "rgba(63,185,80,.5)"}` : "none",
            }}
          />
          <span className="name">{p.connected ? p.activeName : "Not connected"}</span>
          {p.connected && p.activeUserHost && <span className="host">{p.activeUserHost}</span>}
          {p.connected && (
            <span className="env-pill" style={{ color: em.color, background: em.bg }}>
              {p.activeEnv}
            </span>
          )}
          <span style={{ fontSize: 9, color: "var(--tn-tm)" }}>▾</span>
        </button>
        {p.connMenu && (
          <div className="conn-menu">
            <div className="menu-label">Switch connection</div>
            {p.saved.map((c) => {
              const m = envMeta(c.environment);
              return (
                <button
                  key={c.id}
                  className={`row ${c.id === p.activeId ? "active" : ""}`}
                  onClick={() => p.onSelectProfile(c)}
                >
                  <span
                    className="dot"
                    style={{ background: c.id === p.activeId && p.connected ? "#3fb950" : "#4a4f57" }}
                  />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: 12, fontWeight: 650 }}>{c.name}</span>
                    <span className="host" style={{ display: "block", fontFamily: "JetBrains Mono, monospace", fontSize: 9.5, color: "var(--tn-tm)" }}>
                      {c.username}@{c.host}:{c.port}/{c.database}
                    </span>
                  </span>
                  <span className="env-pill" style={{ color: m.color, background: m.bg }}>
                    {c.environment ?? "dev"}
                  </span>
                </button>
              );
            })}
            <div className="divider" />
            <button className="new-conn" onClick={p.onNewConnection}>
              ＋ New connection…
            </button>
          </div>
        )}
      </div>
      <div style={{ flex: 1 }} />
      <button className="palette-btn" onClick={p.onOpenPalette}>
        <span>Search &amp; commands</span>
        <span className="kbd">⌘K</span>
      </button>
      <button className="icon-btn" title="Toggle theme" onClick={p.onToggleTheme}>
        {p.theme === "dark" ? "☾" : "☀"}
      </button>
      <button className="icon-btn" title="Settings" onClick={p.onOpenSettings}>
        <GearIcon />
      </button>
    </header>
  );
}
