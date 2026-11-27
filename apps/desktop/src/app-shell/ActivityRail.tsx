import {
  DashboardRailIcon,
  DiagramRailIcon,
  ExplorerRailIcon,
  GearIcon,
  HistoryRailIcon,
  MonitorRailIcon,
  NotebookRailIcon,
  PastePlanRailIcon,
} from "../lib/icons";
import { kbd } from "../lib/platform";

export type RailView = "explorer" | "history";
/** Pages the rail opens in place of the editor. */
export type RailPage = "dashboards" | "notebooks";

type Props = {
  view: RailView;
  collapsed: boolean;
  connected: boolean;
  onView: (v: RailView) => void;
  onMonitor: () => void;
  onDiagram: () => void;
  onPastePlan: () => void;
  onSettings: () => void;
  /** The page open in the main area, if it is one of the rail's. */
  page?: string | null;
  onPage?: (page: RailPage) => void;
};

/**
 * One rail button.
 *
 * Defined out here on purpose. It used to live inside `ActivityRail`, which
 * made it a new component type on every render: React cannot know the two are
 * the same, so it threw the buttons away and built them again each time. The
 * rail is a row of static icons, so it looked fine — until you noticed that
 * keyboard focus on a rail button was dropped by any re-render, and App
 * re-renders once a second while a transaction is open, to tick the timer.
 */
function Item(opts: {
  active?: boolean;
  disabled?: boolean;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
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
}

/** VS Code / DataGrip-style activity rail: switches the sidebar panel and
 *  launches tool overlays. The active view shows an accent indicator bar. */
export default function ActivityRail(p: Props) {
  return (
    <nav className="activity-rail">
      <div className="rail-group">
        <Item
          title={`Explorer (${kbd("mod", "B")})`}
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
        {/* Open with no session too: each page says what it needs, and a
            saved notebook can be read offline. */}
        <Item title="Dashboards" active={p.page === "dashboards"} onClick={() => p.onPage?.("dashboards")}>
          <DashboardRailIcon />
        </Item>
        <Item title="Notebooks" active={p.page === "notebooks"} onClick={() => p.onPage?.("notebooks")}>
          <NotebookRailIcon />
        </Item>
        {/* Deliberately not gated on `connected`: the whole point is analysing
            a plan from somewhere this app cannot reach. */}
        <Item title="Analyze a pasted plan" onClick={p.onPastePlan}>
          <PastePlanRailIcon />
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
