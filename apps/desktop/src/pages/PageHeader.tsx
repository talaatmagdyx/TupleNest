import type { ReactNode } from "react";

/**
 * The one header every page uses: a way back to the editor, the title, a
 * line saying what the page is, and the page's actions at the right.
 *
 * Every page that takes the editor's place (history, saved queries,
 * dashboards, notebooks, backup, roles) draws this at the top of its first
 * island, so they look and behave alike. Escape goes back as well; see
 * `onPageKeyDown`.
 */
export default function PageHeader(p: {
  title: string;
  /** What the page is, in one line. */
  sub?: ReactNode;
  /** Controls that belong next to the title, such as the dashboard picker. */
  meta?: ReactNode;
  /** The page's actions, primary last. */
  actions?: ReactNode;
  onBack: () => void;
}) {
  return (
    <div className="page-head">
      <button className="btn xs page-back" onClick={p.onBack} aria-label="Back to the editor" title="Back to the editor (Esc)">
        <span aria-hidden>←</span> Editor
      </button>
      <h1 className="page-title">{p.title}</h1>
      {p.meta}
      {p.sub ? <span className="page-sub">{p.sub}</span> : null}
      <div className="grow" />
      {p.actions}
    </div>
  );
}

/** Escape on a page goes back to the editor. Stopped here, so the window's
 *  own Escape does not also act (it would cancel a running query). A dialog
 *  over the page stops Escape itself and closes only the dialog. */
export function onPageKeyDown(onBack: () => void) {
  return (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onBack();
    }
  };
}
