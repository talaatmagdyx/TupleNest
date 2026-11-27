import { useMemo, useState } from "react";
import type { SnippetRecord } from "../ipc/types";
import PageHeader, { onPageKeyDown } from "./PageHeader";

export type SavedPageProps = {
  items: SnippetRecord[];
  onOpen: (s: SnippetRecord) => void;
  onNew: () => void;
  onClose: () => void;
};

/** A snippet's tags: the store keeps one free-text column, comma separated. */
export function tagsOf(s: SnippetRecord): string[] {
  return (s.tags ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Saved queries and snippets as a page: tag chips when any snippet has tags,
 * then a card per snippet. Opening one puts its text in the editor, as the
 * palette's snippet entries do.
 */
export default function SavedPage(p: SavedPageProps) {
  const [tag, setTag] = useState<string | null>(null);
  const tags = useMemo(() => [...new Set(p.items.flatMap(tagsOf))].sort(), [p.items]);
  const shown = tag === null ? p.items : p.items.filter((s) => tagsOf(s).includes(tag));

  return (
    <div className="page saved-page" onKeyDown={onPageKeyDown(p.onClose)}>
      <section className="page-island grow-col" aria-label="Saved queries">
        <PageHeader
          title="Saved queries"
          sub="Reusable queries and snippets. Save one from the command palette."
          onBack={p.onClose}
          actions={
            <button className="btn primary" onClick={p.onNew}>
              New query
            </button>
          }
        />
        {tags.length > 0 && (
          <div className="page-tools">
            <div className="chip-filters" role="group" aria-label="Filter by tag">
              {[null, ...tags].map((t) => (
                <button
                  key={t ?? ""}
                  className={`fchip ${tag === t ? "on" : ""}`}
                  aria-pressed={tag === t}
                  onClick={() => setTag(t)}
                >
                  {t ?? "All"}
                </button>
              ))}
            </div>
          </div>
        )}
        {p.items.length === 0 ? (
          <div className="center-note page-empty">
            Nothing saved yet. Write a query, then choose “Save current query as snippet” in the command palette.
          </div>
        ) : (
          <ul className="sq-grid" aria-label="Snippets">
            {shown.map((s) => (
              <li key={s.id}>
                <button className="sq-card" onClick={() => p.onOpen(s)} title={`Open “${s.name}” in the editor`}>
                  <span className="sq-title">{s.name}</span>
                  <pre className="sq-sql">{s.body}</pre>
                  {tagsOf(s).length > 0 && (
                    <span className="sq-tags">
                      {tagsOf(s).map((t) => (
                        <span key={t} className="tchip info">
                          {t}
                        </span>
                      ))}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
