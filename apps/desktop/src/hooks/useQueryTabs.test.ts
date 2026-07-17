import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { FIRST_TAB, useQueryTabs } from "./useQueryTabs";

const three = [
  { name: "a.sql", sql: "select 1", dirty: false },
  { name: "b.sql", sql: "select 2", dirty: false },
  { name: "c.sql", sql: "select 3", dirty: false },
];

describe("useQueryTabs — defaults", () => {
  it("opens with one tab, active", () => {
    const { result } = renderHook(() => useQueryTabs());
    expect(result.current.tabs).toEqual([FIRST_TAB]);
    expect(result.current.activeTab).toBe(0);
    expect(result.current.activeSql).toBe(FIRST_TAB.sql);
  });

  it("exposes the active tab's sql", () => {
    const { result } = renderHook(() => useQueryTabs(three));
    act(() => result.current.setActiveTab(2));
    expect(result.current.activeSql).toBe("select 3");
  });
});

describe("useQueryTabs — editing", () => {
  it("marks a tab dirty when the user types", () => {
    const { result } = renderHook(() => useQueryTabs(three));
    act(() => result.current.setActiveSql("select 99"));
    expect(result.current.tabs[0]).toMatchObject({ sql: "select 99", dirty: true });
  });

  it("does not dirty a tab the app filled in itself", () => {
    // Loading a history entry or a generated script is not an unsaved edit.
    const { result } = renderHook(() => useQueryTabs(three));
    act(() => result.current.setActiveSql("select 99", { markClean: true }));
    expect(result.current.tabs[0].dirty).toBe(false);
  });

  it("edits the active tab, not the first one", () => {
    const { result } = renderHook(() => useQueryTabs(three));
    act(() => result.current.setActiveTab(1));
    act(() => result.current.setActiveSql("edited"));
    expect(result.current.tabs[1].sql).toBe("edited");
    expect(result.current.tabs[0].sql).toBe("select 1");
  });

  it("re-seeds rather than throwing if there are somehow no tabs", () => {
    const { result } = renderHook(() => useQueryTabs([]));
    act(() => result.current.setActiveSql("x"));
    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.tabs[0].sql).toBe("x");
  });
});

describe("useQueryTabs — opening", () => {
  it("appends a tab and selects it", () => {
    // The bug this guards: two setTabs calls in a row read a stale length and
    // selected the wrong tab once React batched them.
    const { result } = renderHook(() => useQueryTabs(three));
    act(() => result.current.newTab());
    expect(result.current.tabs).toHaveLength(4);
    expect(result.current.activeTab).toBe(3);
    expect(result.current.activeSql).toBe("");
  });

  it("names untitled tabs in sequence, never colliding", () => {
    const { result } = renderHook(() => useQueryTabs(three));
    act(() => result.current.newTab());
    act(() => result.current.newTab());
    const names = result.current.tabs.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("opens a named script tab, pre-filled and dirty", () => {
    const { result } = renderHook(() => useQueryTabs(three));
    act(() => result.current.newTab({ name: "drop.sql", sql: "DROP INDEX x;", dirty: true }));
    expect(result.current.tabs[3]).toEqual({ name: "drop.sql", sql: "DROP INDEX x;", dirty: true });
    expect(result.current.activeTab).toBe(3);
  });

  it("selects the tab it just opened even across two opens in one batch", () => {
    const { result } = renderHook(() => useQueryTabs(three));
    act(() => {
      result.current.newTab();
      result.current.newTab();
    });
    expect(result.current.tabs).toHaveLength(5);
    expect(result.current.activeTab).toBe(4);
  });
});

describe("useQueryTabs — closing", () => {
  it("removes the tab", () => {
    const { result } = renderHook(() => useQueryTabs(three));
    act(() => result.current.closeTab(1));
    expect(result.current.tabs.map((t) => t.name)).toEqual(["a.sql", "c.sql"]);
  });

  it("keeps the same tab active when closing one after it", () => {
    const { result } = renderHook(() => useQueryTabs(three));
    act(() => result.current.setActiveTab(0));
    act(() => result.current.closeTab(2));
    expect(result.current.activeTab).toBe(0);
  });

  it("shifts the active index down when closing one before it", () => {
    const { result } = renderHook(() => useQueryTabs(three));
    act(() => result.current.setActiveTab(2));
    act(() => result.current.closeTab(0));
    expect(result.current.activeSql).toBe("select 3");
  });

  it("never leaves the index past the end", () => {
    const { result } = renderHook(() => useQueryTabs(three));
    act(() => result.current.setActiveTab(2));
    act(() => result.current.closeTab(2));
    expect(result.current.activeTab).toBe(1);
    expect(result.current.activeSql).toBe("select 2");
  });

  it("closes the last tab, leaving none for the empty state to answer", () => {
    // It used to re-seed a blank tab here. That made closing the last tab look
    // like it had failed, and left App's onboarding card unreachable.
    const { result } = renderHook(() => useQueryTabs([three[0]]));
    act(() => result.current.closeTab(0));
    expect(result.current.tabs).toEqual([]);
    expect(result.current.activeTab).toBe(0);
  });
});

describe("useQueryTabs — selection is always valid", () => {
  it("clamps a too-high index", () => {
    const { result } = renderHook(() => useQueryTabs(three));
    act(() => result.current.setActiveTab(99));
    expect(result.current.activeTab).toBe(2);
  });

  it("clamps a negative index", () => {
    const { result } = renderHook(() => useQueryTabs(three));
    act(() => result.current.setActiveTab(-5));
    expect(result.current.activeTab).toBe(0);
  });
});
