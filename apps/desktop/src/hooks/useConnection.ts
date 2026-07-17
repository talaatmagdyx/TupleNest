import { useCallback, useEffect, useRef, useState } from "react";
import { errText } from "../lib/text";
import { invoke } from "@tauri-apps/api/core";
import type { MetadataOut, PgParams, TestReport, TestStage } from "../ipc/types";

/** Gap between revealed test stages. Progressive reveal is the HUD design:
 *  the probe is staged, so the report reads as it happens rather than
 *  appearing whole after a wait. */
export const STAGE_REVEAL_MS = 160;

export type ConnectOutcome = { ok: true } | { ok: false; message: string };

export type Connection = {
  connected: boolean;
  /** The environment of the *live session* — not the form. The prod banner
   *  keys off this, so it must never describe a connection we don't have. */
  connectedEnv: string | null;
  serverVersion: string | null;
  status: string;
  setStatus: (s: string) => void;
  stages: TestStage[] | null;
  testing: boolean;
  testSummary: string;
  connect: (params: PgParams, environment: string) => Promise<ConnectOutcome>;
  /** Close the session and forget everything about it. */
  disconnect: () => Promise<void>;
  /** The server dropped us. Same forgetting, but nothing is sent — there is
   *  nobody left to say goodbye to. */
  markLost: () => void;
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
  const [serverVersion, setServerVersion] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [stages, setStages] = useState<TestStage[] | null>(null);
  const [testing, setTesting] = useState(false);
  const [testSummary, setTestSummary] = useState("");

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
      const m = /PostgreSQL ([\d.]+)/.exec(r.payload.version ?? "");
      setServerVersion(m ? m[1] : null);
    } catch {
      // Only the version chip depends on this. A session that works but can't
      // report its version is still a session.
      setServerVersion(null);
    }
  }, []);

  const connect = useCallback(
    async (params: PgParams, environment: string): Promise<ConnectOutcome> => {
      setStatus("Connecting…");
      try {
        await invoke("pg_connect", { params });
        setConnected(true);
        setConnectedEnv(environment);
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
    setConnected(false);
    setConnectedEnv(null);
    setServerVersion(null);
    setStatus(why);
  }, []);

  const disconnect = useCallback(async () => {
    // The failure is ignored on purpose: the session being unreachable is the
    // usual reason to be here, and the local state must come down either way.
    await invoke("pg_disconnect").catch(() => {});
    forget("Disconnected");
  }, [forget]);

  const markLost = useCallback(() => forget("Connection lost"), [forget]);

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
    serverVersion,
    status,
    setStatus,
    stages,
    testing,
    testSummary,
    connect,
    disconnect,
    markLost,
    test,
    clearTest,
  };
}
