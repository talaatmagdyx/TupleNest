import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useHealth } from "./useHealth";

const invokeMock = vi.mocked(invoke);
beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({ payload: { items: [] } });
});

/** The request kind each call carried, in order. */
const kinds = () => invokeMock.mock.calls.map((c) => (c[1] as any).request.kind);

describe("useHealth — loading", () => {
  it("starts on indexes with nothing fetched", () => {
    const { result } = renderHook(() => useHealth());
    expect(result.current.tab).toBe("indexes");
    expect(result.current.indexes).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("fetches the index report", async () => {
    const { result } = renderHook(() => useHealth());
    await act(() => result.current.load("indexes"));
    expect(invokeMock).toHaveBeenCalledWith("pg_metadata", {
      request: { kind: "index_health", schema: null },
    });
    expect(result.current.indexes).not.toBeNull();
  });

  it("fetches vacuum data only when that tab is opened", async () => {
    const { result } = renderHook(() => useHealth());
    await act(() => result.current.load("indexes"));
    expect(kinds()).not.toContain("table_health");
    await act(() => result.current.load("tables"));
    expect(kinds()).toContain("table_health");
    expect(result.current.tables).not.toBeNull();
  });

  it("fetches top queries with a bounded limit", async () => {
    const { result } = renderHook(() => useHealth());
    await act(() => result.current.load("queries"));
    expect(invokeMock).toHaveBeenCalledWith("pg_metadata", {
      request: { kind: "top_queries", limit: 50 },
    });
  });

  it("switches tab even when the data is already in hand", async () => {
    const { result } = renderHook(() => useHealth());
    await act(() => result.current.load("tables"));
    expect(result.current.tab).toBe("tables");
  });
});

describe("useHealth — fetch once", () => {
  it("does not re-scan every index because someone clicked back", async () => {
    // The index report walks all 8,887 indexes; re-running it on a tab switch
    // would make the panel feel broken.
    const { result } = renderHook(() => useHealth());
    await act(() => result.current.load("indexes"));
    await act(() => result.current.load("tables"));
    await act(() => result.current.load("indexes"));
    expect(kinds().filter((k) => k === "index_health")).toHaveLength(1);
  });

  it("keeps each tab's data across switches", async () => {
    const { result } = renderHook(() => useHealth());
    await act(() => result.current.load("indexes"));
    await act(() => result.current.load("tables"));
    expect(result.current.indexes).not.toBeNull();
    expect(result.current.tables).not.toBeNull();
  });

  it("retries a tab whose first fetch failed", async () => {
    // A failure leaves the data null, so the next visit must try again rather
    // than sit on an error for ever.
    const rejected = Promise.reject(new Error("boom"));
    rejected.catch(() => {});
    invokeMock.mockReturnValueOnce(rejected);
    const { result } = renderHook(() => useHealth());
    await act(() => result.current.load("indexes"));
    expect(result.current.error).toContain("boom");

    await act(() => result.current.load("indexes"));
    expect(kinds().filter((k) => k === "index_health")).toHaveLength(2);
    expect(result.current.indexes).not.toBeNull();
    expect(result.current.error).toBeNull();
  });
});

describe("useHealth — errors", () => {
  it("reports a failure", async () => {
    const rejected = Promise.reject(new Error("permission denied"));
    rejected.catch(() => {});
    invokeMock.mockReturnValueOnce(rejected);
    const { result } = renderHook(() => useHealth());
    await act(() => result.current.load("indexes"));
    expect(result.current.error).toContain("permission denied");
  });

  it("clears a stale error when another tab is opened", async () => {
    const rejected = Promise.reject(new Error("boom"));
    rejected.catch(() => {});
    invokeMock.mockReturnValueOnce(rejected);
    const { result } = renderHook(() => useHealth());
    await act(() => result.current.load("indexes"));
    expect(result.current.error).not.toBeNull();
    await act(() => result.current.load("tables"));
    expect(result.current.error).toBeNull();
  });

  it("still switches tab when a fetch fails", async () => {
    const rejected = Promise.reject(new Error("boom"));
    rejected.catch(() => {});
    invokeMock.mockReturnValueOnce(rejected);
    const { result } = renderHook(() => useHealth());
    await act(() => result.current.load("queries"));
    expect(result.current.tab).toBe("queries");
  });
});
