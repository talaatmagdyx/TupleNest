import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import type { CellEdit, EditTarget } from "../lib/dml";
import { useRowEdits } from "./useRowEdits";

const invokeMock = vi.mocked(invoke);

const TARGET: EditTarget = {
  schema: "public",
  table: "users",
  pk: [{ name: "id", index: 0 }],
  writable: [false, true],
};

const edit = (over: Partial<CellEdit> = {}): CellEdit => ({
  rowKey: "[1]",
  pkValues: [1],
  column: "name",
  value: "new",
  ...over,
});

const cmds = () => invokeMock.mock.calls.map((c) => c[0]);

/** Reject only the Nth invoke, leaving the rest to succeed. */
const failOn = (cmd: string, msg: string) => {
  invokeMock.mockImplementation(async (c: string) => {
    if (c === cmd) return Promise.reject(msg) as never;
    return undefined as never;
  });
};

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
});

const stage = (result: { current: ReturnType<typeof useRowEdits> }, ...es: CellEdit[]) =>
  act(() => es.forEach((e) => result.current.stage(e)));

const apply = async (result: { current: ReturnType<typeof useRowEdits> }, inTx = false, target: EditTarget | null = TARGET) => {
  let out;
  await act(async () => void (out = await result.current.apply({ target, inTx })));
  return out as unknown as Awaited<ReturnType<ReturnType<typeof useRowEdits>["apply"]>>;
};

describe("useRowEdits — staging", () => {
  it("starts with nothing staged", () => {
    const { result } = renderHook(() => useRowEdits(0));
    expect(result.current.edits).toEqual([]);
  });

  it("keeps one edit per cell — a second is a correction, not a second write", () => {
    const { result } = renderHook(() => useRowEdits(0));
    stage(result, edit({ value: "first" }), edit({ value: "second" }));
    expect(result.current.edits).toHaveLength(1);
    expect(result.current.edits[0].value).toBe("second");
  });

  it("corrects a cell in place rather than moving it down the review list", () => {
    // The review list is read top to bottom before the user approves a write.
    // Re-ordering it under them as they retype is how the wrong line gets read.
    const { result } = renderHook(() => useRowEdits(0));
    stage(result, edit({ column: "name" }), edit({ column: "email" }), edit({ column: "name", value: "fixed" }));
    expect(result.current.edits.map((e) => e.column)).toEqual(["name", "email"]);
    expect(result.current.edits[0].value).toBe("fixed");
  });

  it("keeps different cells of the same row apart", () => {
    const { result } = renderHook(() => useRowEdits(0));
    stage(result, edit({ column: "name" }), edit({ column: "email" }));
    expect(result.current.edits).toHaveLength(2);
  });

  it("keeps the same column of different rows apart", () => {
    const { result } = renderHook(() => useRowEdits(0));
    stage(result, edit({ rowKey: "[1]" }), edit({ rowKey: "[2]", pkValues: [2] }));
    expect(result.current.edits).toHaveLength(2);
  });

  it("discards everything, including a stale error", () => {
    const { result } = renderHook(() => useRowEdits(0));
    stage(result, edit());
    act(() => result.current.setReviewOpen(true));
    act(() => result.current.discard());
    expect(result.current.edits).toEqual([]);
    expect(result.current.reviewOpen).toBe(false);
    expect(result.current.applyError).toBeNull();
  });
});

describe("useRowEdits — a new result invalidates the staged set", () => {
  it("drops edits when the epoch changes", () => {
    // Row keys address the rows of the result they were made against. Carrying
    // them onto a new result would write them to whatever now sits at that key.
    const { result, rerender } = renderHook(({ e }) => useRowEdits(e), { initialProps: { e: 0 } });
    stage(result, edit());
    rerender({ e: 1 });
    expect(result.current.edits).toEqual([]);
  });

  it("closes the review with them", () => {
    const { result, rerender } = renderHook(({ e }) => useRowEdits(e), { initialProps: { e: 0 } });
    stage(result, edit());
    act(() => result.current.setReviewOpen(true));
    rerender({ e: 1 });
    expect(result.current.reviewOpen).toBe(false);
  });

  it("keeps them when the epoch has not changed", () => {
    const { result, rerender } = renderHook(({ e }) => useRowEdits(e), { initialProps: { e: 7 } });
    stage(result, edit());
    rerender({ e: 7 });
    expect(result.current.edits).toHaveLength(1);
  });
});

describe("useRowEdits — applying on its own", () => {
  it("writes inside a transaction it opens and commits", async () => {
    const { result } = renderHook(() => useRowEdits(0));
    stage(result, edit());
    const out = await apply(result);
    expect(out).toEqual({ kind: "applied", count: 1 });
    expect(cmds()).toEqual(["pg_begin", "pg_query", "pg_commit"]);
  });

  it("sends the values as parameters, not as SQL text", async () => {
    const { result } = renderHook(() => useRowEdits(0));
    stage(result, edit({ value: "Robert'); DROP TABLE users;--" }));
    await apply(result);
    const call = invokeMock.mock.calls.find((c) => c[0] === "pg_query")?.[1] as { sql: string; params: unknown[] };
    expect(call.params).toContain("Robert'); DROP TABLE users;--");
    expect(call.sql).not.toContain("DROP TABLE");
  });

  it("clears the staged set only after the commit lands", async () => {
    const { result } = renderHook(() => useRowEdits(0));
    stage(result, edit());
    await apply(result);
    expect(result.current.edits).toEqual([]);
    expect(result.current.reviewOpen).toBe(false);
  });

  it("rolls the whole set back when one statement fails", async () => {
    // All-or-nothing: a partial write leaves the grid and the table disagreeing
    // with nothing to say where it stopped.
    const { result } = renderHook(() => useRowEdits(0));
    stage(result, edit({ rowKey: "[1]" }), edit({ rowKey: "[2]", pkValues: [2] }));
    failOn("pg_query", "null value in column violates not-null constraint");
    const out = await apply(result);
    expect(out).toMatchObject({ kind: "error", message: expect.stringContaining("not-null") });
    expect(cmds()).toContain("pg_rollback");
    expect(cmds()).not.toContain("pg_commit");
  });

  it("keeps the edits staged after a failure so they can be fixed", async () => {
    const { result } = renderHook(() => useRowEdits(0));
    stage(result, edit());
    failOn("pg_query", "boom");
    await apply(result);
    expect(result.current.edits).toHaveLength(1);
    expect(result.current.applyError).toContain("boom");
  });

  it("reports the original error even when the rollback also fails", async () => {
    // The session being gone is often *why* the write failed. "rollback failed"
    // would replace the only message that explains anything.
    const { result } = renderHook(() => useRowEdits(0));
    stage(result, edit());
    invokeMock.mockImplementation(async (c: string) => {
      if (c === "pg_query") return Promise.reject("connection closed") as never;
      if (c === "pg_rollback") return Promise.reject("no connection") as never;
      return undefined as never;
    });
    const out = await apply(result);
    expect(out).toMatchObject({ kind: "error", message: expect.stringContaining("connection closed") });
    expect(result.current.applyError).toContain("connection closed");
  });

  it("does not open a transaction it cannot use", async () => {
    const { result } = renderHook(() => useRowEdits(0));
    stage(result, edit());
    failOn("pg_begin", "already in a transaction");
    const out = await apply(result);
    expect(out.kind).toBe("error");
    expect(cmds()).not.toContain("pg_query");
  });
});

describe("useRowEdits — joining the user's transaction", () => {
  it("does not open one of its own", async () => {
    const { result } = renderHook(() => useRowEdits(0));
    stage(result, edit());
    const out = await apply(result, true);
    expect(out).toEqual({ kind: "staged", count: 1 });
    expect(cmds()).toEqual(["pg_query"]);
  });

  it("never commits a transaction it did not open", async () => {
    // A COMMIT here would also commit whatever else the user had pending —
    // work we did not write and cannot see.
    const { result } = renderHook(() => useRowEdits(0));
    stage(result, edit());
    await apply(result, true);
    expect(cmds()).not.toContain("pg_commit");
  });

  it("never rolls back the user's transaction on failure", async () => {
    // Their transaction may hold work of theirs. Discarding it to clean up
    // after our failed statement destroys data we were never asked to touch.
    const { result } = renderHook(() => useRowEdits(0));
    stage(result, edit());
    failOn("pg_query", "check constraint violated");
    const out = await apply(result, true);
    expect(out.kind).toBe("error");
    expect(cmds()).not.toContain("pg_rollback");
  });
});

describe("useRowEdits — refusing", () => {
  it("writes nothing when nothing is staged", async () => {
    const { result } = renderHook(() => useRowEdits(0));
    expect(await apply(result)).toEqual({ kind: "noop" });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("writes nothing when the result maps to no single table", async () => {
    // A join or an expression column has no safe row identity to write back to.
    const { result } = renderHook(() => useRowEdits(0));
    stage(result, edit());
    expect(await apply(result, false, null)).toEqual({ kind: "noop" });
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("useRowEdits — applying flag", () => {
  it("clears however the write ends", async () => {
    const { result } = renderHook(() => useRowEdits(0));
    stage(result, edit());
    await apply(result);
    expect(result.current.applying).toBe(false);

    failOn("pg_query", "boom");
    await apply(result);
    expect(result.current.applying).toBe(false);
  });
});
