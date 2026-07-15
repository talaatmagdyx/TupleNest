import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { DbColumn, DbObject, MetadataOut } from "../ipc/types";
import type { Catalog } from "../lib/complete";
import {
  comparePlans,
  diffSchemas,
  findUsages,
  renameIdentifier,
  type PlanSummary,
  type TableDiff,
} from "../lib/intel";

type Tab = { name: string; sql: string };

type Props = {
  tabs: Tab[];
  catalog?: Catalog;
  /** The two most recent EXPLAIN summaries, oldest first. */
  plans: { label: string; summary: PlanSummary }[];
  onJump: (tabIndex: number, offset: number) => void;
  onRename: (tabIndex: number, sql: string) => void;
  onClose: () => void;
};

type Pane = "usages" | "diff" | "plans";

/** Bounded so "diff two schemas" can't fire thousands of describe calls at a
 *  4000-table schema. */
const DIFF_TABLE_CAP = 150;

export default function IntelModal(p: Props) {
  const [pane, setPane] = useState<Pane>("usages");

  /* ------------------------------------------------------------- usages */
  const [needle, setNeedle] = useState("");
  const [renameTo, setRenameTo] = useState("");

  const usages = useMemo(() => {
    if (!needle.trim()) return [];
    return p.tabs.flatMap((t, i) =>
      findUsages(t.sql, needle.trim()).map((u) => ({ ...u, tabIndex: i, tabName: t.name }))
    );
  }, [needle, p.tabs]);

  const doRename = () => {
    if (!needle.trim() || !renameTo.trim()) return;
    p.tabs.forEach((t, i) => {
      const r = renameIdentifier(t.sql, needle.trim(), renameTo.trim());
      if (r.count > 0) p.onRename(i, r.sql);
    });
    setNeedle(renameTo.trim());
    setRenameTo("");
  };

  /* --------------------------------------------------------- schema diff */
  const schemas = p.catalog?.schemas ?? [];
  const [left, setLeft] = useState(schemas[0] ?? "");
  const [right, setRight] = useState(schemas[1] ?? schemas[0] ?? "");
  const [diff, setDiff] = useState<TableDiff[] | null>(null);
  const [diffBusy, setDiffBusy] = useState(false);
  const [diffNote, setDiffNote] = useState<string | null>(null);

  const loadSchema = async (schema: string): Promise<Record<string, DbColumn[]>> => {
    const objs = await invoke<MetadataOut<DbObject[]>>("pg_metadata", {
      request: { kind: "list_objects", schema },
    });
    const tables = objs.payload.filter((o) => o.kind === "table").slice(0, DIFF_TABLE_CAP);
    const out: Record<string, DbColumn[]> = {};
    for (const t of tables) {
      const d = await invoke<MetadataOut<{ columns: DbColumn[] }>>("pg_metadata", {
        request: { kind: "describe_object", schema, name: t.name },
      });
      out[t.name] = d.payload.columns;
    }
    if (objs.payload.filter((o) => o.kind === "table").length > DIFF_TABLE_CAP) {
      setDiffNote(`Compared the first ${DIFF_TABLE_CAP} tables of each schema.`);
    }
    return out;
  };

  const runDiff = async () => {
    if (!left || !right) return;
    setDiffBusy(true);
    setDiff(null);
    setDiffNote(null);
    try {
      const [l, r] = [await loadSchema(left), await loadSchema(right)];
      setDiff(diffSchemas(l, r));
    } catch (e) {
      setDiffNote(String(e).slice(0, 120));
    } finally {
      setDiffBusy(false);
    }
  };

  /* -------------------------------------------------------- plan compare */
  const delta =
    p.plans.length >= 2
      ? comparePlans(p.plans[p.plans.length - 2].summary, p.plans[p.plans.length - 1].summary)
      : null;

  useEffect(() => {
    if (schemas.length && !left) setLeft(schemas[0]);
    if (schemas.length > 1 && !right) setRight(schemas[1]);
  }, [schemas, left, right]);

  const pct = (v: number | null) => (v === null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`);
  const num = (v: number | null, unit = "") => (v === null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}${unit}`);

  return (
    <div className="overlay center" onClick={p.onClose}>
      <div className="modal intel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="t">SQL intelligence</span>
          <button className="x" onClick={p.onClose}>
            ×
          </button>
        </div>

        <div className="intel-tabs">
          {(
            [
              ["usages", "Find usages & rename"],
              ["diff", "Schema diff"],
              ["plans", "Plan compare"],
            ] as [Pane, string][]
          ).map(([id, label]) => (
            <button key={id} className={`rtab ${pane === id ? "on" : ""}`} onClick={() => setPane(id)}>
              {label}
            </button>
          ))}
        </div>

        <div className="modal-body">
          {pane === "usages" && (
            <>
              <div className="intel-row">
                {/* spellCheck/autoComplete off: identifiers aren't prose, and
                    the OS suggestion popup covers the results list. */}
                <input
                  autoFocus
                  spellCheck={false}
                  autoComplete="off"
                  autoCapitalize="off"
                  className="intel-input"
                  placeholder="Identifier — table, column, alias…"
                  value={needle}
                  onChange={(e) => setNeedle(e.target.value)}
                />
                <input
                  spellCheck={false}
                  autoComplete="off"
                  autoCapitalize="off"
                  className="intel-input"
                  placeholder="Rename to…"
                  value={renameTo}
                  onChange={(e) => setRenameTo(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && doRename()}
                />
                <button className="btn" onClick={doRename} disabled={!needle.trim() || !renameTo.trim()}>
                  Rename {usages.length > 0 ? `(${usages.length})` : ""}
                </button>
              </div>
              <p className="intel-note">
                Matches whole identifiers only across every open tab — never inside a longer name, a
                comment, or a string literal.
              </p>
              {needle.trim() && usages.length === 0 && <div className="center-note">No usages found</div>}
              <div className="intel-list">
                {usages.map((u, i) => (
                  <button
                    key={i}
                    className="intel-hit"
                    onClick={() => {
                      p.onJump(u.tabIndex, u.start);
                      p.onClose();
                    }}
                  >
                    <span className="ih-file">{u.tabName}</span>
                    <span className="ih-line">:{u.line}</span>
                    <span className="ih-prev">{u.preview}</span>
                  </button>
                ))}
              </div>
            </>
          )}

          {pane === "diff" && (
            <>
              <div className="intel-row">
                <select className="intel-input" value={left} onChange={(e) => setLeft(e.target.value)}>
                  {schemas.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
                <span className="intel-arrow">→</span>
                <select className="intel-input" value={right} onChange={(e) => setRight(e.target.value)}>
                  {schemas.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
                <button className="btn primary" onClick={runDiff} disabled={diffBusy || left === right}>
                  {diffBusy ? "Comparing…" : "Compare"}
                </button>
              </div>
              {left === right && <p className="intel-note">Pick two different schemas.</p>}
              {diffNote && <p className="intel-note">{diffNote}</p>}
              {diff && diff.length === 0 && <div className="center-note">Schemas are identical</div>}
              <div className="intel-list">
                {diff?.map((d, i) => (
                  <div key={i} className="diff-block">
                    <div className={`diff-t k-${d.kind}`}>
                      <span className="dt-badge">{d.kind}</span>
                      {d.table}
                    </div>
                    {d.kind === "changed" &&
                      d.columns.map((c, j) => (
                        <div key={j} className={`diff-c k-${c.kind}`}>
                          <span className="dc-badge">{c.kind}</span>
                          <span className="dc-name">{c.column}</span>
                          <span className="dc-detail">
                            {c.kind === "added" || c.kind === "removed"
                              ? c.type
                              : `${String(c.from)} → ${String(c.to)}`}
                          </span>
                        </div>
                      ))}
                  </div>
                ))}
              </div>
            </>
          )}

          {pane === "plans" && (
            <>
              {p.plans.length < 2 ? (
                <div className="center-note" style={{ padding: 30 }}>
                  Run EXPLAIN on two queries to compare their plans.
                  <br />
                  <span className="muted">{p.plans.length} captured so far.</span>
                </div>
              ) : (
                <>
                  <div className="plan-cmp-head">
                    <span className="pc-old">{p.plans[p.plans.length - 2].label}</span>
                    <span className="intel-arrow">→</span>
                    <span className="pc-new">{p.plans[p.plans.length - 1].label}</span>
                  </div>
                  {delta?.newSeqScan && (
                    <div className="er-warn">
                      <strong>New sequential scan.</strong> The newer plan scans a table the older one
                      reached by index — usually the cause of a regression.
                    </div>
                  )}
                  <div className="pc-grid">
                    <div className={`pc-cell ${(delta?.msDelta ?? 0) > 0 ? "worse" : "better"}`}>
                      <span className="pc-k">Execution time</span>
                      <span className="pc-v">{num(delta?.msDelta ?? null, " ms")}</span>
                      <span className="pc-p">{pct(delta?.msPercent ?? null)}</span>
                    </div>
                    <div className={`pc-cell ${(delta?.costDelta ?? 0) > 0 ? "worse" : "better"}`}>
                      <span className="pc-k">Estimated cost</span>
                      <span className="pc-v">{num(delta?.costDelta ?? null)}</span>
                      <span className="pc-p">{pct(delta?.costPercent ?? null)}</span>
                    </div>
                  </div>
                  <div className="intel-list">
                    {delta?.nodeChanges.map((c, i) => (
                      <div key={i} className={`diff-c ${c.to > c.from ? "k-added" : "k-removed"}`}>
                        <span className="dc-badge">{c.to > c.from ? "more" : "fewer"}</span>
                        <span className="dc-name">{c.node}</span>
                        <span className="dc-detail">
                          {c.from} → {c.to}
                        </span>
                      </div>
                    ))}
                    {delta?.nodeChanges.length === 0 && (
                      <div className="center-note">Same plan shape — only the numbers moved.</div>
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
