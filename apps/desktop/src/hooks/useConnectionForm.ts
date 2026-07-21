import { useCallback, useState } from "react";
import type { ConnectionRecord, PgParams, SshParams } from "../ipc/types";

/** A profile that has never been saved has no id. */
export const BLANK = {
  profileId: null as string | null,
  profileName: "",
  environment: "dev",
  // Off by default: a profile that silently refused writes would be a
  // worse surprise than one that allows them.
  readOnly: false,
  host: "localhost",
  port: 5432,
  database: "postgres",
  username: "",
  password: "",
  secretRef: null as string | null,
  // Fails closed: a new profile verifies the server's certificate until
  // someone deliberately decides otherwise.
  tlsMode: "verify-full",
  tlsCaPath: "",
  sshEnabled: false,
  sshHost: "",
  sshPort: 22,
  sshUser: "",
  sshKeyPath: "",
  sshFingerprint: "",
  // Seconds in the UI, milliseconds on the wire: nobody thinks about a query
  // ceiling in milliseconds. 0 means no limit, as PostgreSQL does.
  statementTimeoutSec: 0,
};

export type ConnectionFormState = typeof BLANK;

export type ConnectionForm = ConnectionFormState & {
  set: <K extends keyof ConnectionFormState>(k: K, v: ConnectionFormState[K]) => void;
  /** Fill the form from a saved profile. */
  load: (c: ConnectionRecord) => void;
  /** Back to a blank new-connection form. */
  reset: () => void;
  /** The SSH block, or null when there is no usable tunnel configured. */
  ssh: () => SshParams | null;
  /** Connection params for the backend. `secretRef` is supplied by the caller
   *  because only it knows whether the password was just re-saved. */
  toParams: (secretRef: string | null) => PgParams;
};

/** Seconds in the form to milliseconds on the wire.
 *
 *  A negative or non-finite value means "no limit" rather than something
 *  strange: `SET statement_timeout = -1` is an error, and a NaN from an empty
 *  input box must not become one. */
export function timeoutMs(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.round(seconds) * 1000;
}

/** Parse `sshJson`, tolerating a row written by an older or broken build. */
export function parseSsh(sshJson: string | null): SshParams | null {
  if (!sshJson) return null;
  try {
    const s = JSON.parse(sshJson) as SshParams;
    return s && typeof s.host === "string" ? s : null;
  } catch {
    return null;
  }
}

export function useConnectionForm(initial: Partial<ConnectionFormState> = {}): ConnectionForm {
  const [state, setState] = useState<ConnectionFormState>({ ...BLANK, ...initial });

  const set = useCallback(
    <K extends keyof ConnectionFormState>(k: K, v: ConnectionFormState[K]) =>
      setState((s) => ({ ...s, [k]: v })),
    [],
  );

  const reset = useCallback(() => setState({ ...BLANK }), []);

  const load = useCallback((c: ConnectionRecord) => {
    const ssh = parseSsh(c.sshJson ?? null);
    setState({
      profileId: c.id,
      profileName: c.name,
      environment: c.environment ?? "dev",
      readOnly: c.readOnly ?? false,
      host: c.host,
      port: c.port,
      database: c.database,
      username: c.username,
      // Never populate the box from the keychain: the value is not ours to
      // show, and a filled field implies it was typed here.
      password: "",
      secretRef: c.secretRef,
      tlsMode: c.tlsMode || "verify-full",
      tlsCaPath: c.tlsCaPath ?? "",
      sshEnabled: ssh !== null,
      sshHost: ssh?.host ?? "",
      sshPort: ssh?.port || 22,
      sshUser: ssh?.username ?? "",
      sshKeyPath: ssh?.keyPath ?? "",
      sshFingerprint: ssh?.fingerprint ?? "",
      statementTimeoutSec: Math.round((c.statementTimeoutMs ?? 0) / 1000),
    });
  }, []);

  const ssh = useCallback((): SshParams | null => {
    // A tunnel toggled on but never filled in is not a tunnel. Sending a
    // half-built one would fail at connect time with a worse message.
    if (!state.sshEnabled || !state.sshHost) return null;
    return {
      host: state.sshHost,
      port: state.sshPort,
      username: state.sshUser,
      keyPath: state.sshKeyPath,
      fingerprint: state.sshFingerprint,
    };
  }, [state]);

  const toParams = useCallback(
    (secretRef: string | null): PgParams => ({
      host: state.host,
      port: state.port,
      database: state.database,
      username: state.username,
      secretRef,
      tlsMode: state.tlsMode,
      // "" means "not set", and the backend distinguishes null from empty.
      tlsCaPath: state.tlsCaPath || null,
      environment: state.environment,
      readOnly: state.readOnly,
      statementTimeoutMs: timeoutMs(state.statementTimeoutSec),
      ssh: ssh(),
    }),
    [state, ssh],
  );

  return { ...state, set, load, reset, ssh, toParams };
}
