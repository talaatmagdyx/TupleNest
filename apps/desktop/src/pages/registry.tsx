/**
 * The pages and first-run dialogs of stage 6b, registered in one place.
 *
 * App.tsx knows only this module: which page is open (`Page`), the palette
 * entries that open them (`pageCommands`), and the host that draws one in the
 * main area (`PageHost`). Adding a page means adding it here, not threading
 * another overlay kind and its props through App.
 */
import type { Feature } from "../lib/engine";
import type { PaletteItem } from "../overlays/Overlays";
import BackupPage from "./BackupPage";
import DashboardsPage from "./DashboardsPage";
import NotebooksPage from "./NotebooksPage";
import RolesPage from "./RolesPage";
import type { PageContext } from "./context";

export type { PageContext } from "./context";
export { default as FirstRun, type FirstRunRequest } from "./FirstRun";
export { isPostgres } from "./context";

export type Page = "dashboards" | "notebooks" | "backup" | "roles";

export const PAGE_TITLES: Record<Page, string> = {
  dashboards: "Dashboards",
  notebooks: "Notebooks",
  backup: "Backup and restore",
  roles: "Users and roles",
};

/** Is this main-area view one of the pages registered here? */
export function isRegistryPage(view: string): view is Page {
  return view in PAGE_TITLES;
}

/**
 * Palette entries. Dashboards and notebooks run on any engine through the
 * normal query path. Backup and roles are PostgreSQL-only: hidden while a
 * session of another engine is live (`lacks`, App's rule for every
 * engine-specific command); offline they still open and say what they need.
 */
export function pageCommands(open: (page: Page) => void, lacks: (f: Feature) => boolean): PaletteItem[] {
  return [
    { icon: "▦", label: "Open dashboards", type: "Action", exec: () => open("dashboards") },
    { icon: "▤", label: "Open notebooks", type: "Action", exec: () => open("notebooks") },
    ...(lacks("backup")
      ? []
      : [{ icon: "⇩", label: "Backup and restore (pg_dump)…", type: "Action", exec: () => open("backup") }]),
    ...(lacks("roles") ? [] : [{ icon: "☺", label: "Users and roles…", type: "Action", exec: () => open("roles") }]),
  ];
}

/** The open page, in place of the editor. The editor stays mounted behind it
 *  (hidden), so its tabs and undo history are there on the way back. */
export function PageHost(p: { page: Page; ctx: PageContext; onClose: () => void }) {
  return (
    <main className="main-col page-host">
      <div className="page-back">
        <button className="btn xs" onClick={p.onClose}>
          ← Back to the editor
        </button>
        <span className="page-sub">{PAGE_TITLES[p.page]}</span>
      </div>
      {p.page === "dashboards" && <DashboardsPage ctx={p.ctx} />}
      {p.page === "notebooks" && <NotebooksPage ctx={p.ctx} />}
      {p.page === "backup" && <BackupPage ctx={p.ctx} />}
      {p.page === "roles" && <RolesPage ctx={p.ctx} />}
    </main>
  );
}
