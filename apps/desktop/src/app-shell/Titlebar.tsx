import type { ConnectionRecord } from "../ipc/types";
import { kbd } from "../lib/platform";
import { envMeta } from "../lib/sql";
import { GearIcon, SidebarIcon, BrandMark, SearchIcon } from "../lib/icons";
import { Menu, MenuGroup } from "../lib/a11y";

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
  sidebarCollapsed?: boolean;
  onOpenPalette: () => void;
  onToggleTheme: () => void;
  onOpenSettings: () => void;
};

/** The environments whose badge is a solid block rather than a tint: the two
 *  where a stray write costs something. */
const SOLID_ENVS = new Set(["prod", "staging"]);

export default function Titlebar(p: Props) {
  const em = envMeta(p.activeEnv);
  // Only a live session has an environment. The connection form's value is
  // what activeEnv carries while disconnected, and that is not where you are.
  const ribbon = p.connected && SOLID_ENVS.has(p.activeEnv) ? p.activeEnv : "none";
  const solid = SOLID_ENVS.has(p.activeEnv);
  return (
    <header className="titlebar">
      {/* The window's top edge, coloured by where the session points. Fixed to
          the viewport, so where it sits in the tree does not matter; hidden
          from assistive tech because the badge beside the name says it. */}
      <div className={`env-ribbon env-ribbon-${ribbon}`} aria-hidden />
      <button className="icon-btn" title="Toggle sidebar" onClick={p.onToggleSidebar}>
        <SidebarIcon />
      </button>
      <div className="brand">
        <BrandMark size={22} />
        <span className="brand-word">TupleNest</span>
      </div>
      <div className="conn-switch">
        <button onClick={p.onToggleConnMenu} aria-haspopup="menu" aria-expanded={p.connMenu}>
          <span
            className="dot"
            style={{
              backgroundColor: p.connected
                ? p.activeEnv === "prod"
                  ? "var(--tn-danger)"
                  : "var(--tn-success)"
                : "var(--tn-tm)",
            }}
          />
          <span className="name">{p.connected ? p.activeName : "Not connected"}</span>
          {p.connected && p.activeUserHost && <span className="host">{p.activeUserHost}</span>}
          {p.connected &&
            (solid ? (
              <span className={`env-pill solid env-${p.activeEnv}`}>{p.activeEnv}</span>
            ) : (
              <span className="env-pill" style={{ color: em.color, background: em.bg }}>
                {p.activeEnv}
              </span>
            ))}
          <span className="caret" aria-hidden>
            ▾
          </span>
        </button>
        {p.connMenu && (
          <Menu className="conn-menu" label="Connections" onClose={p.onToggleConnMenu}>
            <MenuGroup id="conn-switch" label="Switch connection">
            {p.saved.map((c) => {
              const m = envMeta(c.environment);
              return (
                <button
                  key={c.id}
                  role="menuitemradio"
                  aria-checked={c.id === p.activeId}
                  className={`row ${c.id === p.activeId ? "active" : ""}`}
                  onClick={() => p.onSelectProfile(c)}
                >
                  <span
                    className="dot"
                    style={{ backgroundColor: c.id === p.activeId && p.connected ? "var(--tn-success)" : "var(--tn-tm)" }}
                  />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: 12, fontWeight: 650 }}>{c.name}</span>
                    <span className="host" style={{ display: "block", fontFamily: "var(--tn-mono)", fontSize: 9.5, color: "var(--tn-tm)" }}>
                      {c.username}@{c.host}:{c.port}/{c.database}
                    </span>
                  </span>
                  <span className="env-pill" style={{ color: m.color, background: m.bg }}>
                    {c.environment ?? "dev"}
                  </span>
                </button>
              );
            })}
            </MenuGroup>
            <div className="divider" role="separator" />
            <button className="new-conn" role="menuitem" onClick={p.onNewConnection}>
              ＋ New connection…
            </button>
          </Menu>
        )}
      </div>
      <div className="tb-center">
        <button className="palette-btn" onClick={p.onOpenPalette}>
          <SearchIcon />
          <span className="palette-label">Search &amp; commands</span>
          <span className="kbd">{kbd("mod", "K")}</span>
        </button>
      </div>
      <button className="icon-btn outlined" title="Toggle theme" onClick={p.onToggleTheme}>
        {p.theme === "dark" ? "☾" : "☀"}
      </button>
      <button className="icon-btn" title="Settings" onClick={p.onOpenSettings}>
        <GearIcon />
      </button>
    </header>
  );
}
