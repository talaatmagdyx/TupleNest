import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type AppInfo = { name: string; version: string; os: string };

type PgParams = {
  host: string;
  port: number;
  database: string;
  username: string;
  secretRef: string | null;
};

type TestReport = {
  serverVersion: string | null;
  stages: { name: string; passed: boolean; durationMs: number; detail: string | null }[];
};

type QueryResult = {
  columns: { name: string; dbType: string }[];
  rows: unknown[][];
  totalRows: number;
  truncated: boolean;
  rowsAffected: number | null;
  elapsedMs: number;
};

export default function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  const [host, setHost] = useState("localhost");
  const [port, setPort] = useState(5432);
  const [database, setDatabase] = useState("postgres");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [secretRef, setSecretRef] = useState<string | null>(null);

  const [status, setStatus] = useState<string>("");
  const [connected, setConnected] = useState(false);
  const [sql, setSql] = useState("select now(), version()");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<QueryResult | null>(null);

  useEffect(() => {
    invoke<AppInfo>("app_get_info").then(setInfo).catch(console.error);
    invoke<"dark" | "light" | null>("settings_get", { key: "theme" })
      .then((t) => t && setTheme(t))
      .catch(() => {});
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const toggleTheme = useCallback(async () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    await invoke("settings_set", { key: "theme", value: next });
  }, [theme]);


  const savePassword = useCallback(async () => {
    if (!password) return null;
    // The password crosses the IPC boundary exactly once, is stored in the
    // OS keychain, and only the opaque reference stays in frontend state.
    const ref = await invoke<string>("pg_secret_save", { password });
    setPassword("");
    setSecretRef(ref);
    return ref;
  }, [password]);

  const withSecret = useCallback(async (): Promise<PgParams> => {
    const ref = password ? await savePassword() : secretRef;
    return { host, port, database, username, secretRef: ref };
  }, [password, savePassword, secretRef, host, port, database, username]);

  const doTest = useCallback(async () => {
    setStatus("Testing…");
    try {
      const report = await invoke<TestReport>("pg_test", { params: await withSecret() });
      const failed = report.stages.filter((s) => !s.passed);
      setStatus(
        failed.length === 0
          ? `OK — server ${report.serverVersion ?? "?"} (${report.stages
              .map((s) => `${s.name} ${s.durationMs}ms`)
              .join(", ")})`
          : `FAILED at ${failed[0].name}: ${failed[0].detail ?? "unknown"}`
      );
    } catch (e) {
      setStatus(`Error: ${e}`);
    }
  }, [withSecret]);

  const doConnect = useCallback(async () => {
    setStatus("Connecting…");
    try {
      await invoke("pg_connect", { params: await withSecret() });
      setConnected(true);
      setStatus("Connected");
    } catch (e) {
      setStatus(`Error: ${e}`);
    }
  }, [withSecret]);

  const doDisconnect = useCallback(async () => {
    await invoke("pg_disconnect").catch(() => {});
    setConnected(false);
    setResult(null);
    setStatus("Disconnected");
  }, []);

  const doRun = useCallback(async () => {
    setRunning(true);
    setStatus("Running…");
    try {
      const r = await invoke<QueryResult>("pg_query", { sql, maxRows: 200 });
      setResult(r);
      setStatus(
        r.columns.length > 0
          ? `${r.totalRows} row(s) in ${r.elapsedMs}ms${r.truncated ? " (showing first 200)" : ""}`
          : `${r.rowsAffected ?? 0} row(s) affected in ${r.elapsedMs}ms`
      );
    } catch (e) {
      setStatus(`Error: ${e}`);
      setResult(null);
    } finally {
      setRunning(false);
    }
  }, [sql]);

  const doCancel = useCallback(async () => {
    try {
      await invoke("pg_cancel");
      setStatus("Cancel requested");
    } catch (e) {
      setStatus(`Cancel error: ${e}`);
    }
  }, []);

  return (
    <div className="shell">
      <header className="titlebar">
        <span className="brand">TupleNest</span>
        <span className="muted">
          {info ? `v${info.version} · ${info.os}` : ""}
        </span>
        <button onClick={toggleTheme}>
          {theme === "dark" ? "Light theme" : "Dark theme"}
        </button>
      </header>
      <main className="content">
        <section className="panel">
          <h2>PostgreSQL connection (Phase 0 PoC)</h2>
          <div className="form-row">
            <input placeholder="host" value={host} onChange={(e) => setHost(e.target.value)} />
            <input
              placeholder="port"
              type="number"
              value={port}
              onChange={(e) => setPort(Number(e.target.value) || 5432)}
              style={{ width: 80 }}
            />
            <input placeholder="database" value={database} onChange={(e) => setDatabase(e.target.value)} />
            <input placeholder="username" value={username} onChange={(e) => setUsername(e.target.value)} />
            <input
              placeholder={secretRef ? "password saved in keychain" : "password (optional)"}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div className="form-row">
            <button onClick={doTest}>Test</button>
            {connected ? (
              <button onClick={doDisconnect}>Disconnect</button>
            ) : (
              <button onClick={doConnect}>Connect</button>
            )}
            <span className="status">{status}</span>
          </div>
        </section>

        <section className="panel">
          <h2>Query</h2>
          <textarea
            rows={4}
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            spellCheck={false}
            disabled={!connected}
          />
          <div className="form-row">
            <button onClick={doRun} disabled={!connected || running}>
              {running ? "Running…" : "Run"}
            </button>
            <button onClick={doCancel} disabled={!running}>
              Cancel
            </button>
          </div>
          {result && result.columns.length > 0 && (
            <div className="grid-wrap">
              <table className="grid">
                <thead>
                  <tr>
                    {result.columns.map((c) => (
                      <th key={c.name} title={c.dbType}>
                        {c.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, i) => (
                    <tr key={i}>
                      {row.map((cell, j) => (
                        <td key={j}>
                          {cell === null ? <em className="muted">null</em> : String(cell)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <p className="hint">
          Credentials never enter this WebView beyond one-time entry: they go
          straight to the OS keychain and only an opaque reference remains.
        </p>
      </main>
    </div>
  );
}
