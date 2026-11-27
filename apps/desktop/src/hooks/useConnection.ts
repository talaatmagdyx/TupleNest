import { useCallback, useEffect, useRef, useState } from "react";
import { errText } from "../lib/text";
import { invoke } from "@tauri-apps/api/core";
import type { MetadataOut, PgParams, TestReport, TestStage } from "../ipc/types";
import { engineOf, type Engine } from "../lib/engine";

/** Gap between revealed test stages. Progressive reveal is the HUD design:
 *  the probe is staged, so the report reads as it happens rather than
 *  appearing whole after a wait. */
export const STAGE_REVEAL_MS = 160;

export type ConnectOutcome = { ok: true } | { ok: false; message: string };

/** Where the live session goes: taken from what was sent to `pg_connect`. */
export type ConnectedTo = {
  profileId: string | null;
  engine: Engine;
  /** The database name, or for SQLite the file's path. */
  database: string;
  username: string;
  host: string;
  port: number;
  tlsMode: string;
};

export type Connection = {
  connected: boolean;
  /** The target of the *live session* — not the form. The title bar and the
   *  status bar name the connection from this: the form changes the moment
   *  another profile is opened for editing, while the session stays put. */
  connectedTo: ConnectedTo | null;
  /** The environment of the *live session* — not the form. The prod banner
   *  keys off this, so it must never describe a connection we don't have. */
  connectedEnv: string | null;
  serverVersion: string | null;
  status: string;
  setStatus: (s: string) => void;
  stages: TestStage[] | null;
  testing: boolean;
  testSummary: string;
  connect: (params: PgParams, environment: string, profileId?: string | null) => Promise<ConnectOutcome>;
  /** Close the session and forget everything about it. */
  disconnect: () => Promise<void>;
  /** The server dropped us. Same forgetting, but nothing is sent — there is
   *  nobody left to say goodbye to. */
  markLost: () => void;
  /** Is `generation` (from a `pg:connection-lost` event) the session on
   *  screen? False after a disconnect, a loss, or a reconnect. */
  isLive: (generation: number) => boolean;
  test: (params: PgParams) => Promise<void>;
  /** Drop a finished test report, so the editor doesn't reopen showing the
   *  result of a probe against whatever host was in the form last time. */
  clearTest: () => void;
};

/**
 * The database session.
 *
 * `connected` follows the server, never the form: it is set only after
 * `pg_connect` resolves and cleared before anything else on a disconnect. The
 * prod banner and the run guard both read it, so a `connected` that ran ahead
 * of the server would arm neither.
 */
export function useConnection(): Connection {
  const [connected, setConnected] = useState(false);
  const [connectedEnv, setConnectedEnv] = useState<string | null>(null);
  const [connectedTo, setConnectedTo] = useState<ConnectedTo | null>(null);
  const [serverVersion, setServerVersion] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [stages, setStages] = useState<TestStage[] | null>(null);
  const [testing, setTesting] = useState(false);
  const [testSummary, setTestSummary] = useState("");
  // The backend's id for the live session (`pg_connect`'s `generation`). A
  // ref, not state: it is read from an event listener, and only ever to
  // decide whether an event is about the session still on screen.
  const generation = useRef<number | null>(null);

  // Pending stage-reveal timers, so a second test — or an unmount — cannot be
  // interrupted by the first test's stages still arriving.
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const clearTimers = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  }, []);
  useEffect(() => clearTimers, [clearTimers]);

  const loadServerVersion = useCallback(async () => {
    try {
      const r = await invoke<MetadataOut<{ version: string }>>("pg_metadata", {
        request: { kind: "server_info" },
      });
      const m = /(?:PostgreSQL|SQLite) ([\d.]+)/.exec(r.payload.version ?? "");
      setServerVersion(m ? m[1] : null);
    } catch {
      // Only the version chip depends on this. A session that works but can't
      // report its version is still a session.
      setServerVersion(null);
    }
  }, []);

  const connect = useCallback(
    async (params: PgParams, environment: string, profileId: string | null = null): Promise<ConnectOutcome> => {
      setStatus("Connecting…");
      try {
        // The backend answers with the environment it settled on, which can
        // be more protective than the one asked for: two saved profiles for
        // one database, one tagged prod. The window follows the backend, so
        // the banner and the statement guard match the audit log.
        const settled = await invoke<{ environment?: string | null; generation?: number } | null | undefined>(
          "pg_connect",
          { params },
        );
        generation.current = settled?.generation ?? null;
        setConnected(true);
        setConnectedEnv(settled?.environment ?? environment);
        setConnectedTo({
          profileId,
          engine: engineOf(params.engine),
          database: params.database,
          username: params.username,
          host: params.host,
          port: params.port,
          tlsMode: params.tlsMode,
        });
        setStatus("Connected");
        void loadServerVersion();
        return { ok: true };
      } catch (e) {
        // Nothing is claimed on failure. A `connected` set here would leave
        // the prod banner describing a session that does not exist.
        const message = String(e);
        setStatus(`Error: ${message}`);
        return { ok: false, message };
      }
    },
    [loadServerVersion],
  );

  const forget = useCallback((why: string) => {
    generation.current = null;
    setConnected(false);
    setConnectedEnv(null);
    setConnectedTo(null);
    setServerVersion(null);
    setStatus(why);
  }, []);

  const disconnect = useCallback(async () => {
    // The failure is ignored on purpose: the session being unreachable is the
    // usual reason to be here, and the local state must come down either way.
    // The session stops being live before the backend is asked: a lost-
    // connection event racing this disconnect describes a session the user
    // is already closing, and must not pop up "Connection lost".
    generation.current = null;
    await invoke("pg_disconnect").catch(() => {});
    forget("Disconnected");
  }, [forget]);

  const markLost = useCallback(() => forget("Connection lost"), [forget]);

  const isLive = useCallback((g: number) => generation.current !== null && generation.current === g, []);

  const clearTest = useCallback(() => {
    clearTimers();
    setStages(null);
    setTestSummary("");
    setTesting(false);
    // `status` too: the editor's footer renders it, and the last test wrote
    // its summary there. Leaving it puts a green "OK — server 18.0" next to a
    // connection that was never tested — the probe was against whatever host
    // the form held before.
    setStatus("");
  }, [clearTimers]);

  const test = useCallback(
    async (params: PgParams) => {
      clearTimers(); // a new test supersedes whatever the last one was revealing
      setTesting(true);
      setStages(null);
      setTestSummary("");
      setStatus("Testing…");
      try {
        const report = await invoke<TestReport>("pg_test", { params });
        setStages([]);
        if (report.stages.length === 0) {
          setTesting(false);
          return;
        }
        report.stages.forEach((s, i) => {
          const t = setTimeout(
            () => {
              setStages((prev) => [...(prev ?? []), s]);
              if (i === report.stages.length - 1) {
                setTesting(false);
                const failed = report.stages.filter((x) => !x.passed);
                // Name the first failing stage rather than saying "failed":
                // the whole point of a staged probe is knowing how far it got.
                const summary =
                  failed.length === 0
                    ? `OK — server ${report.serverVersion ?? "?"}`
                    : `FAILED at ${failed[0].name}`;
                setTestSummary(summary);
                setStatus(summary);
              }
            },
            STAGE_REVEAL_MS * (i + 1),
          );
          timers.current.push(t);
        });
      } catch (e) {
        setTesting(false);
        setStatus(`Error: ${errText(e)}`);
      }
    },
    [clearTimers],
  );

  return {
    connected,
    connectedEnv,
    connectedTo,
    serverVersion,
    status,
    setStatus,
    stages,
    testing,
    testSummary,
    connect,
    disconnect,
    markLost,
    isLive,
    test,
    clearTest,
  };
}
