/**
 * The pages and first-run dialogs of stage 6b, registered in one place.
 *
 * App.tsx knows only this module: which page is open (`Page`), the palette
 * entries that open them (`pageCommands`), and the host that draws one in the
 * main area (`PageHost`). Adding a page means adding it here, not threading
 * another overlay kind and its props through App.
 */
import type { PaletteItem } from "../overlays/Overlays";
import DashboardsPage from "./DashboardsPage";
import type { PageContext } from "./context";

export type { PageContext } from "./context";
export { isPostgres } from "./context";

export type Page = "dashboards";

export const PAGE_TITLES: Record<Page, string> = {
  dashboards: "Dashboards",
};

/** Palette entries. Every page is PostgreSQL-only; one opened with no session
 *  says what it needs rather than being hidden. */
export function pageCommands(open: (page: Page) => void): PaletteItem[] {
  return [{ icon: "▦", label: "Open dashboards", type: "Action", exec: () => open("dashboards") }];
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
    </main>
  );
}
