import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import MonitorModal from "./MonitorModal";

const invokeMock = vi.mocked(invoke);

const session = (over: Record<string, unknown> = {}) => ({
  pid: 4242,
  user: "appuser",
  database: "appdb",
  application: "psql",
  clientAddr: "127.0.0.1",
  state: "active",
  waitType: "Lock",
  waitEvent: "transactionid",
  seconds: 12,
  query: "select pg_sleep(60)",
  ...over,
});

const activity = (over: Record<string, unknown> = {}) => ({
  sessions: [session()],
  locks: [],
  db: {
    backends: 3,
    commits: 1000,
    rollbacks: 2,
    blocksHit: 900,
    blocksRead: 100,
    tuplesReturned: 0,
    tuplesFetched: 0,
    size: "8500 MB",
  },
  ...over,
});

const base = { onToast: vi.fn(), onClose: vi.fn() };

/**
 * Answer by command, the way the real IPC does.
 *
 * A blanket `mockResolvedValue` answers every command with the same thing.
 * The admin tests below set it to `true` for `pg_admin_backend` — and the
 * refresh that follows a terminate then also got `true`, so `data` became a
 * boolean and the modal threw while rendering. The tests still passed; the
 * crash only showed up as an unhandled error at the end of the run.
 */
const serve = (act: unknown = activity(), admin: unknown = true) =>
  invokeMock.mockImplementation((async (cmd: string) =>
    cmd === "pg_admin_backend" ? admin : act) as never);

beforeEach(() => {
  invokeMock.mockReset();
  serve();
});
afterEach(() => vi.useRealTimers());

describe("MonitorModal — stats", () => {
  it("asks for activity on open", async () => {
    render(<MonitorModal {...base} />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("pg_activity"));
  });

  it("shows the database headline stats", async () => {
    render(<MonitorModal {...base} />);
    expect(await screen.findByText("8500 MB")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("1,000")).toBeInTheDocument();
  });

  it("computes the cache hit ratio", async () => {
    render(<MonitorModal {...base} />);
    expect(await screen.findByText("90.0%")).toBeInTheDocument();
  });

  it("shows a dash rather than dividing by zero on an idle database", async () => {
    serve(activity({ db: { ...activity().db, blocksHit: 0, blocksRead: 0 } }));
    render(<MonitorModal {...base} />);
    expect(await screen.findByText("—%")).toBeInTheDocument();
  });
});

describe("MonitorModal — sessions", () => {
  it("lists a session with its pid, state and age", async () => {
    render(<MonitorModal {...base} />);
    expect(await screen.findByText("4242")).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(screen.getByText("12s")).toBeInTheDocument();
    expect(screen.getByText("select pg_sleep(60)")).toBeInTheDocument();
  });

  it("says idle rather than showing an empty query cell", async () => {
    serve(activity({ sessions: [session({ query: null, state: "sleeping" })] }));
    const { container } = render(<MonitorModal {...base} />);
    await screen.findByText("sleeping");
    // The placeholder is emphasised so it reads as a note, not as SQL.
    expect(container.querySelector("em")).toHaveTextContent("idle");
  });

  it("dashes an unknown age and wait rather than inventing zeros", async () => {
    serve(activity({ sessions: [session({ seconds: null, waitEvent: null, state: null })] }));
    render(<MonitorModal {...base} />);
    expect(await screen.findAllByText("—")).toHaveLength(3);
  });

  it("says so when nothing else is connected", async () => {
    serve(activity({ sessions: [] }));
    render(<MonitorModal {...base} />);
    expect(await screen.findByText("No other sessions.")).toBeInTheDocument();
  });

  it("cancels a query without killing the backend", async () => {
    serve(activity(), true);
    render(<MonitorModal {...base} />);
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(invokeMock).toHaveBeenCalledWith("pg_admin_backend", { pid: 4242, terminate: false });
  });

  it("kills a backend only when Kill is chosen", async () => {
    serve(activity(), true);
    render(<MonitorModal {...base} />);
    await userEvent.click(await screen.findByRole("button", { name: "Kill" }));
    expect(invokeMock).toHaveBeenCalledWith("pg_admin_backend", { pid: 4242, terminate: true });
  });

  it("reports what actually happened, not what was asked", async () => {
    // pg_cancel_backend returns false when the pid has already gone.
    const onToast = vi.fn();
    serve(activity(), false);
    render(<MonitorModal {...base} onToast={onToast} />);
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(onToast).toHaveBeenCalledWith("pid 4242 not affected"));
  });

  it("says why the kill failed rather than nothing at all", async () => {
    // Terminating someone else's backend needs privileges. A click that
    // silently does nothing reads as a broken button.
    const onToast = vi.fn();
    render(<MonitorModal {...base} onToast={onToast} />);
    const p = Promise.reject("must be a member of the role whose process is being terminated");
    p.catch(() => {});
    invokeMock.mockReturnValueOnce(p);
    await userEvent.click(await screen.findByRole("button", { name: "Kill" }));
    await waitFor(() => expect(onToast).toHaveBeenCalledWith(expect.stringContaining("must be a member")));
  });

  it("confirms a successful terminate", async () => {
    const onToast = vi.fn();
    serve(activity(), true);
    render(<MonitorModal {...base} onToast={onToast} />);
    await userEvent.click(await screen.findByRole("button", { name: "Kill" }));
    await waitFor(() => expect(onToast).toHaveBeenCalledWith("Terminated pid 4242"));
  });
});

describe("MonitorModal — locks", () => {
  const locked = activity({
    locks: [
      {
        blockedPid: 99,
        blockedUser: "app",
        lockType: "transactionid",
        mode: "ShareLock",
        object: "public.users",
      },
    ],
  });

  it("counts blocked locks in the stats", async () => {
    serve(locked);
    render(<MonitorModal {...base} />);
    expect(await screen.findByText("Blocked locks")).toBeInTheDocument();
  });

  it("shows the lock detail on its tab", async () => {
    serve(locked);
    render(<MonitorModal {...base} />);
    await userEvent.click(await screen.findByRole("button", { name: /Blocking locks/ }));
    expect(screen.getByText("99")).toBeInTheDocument();
    expect(screen.getByText("ShareLock")).toBeInTheDocument();
    expect(screen.getByText("public.users")).toBeInTheDocument();
  });

  it("calls no locks healthy rather than just empty", async () => {
    render(<MonitorModal {...base} />);
    await userEvent.click(await screen.findByRole("button", { name: /Blocking locks/ }));
    expect(screen.getByText("No blocking locks — healthy.")).toBeInTheDocument();
  });

  it("dashes an unknown user and mode", async () => {
    serve(activity({ locks: [{ blockedPid: 1, blockedUser: null, lockType: "relation", mode: null, object: "t" }] }));
    render(<MonitorModal {...base} />);
    await userEvent.click(await screen.findByRole("button", { name: /Blocking locks/ }));
    expect(screen.getAllByText("—").length).toBe(2);
  });

  it("switches back to sessions", async () => {
    render(<MonitorModal {...base} />);
    await userEvent.click(await screen.findByRole("button", { name: /Blocking locks/ }));
    await userEvent.click(screen.getByRole("button", { name: /Sessions/ }));
    expect(screen.getByRole("button", { name: /Sessions/ })).toHaveClass("on");
  });
});

describe("MonitorModal — refresh", () => {
  it("refreshes on demand", async () => {
    render(<MonitorModal {...base} />);
    await screen.findByText("4242");
    invokeMock.mockClear();
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(invokeMock).toHaveBeenCalledWith("pg_activity");
  });

  it("polls while auto-refresh is on", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<MonitorModal {...base} />);
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalled());
    invokeMock.mockClear();
    await vi.advanceTimersByTimeAsync(2500);
    expect(invokeMock).toHaveBeenCalledWith("pg_activity");
  });

  it("stops polling when auto-refresh is turned off", async () => {
    // A live-updating table under a cursor makes the Kill button a moving
    // target; turning it off has to actually stop the timer.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<MonitorModal {...base} />);
    await vi.waitFor(() => expect(screen.getByRole("checkbox")).toBeChecked());
    await userEvent.click(screen.getByRole("checkbox"));
    invokeMock.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("surfaces a failure rather than freezing on stale numbers", async () => {
    const rejected = Promise.reject(new Error("connection closed"));
    rejected.catch(() => {});
    invokeMock.mockReturnValue(rejected);
    render(<MonitorModal {...base} />);
    expect(await screen.findByText(/connection closed/)).toBeInTheDocument();
  });
});
