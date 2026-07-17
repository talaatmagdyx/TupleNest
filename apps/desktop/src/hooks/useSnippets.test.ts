import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import type { SnippetRecord } from "../ipc/types";
import { suggestName, useSnippets } from "./useSnippets";

const invokeMock = vi.mocked(invoke);
const snip = (over: Partial<SnippetRecord> = {}): SnippetRecord =>
  ({ id: "1", name: "s", body: "select 1", tags: null, ...over });

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue([]);
});

const save = async (result: { current: ReturnType<typeof useSnippets> }, args: Parameters<ReturnType<typeof useSnippets>["save"]>[0]) => {
  let out;
  await act(async () => void (out = await result.current.save(args)));
  return out as unknown as Awaited<ReturnType<ReturnType<typeof useSnippets>["save"]>>;
};

describe("suggestName", () => {
  it("collapses the query onto one line", () => {
    expect(suggestName("select *\n  from users\n  where id = 1")).toBe("select * from users where id = 1");
  });

  it("truncates a long query", () => {
    expect(suggestName("x".repeat(100))).toHaveLength(40);
  });

  it("trims the ragged edge left by truncation", () => {
    expect(suggestName("select a from t", 9)).toBe("select a");
  });

  it("has nothing to suggest for whitespace", () => {
    expect(suggestName("   \n\t ")).toBe("");
  });
});

describe("useSnippets", () => {
  it("does not read the store until asked", () => {
    // The library is only opened from the palette; loading it on mount costs
    // a read on every app start for a panel most sessions never open.
    renderHook(() => useSnippets());
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("loads the list", async () => {
    invokeMock.mockResolvedValue([snip(), snip({ id: "2" })]);
    const { result } = renderHook(() => useSnippets());
    await act(async () => void (await result.current.refresh()));
    expect(result.current.items).toHaveLength(2);
  });

  it("keeps the last list when the read fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    invokeMock.mockResolvedValue([snip()]);
    const { result } = renderHook(() => useSnippets());
    await act(async () => void (await result.current.refresh()));

    const p = Promise.reject("store locked");
    p.catch(() => {});
    invokeMock.mockReturnValueOnce(p);
    await act(async () => void (await result.current.refresh()));
    expect(result.current.items).toHaveLength(1);
  });

  it("saves a new snippet with a null id", async () => {
    const { result } = renderHook(() => useSnippets());
    expect(await save(result, { name: "recent users", body: "select 1" })).toEqual({ ok: true });
    expect(invokeMock).toHaveBeenCalledWith("snippet_save", {
      id: null,
      name: "recent users",
      body: "select 1",
      tags: null,
    });
  });

  it("overwrites when given an id", async () => {
    const { result } = renderHook(() => useSnippets());
    await save(result, { id: "5", name: "n", body: "b" });
    expect(invokeMock).toHaveBeenCalledWith("snippet_save", { id: "5", name: "n", body: "b", tags: null });
  });

  it("re-reads after a save rather than patching the list", async () => {
    // The store assigns the id. A locally-appended row has none, and the next
    // edit of it would save a second copy.
    const { result } = renderHook(() => useSnippets());
    invokeMock.mockImplementation(async (c: string) => (c === "snippet_list" ? [snip({ id: "9" })] : undefined) as never);
    await save(result, { name: "n", body: "b" });
    expect(result.current.items.map((s) => s.id)).toEqual(["9"]);
  });

  it("reports a failed save instead of claiming it landed", async () => {
    const { result } = renderHook(() => useSnippets());
    const p = Promise.reject("UNIQUE constraint failed: snippets.name");
    p.catch(() => {});
    invokeMock.mockReturnValueOnce(p);
    const out = await save(result, { name: "dupe", body: "b" });
    expect(out).toMatchObject({ ok: false, message: expect.stringContaining("UNIQUE") });
  });

  it("does not re-read after a failed save", async () => {
    const { result } = renderHook(() => useSnippets());
    const p = Promise.reject("nope");
    p.catch(() => {});
    invokeMock.mockReturnValueOnce(p);
    await save(result, { name: "n", body: "b" });
    expect(invokeMock.mock.calls.filter((c) => c[0] === "snippet_list")).toHaveLength(0);
  });
});
