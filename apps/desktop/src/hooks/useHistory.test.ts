import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import type { HistoryEntry } from "../ipc/types";
import { HISTORY_LIMIT, useHistory } from "./useHistory";

const invokeMock = vi.mocked(invoke);

const entry = (over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  id: "1",
  connectionKey: "local",
  sqlText: "select 1",
  status: "success",
  errorText: null,
  rowsReturned: 1,
  rowsAffected: null,
  startedAt: 0,
  durationMs: 3,
  favorite: false,
  ...over,
});

/** A promise the test decides when to settle. */
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

const lists = () => invokeMock.mock.calls.filter((c) => c[0] === "history_list");

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue([]);
});

/** Mount and wait for the read the mount fires. */
const mount = async () => {
  const h = renderHook(() => useHistory());
  await waitFor(() => expect(lists().length).toBeGreaterThan(0));
  return h;
};

describe("useHistory — reading", () => {
  it("loads on mount", async () => {
    invokeMock.mockResolvedValue([entry()]);
    const { result } = await mount();
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(lists()[0][1]).toEqual({ search: null, limit: HISTORY_LIMIT });
  });

  it("sends null rather than an empty search", async () => {
    // The store treats null as "no filter"; "" would be a LIKE '%%' scan.
    await mount();
    expect(lists()[0][1]).toMatchObject({ search: null });
  });

  it("re-reads when the search term changes", async () => {
    const { result } = await mount();
    act(() => result.current.setSearch("users"));
    await waitFor(() => expect(lists()[lists().length - 1][1]).toMatchObject({ search: "users" }));
  });

  it("keeps the previous list when the read fails", async () => {
    // A blank panel reads as "you have no history" — a worse lie than a
    // slightly stale list.
    invokeMock.mockResolvedValue([entry()]);
    const { result } = await mount();
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    vi.spyOn(console, "error").mockImplementation(() => {});
    const p = Promise.reject("store locked");
    p.catch(() => {});
    invokeMock.mockReturnValueOnce(p);
    act(() => result.current.setSearch("x"));
    await waitFor(() => expect(lists().length).toBe(2));
    expect(result.current.items).toHaveLength(1);
  });
});

describe("useHistory — out-of-order responses", () => {
  it("ignores a stale response that lands after a newer one", async () => {
    // Typing fires one read per keystroke. A slow "sel" landing after a fast
    // "select * from users" would repaint the list for a term the box no
    // longer holds.
    const { result } = await mount();
    const slow = deferred<HistoryEntry[]>();
    const fast = deferred<HistoryEntry[]>();

    invokeMock.mockReturnValueOnce(slow.promise as never);
    act(() => result.current.setSearch("sel"));
    await waitFor(() => expect(lists().length).toBe(2));

    invokeMock.mockReturnValueOnce(fast.promise as never);
    act(() => result.current.setSearch("select"));
    await waitFor(() => expect(lists().length).toBe(3));

    await act(async () => {
      fast.resolve([entry({ id: "99", sqlText: "select * from users" })]);
      await fast.promise;
    });
    await act(async () => {
      slow.resolve([entry({ id: "1", sqlText: "sel" })]);
      await slow.promise;
    });

    expect(result.current.items.map((i) => i.id)).toEqual(["99"]);
  });

  it("accepts the newest response even when it lands last", async () => {
    const { result } = await mount();
    const d = deferred<HistoryEntry[]>();
    invokeMock.mockReturnValueOnce(d.promise as never);
    act(() => result.current.setSearch("q"));
    await waitFor(() => expect(lists().length).toBe(2));
    await act(async () => {
      d.resolve([entry({ id: "42" })]);
      await d.promise;
    });
    expect(result.current.items.map((i) => i.id)).toEqual(["42"]);
  });
});

describe("useHistory — favourites", () => {
  it("sets the flag and re-reads", async () => {
    const { result } = await mount();
    await act(async () => void (await result.current.toggleFavorite("7", true)));
    expect(invokeMock).toHaveBeenCalledWith("history_favorite", { id: "7", favorite: true });
    expect(lists().length).toBe(2);
  });

  it("re-reads even when the write failed, so the star matches the store", async () => {
    // Leaving the star where the click put it asserts a change that did not
    // happen, and the next read silently contradicts it.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { result } = await mount();
    invokeMock.mockImplementation(async (c: string) => {
      if (c === "history_favorite") return Promise.reject("readonly database") as never;
      return [] as never;
    });
    await act(async () => void (await result.current.toggleFavorite("7", true)));
    expect(lists().length).toBe(2);
  });

  it("carries the value through rather than toggling blind", async () => {
    const { result } = await mount();
    await act(async () => void (await result.current.toggleFavorite("3", false)));
    expect(invokeMock).toHaveBeenCalledWith("history_favorite", { id: "3", favorite: false });
  });
});

describe("useHistory — clearing", () => {
  it("keeps favourites", async () => {
    // The button says "Cleared history — favorites kept". It has to be true.
    const { result } = await mount();
    await act(async () => void (await result.current.clear()));
    expect(invokeMock).toHaveBeenCalledWith("history_clear", { includeFavorites: false });
  });

  it("re-reads afterwards", async () => {
    const { result } = await mount();
    await act(async () => void (await result.current.clear()));
    expect(lists().length).toBe(2);
  });

  it("re-reads even when the clear failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { result } = await mount();
    invokeMock.mockImplementation(async (c: string) => {
      if (c === "history_clear") return Promise.reject("locked") as never;
      return [] as never;
    });
    await act(async () => void (await result.current.clear()));
    expect(lists().length).toBe(2);
  });
});

describe("useHistory — refresh", () => {
  it("re-reads with the term currently in the box", async () => {
    const { result } = await mount();
    act(() => result.current.setSearch("orders"));
    await waitFor(() => expect(lists().length).toBe(2));
    await act(async () => void (await result.current.refresh()));
    expect(lists()[lists().length - 1][1]).toMatchObject({ search: "orders" });
  });

  it("keeps a stable identity across a search change", async () => {
    // `refresh` is a dependency of the run path and of every mutation here. A
    // new identity per keystroke would re-fire all of them.
    const { result } = await mount();
    const first = result.current.refresh;
    act(() => result.current.setSearch("x"));
    await waitFor(() => expect(lists().length).toBe(2));
    expect(result.current.refresh).toBe(first);
  });
});
