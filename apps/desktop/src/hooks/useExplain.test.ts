import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { DEFAULT_EXPLAIN, type ExplainOptions } from "../lib/explain";
import { useExplain } from "./useExplain";

const invokeMock = vi.mocked(invoke);

/** A plan the server would return for `select * from users`. */
const PLAN = [
  {
    Plan: { "Node Type": "Seq Scan", "Relation Name": "users", "Actual Total Time": 12.5, "Actual Rows": 3 },
    "Planning Time": 0.2,
    "Execution Time": 13.0,
  },
];

/** Answer pg_query with a row count, then pg_rows with the payload. */
const serve = (cell: unknown, storedRows = 1) => {
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "pg_query") return { columns: [], storedRows } as never;
    if (cmd === "pg_rows") return (Array.isArray(cell) && storedRows > 1 ? cell : [[cell]]) as never;
    throw new Error(`unexpected ${cmd}`);
  });
};

const opts = (o: Partial<ExplainOptions> = {}): ExplainOptions => ({ ...DEFAULT_EXPLAIN, ...o });

const run = async (
  result: { current: ReturnType<typeof useExplain> },
  args: Partial<Parameters<ReturnType<typeof useExplain>["run"]>[0]> = {},
) => {
  let out;
  await act(async () => {
    out = await result.current.run({ sql: "select * from users", title: "q.sql", connected: true, ...args });
  });
  return out as unknown as Awaited<ReturnType<ReturnType<typeof useExplain>["run"]>>;
};

beforeEach(() => {
  invokeMock.mockReset();
  serve(JSON.stringify(PLAN));
});

describe("useExplain — what it refuses to do", () => {
  it("does not explain nothing", async () => {
    const { result } = renderHook(() => useExplain());
    expect(await run(result, { sql: "   " })).toEqual({ kind: "blocked", reason: "empty" });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("does not explain without a connection", async () => {
    const { result } = renderHook(() => useExplain());
    expect(await run(result, { connected: false })).toEqual({ kind: "blocked", reason: "disconnected" });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("does not send a combination the server would reject", async () => {
    // TIMING without ANALYZE is an error, and the round trip only earns a
    // wall of red the panel already knows how to explain.
    const { result } = renderHook(() => useExplain());
    const out = await run(result, { override: opts({ timing: true, analyze: false }) });
    expect(out).toEqual({ kind: "blocked", reason: "options" });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("does not send an option this server is too old for", async () => {
    const { result } = renderHook(() => useExplain(15));
    expect(await run(result, { override: opts({ memory: true }) })).toEqual({ kind: "blocked", reason: "options" });
  });

  it("keeps the rejected options so the panel can show what was wrong", async () => {
    const { result } = renderHook(() => useExplain());
    await run(result, { override: opts({ timing: true }) });
    expect(result.current.opts.timing).toBe(true);
  });
});

describe("useExplain — ANALYZE is not chosen on the user's behalf", () => {
  it("turns ANALYZE on for a plain SELECT", async () => {
    const { result } = renderHook(() => useExplain());
    await run(result, { sql: "select * from users" });
    expect(invokeMock).toHaveBeenCalledWith("pg_query", { sql: expect.stringContaining("ANALYZE") });
  });

  it.each([
    ["delete from users", "delete"],
    ["update users set a = 1", "update"],
    ["insert into users values (1)", "insert"],
    ["truncate users", "truncate"],
    ["drop table users", "drop"],
  ])("leaves ANALYZE off for %s", async (sql) => {
    // EXPLAIN ANALYZE *executes* the statement. Defaulting it on here is how
    // an explain becomes a deletion.
    const { result } = renderHook(() => useExplain());
    await run(result, { sql });
    expect(invokeMock).toHaveBeenCalledWith("pg_query", { sql: expect.not.stringContaining("ANALYZE") });
    expect(result.current.opts.analyze).toBe(false);
  });

  it("still obeys an explicit ANALYZE on a DELETE — it was asked for", async () => {
    const { result } = renderHook(() => useExplain());
    await run(result, { sql: "delete from users", override: opts({ analyze: true }) });
    expect(invokeMock).toHaveBeenCalledWith("pg_query", { sql: expect.stringContaining("ANALYZE") });
  });

  it("ignores a MouseEvent handed over by onClick", async () => {
    // `onClick={run}` passes an event. It used to sail through as options and
    // throw on `.format.toUpperCase()`, so the button did nothing at all.
    const { result } = renderHook(() => useExplain());
    const out = await run(result, { override: { type: "click", clientX: 4 } });
    expect(out.kind).toBe("ok");
    expect(result.current.opts.format).toBe("json");
  });
});

describe("useExplain — onStart", () => {
  it("fires before the server is asked, so the modal can open with a spinner", async () => {
    // An EXPLAIN ANALYZE of a slow query takes as long as the query. Opening
    // the modal only on the result makes the button look broken until it lands.
    const { result } = renderHook(() => useExplain());
    const seen: string[] = [];
    invokeMock.mockImplementation(async (cmd: string) => {
      seen.push(cmd);
      return (cmd === "pg_query" ? { columns: [], storedRows: 1 } : [[JSON.stringify(PLAN)]]) as never;
    });
    await run(result, { onStart: () => seen.push("onStart") });
    expect(seen).toEqual(["onStart", "pg_query", "pg_rows"]);
  });

  it("does not fire for a run that never started", async () => {
    const { result } = renderHook(() => useExplain());
    const onStart = vi.fn();
    await run(result, { sql: "  ", onStart });
    await run(result, { connected: false, onStart });
    await run(result, { override: opts({ timing: true }), onStart });
    expect(onStart).not.toHaveBeenCalled();
  });

  it("fires for a run that starts and then fails — the modal shows the error", async () => {
    const { result } = renderHook(() => useExplain());
    const p = Promise.reject("boom");
    p.catch(() => {});
    invokeMock.mockReturnValueOnce(p);
    const onStart = vi.fn();
    await run(result, { onStart });
    expect(onStart).toHaveBeenCalledOnce();
  });
});

describe("useExplain — the plan", () => {
  it("walks a JSON plan onto the screen", async () => {
    const { result } = renderHook(() => useExplain());
    const out = await run(result);
    expect(out).toMatchObject({ kind: "ok", root: { "Execution Time": 13.0 } });
    expect(result.current.explain).toMatchObject({
      title: "q.sql",
      sql: "select * from users",
      error: null,
      nodes: [{ title: "Seq Scan on users", ms: 12.5 }],
    });
  });

  it("keeps the statement it sent, not a rebuilt guess", async () => {
    const { result } = renderHook(() => useExplain());
    await run(result);
    const sent = invokeMock.mock.calls.find((c) => c[0] === "pg_query")?.[1] as { sql: string };
    expect(result.current.explain?.statement).toBe(sent.sql);
  });

  it("asks for every row of a FORMAT TEXT plan", async () => {
    // 295 rows for a real query here — one row per line. Asking for one row
    // would keep the first line and silently drop the plan.
    const { result } = renderHook(() => useExplain());
    serve([["Seq Scan on users"], ["  Filter: (id = 1)"]], 2);
    await run(result, { override: opts({ format: "text" }) });
    expect(invokeMock).toHaveBeenCalledWith("pg_rows", { offset: 0, limit: 2 });
    expect(result.current.explain?.raw).toBe("Seq Scan on users\n  Filter: (id = 1)");
  });

  it("asks for at least one row when the server reports none", async () => {
    const { result } = renderHook(() => useExplain());
    serve(JSON.stringify(PLAN), 0);
    await run(result);
    expect(invokeMock).toHaveBeenCalledWith("pg_rows", { offset: 0, limit: 1 });
  });

  it("does not pretend a non-JSON format has a tree", async () => {
    const { result } = renderHook(() => useExplain());
    serve("- Plan:\n    Node Type: Seq Scan");
    const out = await run(result, { override: opts({ format: "yaml" }) });
    expect(out).toEqual({ kind: "ok", root: null }); // nothing to compare
    expect(result.current.explain).toMatchObject({ nodes: [], stats: [], raw: "- Plan:\n    Node Type: Seq Scan" });
  });

  it("accepts a JSON cell the driver already parsed", async () => {
    const { result } = renderHook(() => useExplain());
    serve(PLAN); // an object, not a string
    expect((await run(result)).kind).toBe("ok");
    expect(result.current.explain?.nodes).toHaveLength(1);
  });

  it("records which options produced the plan on screen", async () => {
    // The modal compares ranOpts against the live opts to mark a plan stale.
    const { result } = renderHook(() => useExplain());
    await run(result, { override: opts({ verbose: true }) });
    expect(result.current.explain?.ranOpts.verbose).toBe(true);
  });
});

describe("useExplain — failure", () => {
  it("reports the error and drops the stale tree", async () => {
    // Leaving the previous plan drawn under a fresh error invites reading it
    // as the result of the run that just failed.
    const { result } = renderHook(() => useExplain());
    await run(result);
    expect(result.current.explain?.nodes).toHaveLength(1);

    invokeMock.mockReset();
    const p = Promise.reject("relation \"nope\" does not exist");
    p.catch(() => {});
    invokeMock.mockReturnValueOnce(p);
    const out = await run(result, { sql: "select * from nope" });

    expect(out).toMatchObject({ kind: "error", message: expect.stringContaining("does not exist") });
    expect(result.current.explain?.error).toContain("does not exist");
    expect(result.current.explain?.nodes).toEqual([]);
  });

  it("survives a payload that isn't the JSON it claimed", async () => {
    const { result } = renderHook(() => useExplain());
    serve("not json at all");
    const out = await run(result);
    expect(out.kind).toBe("error");
    expect(result.current.explain?.error).toBeTruthy();
  });

  it("clears busy however the run ends", async () => {
    const { result } = renderHook(() => useExplain());
    serve("not json");
    await run(result);
    expect(result.current.busy).toBe(false);
  });
});
