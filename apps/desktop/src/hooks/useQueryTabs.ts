import { useCallback, useRef, useState } from "react";
import type { QueryTab } from "../editor/TabsBar";

/**
 * The open query tabs and which one is active.
 *
 * Extracted from App so the invariants can be stated and tested: the active
 * index always points at a real tab, closing the last tab leaves a usable
 * editor rather than an empty screen, and `dirty` means "edited since it was
 * loaded" rather than "has text in it".
 */
export type QueryTabs = {
  tabs: QueryTab[];
  activeTab: number;
  activeSql: string;
  setActiveTab: (i: number) => void;
  /** Replace the active tab's SQL. `markClean` for text the app loaded itself
   *  (a history entry, a generated script) rather than text the user typed. */
  setActiveSql: (sql: string, opts?: { markClean?: boolean }) => void;
  newTab: (init?: { name?: string; sql?: string; dirty?: boolean }) => void;
  closeTab: (i: number) => void;
  setTabs: React.Dispatch<React.SetStateAction<QueryTab[]>>;
};

let seq = 0;
/** Monotonic, process-local. Not persisted: tabs do not outlive the window. */
export const tabId = (): string => `tab-${++seq}`;

export const FIRST_TAB: QueryTab = {
  id: "tab-0",
  name: "untitled-1.sql",
  sql: "select now(), version()",
  dirty: false,
};

export function useQueryTabs(initial: QueryTab[] = [FIRST_TAB]): QueryTabs {
  const [tabs, setTabs] = useState<QueryTab[]>(initial);
  const [activeTab, setActiveTabRaw] = useState(0);
  const untitledSeq = useRef(initial.length + 1);

  /** Never let the index point past the end — a stale index renders nothing
   *  and the app looks broken rather than merely wrong. */
  const setActiveTab = useCallback((i: number) => {
    setTabs((ts) => {
      setActiveTabRaw(Math.max(0, Math.min(i, ts.length - 1)));
      return ts;
    });
  }, []);

  const setActiveSql = useCallback(
    (sql: string, opts?: { markClean?: boolean }) => {
      setTabs((ts) => {
        if (ts.length === 0) return [{ ...FIRST_TAB, sql }];
        const out = [...ts];
        out[activeTab] = { ...out[activeTab], sql, dirty: !opts?.markClean };
        return out;
      });
    },
    [activeTab],
  );

  const newTab = useCallback((init?: { name?: string; sql?: string; dirty?: boolean }) => {
    // One setTabs, not two. The previous version called setTabs twice and read
    // `ts.length` from the *stale* first closure to pick the active index,
    // which selected the wrong tab whenever React batched the updates.
    setTabs((ts) => {
      const next = [
        ...ts,
        {
          id: tabId(),
          name: init?.name ?? `untitled-${untitledSeq.current++}.sql`,
          sql: init?.sql ?? "",
          dirty: init?.dirty ?? false,
        },
      ];
      setActiveTabRaw(next.length - 1);
      return next;
    });
  }, []);

  const closeTab = useCallback((i: number) => {
    setTabs((ts) => {
      const next = ts.filter((_, x) => x !== i);
      // Closing the last one is allowed to leave none. This used to re-seed a
      // blank tab so the screen was never empty, which quietly made the app's
      // own empty state unreachable — and that state is the better answer: it
      // says what happened and offers the way back, where a blank untitled tab
      // just looks like the close silently failed.
      setActiveTabRaw((a) => Math.max(0, Math.min(a >= i ? a - 1 : a, next.length - 1)));
      return next;
    });
  }, []);

  return {
    tabs,
    activeTab,
    activeSql: tabs[activeTab]?.sql ?? "",
    setActiveTab,
    setActiveSql,
    newTab,
    closeTab,
    setTabs,
  };
}
