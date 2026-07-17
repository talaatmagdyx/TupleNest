import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useSearch } from "./useSearch";

const invokeMock = vi.mocked(invoke);
beforeEach(() => invokeMock.mockReset());

const hits = (...names: string[]) => ({
  payload: {
    items: names.map((name) => ({ schema: "public", name, kind: "table", column: "" })),
    truncated: false,
  },
});

/** A promise the test decides when to settle, so races can be staged. */
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

describe("useSearch — querying", () => {
  it("starts empty and idle", () => {
    const { result } = renderHook(() => useSearch());
    expect(result.current.results).toBeNull();
    expect(result.current.busy).toBe(false);
  });

  it("asks the backend and keeps the results", async () => {
    invokeMock.mockResolvedValue(hits("users"));
    const { result } = renderHook(() => useSearch());
    await act(() => result.current.run("users"));
    expect(invokeMock).toHaveBeenCalledWith("pg_metadata", {
      request: { kind: "search_objects", term: "users", limit: 200 },
    });
    expect(result.current.results?.items).toHaveLength(1);
  });

  it("trims the term before sending it", async () => {
    invokeMock.mockResolvedValue(hits("users"));
    const { result } = renderHook(() => useSearch());
    await act(() => result.current.run("  users  "));
    expect(invokeMock).toHaveBeenCalledWith(
      "pg_metadata",
      expect.objectContaining({ request: expect.objectContaining({ term: "users" }) }),
    );
  });

  it("does not search a term too short to be meaningful", async () => {
    const { result } = renderHook(() => useSearch());
    await act(() => result.current.run("u"));
    expect(invokeMock).not.toHaveBeenCalled();
    expect(result.current.results).toBeNull();
  });

  it("clears results when the box is emptied rather than leaving stale hits", async () => {
    invokeMock.mockResolvedValue(hits("users"));
    const { result } = renderHook(() => useSearch());
    await act(() => result.current.run("users"));
    await act(() => result.current.run(""));
    expect(result.current.results).toBeNull();
  });

  it("reports a failure", async () => {
    // `mockReturnValueOnce` with a pre-caught rejection: a `mockReturnValue`
    // that stays armed leaves the same rejected promise attached to the mock
    // after the test, and the runtime reports it as unhandled.
    const rejected = Promise.reject(new Error("relation does not exist"));
    rejected.catch(() => {});
    invokeMock.mockReturnValueOnce(rejected);
    const { result } = renderHook(() => useSearch());
    await act(() => result.current.run("users"));
    expect(result.current.error).toContain("relation does not exist");
    expect(result.current.busy).toBe(false);
  });

  it("clears a previous error on the next search", async () => {
    const rejected = Promise.reject(new Error("boom"));
    rejected.catch(() => {});
    invokeMock.mockReturnValueOnce(rejected).mockResolvedValue(hits("users"));
    const { result } = renderHook(() => useSearch());
    await act(() => result.current.run("users"));
    expect(result.current.error).not.toBeNull();
    await act(() => result.current.run("orders"));
    expect(result.current.error).toBeNull();
  });
});

describe("useSearch — races", () => {
  it("ignores a slow answer that lands after a newer one", async () => {
    // The whole reason the sequence number exists: type "eng", then "eng_int";
    // if the first query is slower, its results must not overwrite the second.
    const slow = deferred<unknown>();
    const fast = deferred<unknown>();
    invokeMock.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);

    const { result } = renderHook(() => useSearch());
    act(() => void result.current.run("eng"));
    act(() => void result.current.run("eng_int"));

    await act(async () => {
      fast.resolve(hits("messages"));
      await fast.promise;
    });
    expect(result.current.results?.items[0].name).toBe("messages");

    await act(async () => {
      slow.resolve(hits("eng_stale"));
      await slow.promise;
    });
    // Still the newer answer.
    expect(result.current.results?.items[0].name).toBe("messages");
  });

  it("does not clear busy when a stale search finishes", async () => {
    const slow = deferred<unknown>();
    const pending = deferred<unknown>();
    invokeMock.mockReturnValueOnce(slow.promise).mockReturnValueOnce(pending.promise);

    const { result } = renderHook(() => useSearch());
    act(() => void result.current.run("eng"));
    act(() => void result.current.run("eng_int"));

    await act(async () => {
      slow.resolve(hits("stale"));
      await slow.promise;
    });
    // The newer search is still running, so the spinner must stay.
    expect(result.current.busy).toBe(true);

    await act(async () => {
      pending.resolve(hits("fresh"));
      await pending.promise;
    });
    expect(result.current.busy).toBe(false);
  });

  it("does not surface an error from a search that has been superseded", async () => {
    const stale = deferred<unknown>();
    const fresh = deferred<unknown>();
    invokeMock.mockReturnValueOnce(stale.promise as never).mockReturnValueOnce(fresh.promise);
    const { result } = renderHook(() => useSearch());
    act(() => void result.current.run("eng"));
    act(() => void result.current.run("eng_int"));

    await act(async () => {
      fresh.resolve(hits("messages"));
      await fresh.promise;
    });
    expect(result.current.error).toBeNull();
    expect(result.current.results?.items[0].name).toBe("messages");
  });

  it("abandons an in-flight search on reset", async () => {
    // Reopening the palette must not be interrupted by the last one's answer.
    const inflight = deferred<unknown>();
    invokeMock.mockReturnValue(inflight.promise);
    const { result } = renderHook(() => useSearch());
    act(() => void result.current.run("eng"));
    act(() => result.current.reset());

    await act(async () => {
      inflight.resolve(hits("late"));
      await inflight.promise;
    });
    expect(result.current.results).toBeNull();
    expect(result.current.busy).toBe(false);
  });
});
