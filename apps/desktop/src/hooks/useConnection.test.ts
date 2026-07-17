import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import type { PgParams, TestReport, TestStage } from "../ipc/types";
import { STAGE_REVEAL_MS, useConnection } from "./useConnection";

const invokeMock = vi.mocked(invoke);

const PARAMS = {
  host: "localhost",
  port: 5432,
  database: "appdb",
  username: "appuser",
  secretRef: null,
  tlsMode: "verify-full",
  tlsCaPath: null,
} as unknown as PgParams;

const stage = (name: string, passed = true): TestStage => ({ name, passed }) as TestStage;

const report = (stages: TestStage[], serverVersion: string | null = "18.0"): TestReport =>
  ({ stages, serverVersion }) as TestReport;

const failOnce = (msg: string) => {
  const p = Promise.reject(msg);
  p.catch(() => {});
  invokeMock.mockReturnValueOnce(p);
};

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

const connect = async (result: { current: ReturnType<typeof useConnection> }, env = "dev") => {
  let out;
  await act(async () => void (out = await result.current.connect(PARAMS, env)));
  return out as unknown as Awaited<ReturnType<ReturnType<typeof useConnection>["connect"]>>;
};

describe("useConnection — connecting", () => {
  it("starts with no session", () => {
    const { result } = renderHook(() => useConnection());
    expect(result.current.connected).toBe(false);
    expect(result.current.connectedEnv).toBeNull();
  });

  it("opens a session and records its environment", async () => {
    const { result } = renderHook(() => useConnection());
    expect(await connect(result, "prod")).toEqual({ ok: true });
    expect(invokeMock).toHaveBeenCalledWith("pg_connect", { params: PARAMS });
    expect(result.current.connected).toBe(true);
    expect(result.current.connectedEnv).toBe("prod");
    expect(result.current.status).toBe("Connected");
  });

  it("claims nothing when the connection fails", async () => {
    // `connectedEnv` arms the prod banner and `connected` arms the run guard.
    // Setting either here describes a session that does not exist.
    const { result } = renderHook(() => useConnection());
    failOnce("password authentication failed");
    const out = await connect(result, "prod");
    expect(out).toMatchObject({ ok: false, message: expect.stringContaining("authentication") });
    expect(result.current.connected).toBe(false);
    expect(result.current.connectedEnv).toBeNull();
    expect(result.current.status).toContain("authentication");
  });

  it("reads the server version once connected", async () => {
    const { result } = renderHook(() => useConnection());
    invokeMock.mockImplementation(async (cmd: string) =>
      (cmd === "pg_metadata" ? { payload: { version: "PostgreSQL 18.0 on aarch64-apple-darwin" } } : undefined) as never,
    );
    await connect(result);
    expect(result.current.serverVersion).toBe("18.0");
  });

  it("stays connected when the version cannot be read", async () => {
    // Only the version chip depends on it. A session that works but cannot
    // report its version is still a session.
    const { result } = renderHook(() => useConnection());
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "pg_metadata") throw new Error("permission denied");
      return undefined as never;
    });
    await connect(result);
    expect(result.current.connected).toBe(true);
    expect(result.current.serverVersion).toBeNull();
  });

  it("reports no version rather than a wrong one for an unparseable banner", async () => {
    const { result } = renderHook(() => useConnection());
    invokeMock.mockImplementation(async (cmd: string) =>
      (cmd === "pg_metadata" ? { payload: { version: "CockroachDB CCL v23" } } : undefined) as never,
    );
    await connect(result);
    expect(result.current.serverVersion).toBeNull();
  });
});

describe("useConnection — disconnecting", () => {
  it("closes the session and forgets it", async () => {
    const { result } = renderHook(() => useConnection());
    await connect(result, "prod");
    await act(async () => void (await result.current.disconnect()));
    expect(invokeMock).toHaveBeenCalledWith("pg_disconnect");
    expect(result.current.connected).toBe(false);
    expect(result.current.connectedEnv).toBeNull();
    expect(result.current.serverVersion).toBeNull();
    expect(result.current.status).toBe("Disconnected");
  });

  it("comes down even when the server cannot be told", async () => {
    // An unreachable session is the usual reason to be disconnecting. Leaving
    // `connected` set because the goodbye failed strands the whole UI.
    const { result } = renderHook(() => useConnection());
    await connect(result);
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "pg_disconnect") throw new Error("broken pipe");
      return undefined as never;
    });
    await act(async () => void (await result.current.disconnect()));
    expect(result.current.connected).toBe(false);
  });
});

describe("useConnection — a session the server dropped", () => {
  it("forgets it without saying goodbye", async () => {
    // There is nobody to say goodbye to. pg_disconnect here would be a call
    // into a socket that is already gone, and its failure means nothing.
    const { result } = renderHook(() => useConnection());
    await connect(result, "prod");
    invokeMock.mockClear();
    act(() => result.current.markLost());
    expect(invokeMock).not.toHaveBeenCalled();
    expect(result.current.connected).toBe(false);
    expect(result.current.connectedEnv).toBeNull();
  });

  it("says so, rather than reading as a deliberate disconnect", async () => {
    const { result } = renderHook(() => useConnection());
    await connect(result);
    act(() => result.current.markLost());
    expect(result.current.status).toBe("Connection lost");
  });
});

describe("useConnection — clearing a test report", () => {
  it("drops a finished report", async () => {
    // Reopening the editor showing a green report from a probe against a
    // different host is how a bad connection gets trusted.
    vi.useFakeTimers();
    const { result } = renderHook(() => useConnection());
    invokeMock.mockResolvedValue(report([stage("DNS")]));
    await act(async () => void (await result.current.test(PARAMS)));
    await act(async () => void vi.advanceTimersByTime(STAGE_REVEAL_MS));
    expect(result.current.testSummary).toBeTruthy();

    act(() => result.current.clearTest());
    expect(result.current.stages).toBeNull();
    expect(result.current.testSummary).toBe("");
    expect(result.current.testing).toBe(false);
  });

  it("clears the summary out of the status line the editor renders", async () => {
    // The editor's footer shows `status`, and a passing test writes its
    // summary there. Reopening the editor on a different connection with a
    // green "OK — server 18.0" still under it says that one was verified.
    vi.useFakeTimers();
    const { result } = renderHook(() => useConnection());
    invokeMock.mockResolvedValue(report([stage("DNS")], "18.0"));
    await act(async () => void (await result.current.test(PARAMS)));
    await act(async () => void vi.advanceTimersByTime(STAGE_REVEAL_MS));
    expect(result.current.status).toBe("OK — server 18.0");

    act(() => result.current.clearTest());
    expect(result.current.status).toBe("");
  });

  it("cancels a report still being revealed", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useConnection());
    invokeMock.mockResolvedValue(report([stage("DNS"), stage("TCP")]));
    await act(async () => void (await result.current.test(PARAMS)));
    act(() => result.current.clearTest());
    await act(async () => void vi.advanceTimersByTime(STAGE_REVEAL_MS * 5));
    expect(result.current.stages).toBeNull();
  });

  it("leaves the session alone — it is about the form, not the connection", async () => {
    const { result } = renderHook(() => useConnection());
    await connect(result, "prod");
    act(() => result.current.clearTest());
    expect(result.current.connected).toBe(true);
    expect(result.current.connectedEnv).toBe("prod");
  });
});

describe("useConnection — the staged probe", () => {
  const runTest = async (result: { current: ReturnType<typeof useConnection> }) => {
    await act(async () => void (await result.current.test(PARAMS)));
  };

  it("reveals the stages one at a time", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useConnection());
    invokeMock.mockResolvedValue(report([stage("DNS"), stage("TCP"), stage("TLS")]));
    await runTest(result);

    expect(result.current.stages).toEqual([]);
    await act(async () => void vi.advanceTimersByTime(STAGE_REVEAL_MS));
    expect(result.current.stages).toHaveLength(1);
    await act(async () => void vi.advanceTimersByTime(STAGE_REVEAL_MS * 2));
    expect(result.current.stages).toHaveLength(3);
    expect(result.current.testing).toBe(false);
  });

  it("summarises a pass with the server version", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useConnection());
    invokeMock.mockResolvedValue(report([stage("DNS")], "18.0"));
    await runTest(result);
    await act(async () => void vi.advanceTimersByTime(STAGE_REVEAL_MS));
    expect(result.current.testSummary).toBe("OK — server 18.0");
    expect(result.current.status).toBe("OK — server 18.0");
  });

  it("names the stage that failed, not just that it failed", async () => {
    // The point of a staged probe is knowing how far it got. "FAILED" alone
    // is the same information as no probe at all.
    vi.useFakeTimers();
    const { result } = renderHook(() => useConnection());
    invokeMock.mockResolvedValue(report([stage("DNS"), stage("TCP", false), stage("TLS", false)]));
    await runTest(result);
    await act(async () => void vi.advanceTimersByTime(STAGE_REVEAL_MS * 3));
    expect(result.current.testSummary).toBe("FAILED at TCP");
  });

  it("says OK with an unknown version rather than omitting the line", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useConnection());
    invokeMock.mockResolvedValue(report([stage("DNS")], null));
    await runTest(result);
    await act(async () => void vi.advanceTimersByTime(STAGE_REVEAL_MS));
    expect(result.current.testSummary).toBe("OK — server ?");
  });

  it("stops testing when the report has no stages at all", async () => {
    // Nothing will ever arrive to clear the flag, so the spinner would run
    // forever.
    const { result } = renderHook(() => useConnection());
    invokeMock.mockResolvedValue(report([]));
    await runTest(result);
    expect(result.current.testing).toBe(false);
    expect(result.current.stages).toEqual([]);
  });

  it("stops testing when the probe itself throws", async () => {
    const { result } = renderHook(() => useConnection());
    failOnce("no route to host");
    await runTest(result);
    expect(result.current.testing).toBe(false);
    expect(result.current.status).toContain("no route to host");
  });

  it("does not let a previous test's stages land in a new one", async () => {
    // Each stage is revealed on its own timer. Without cancelling them, a
    // second test shows the first one's stages appended to its own — a report
    // for a host the user is no longer testing.
    vi.useFakeTimers();
    const { result } = renderHook(() => useConnection());

    invokeMock.mockResolvedValue(report([stage("OLD-1"), stage("OLD-2"), stage("OLD-3")]));
    await runTest(result);
    await act(async () => void vi.advanceTimersByTime(STAGE_REVEAL_MS)); // only OLD-1 revealed

    invokeMock.mockResolvedValue(report([stage("NEW-1")]));
    await runTest(result);
    await act(async () => void vi.advanceTimersByTime(STAGE_REVEAL_MS * 5));

    expect(result.current.stages?.map((s) => s.name)).toEqual(["NEW-1"]);
  });

  it("clears the previous summary when a new test starts", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useConnection());
    invokeMock.mockResolvedValue(report([stage("DNS")]));
    await runTest(result);
    await act(async () => void vi.advanceTimersByTime(STAGE_REVEAL_MS));
    expect(result.current.testSummary).toBeTruthy();

    invokeMock.mockResolvedValue(report([stage("DNS")]));
    await runTest(result);
    expect(result.current.testSummary).toBe("");
    expect(result.current.testing).toBe(true);
  });

  it("drops pending timers on unmount", async () => {
    // Otherwise they fire into an unmounted component's setState.
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useConnection());
    invokeMock.mockResolvedValue(report([stage("DNS"), stage("TCP")]));
    await act(async () => void (await result.current.test(PARAMS)));
    unmount();
    expect(() => vi.advanceTimersByTime(STAGE_REVEAL_MS * 5)).not.toThrow();
  });
});
