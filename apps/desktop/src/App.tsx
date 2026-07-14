import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Grid from "./results/Grid";

type AppInfo = { name: string; version: string; os: string };

type PgParams = {
  host: string;
  port: number;
  database: string;
  username: string;
  secretRef: string | null;
  tlsMode: string;
  tlsCaPath: string | null;
  environment?: string | null;
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

type MetadataOut<T> = { payload: T; cached: boolean; fetchedAt: number | null };

type DbObject = { name: string; kind: string; comment: string | null };

type DbColumn = {
  name: string;
  dbType: string;
  nullable: boolean;
  primaryKey: boolean;
  comment: string | null;
};

type HistoryEntry = {
  id: string;
  connectionKey: string;
  sqlText: string | null;
  status: "success" | "error" | "cancelled";
  errorText: string | null;
  rowsReturned: number;
  rowsAffected: number | null;
  startedAt: number;
  durationMs: number;
  favorite: boolean;
};

type QueryResult = {
  columns: { name: string; dbType: string }[];
  totalRows: number;
  storedRows: number;
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
  const [queryEpoch, setQueryEpoch] = useState(0);
  const [inTx, setInTx] = useState(false);
  const [txPrompt, setTxPrompt] = useState(false);

  // Explorer tree (E1.3): lazily loaded schemas → objects → columns.
  const [schemas, setSchemas] = useState<string[] | null>(null);
  const [openSchemas, setOpenSchemas] = useState<Record<string, boolean>>({});
  const [objects, setObjects] = useState<Record<string, DbObject[]>>({});
  const [openTables, setOpenTables] = useState<Record<string, boolean>>({});
  const [columns, setColumns] = useState<Record<string, DbColumn[]>>({});
  const [metaCached, setMetaCached] = useState(false);

  // Query history (E1.5)
  const [historyItems, setHistoryItems] = useState<HistoryEntry[]>([]);
  const [historySearch, setHistorySearch] = useState("");

  const refreshHistory = useCallback(async (search: string) => {
    try {
      setHistoryItems(
        await invoke<HistoryEntry[]>("history_list", { search: search || null, limit: 50 })
      );
    } catch (e) {
      console.error(e);
    }
  }, []);

  useEffect(() => {
    refreshHistory(historySearch);
  }, [historySearch, refreshHistory]);

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
      environment,
    };
  }, [password, savePassword, secretRef, host, port, database, username, tlsMode, tlsCaPath, environment]);

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
    setMetaCached(false);
  }, []);

  /// Live metadata when connected (server may still serve stale cache on
  /// failure); pure cache lookups otherwise.
  const metaFetch = useCallback(
    async (request: Record<string, unknown>): Promise<MetadataOut<unknown> | null> => {
      if (connected) {
        return await invoke<MetadataOut<unknown>>("pg_metadata", { request });
      }
      return await invoke<MetadataOut<unknown> | null>("pg_metadata_cached", {
        params: {
          host,
          port,
          database,
          username,
          secretRef: null,
          tlsMode,
          tlsCaPath: null,
        },
        request,
      });
    },
    [connected, host, port, database, username, tlsMode]
  );

  const doConnect = useCallback(async () => {
    setStatus("Connecting…");
    try {
      await invoke("pg_connect", { params: await withSecret() });
      setConnected(true);
      setConnectedEnv(environment);
      setStatus("Connected");
      resetExplorer();
      invoke<MetadataOut<string[]>>("pg_metadata", { request: { kind: "list_schemas" } })
        .then((r) => {
          setSchemas(r.payload);
          setMetaCached(r.cached);
        })
        .catch((e) => setStatus(`Explorer error: ${e}`));
    } catch (e) {
      setStatus(`Error: ${e}`);
    }
  }, [withSecret, environment, resetExplorer]);

  const reallyDisconnect = useCallback(async () => {
    await invoke("pg_disconnect").catch(() => {});
    setConnected(false);
    setConnectedEnv(null);
    setResult(null);
    setInTx(false);
    setTxPrompt(false);
    resetExplorer();
    setStatus("Disconnected");
  }, [resetExplorer]);

  const doDisconnect = useCallback(async () => {
    // E1.4 rule: never silently drop an open transaction.
    if (inTx) {
      setTxPrompt(true);
      return;
    }
    await reallyDisconnect();
  }, [inTx, reallyDisconnect]);

  const doBegin = useCallback(async () => {
    try {
      await invoke("pg_begin");
      setInTx(true);
      setStatus("Transaction started");
    } catch (e) {
      setStatus(`Begin error: ${e}`);
    }
  }, []);

  const doCommit = useCallback(async () => {
    try {
      await invoke("pg_commit");
      setInTx(false);
      setStatus("Committed");
    } catch (e) {
      setStatus(`Commit error: ${e}`);
    }
  }, []);

  const doRollback = useCallback(async () => {
    try {
      await invoke("pg_rollback");
      setInTx(false);
      setStatus("Rolled back");
    } catch (e) {
      setStatus(`Rollback error: ${e}`);
    }
  }, []);

  const commitAndDisconnect = useCallback(async () => {
    try {
      await invoke("pg_commit");
    } catch (e) {
      setStatus(`Commit error: ${e}`);
      return; // stay connected; user can inspect
    }
    setInTx(false);
    await reallyDisconnect();
  }, [reallyDisconnect]);

  const rollbackAndDisconnect = useCallback(async () => {
    await invoke("pg_rollback").catch(() => {});
    setInTx(false);
    await reallyDisconnect();
  }, [reallyDisconnect]);

  const toggleSchema = useCallback(
    async (schema: string) => {
      const opening = !openSchemas[schema];
      setOpenSchemas((m) => ({ ...m, [schema]: opening }));
      if (opening && !(schema in objects)) {
        try {
          const r = await metaFetch({ kind: "list_objects", schema });
          if (r) {
            setObjects((m) => ({ ...m, [schema]: r.payload as DbObject[] }));
            if (r.cached) setMetaCached(true);
          } else {
            setObjects((m) => ({ ...m, [schema]: [] }));
          }
        } catch (e) {
          setStatus(`Explorer error: ${e}`);
        }
      }
    },
    [openSchemas, objects, metaFetch]
  );

  const toggleTable = useCallback(
    async (schema: string, name: string) => {
      const key = `${schema}.${name}`;
      const opening = !openTables[key];
      setOpenTables((m) => ({ ...m, [key]: opening }));
      if (opening && !(key in columns)) {
        try {
          const r = await metaFetch({ kind: "describe_object", schema, name });
          if (r) {
            const desc = r.payload as { columns: DbColumn[] };
            setColumns((m) => ({ ...m, [key]: desc.columns }));
            if (r.cached) setMetaCached(true);
          } else {
            setColumns((m) => ({ ...m, [key]: [] }));
          }
        } catch (e) {
          setStatus(`Explorer error: ${e}`);
        }
      }
    },
    [openTables, columns, metaFetch]
  );

  const insertSelect = useCallback((schema: string, name: string) => {
    setSql(`select * from "${schema}"."${name}" limit 100`);
  }, []);

  const doRun = useCallback(async () => {
    setRunning(true);
    setStatus("Running…");
    try {
      const r = await invoke<QueryResult>("pg_query", { sql });
      setResult(r);
      setQueryEpoch((n) => n + 1);
      setStatus(
        r.columns.length > 0
          ? `${r.totalRows} row(s) in ${r.elapsedMs}ms${
              r.truncated ? ` (first ${r.storedRows.toLocaleString()} kept for scrolling)` : ""
            }`
          : `${r.rowsAffected ?? 0} row(s) affected in ${r.elapsedMs}ms`
      );
    } catch (e) {
      setStatus(`Error: ${e}`);
      setResult(null);
    } finally {
      setRunning(false);
      refreshHistory(historySearch);
    }
  }, [sql, refreshHistory, historySearch]);

  const toggleFavorite = useCallback(
    async (h: HistoryEntry) => {
      try {
        await invoke("history_favorite", { id: h.id, favorite: !h.favorite });
        await refreshHistory(historySearch);
      } catch (e) {
        console.error(e);
      }
    },
    [refreshHistory, historySearch]
  );

  const clearHistory = useCallback(async () => {
    try {
      await invoke("history_clear", { includeFavorites: false });
      await refreshHistory(historySearch);
    } catch (e) {
      console.error(e);
    }
  }, [refreshHistory, historySearch]);

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

  const loadProfile = useCallback(
    (c: ConnectionRecord) => {
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
      if (connected) return; // live explorer stays as-is
      // Offline/pre-connect: render the explorer from the metadata cache.
      resetExplorer();
      invoke<MetadataOut<string[]> | null>("pg_metadata_cached", {
        params: {
          host: c.host,
          port: c.port,
          database: c.database,
          username: c.username,
          secretRef: null,
          tlsMode: c.tlsMode || "verify-full",
          tlsCaPath: null,
        },
        request: { kind: "list_schemas" },
      })
        .then((r) => {
          if (r) {
            setSchemas(r.payload);
            setMetaCached(true);
          }
        })
        .catch(() => {});
    },
    [connected, resetExplorer]
  );

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
          {(connected || schemas !== null) && (
            <div className="explorer">
              <h2>
                Explorer{" "}
                {metaCached && (
                  <span className="cache-badge" title="Served from local metadata cache">
                    cached
                  </span>
                )}
              </h2>
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
            <span className="tx-sep" />
            {!inTx ? (
              <button onClick={doBegin} disabled={!connected}>
                Begin
              </button>
            ) : (
              <>
                <span className="tx-chip">IN TRANSACTION</span>
                <button onClick={doCommit}>Commit</button>
                <button onClick={doRollback}>Rollback</button>
              </>
            )}
          </div>
          {txPrompt && (
            <div className="tx-prompt" role="alertdialog">
              <span>
                A transaction is still open. What should happen to it before
                disconnecting?
              </span>
              <button onClick={commitAndDisconnect}>Commit &amp; disconnect</button>
              <button onClick={rollbackAndDisconnect}>Rollback &amp; disconnect</button>
              <button onClick={() => setTxPrompt(false)}>Stay connected</button>
            </div>
          )}
          {result && result.columns.length > 0 && (
            <Grid
              columns={result.columns}
              storedRows={result.storedRows}
              epoch={queryEpoch}
            />
          )}
        </section>

        <section className="panel">
          <h2>History</h2>
          <div className="form-row">
            <input
              placeholder="search history…"
              value={historySearch}
              onChange={(e) => setHistorySearch(e.target.value)}
              style={{ flex: 1 }}
            />
            <button onClick={clearHistory} title="Clear non-favorites">
              Clear
            </button>
          </div>
          {historyItems.length === 0 && <p className="muted">No history yet.</p>}
          <ul className="history-list">
            {historyItems.map((h) => (
              <li key={h.id} title={h.errorText ?? h.sqlText ?? ""}>
                <span className={`hstatus ${h.status}`}>
                  {h.status === "success" ? "✓" : h.status === "cancelled" ? "⊘" : "✗"}
                </span>
                <span
                  className={`hsql ${h.sqlText ? "clickable" : ""}`}
                  onClick={() => h.sqlText && setSql(h.sqlText)}
                >
                  {h.sqlText ?? <em className="muted">(query text hidden — prod)</em>}
                </span>
                <span className="muted hmeta">
                  {h.status === "success"
                    ? `${h.rowsReturned || h.rowsAffected || 0} rows`
                    : h.status}
                  {" · "}
                  {h.durationMs}ms
                  {" · "}
                  {new Date(h.startedAt * 1000).toLocaleTimeString()}
                </span>
                <button
                  className={`ghost star ${h.favorite ? "on" : ""}`}
                  title={h.favorite ? "Unfavorite" : "Favorite"}
                  onClick={() => toggleFavorite(h)}
                >
                  {h.favorite ? "★" : "☆"}
                </button>
              </li>
            ))}
          </ul>
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
