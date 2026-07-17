import { useEffect, useRef, useState } from "react";
import { ModalHead, Overlay } from "./Overlays";
import type { SearchHit, SearchResults } from "../ipc/types";

type Props = {
  results: SearchResults | null;
  busy: boolean;
  error: string | null;
  /** Debounced by the caller; this component only reports keystrokes. */
  onSearch: (term: string) => void;
  onPick: (hit: SearchHit) => void;
  onClose: () => void;
};

const KIND_CH: Record<string, string> = {
  table: "T",
  view: "V",
  matview: "M",
  sequence: "S",
  index: "I",
  foreign: "F",
  column: "·",
};

export default function SearchModal(p: Props) {
  const [term, setTerm] = useState("");
  const [sel, setSel] = useState(0);
  const box = useRef<HTMLInputElement>(null);
  const items = p.results?.items ?? [];

  useEffect(() => box.current?.focus(), []);

  /** New results, new highlight. Adjusted during render rather than in an
   *  effect, which would paint one frame with the previous result's index —
   *  pointing at a row that is no longer there, or past the end of the list. */
  const [prevResults, setPrevResults] = useState(p.results);
  if (p.results !== prevResults) {
    setPrevResults(p.results);
    setSel(0);
  }

  const key = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter" && items[sel]) {
      p.onPick(items[sel]);
    }
  };

  return (
    <Overlay onClose={p.onClose}>
      <div className="modal search-modal" onKeyDown={key}>
        <ModalHead title="Find anything" onClose={p.onClose} />
        <div className="modal-body">
          <input
            ref={box}
            className="in big"
            placeholder="Table, view, sequence, index or column name…"
            value={term}
            onChange={(e) => {
              setTerm(e.target.value);
              p.onSearch(e.target.value);
            }}
          />
          {p.error && <div className="error-box">{p.error}</div>}
          {!p.error && p.busy && <div className="note muted">searching…</div>}
          {!p.error && !p.busy && term.length > 0 && items.length === 0 && (
            <div className="note muted">No matches.</div>
          )}
          {items.length > 0 && (
            <div className="hit-list">
              {items.map((h, i) => (
                <div
                  key={`${h.schema}.${h.name}.${h.column}.${i}`}
                  className={`hit ${i === sel ? "on" : ""}`}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => p.onPick(h)}
                >
                  <span className="obj-ic">{KIND_CH[h.kind] ?? "?"}</span>
                  <span className="mono">
                    {h.column ? (
                      <>
                        {h.schema}.{h.name}.<b>{h.column}</b>
                      </>
                    ) : (
                      <>
                        {h.schema}.<b>{h.name}</b>
                      </>
                    )}
                  </span>
                  <span className="ct">{h.kind}</span>
                </div>
              ))}
            </div>
          )}
          {p.results?.truncated && (
            <div className="note muted">
              Showing the first {items.length}. Narrow the term to see the rest.
            </div>
          )}
          {/* Partitions are excluded on purpose — see the driver comment. */}
          {term.length > 0 && (
            <div className="note muted dim">
              Partitions are hidden; searching a partitioned table shows the parent.
            </div>
          )}
        </div>
      </div>
    </Overlay>
  );
}
