import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useTransaction } from "./useTransaction";

const invokeMock = vi.mocked(invoke);
beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

const failOnce = (msg: string) => {
  const p = Promise.reject(msg);
  p.catch(() => {});
  invokeMock.mockReturnValueOnce(p);
};

/** Open a transaction and assert it took, so later steps start from truth. */
const open = async (result: { current: ReturnType<typeof useTransaction> }) => {
  await act(async () => void (await result.current.begin()));
  expect(result.current.inTx).toBe(true);
};

describe("useTransaction — begin", () => {
  it("starts with none open", () => {
    const { result } = renderHook(() => useTransaction());
    expect(result.current.inTx).toBe(false);
    expect(result.current.openSince).toBeNull();
  });

  it("opens one and stamps the time", async () => {
    vi.useFakeTimers().setSystemTime(new Date("2026-07-16T00:00:00Z"));
    const { result } = renderHook(() => useTransaction());
    await act(async () => void (await result.current.begin()));
    expect(invokeMock).toHaveBeenCalledWith("pg_begin");
    expect(result.current.inTx).toBe(true);
    expect(result.current.openSince).toBe(Date.parse("2026-07-16T00:00:00Z"));
  });

  it("claims nothing when BEGIN fails", async () => {
    // Claiming an open transaction that does not exist arms the close prompt
    // for nothing and shows a timer counting up from a lie.
    failOnce("cannot begin: already in transaction");
    const { result } = renderHook(() => useTransaction());
    let out;
    await act(async () => void (out = await result.current.begin()));
    expect(out).toMatchObject({ ok: false });
    expect(result.current.inTx).toBe(false);
    expect(result.current.openSince).toBeNull();
  });
});

describe("useTransaction — commit", () => {
  it("closes the transaction", async () => {
    const { result } = renderHook(() => useTransaction());
    await open(result);
    let out;
    await act(async () => void (out = await result.current.commit()));
    expect(invokeMock).toHaveBeenCalledWith("pg_commit");
    expect(out).toEqual({ ok: true });
    expect(result.current.inTx).toBe(false);
    expect(result.current.openSince).toBeNull();
  });

  it("keeps the transaction open when COMMIT fails", async () => {
    // The one that matters. A COMMIT that failed did not commit — the
    // transaction is still open on the server. Clearing the flag here is how
    // someone comes to believe their write landed when it did not.
    const { result } = renderHook(() => useTransaction());
    await open(result);
    failOnce("could not serialize access due to concurrent update");
    let out;
    await act(async () => void (out = await result.current.commit()));
    expect(out).toMatchObject({ ok: false, message: expect.stringContaining("serialize") });
    expect(result.current.inTx).toBe(true);
    expect(result.current.openSince).not.toBeNull();
  });

  it("can be retried after a failure", async () => {
    const { result } = renderHook(() => useTransaction());
    await open(result);
    failOnce("deadlock detected");
    await act(async () => void (await result.current.commit()));
    expect(result.current.inTx).toBe(true);
    await act(async () => void (await result.current.commit()));
    expect(result.current.inTx).toBe(false);
  });
});

describe("useTransaction — rollback", () => {
  it("closes the transaction", async () => {
    const { result } = renderHook(() => useTransaction());
    await open(result);
    let out;
    await act(async () => void (out = await result.current.rollback()));
    expect(invokeMock).toHaveBeenCalledWith("pg_rollback");
    expect(out).toEqual({ ok: true });
    expect(result.current.inTx).toBe(false);
  });

  it("keeps the flag set when ROLLBACK fails", async () => {
    // Same reasoning as commit: the flag describes the server, and the server
    // did not say the transaction ended.
    const { result } = renderHook(() => useTransaction());
    await open(result);
    failOnce("connection is closed");
    await act(async () => void (await result.current.rollback()));
    expect(result.current.inTx).toBe(true);
  });

  it("rolls back rather than commits — they are not interchangeable", async () => {
    const { result } = renderHook(() => useTransaction());
    await open(result);
    invokeMock.mockClear();
    await act(async () => void (await result.current.rollback()));
    expect(invokeMock).toHaveBeenCalledWith("pg_rollback");
    expect(invokeMock).not.toHaveBeenCalledWith("pg_commit");
  });
});

describe("useTransaction — forget", () => {
  it("clears the flag when the session is gone", async () => {
    // A dropped connection took the transaction with it. This is the only
    // case where the flag may be cleared without the server saying so —
    // there is no server left to say anything.
    const { result } = renderHook(() => useTransaction());
    await open(result);
    act(() => result.current.forget());
    expect(result.current.inTx).toBe(false);
    expect(result.current.openSince).toBeNull();
  });

  it("sends nothing — there is nobody listening", async () => {
    const { result } = renderHook(() => useTransaction());
    await open(result);
    invokeMock.mockClear();
    act(() => result.current.forget());
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
