import { kbd } from "../lib/platform";
/** `id` is stable for the life of the tab. Index is not: closing a tab to
 *  the left renumbers every tab after it, so anything that has to remember
 *  *which* tab (the open transaction's owner) must hold the id. */
export type QueryTab = { id: string; name: string; sql: string; dirty: boolean };

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
      {p.tabs.map((t, i) => (
        <button
          key={i}
          className={`qtab ${i === p.active ? "on" : ""}`}
          onClick={() => p.onSelect(i)}
          onAuxClick={(e) => {
            if (e.button === 1) {
              e.preventDefault();
              p.onClose(i);
            }
          }}
        >
          <span>{t.name}</span>
          {t.dirty && <span className="dirty" />}
          <span
            className="x"
            title="Close"
            onClick={(e) => {
              e.stopPropagation();
              p.onClose(i);
            }}
          >
            ×
          </span>
        </button>
      ))}
      <button className="qtab-new" title={`New tab (${kbd("mod", "T")})`} onClick={p.onNew}>
        ＋
      </button>
    </div>
  );
}
