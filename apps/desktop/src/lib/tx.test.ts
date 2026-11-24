import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { serverInTransaction } from "./tx";

const invokeMock = vi.mocked(invoke);
beforeEach(() => invokeMock.mockReset());

describe("serverInTransaction", () => {
  it("is what the server says", async () => {
    invokeMock.mockResolvedValueOnce(true as never);
    expect(await serverInTransaction()).toBe(true);
    invokeMock.mockResolvedValueOnce(false as never);
    expect(await serverInTransaction()).toBe(false);
  });
  it("assumes a transaction is open when it cannot ask — the safe mistake", async () => {
    invokeMock.mockRejectedValueOnce("not connected");
    expect(await serverInTransaction()).toBe(true);
  });
});
