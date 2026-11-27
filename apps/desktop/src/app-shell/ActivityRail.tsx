import {
  AuditRailIcon,
  DiagramRailIcon,
  ExplorerRailIcon,
  GearIcon,
  HistoryRailIcon,
  MonitorRailIcon,
  PastePlanRailIcon,
  SavedRailIcon,
} from "../lib/icons";
import { kbd } from "../lib/platform";

/** What the main area shows. "explorer" is the editor with the explorer
 *  beside it; the others are pages that take the editor's place. */
export type RailView = "explorer" | "history" | "saved";

type Props = {
  view: RailView;
  collapsed: boolean;
  connected: boolean;
  onView: (v: RailView) => void;
  onMonitor: () => void;
  onDiagram: () => void;
  onAudit: () => void;
  onPastePlan: () => void;
  onSettings: () => void;
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
      aria-current={opts.active ? "page" : undefined}
      disabled={opts.disabled}
      onClick={opts.onClick}
    >
      {opts.active && <span className="rail-ind" />}
      {opts.children}
    </button>
  );
}

/** VS Code / DataGrip-style activity rail: switches the main area between the
 *  editor and its pages, and launches tool overlays. The active view shows an
 *  accent indicator bar. */
export default function ActivityRail(p: Props) {
  return (
    <nav className="activity-rail" aria-label="Views">
      <div className="rail-group">
        <Item
          title={`Explorer (${kbd("mod", "B")})`}
          active={p.view === "explorer" && !p.collapsed}
          onClick={() => p.onView("explorer")}
        >
          <ExplorerRailIcon />
        </Item>
        <Item title="Query history" active={p.view === "history"} onClick={() => p.onView("history")}>
          <HistoryRailIcon />
        </Item>
        <Item title="Saved queries" active={p.view === "saved"} onClick={() => p.onView("saved")}>
          <SavedRailIcon />
        </Item>
        <Item title="Server monitor" disabled={!p.connected} onClick={p.onMonitor}>
          <MonitorRailIcon />
        </Item>
        <Item title="ER diagram" disabled={!p.connected} onClick={p.onDiagram}>
          <DiagramRailIcon />
        </Item>
        {/* Not gated on `connected`: the log lives in the local store, and
            reading what was run is most useful after the session is gone. */}
        <Item title="Audit log" onClick={p.onAudit}>
          <AuditRailIcon />
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
