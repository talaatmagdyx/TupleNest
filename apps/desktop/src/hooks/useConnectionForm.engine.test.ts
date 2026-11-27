import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { BLANK, useConnectionForm } from "./useConnectionForm";
import type { ConnectionRecord } from "../ipc/types";

describe("useConnectionForm — engines", () => {
  it("starts on PostgreSQL, not creating anything", () => {
    expect(BLANK.engine).toBe("postgres");
    expect(BLANK.createFile).toBe(false);
  });

  it("switching to SQLite drops the PostgreSQL default database, and back", () => {
    const { result } = renderHook(() => useConnectionForm());
    act(() => result.current.chooseEngine("sqlite"));
    expect(result.current.engine).toBe("sqlite");
    expect(result.current.database).toBe("");
    act(() => result.current.set("database", "/data/app.db"));
    act(() => result.current.set("createFile", true));
    // A path the user typed is kept; switching resets "create".
    act(() => result.current.chooseEngine("postgres"));
    expect(result.current.database).toBe("/data/app.db");
    expect(result.current.createFile).toBe(false);
    act(() => result.current.set("database", ""));
    act(() => result.current.chooseEngine("postgres"));
    act(() => result.current.chooseEngine("sqlite"));
    act(() => result.current.chooseEngine("postgres"));
    expect(result.current.database).toBe(BLANK.database);
  });

  it("SQLite params carry the file and the policy, never a secret, server or tunnel", () => {
    const { result } = renderHook(() =>
      useConnectionForm({
        engine: "sqlite",
        database: " /data/app.db ",
        createFile: true,
        environment: "prod",
        readOnly: true,
        statementTimeoutSec: 5,
        host: "db.internal",
        username: "appuser",
        sshEnabled: true,
        sshHost: "bastion",
      }),
    );
    expect(result.current.toParams("tn-secret", "tn-pp")).toEqual({
      engine: "sqlite",
      create: true,
      host: "",
      port: 0,
      database: "/data/app.db",
      username: "",
      secretRef: null,
      tlsMode: "disabled",
      tlsCaPath: null,
      environment: "prod",
      readOnly: true,
      statementTimeoutMs: 5000,
      ssh: null,
    });
  });

  it("PostgreSQL params are as they were: no engine field", () => {
    const { result } = renderHook(() => useConnectionForm());
    expect(result.current.toParams(null)).not.toHaveProperty("engine");
  });

  it("loads a saved profile's engine; a profile without one is PostgreSQL", () => {
    const { result } = renderHook(() => useConnectionForm());
    const rec = (over: Partial<ConnectionRecord>) =>
      ({
        id: "s1",
        name: "file",
        host: "",
        port: 0,
        database: "/data/app.db",
        username: "",
        secretRef: null,
        environment: "dev",
        tlsMode: "disabled",
        tlsCaPath: null,
        sshJson: null,
        ...over,
      }) as ConnectionRecord;
    act(() => result.current.load(rec({ engine: "sqlite" })));
    expect(result.current.engine).toBe("sqlite");
    expect(result.current.database).toBe("/data/app.db");
    act(() => result.current.load(rec({})));
    expect(result.current.engine).toBe("postgres");
  });
});
