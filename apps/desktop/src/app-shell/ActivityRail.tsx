import {
  DiagramRailIcon,
  ExplorerRailIcon,
  GearIcon,
  HistoryRailIcon,
  MonitorRailIcon,
} from "../lib/icons";

export type RailView = "explorer" | "history";

type Props = {
  view: RailView;
  collapsed: boolean;
  connected: boolean;
  onView: (v: RailView) => void;
  onMonitor: () => void;
  onDiagram: () => void;
  onSettings: () => void;
};

/** VS Code / DataGrip-style activity rail: switches the sidebar panel and
 *  launches tool overlays. The active view shows an accent indicator bar. */
export default function ActivityRail(p: Props) {
  const Item = (opts: {
    active?: boolean;
    disabled?: boolean;
    title: string;
    onClick: () => void;
    children: React.ReactNode;
  }) => (
    <button
      className={`rail-btn ${opts.active ? "on" : ""}`}
      title={opts.title}
      disabled={opts.disabled}
      onClick={opts.onClick}
    >
      {opts.active && <span className="rail-ind" />}
      {opts.children}
    </button>
  );

  return (
    <nav className="activity-rail">
      <div className="rail-group">
        <Item
          title="Explorer (⌘B)"
          active={p.view === "explorer" && !p.collapsed}
          onClick={() => p.onView("explorer")}
        >
          <ExplorerRailIcon />
        </Item>
        <Item
          title="Query history"
          active={p.view === "history" && !p.collapsed}
          onClick={() => p.onView("history")}
        >
          <HistoryRailIcon />
        </Item>
        <Item title="Server monitor" disabled={!p.connected} onClick={p.onMonitor}>
          <MonitorRailIcon />
        </Item>
        <Item title="ER diagram" disabled={!p.connected} onClick={p.onDiagram}>
          <DiagramRailIcon />
        </Item>
      </div>
      <div className="rail-group bottom">
        <Item title="Settings" onClick={p.onSettings}>
          <GearIcon size={19} />
        </Item>
      </div>
    </nav>
  );
}
