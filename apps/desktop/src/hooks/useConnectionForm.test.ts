import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { BLANK, parseSsh, useConnectionForm } from "./useConnectionForm";
import type { ConnectionRecord, SshParams } from "../ipc/types";

const ssh: SshParams = {
  host: "bastion.internal",
  port: 2222,
  username: "deploy",
  keyPath: "~/.ssh/id_ed25519",
  fingerprint: "SHA256:abc",
};

const rec = (over: Partial<ConnectionRecord> = {}): ConnectionRecord =>
  ({
    id: "c1",
    name: "customer_analytics",
    host: "db.internal",
    port: 5433,
    database: "appdb",
    username: "appuser",
    secretRef: "keychain-ref",
    environment: "prod",
    tlsMode: "verify-ca",
    tlsCaPath: "/etc/ssl/ca.pem",
    sshJson: null,
    ...over,
  }) as ConnectionRecord;

describe("parseSsh", () => {
  it("reads a tunnel", () => {
    expect(parseSsh(JSON.stringify(ssh))).toEqual(ssh);
  });

  it("treats absent as no tunnel", () => {
    expect(parseSsh(null)).toBeNull();
  });

  it("survives a row written by a broken build rather than throwing", () => {
    // A parse error here used to be caught by a bare `catch {}` in App; the
    // profile still has to load, just without a tunnel.
    expect(parseSsh("{not json")).toBeNull();
  });

  it("rejects json that is not a tunnel", () => {
    expect(parseSsh('{"nope":1}')).toBeNull();
    expect(parseSsh("null")).toBeNull();
  });
});

describe("useConnectionForm — read-only", () => {
  it("is off unless asked for", () => {
    const { result } = renderHook(() => useConnectionForm());
    expect(result.current.readOnly).toBe(false);
  });

  it("carries the flag to the backend, where the server enforces it", () => {
    // It was collected and then dropped on the floor for a while: the field
    // existed all the way down to ConnectionConfig and was hard-coded false.
    const { result } = renderHook(() => useConnectionForm());
    act(() => result.current.set("readOnly", true));
    expect(result.current.toParams(null).readOnly).toBe(true);
  });

  it("restores the flag when a saved profile is loaded", () => {
    const { result } = renderHook(() => useConnectionForm());
    act(() => result.current.load(rec({ readOnly: true })));
    expect(result.current.readOnly).toBe(true);
  });
});

describe("useConnectionForm — defaults", () => {
  it("starts blank, with TLS verifying", () => {
    // Fails closed: a fresh profile must not silently accept any certificate.
    const { result } = renderHook(() => useConnectionForm());
    expect(result.current.tlsMode).toBe("verify-full");
    expect(result.current.profileId).toBeNull();
    expect(result.current.sshEnabled).toBe(false);
  });

  it("accepts initial values", () => {
    const { result } = renderHook(() => useConnectionForm({ host: "db", port: 6000 }));
    expect(result.current.host).toBe("db");
    expect(result.current.port).toBe(6000);
  });

  it("sets a field", () => {
    const { result } = renderHook(() => useConnectionForm());
    act(() => result.current.set("database", "appdb"));
    expect(result.current.database).toBe("appdb");
  });
});

describe("useConnectionForm — loading a profile", () => {
  it("fills every field", () => {
    const { result } = renderHook(() => useConnectionForm());
    act(() => result.current.load(rec()));
    expect(result.current).toMatchObject({
      profileId: "c1",
      profileName: "customer_analytics",
      environment: "prod",
      host: "db.internal",
      port: 5433,
      database: "appdb",
      username: "appuser",
      secretRef: "keychain-ref",
      tlsMode: "verify-ca",
      tlsCaPath: "/etc/ssl/ca.pem",
    });
  });

  it("never puts the password back in the box", () => {
    // The value lives in the keychain and is not the app's to display; a
    // filled field would also imply it had been typed here.
    const { result } = renderHook(() => useConnectionForm());
    act(() => result.current.set("password", "typed"));
    act(() => result.current.load(rec()));
    expect(result.current.password).toBe("");
  });

  it("defaults a profile with no environment to dev", () => {
    const { result } = renderHook(() => useConnectionForm());
    act(() => result.current.load(rec({ environment: null })));
    expect(result.current.environment).toBe("dev");
  });

  it("defaults an empty tls mode to verify-full rather than to nothing", () => {
    const { result } = renderHook(() => useConnectionForm());
    act(() => result.current.load(rec({ tlsMode: "" })));
    expect(result.current.tlsMode).toBe("verify-full");
  });

  it("turns the tunnel on and fills it from the profile", () => {
    const { result } = renderHook(() => useConnectionForm());
    act(() => result.current.load(rec({ sshJson: JSON.stringify(ssh) })));
    expect(result.current.sshEnabled).toBe(true);
    expect(result.current.sshHost).toBe("bastion.internal");
    expect(result.current.sshPort).toBe(2222);
    expect(result.current.sshFingerprint).toBe("SHA256:abc");
  });

  it("defaults a tunnel with no port to 22", () => {
    const { result } = renderHook(() => useConnectionForm());
    act(() => result.current.load(rec({ sshJson: JSON.stringify({ ...ssh, port: 0 }) })));
    expect(result.current.sshPort).toBe(22);
  });

  it("clears a previous profile's tunnel when the new one has none", () => {
    // Otherwise the next connection quietly routes through the last bastion.
    const { result } = renderHook(() => useConnectionForm());
    act(() => result.current.load(rec({ sshJson: JSON.stringify(ssh) })));
    act(() => result.current.load(rec({ id: "c2", sshJson: null })));
    expect(result.current.sshEnabled).toBe(false);
    expect(result.current.sshHost).toBe("");
    expect(result.current.sshFingerprint).toBe("");
  });

  it("loads a profile whose tunnel json is corrupt, without the tunnel", () => {
    const { result } = renderHook(() => useConnectionForm());
    act(() => result.current.load(rec({ sshJson: "{broken" })));
    expect(result.current.profileId).toBe("c1");
    expect(result.current.sshEnabled).toBe(false);
  });
});

describe("useConnectionForm — reset", () => {
  it("goes back to blank", () => {
    const { result } = renderHook(() => useConnectionForm());
    act(() => result.current.load(rec({ sshJson: JSON.stringify(ssh) })));
    act(() => result.current.reset());
    expect(result.current.profileId).toBeNull();
    expect(result.current.sshEnabled).toBe(false);
    expect(result.current.tlsMode).toBe(BLANK.tlsMode);
    expect(result.current.secretRef).toBeNull();
  });

  it("drops the previous profile's keychain reference", () => {
    // Keeping it would point a brand-new connection at another one's password.
    const { result } = renderHook(() => useConnectionForm());
    act(() => result.current.load(rec()));
    act(() => result.current.reset());
    expect(result.current.secretRef).toBeNull();
  });
});

describe("useConnectionForm — ssh()", () => {
  it("is null when the tunnel is off", () => {
    const { result } = renderHook(() => useConnectionForm());
    act(() => result.current.set("sshHost", "bastion"));
    expect(result.current.ssh()).toBeNull();
  });

  it("is null when the tunnel is on but has no host", () => {
    // A half-filled tunnel would fail at connect time with a worse message.
    const { result } = renderHook(() => useConnectionForm());
    act(() => result.current.set("sshEnabled", true));
    expect(result.current.ssh()).toBeNull();
  });

  it("is the tunnel when it is usable", () => {
    const { result } = renderHook(() => useConnectionForm());
    act(() => result.current.load(rec({ sshJson: JSON.stringify(ssh) })));
    expect(result.current.ssh()).toEqual(ssh);
  });
});

describe("useConnectionForm — toParams", () => {
  it("carries the fields the backend needs", () => {
    const { result } = renderHook(() => useConnectionForm());
    act(() => result.current.load(rec()));
    expect(result.current.toParams("ref")).toEqual({
      host: "db.internal",
      port: 5433,
      database: "appdb",
      username: "appuser",
      secretRef: "ref",
      tlsMode: "verify-ca",
      tlsCaPath: "/etc/ssl/ca.pem",
      environment: "prod",
      readOnly: false,
      ssh: null,
    });
  });

  it("takes the caller's secret ref, since only it knows about a fresh save", () => {
    const { result } = renderHook(() => useConnectionForm());
    act(() => result.current.load(rec()));
    expect(result.current.toParams(null).secretRef).toBeNull();
  });

  it("sends null rather than an empty CA path", () => {
    const { result } = renderHook(() => useConnectionForm());
    act(() => result.current.set("tlsCaPath", ""));
    expect(result.current.toParams(null).tlsCaPath).toBeNull();
  });

  it("includes a usable tunnel", () => {
    const { result } = renderHook(() => useConnectionForm());
    act(() => result.current.load(rec({ sshJson: JSON.stringify(ssh) })));
    expect(result.current.toParams(null).ssh).toEqual(ssh);
  });

  it("never sends the password itself", () => {
    // Credentials go to the keychain; params only ever carry a reference.
    const { result } = renderHook(() => useConnectionForm());
    act(() => result.current.set("password", "hunter2"));
    expect(JSON.stringify(result.current.toParams("ref"))).not.toContain("hunter2");
  });
});
