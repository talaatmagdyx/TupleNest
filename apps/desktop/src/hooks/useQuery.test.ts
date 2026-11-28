import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { announceText, isCancelled, isConnectionLost, isFixableError, statusText, useQuery } from "./useQuery";
import type { QueryResult } from "../ipc/types";

const invokeMock = vi.mocked(invoke);
beforeEach(() => invokeMock.mockReset());

const res = (over: Partial<QueryResult> = {}): QueryResult =>
  ({
    columns: [{ name: "id", dbType: "int8" }],
    storedRows: 2,
    totalRows: 2,
    rowsAffected: null,
    elapsedMs: 12,
    truncated: false,
    ...over,
  }) as QueryResult;

/** A rejection that is handled at creation, and armed for one call only.
 *
 *  Rejects with a plain string, because that is what Tauri does: a command
 *  returning `Err(String)` rejects with the string itself, not an Error.
 *  Wrapping it in `new Error` makes `String(e)` read "Error: …" and quietly
 *  defeats any prefix check the code does. */
const failOnce = (msg: string) => {
  const p = Promise.reject(msg);
  p.catch(() => {});
  invokeMock.mockReturnValueOnce(p);
};

const dev = { env: "dev" as string | null };

describe("isFixableError — only real SQL errors from the engine", () => {
  it("offers a fix for syntax errors and undefined columns", () => {
    expect(isFixableError('Syntax error [SQLSTATE 42601]\nsyntax error at or near "selec"')).toBe(true);
    expect(isFixableError('Undefined column [SQLSTATE 42703]\ncolumn "totl" does not exist')).toBe(true);
    expect(isFixableError("SQL error [SQLITE_ERROR]\nno such column: totl")).toBe(true);
  });

  it("does not for the app's refusals, cancels, read-only modes or a lost connection", () => {
    for (const m of [
      "INSERT is refused on a read-only connection: only statements that read are sent. Nothing was run.",
      "DO blocks and CALL are refused on a read-only connection. Nothing was run.",
      "Refused by the production guard: UPDATE without WHERE.",
      "Query cancelled [SQLSTATE 57014]",
      "Error: Query cancelled",
      "Read-only transaction [SQLSTATE 25006]\ncannot execute INSERT in a read-only transaction",
      "Connection lost: Network error [SQLSTATE 08006] — the session was closed.",
      "Connection failure [SQLSTATE 08001]",
      "Read-only database [SQLITE_READONLY]",
      "Interrupted [SQLITE_INTERRUPT]",
      "",
    ]) {
      expect(isFixableError(m), m).toBe(false);
    }
    expect(isFixableError(null)).toBe(false);
  });
});

describe("statusText", () => {
  it("counts rows and time for a select", () => {
    expect(statusText(res({ totalRows: 1234 }))).toBe("1,234 row(s) in 12ms");
  });

  it("says how much was kept when the result was truncated", () => {
    // The grid holds fewer rows than the query returned; not saying so makes
    // the row count and the scrollbar silently disagree.
    expect(statusText(res({ totalRows: 5000, storedRows: 100, truncated: true }))).toBe(
      "5,000 row(s) in 12ms (first 100 kept for scrolling)",
    );
  });

  it("gives a lower bound when the backend stopped reading at the limit", () => {
    expect(
      statusText(res({ totalRows: 20_000, storedRows: 20_000, truncated: true, totalKnown: false })),
    ).toBe("20,000+ row(s) in 12ms (stopped at the limit) (first 20,000 kept for scrolling)");
  });

  it("reports rows affected for a write, which returns no columns", () => {
    expect(statusText(res({ columns: [], rowsAffected: 7 }))).toBe("7 row(s) affected in 12ms");
  });

  it("says zero rather than nothing when a write affected none", () => {
    expect(statusText(res({ columns: [], rowsAffected: null }))).toBe("0 row(s) affected in 12ms");
  });
});

describe("useQuery — refusing to run", () => {
  it("does nothing for empty sql", async () => {
    const { result } = renderHook(() => useQuery());
    let out;
    await act(async () => void (out = await result.current.run("   ", dev)));
    expect(out).toEqual({ kind: "blocked", reason: "empty" });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("asks for confirmation before a prod UPDATE with no WHERE", async () => {
    const { result } = renderHook(() => useQuery());
    let out;
    await act(async () => void (out = await result.current.run("update t set a=1", { env: "prod" })));
    expect(out).toEqual({ kind: "needs-guard" });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("runs it once the user has confirmed", async () => {
    invokeMock.mockResolvedValue(res());
    const { result } = renderHook(() => useQuery());
    let out;
    await act(async () => {
      out = await result.current.run("update t set a=1", { env: "prod", force: true });
    });
    expect(out).toMatchObject({ kind: "ok" });
  });

  it("guards a write with no WHERE off prod too, and only that (TN-034)", async () => {
    invokeMock.mockResolvedValue(res());
    const { result } = renderHook(() => useQuery());
    let out;
    await act(async () => void (out = await result.current.run("update t set a=1", dev)));
    expect(out).toMatchObject({ kind: "needs-guard" });
    await act(async () => void (out = await result.current.run("alter table t add column c int", dev)));
    expect(out).toMatchObject({ kind: "ok" });
  });

  it("asks for placeholder values before running", async () => {
    const { result } = renderHook(() => useQuery());
    let out;
    await act(async () => void (out = await result.current.run("select $1, $2", dev)));
    expect(out).toEqual({ kind: "needs-params", count: 2 });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("runs once the values are supplied, including an empty list", async () => {
    invokeMock.mockResolvedValue(res());
    const { result } = renderHook(() => useQuery());
    await act(async () => {
      await result.current.run("select $1", { ...dev, params: [42] });
    });
    expect(invokeMock).toHaveBeenCalledWith("pg_query", { sql: "select $1", params: [42] });
  });

  it("guards before it asks for parameters", async () => {
    // "Do you mean to touch every row?" has to be answered before we go
    // hunting for placeholders to bind.
    const { result } = renderHook(() => useQuery());
    let out;
    await act(async () => {
      out = await result.current.run("delete from t -- $1", { env: "prod" });
    });
    expect(out).toEqual({ kind: "needs-guard" });
  });
});

describe("useQuery — running", () => {
  it("sends the sql with no params when there are none", async () => {
    invokeMock.mockResolvedValue(res());
    const { result } = renderHook(() => useQuery());
    await act(async () => void (await result.current.run("select 1", dev)));
    expect(invokeMock).toHaveBeenCalledWith("pg_query", { sql: "select 1", params: null });
  });

  it("keeps the result, the sql that produced it, and a status", async () => {
    invokeMock.mockResolvedValue(res());
    const { result } = renderHook(() => useQuery());
    await act(async () => void (await result.current.run("select 1", dev)));
    expect(result.current.result).not.toBeNull();
    expect(result.current.ranSql).toBe("select 1");
    expect(result.current.status).toMatchObject({ icon: "✓" });
    expect(result.current.lastError).toBeNull();
  });

  it("bumps the epoch per result so the grid drops its state", async () => {
    invokeMock.mockResolvedValue(res());
    const { result } = renderHook(() => useQuery());
    const before = result.current.epoch;
    await act(async () => void (await result.current.run("select 1", dev)));
    await act(async () => void (await result.current.run("select 2", dev)));
    expect(result.current.epoch).toBe(before + 2);
  });

  it("does not bump the epoch for a run that never happened", async () => {
    const { result } = renderHook(() => useQuery());
    const before = result.current.epoch;
    await act(async () => void (await result.current.run("", dev)));
    expect(result.current.epoch).toBe(before);
  });

  it("clears the running flag when it finishes", async () => {
    invokeMock.mockResolvedValue(res());
    const { result } = renderHook(() => useQuery());
    await act(async () => void (await result.current.run("select 1", dev)));
    expect(result.current.running).toBe(false);
  });
});

describe("useQuery — failures", () => {
  it("reports the error", async () => {
    failOnce("syntax error at or near");
    const { result } = renderHook(() => useQuery());
    let out;
    await act(async () => void (out = await result.current.run("selct 1", dev)));
    expect(out).toMatchObject({ kind: "error", connectionLost: false });
    expect(result.current.lastError).toContain("syntax error");
    expect(result.current.status).toMatchObject({ icon: "✕" });
  });

  it("keeps the full multi-line report in lastError, only the title in the status bar", async () => {
    // The backend's contract: line one is the short title, everything under
    // it is the server's report (Detail, Hint, constraint names). The status
    // bar is one line tall; the error box is where the rest belongs. Losing
    // the report here is how "Database error" became a bug report.
    const full =
      'Constraint violation [SQLSTATE 23505]\n' +
      'duplicate key value violates unique constraint "books_pkey"\n' +
      'Detail: Key (id)=(1) already exists.\n' +
      'On: table "books", constraint "books_pkey"';
    failOnce(full);
    const { result } = renderHook(() => useQuery());
    await act(async () => void (await result.current.run("insert…", dev)));
    expect(result.current.lastError).toContain("Detail: Key (id)=(1) already exists.");
    expect(result.current.lastError).toContain('constraint "books_pkey"');
    expect(result.current.status?.text).toBe("Constraint violation [SQLSTATE 23505]");
    expect(result.current.status?.text).not.toContain("\n");
  });

  it("drops the previous result rather than showing it next to an error", async () => {
    // Otherwise the old rows sit under a red banner, reading as though they
    // are what the failed query returned.
    invokeMock.mockResolvedValueOnce(res());
    const { result } = renderHook(() => useQuery());
    await act(async () => void (await result.current.run("select 1", dev)));
    expect(result.current.result).not.toBeNull();

    failOnce("boom");
    await act(async () => void (await result.current.run("selct 1", dev)));
    expect(result.current.result).toBeNull();
  });

  it("flags a lost connection so the caller can offer to reconnect", async () => {
    failOnce("Connection lost: server closed the connection unexpectedly");
    const { result } = renderHook(() => useQuery());
    let out;
    await act(async () => void (out = await result.current.run("select 1", dev)));
    expect(out).toMatchObject({ kind: "error", connectionLost: true });
  });

  it("does not mistake an ordinary error mentioning connections for a lost one", async () => {
    failOnce('relation "connection lost" does not exist');
    const { result } = renderHook(() => useQuery());
    let out;
    await act(async () => void (out = await result.current.run("select 1", dev)));
    expect(out).toMatchObject({ connectionLost: false });
  });

  it("clears the running flag after a failure", async () => {
    failOnce("boom");
    const { result } = renderHook(() => useQuery());
    await act(async () => void (await result.current.run("select 1", dev)));
    expect(result.current.running).toBe(false);
  });

  it("clears a previous error on the next successful run", async () => {
    failOnce("boom");
    const { result } = renderHook(() => useQuery());
    await act(async () => void (await result.current.run("select 1", dev)));
    invokeMock.mockResolvedValue(res());
    await act(async () => void (await result.current.run("select 1", dev)));
    expect(result.current.lastError).toBeNull();
  });
});

describe("useQuery — cancel and reset", () => {
  it("asks the backend to cancel", async () => {
    invokeMock.mockResolvedValue(undefined);
    const { result } = renderHook(() => useQuery());
    await act(() => result.current.cancel());
    expect(invokeMock).toHaveBeenCalledWith("pg_cancel");
  });

  it("swallows a cancel that had nothing to cancel", async () => {
    failOnce("no query running");
    const { result } = renderHook(() => useQuery());
    await expect(act(() => result.current.cancel())).resolves.not.toThrow();
  });

  it("clears everything on reset", async () => {
    invokeMock.mockResolvedValue(res());
    const { result } = renderHook(() => useQuery());
    await act(async () => void (await result.current.run("select 1", dev)));
    act(() => result.current.reset());
    expect(result.current.result).toBeNull();
    expect(result.current.status).toBeNull();
    expect(result.current.ranSql).toBe("");
    expect(result.current.lastError).toBeNull();
  });

  it("starts a new epoch on reset, so edits staged on the old result are dropped", async () => {
    // TN-007: staged edits are keyed to the epoch. A reset that kept it let
    // them survive a connection switch.
    invokeMock.mockResolvedValue(res());
    const { result } = renderHook(() => useQuery());
    await act(async () => void (await result.current.run("select 1", dev)));
    const before = result.current.epoch;
    act(() => result.current.reset());
    expect(result.current.epoch).not.toBe(before);
  });
});

describe("isConnectionLost", () => {
  it("recognises the backend's own message", () => {
    expect(isConnectionLost("Connection lost: server closed the connection")).toBe(true);
  });

  it("recognises it through an Error wrapper", () => {
    // Tauri rejects with a bare string today, but a thrown Error anywhere in
    // the chain would stringify to "Error: …" and otherwise slip past — and
    // the cost of missing it is claiming to be connected to a dead server.
    expect(isConnectionLost("Error: Connection lost: server closed")).toBe(true);
  });

  it("does not fire on an ordinary error that merely mentions it", () => {
    expect(isConnectionLost('relation "connection lost" does not exist')).toBe(false);
    expect(isConnectionLost("syntax error at or near")).toBe(false);
  });

  it("does not fire on a message that only contains the phrase later on", () => {
    expect(isConnectionLost("hint: Connection lost: is a prefix, not a substring")).toBe(false);
  });
});

describe("useQuery — one query at a time, and never a stale one", () => {
  /** A pg_query that stays pending until `finish` is called. */
  const pending = () => {
    let finish!: (r: QueryResult) => void;
    invokeMock.mockReturnValueOnce(new Promise<QueryResult>((r) => (finish = r)) as never);
    return (r: QueryResult) => finish(r);
  };

  it("refuses a second run while one is in flight", async () => {
    // Cmd+Enter during a query used to start a second pg_query; whichever
    // finished last won, and the first one's finish cleared the spinner.
    const { result } = renderHook(() => useQuery());
    const finish = pending();
    let first!: Promise<unknown>;
    act(() => void (first = result.current.run("select 1", dev)));
    let second;
    await act(async () => void (second = await result.current.run("select 2", dev)));
    expect(second).toEqual({ kind: "blocked", reason: "busy" });
    expect(invokeMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish(res());
      await first;
    });
    expect(result.current.running).toBe(false);
  });

  it("drops a result that arrives after reset (disconnect or switch)", async () => {
    // The old session's late result used to be painted under the new
    // connection's name.
    const { result } = renderHook(() => useQuery());
    const finish = pending();
    let first!: Promise<unknown>;
    act(() => void (first = result.current.run("select 1", dev)));
    act(() => result.current.reset());
    let out;
    await act(async () => {
      finish(res({ totalRows: 99 }));
      out = await first;
    });
    expect(out).toEqual({ kind: "blocked", reason: "stale" });
    expect(result.current.result).toBeNull();
    expect(result.current.running).toBe(false);
  });
});

describe("announceText", () => {
  it("counts rows, singular and plural, with separators", () => {
    expect(announceText({ result: res({ totalRows: 42 }) })).toBe("42 rows");
    expect(announceText({ result: res({ totalRows: 1 }) })).toBe("1 row");
    expect(announceText({ result: res({ totalRows: 12345 }) })).toBe("12,345 rows");
    expect(announceText({ result: res({ totalRows: 20_000, totalKnown: false }) })).toBe("20,000+ rows");
    expect(announceText({ result: res({ totalRows: 1, totalKnown: false }) })).toBe("1+ rows");
  });

  it("counts rows affected for a statement with no columns", () => {
    expect(announceText({ result: res({ columns: [], rowsAffected: 3 }) })).toBe("3 rows affected");
    expect(announceText({ result: res({ columns: [], rowsAffected: 1 }) })).toBe("1 row affected");
    expect(announceText({ result: res({ columns: [], rowsAffected: null }) })).toBe("0 rows affected");
  });

  it("gives an error's title line only", () => {
    expect(announceText({ error: 'relation "nope" does not exist [SQLSTATE 42P01]\nDETAIL: …' })).toBe(
      'Error: relation "nope" does not exist [SQLSTATE 42P01]',
    );
  });

  it("says a cancelled statement was cancelled, not that it failed", () => {
    expect(announceText({ error: "Query cancelled [SQLSTATE 57014]\nThe operation was cancelled." })).toBe("Cancelled");
    expect(isCancelled("Error: Query cancelled")).toBe(true);
    expect(isCancelled("Statement timed out [SQLSTATE 57014]")).toBe(false);
  });
});

describe("useQuery — announcement", () => {
  it("starts silent", () => {
    const { result } = renderHook(() => useQuery());
    expect(result.current.announcement).toBeNull();
  });

  it("announces each run once, with a fresh key even when the words repeat", async () => {
    const { result } = renderHook(() => useQuery());
    invokeMock.mockResolvedValueOnce(res({ totalRows: 42 }));
    await act(async () => void (await result.current.run("select 1", dev)));
    const first = result.current.announcement!;
    expect(first.text).toBe("42 rows");
    invokeMock.mockResolvedValueOnce(res({ totalRows: 42 }));
    await act(async () => void (await result.current.run("select 1", dev)));
    expect(result.current.announcement!.text).toBe("42 rows");
    expect(result.current.announcement!.n).not.toBe(first.n);
  });

  it("announces an error and a cancellation", async () => {
    const { result } = renderHook(() => useQuery());
    failOnce("syntax error at or near \"selec\"\nLINE 1");
    await act(async () => void (await result.current.run("selec 1", dev)));
    expect(result.current.announcement!.text).toBe('Error: syntax error at or near "selec"');
    failOnce("Query cancelled [SQLSTATE 57014]");
    await act(async () => void (await result.current.run("select pg_sleep(9)", dev)));
    expect(result.current.announcement!.text).toBe("Cancelled");
  });

  it("goes quiet on reset, so a new session does not inherit the last outcome", async () => {
    const { result } = renderHook(() => useQuery());
    invokeMock.mockResolvedValueOnce(res());
    await act(async () => void (await result.current.run("select 1", dev)));
    act(() => result.current.reset());
    expect(result.current.announcement).toBeNull();
  });
});
