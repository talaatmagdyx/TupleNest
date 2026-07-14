import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type AppInfo = { name: string; version: string; os: string };

type PgParams = {
  host: string;
  port: number;
  database: string;
  username: string;
  secretRef: string | null;
  tlsMode: string;
  tlsCaPath: string | null;
};

type TestStage = { name: string; passed: boolean; durationMs: number; detail: string | null };

type TestReport = {
  serverVersion: string | null;
  stages: TestStage[];
};

type ConnectionRecord = {
  id: string;
  name: string;
  driver: string;
  environment: string | null;
  color: string | null;
  readOnly: boolean;
  host: string;
  port: number;
  database: string;
  username: string;
  secretRef: string | null;
  tlsMode: string;
  tlsCaPath: string | null;
};

type DbObject = { name: string; kind: string; comment: string | null };

type DbColumn = {
  name: string;
  dbType: string;
  nullable: boolean;
  primaryKey: boolean;
  comment: string | null;
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
  const [tlsMode, setTlsMode] = useState("verify-full");
  const [tlsCaPath, setTlsCaPath] = useState("");

  const [profileId, setProfileId] = useState<string | null>(null);
  const [profileName, setProfileName] = useState("");
  const [environment, setEnvironment] = useState<string>("dev");
  const [saved, setSaved] = useState<ConnectionRecord[]>([]);

  const [status, setStatus] = useState<string>("");
  const [stages, setStages] = useState<TestStage[] | null>(null);
  const [connected, setConnected] = useState(false);
  const [connectedEnv, setConnectedEnv] = useState<string | null>(null);
  const [sql, setSql] = useState("select now(), version()");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<QueryResult | null>(null);

  // Explorer tree (E1.3): lazily loaded schemas → objects → columns.
  const [schemas, setSchemas] = useState<string[] | null>(null);
  const [openSchemas, setOpenSchemas] = useState<Record<string, boolean>>({});
  const [objects, setObjects] = useState<Record<string, DbObject[]>>({});
  const [openTables, setOpenTables] = useState<Record<string, boolean>>({});
  const [columns, setColumns] = useState<Record<string, DbColumn[]>>({});

  const refreshSaved = useCallback(async () => {
    try {
      setSaved(await invoke<ConnectionRecord[]>("connection_list"));
    } catch (e) {
      console.error(e);
    }
  }, []);

  useEffect(() => {
    invoke<AppInfo>("app_get_info").then(setInfo).catch(console.error);
    invoke<"dark" | "light" | null>("settings_get", { key: "theme" })
      .then((t) => t && setTheme(t))
      .catch(() => {});
    refreshSaved();
  }, [refreshSaved]);

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
    return {
      host,
      port,
      database,
      username,
      secretRef: ref,
      tlsMode,
      tlsCaPath: tlsCaPath || null,
    };
  }, [password, savePassword, secretRef, host, port, database, username, tlsMode, tlsCaPath]);

  const doTest = useCallback(async () => {
    setStatus("Testing…");
    setStages(null);
    try {
      const report = await invoke<TestReport>("pg_test", { params: await withSecret() });
      setStages(report.stages);
      const failed = report.stages.filter((s) => !s.passed);
      setStatus(
        failed.length === 0
          ? `OK — server ${report.serverVersion ?? "?"}`
          : `FAILED at ${failed[0].name}: ${failed[0].detail ?? "unknown"}`
      );
    } catch (e) {
      setStatus(`Error: ${e}`);
    }
  }, [withSecret]);

  const resetExplorer = useCallback(() => {
    setSchemas(null);
    setOpenSchemas({});
    setObjects({});
    setOpenTables({});
    setColumns({});
  }, []);

  const doConnect = useCallback(async () => {
    setStatus("Connecting…");
    try {
      await invoke("pg_connect", { params: await withSecret() });
      setConnected(true);
      setConnectedEnv(environment);
      setStatus("Connected");
      resetExplorer();
      invoke<string[]>("pg_metadata", { request: { kind: "list_schemas" } })
        .then(setSchemas)
        .catch((e) => setStatus(`Explorer error: ${e}`));
    } catch (e) {
      setStatus(`Error: ${e}`);
    }
  }, [withSecret, environment, resetExplorer]);

  const doDisconnect = useCallback(async () => {
    await invoke("pg_disconnect").catch(() => {});
    setConnected(false);
    setConnectedEnv(null);
    setResult(null);
    resetExplorer();
    setStatus("Disconnected");
  }, [resetExplorer]);

  const toggleSchema = useCallback(
    async (schema: string) => {
      const opening = !openSchemas[schema];
      setOpenSchemas((m) => ({ ...m, [schema]: opening }));
      if (opening && !(schema in objects)) {
        try {
          const objs = await invoke<DbObject[]>("pg_metadata", {
            request: { kind: "list_objects", schema },
          });
          setObjects((m) => ({ ...m, [schema]: objs }));
        } catch (e) {
          setStatus(`Explorer error: ${e}`);
        }
      }
    },
    [openSchemas, objects]
  );

  const toggleTable = useCallback(
    async (schema: string, name: string) => {
      const key = `${schema}.${name}`;
      const opening = !openTables[key];
      setOpenTables((m) => ({ ...m, [key]: opening }));
      if (opening && !(key in columns)) {
        try {
          const desc = await invoke<{ columns: DbColumn[] }>("pg_metadata", {
            request: { kind: "describe_object", schema, name },
          });
          setColumns((m) => ({ ...m, [key]: desc.columns }));
        } catch (e) {
          setStatus(`Explorer error: ${e}`);
        }
      }
    },
    [openTables, columns]
  );

  const insertSelect = useCallback((schema: string, name: string) => {
    setSql(`select * from "${schema}"."${name}" limit 100`);
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

  const doSaveProfile = useCallback(async () => {
    try {
      const rec = await invoke<ConnectionRecord>("connection_save", {
        input: {
          id: profileId,
          name: profileName || `${username || "user"}@${host}/${database}`,
          environment,
          color: null,
          readOnly: false,
          host,
          port,
          database,
          username,
          // Password (if typed) crosses IPC once and lands in the keychain.
          password: password || null,
          tlsMode,
          tlsCaPath: tlsCaPath || null,
        },
      });
      setPassword("");
      setProfileId(rec.id);
      setProfileName(rec.name);
      setSecretRef(rec.secretRef);
      setStatus(`Saved "${rec.name}"`);
      await refreshSaved();
    } catch (e) {
      setStatus(`Save error: ${e}`);
    }
  }, [profileId, profileName, environment, host, port, database, username, password, tlsMode, tlsCaPath, refreshSaved]);

  const loadProfile = useCallback((c: ConnectionRecord) => {
    setProfileId(c.id);
    setProfileName(c.name);
    setEnvironment(c.environment ?? "dev");
    setHost(c.host);
    setPort(c.port);
    setDatabase(c.database);
    setUsername(c.username);
    setSecretRef(c.secretRef);
    setTlsMode(c.tlsMode || "verify-full");
    setTlsCaPath(c.tlsCaPath ?? "");
    setPassword("");
    setStatus(`Loaded "${c.name}"`);
  }, []);

  const newProfile = useCallback(() => {
    setProfileId(null);
    setProfileName("");
    setSecretRef(null);
    setPassword("");
    setStatus("");
  }, []);

  const doDeleteProfile = useCallback(
    async (c: ConnectionRecord) => {
      try {
        await invoke("connection_delete", { id: c.id });
        if (profileId === c.id) newProfile();
        setStatus(`Deleted "${c.name}"`);
        await refreshSaved();
      } catch (e) {
        setStatus(`Delete error: ${e}`);
      }
    },
    [profileId, newProfile, refreshSaved]
  );

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
      {connected && connectedEnv === "prod" && (
        <div className="prod-banner" role="alert">
          PRODUCTION — connected to a prod-tagged database. Changes are live.
        </div>
      )}
      <main className="content with-sidebar">
        <aside className="sidebar">
          <div className="sidebar-head">
            <h2>Connections</h2>
            <button onClick={newProfile} title="New connection">
              +
            </button>
          </div>
          {saved.length === 0 && <p className="muted">No saved connections yet.</p>}
          <ul className="conn-list">
            {saved.map((c) => (
              <li
                key={c.id}
                className={c.id === profileId ? "active" : ""}
                onClick={() => loadProfile(c)}
              >
                <span className={`env env-${c.environment ?? "dev"}`}>
                  {(c.environment ?? "dev").slice(0, 4)}
                </span>
                <span className="conn-name" title={`${c.username}@${c.host}:${c.port}/${c.database}`}>
                  {c.name}
                </span>
                <button
                  className="ghost"
                  title="Delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    doDeleteProfile(c);
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          {connected && (
            <div className="explorer">
              <h2>Explorer</h2>
              {schemas === null && <p className="muted">Loading schemas…</p>}
              <ul className="tree">
                {(schemas ?? []).map((s) => (
                  <li key={s}>
                    <div className="tree-row" onClick={() => toggleSchema(s)}>
                      <span className="twisty">{openSchemas[s] ? "▾" : "▸"}</span>
                      <span className="tree-label">{s}</span>
                    </div>
                    {openSchemas[s] && (
                      <ul className="tree nested">
                        {!(s in objects) && <li className="muted">loading…</li>}
                        {(objects[s] ?? []).length === 0 && s in objects && (
                          <li className="muted">empty</li>
                        )}
                        {(objects[s] ?? []).map((o) => {
                          const key = `${s}.${o.name}`;
                          return (
                            <li key={o.name}>
                              <div className="tree-row" title={o.comment ?? o.kind}>
                                <span
                                  className="twisty"
                                  onClick={() => toggleTable(s, o.name)}
                                >
                                  {openTables[key] ? "▾" : "▸"}
                                </span>
                                <span className={`obj-kind kind-${o.kind}`}>
                                  {o.kind === "table" ? "T" : o.kind === "view" ? "V" : "M"}
                                </span>
                                <span
                                  className="tree-label clickable"
                                  onClick={() => insertSelect(s, o.name)}
                                  title={`Insert SELECT for ${key}`}
                                >
                                  {o.name}
                                </span>
                              </div>
                              {openTables[key] && (
                                <ul className="tree nested cols">
                                  {!(key in columns) && (
                                    <li className="muted">loading…</li>
                                  )}
                                  {(columns[key] ?? []).map((c) => (
                                    <li key={c.name} title={c.comment ?? ""}>
                                      <span className="col-name">
                                        {c.primaryKey ? "🔑 " : ""}
                                        {c.name}
                                      </span>
                                      <span className="muted">
                                        {c.dbType}
                                        {c.nullable ? "" : " · not null"}
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>
        <div className="main-col">
        <section className="panel">
          <h2>{profileId ? "Edit connection" : "New connection"}</h2>
          <div className="form-row">
            <input
              placeholder="profile name"
              value={profileName}
              onChange={(e) => setProfileName(e.target.value)}
            />
            <select value={environment} onChange={(e) => setEnvironment(e.target.value)}>
              <option value="dev">dev</option>
              <option value="test">test</option>
              <option value="staging">staging</option>
              <option value="prod">prod</option>
            </select>
          </div>
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
            <label className="muted">TLS</label>
            <select value={tlsMode} onChange={(e) => setTlsMode(e.target.value)}>
              <option value="verify-full">verify-full (default)</option>
              <option value="verify-ca">verify-ca</option>
              <option value="prefer">prefer (no verification)</option>
              <option value="disabled">disabled (local only)</option>
            </select>
            {(tlsMode === "verify-full" || tlsMode === "verify-ca") && (
              <input
                placeholder="CA file path (optional, PEM)"
                value={tlsCaPath}
                onChange={(e) => setTlsCaPath(e.target.value)}
                style={{ flex: 1 }}
              />
            )}
          </div>
          <div className="form-row">
            <button onClick={doSaveProfile}>Save</button>
            <button onClick={doTest}>Test</button>
            {connected ? (
              <button onClick={doDisconnect}>Disconnect</button>
            ) : (
              <button onClick={doConnect}>Connect</button>
            )}
            <span className="status">{status}</span>
          </div>
          {stages && (
            <ul className="stage-list">
              {stages.map((s) => (
                <li key={s.name} className={s.passed ? "ok" : "fail"}>
                  <span className="stage-icon">{s.passed ? "✓" : "✗"}</span>
                  <span className="stage-name">{s.name}</span>
                  <span className="muted">{s.durationMs}ms</span>
                  {s.detail && <span className="stage-detail">{s.detail}</span>}
                </li>
              ))}
            </ul>
          )}
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
        </div>
      </main>
    </div>
  );
}
