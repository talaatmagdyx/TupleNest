import { kbd } from "../lib/platform";
import { tabKeyDown, tabProps } from "../lib/a11y";
/** `id` is stable for the life of the tab. Index is not: closing a tab to
 *  the left renumbers every tab after it, so anything that has to remember
 *  *which* tab (the open transaction's owner) must hold the id. */
export type QueryTab = { id: string; name: string; sql: string; dirty: boolean };

/** The element the editor tabs control: the query panel below the strip. */
export const QUERY_PANEL_ID = "query-tabpanel";
export const queryTabId = (t: QueryTab) => `qtab-${t.id}`;

type Props = {
  tabs: QueryTab[];
  active: number;
  onSelect: (i: number) => void;
  onClose: (i: number) => void;
  onNew: () => void;
};

export default function TabsBar(p: Props) {
  return (
    <div className="qtabs">
      <div className="qtab-list" role="tablist" aria-label="Query tabs">
        {p.tabs.map((t, i) => (
          <button
            key={i}
            {...tabProps(queryTabId(t), QUERY_PANEL_ID, i === p.active)}
            className={`qtab ${i === p.active ? "on" : ""}`}
            onClick={() => p.onSelect(i)}
            onKeyDown={(e) => {
              if (tabKeyDown(e, i, p.tabs.length, p.onSelect)) return;
              // The × is a mouse target only (a button inside a button is not
              // valid markup), so Delete is its keyboard twin.
              if (e.key === "Delete") {
                e.preventDefault();
                p.onClose(i);
              }
            }}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                p.onClose(i);
              }
            }}
          >
            <span>{t.name}</span>
            {/* The dot is colour alone; the words go in the tab's name. Their
                own span, with the comma, so they are not run into the name. */}
            {t.dirty && (
              <>
                <span className="dirty" aria-hidden />
                <span className="sr-only">, unsaved changes</span>
              </>
            )}
            <span
              className="x"
              title="Close"
              aria-hidden
              onClick={(e) => {
                e.stopPropagation();
                p.onClose(i);
              }}
            >
              ×
            </span>
          </button>
        ))}
      </div>
      <button
        className="qtab-new"
        title={`New tab (${kbd("mod", "T")})`}
        aria-label="New tab"
        onClick={p.onNew}
      >
        ＋
      </button>
    </div>
  );
}
