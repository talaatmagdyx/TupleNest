import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type Event, type EventCallback } from "@tauri-apps/api/event";
import type { PgParams } from "../ipc/types";
import { useConnection } from "./useConnection";
import { CONNECTION_LOST_EVENT, lostDetail, useConnectionLost, type ConnectionLostPayload } from "./useConnectionLost";

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);

const PARAMS = {
  host: "localhost",
  port: 5432,
  database: "appdb",
  username: "appuser",
  secretRef: null,
  tlsMode: "verify-full",
  tlsCaPath: null,
} as unknown as PgParams;

const LOST = "Connection lost: the server ended this session [SQLSTATE 57P01] — the session was closed.";

let handler: EventCallback<ConnectionLostPayload> | null;
let off: ReturnType<typeof vi.fn>;

beforeEach(() => {
  handler = null;
  off = vi.fn();
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
  listenMock.mockImplementation(async (name, cb) => {
    if (name === CONNECTION_LOST_EVENT) handler = cb as EventCallback<ConnectionLostPayload>;
    return off as unknown as () => void;
  });
});

const fire = (generation: number) =>
  act(() => {
    handler?.({ event: CONNECTION_LOST_EVENT, id: 1, payload: { generation, message: LOST, sqlstate: "57P01" } } as Event<ConnectionLostPayload>);
  });

/** useConnection and the listener wired together, the way App wires them. */
const mount = () => {
  const onLost = vi.fn();
  const hook = renderHook(() => {
    const c = useConnection();
    useConnectionLost(c.isLive, onLost);
    return c;
  });
  return { ...hook, onLost };
};

const connectAs = async (result: { current: ReturnType<typeof useConnection> }, generation: number) => {
  invokeMock.mockImplementation(async (cmd) =>
    cmd === "pg_connect" ? { environment: "dev", readOnly: false, generation } : undefined,
  );
  await act(async () => void (await result.current.connect(PARAMS, "dev")));
};

describe("useConnectionLost — the backend noticed the session end", () => {
  it("reports the loss of the live session without any statement being run", async () => {
    const { result, onLost } = mount();
    await connectAs(result, 7);
    const callsBefore = invokeMock.mock.calls.length;
    fire(7);
    expect(onLost).toHaveBeenCalledWith(LOST);
    // Nothing was sent to find out.
    expect(invokeMock.mock.calls.length).toBe(callsBefore);
  });

  it("ignores an event for a session that was replaced by a reconnect", async () => {
    const { result, onLost } = mount();
    await connectAs(result, 7);
    await connectAs(result, 8);
    fire(7);
    expect(onLost).not.toHaveBeenCalled();
    fire(8);
    expect(onLost).toHaveBeenCalledTimes(1);
  });

  it("does not report an intentional disconnect as lost", async () => {
    const { result, onLost } = mount();
    await connectAs(result, 3);
    await act(async () => void (await result.current.disconnect()));
    fire(3);
    expect(onLost).not.toHaveBeenCalled();
  });

  it("does not report a loss that races a disconnect still in flight", async () => {
    const { result, onLost } = mount();
    await connectAs(result, 4);
    let finish!: () => void;
    invokeMock.mockImplementation((cmd) =>
      cmd === "pg_disconnect" ? new Promise<undefined>((r) => (finish = () => r(undefined))) : Promise.resolve(undefined),
    );
    let pending!: Promise<void>;
    act(() => void (pending = result.current.disconnect()));
    fire(4);
    expect(onLost).not.toHaveBeenCalled();
    await act(async () => {
      finish();
      await pending;
    });
    expect(result.current.status).toBe("Disconnected");
  });

  it("reports nothing before any connect, nor after a loss already reported", async () => {
    const { result, onLost } = mount();
    fire(0);
    fire(1);
    expect(onLost).not.toHaveBeenCalled();
    await connectAs(result, 1);
    act(() => result.current.markLost());
    fire(1);
    expect(onLost).not.toHaveBeenCalled();
  });

  it("calls the latest handler, and unsubscribes on unmount", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const { result, rerender, unmount } = renderHook(({ cb }) => {
      const c = useConnection();
      useConnectionLost(c.isLive, cb);
      return c;
    }, { initialProps: { cb: first } });
    await connectAs(result, 2);
    rerender({ cb: second });
    fire(2);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(LOST);
    expect(listenMock).toHaveBeenCalledTimes(1);
    unmount();
    await act(async () => {});
    expect(off).toHaveBeenCalled();
  });
});

describe("lostDetail", () => {
  it("is the backend's message when no transaction was open", () => {
    expect(lostDetail(LOST, false)).toBe(LOST);
  });

  it("says an open transaction was rolled back by the server", () => {
    const d = lostDetail(LOST, true);
    expect(d.startsWith(LOST)).toBe(true);
    expect(d).toMatch(/open transaction was rolled back by the server/);
    expect(d).toMatch(/nothing in it was committed/);
  });
});
