import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import SavedList from "./connections/SavedList";
import ConnectionForm from "./connections/ConnectionForm";
import ExplorerTree from "./explorer/ExplorerTree";
import QueryPanel from "./editor/QueryPanel";
import HistoryPanel from "./history/HistoryPanel";
import type {
  AppInfo,
  ConnectionRecord,
  DbColumn,
  DbObject,
  HistoryEntry,
  MetadataOut,
  PgParams,
  QueryResult,
  SshParams,
  TestReport,
  TestStage,
} from "./ipc/types";

export default function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  // Connection form
  const [host, setHost] = useState("localhost");
  const [port, setPort] = useState(5432);
  const [database, setDatabase] = useState("postgres");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [secretRef, setSecretRef] = useState<string | null>(null);
  const [tlsMode, setTlsMode] = useState("verify-full");
  const [tlsCaPath, setTlsCaPath] = useState("");

  // SSH tunnel (E1.2)
  const [sshEnabled, setSshEnabled] = useState(false);
  const [sshHost, setSshHost] = useState("");
  const [sshPort, setSshPort] = useState(22);
  const [sshUser, setSshUser] = useState("");
  const [sshKeyPath, setSshKeyPath] = useState("");
  const [sshFingerprint, setSshFingerprint] = useState("");

  // Profiles
  const [profileId, setProfileId] = useState<string | null>(null);
  const [profileName, setProfileName] = useState("");
  const [environment, setEnvironment] = useState<string>("dev");
  const [saved, setSaved] = useState<ConnectionRecord[]>([]);

  // Session
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

  // Explorer (E1.3)
  const [schemas, setSchemas] = useState<string[] | null>(null);
  const [openSchemas, setOpenSchemas] = useState<Record<string, boolean>>({});
  const [objects, setObjects] = useState<Record<string, DbObject[]>>({});
  const [openTables, setOpenTables] = useState<Record<string, boolean>>({});
  const [columns, setColumns] = useState<Record<string, DbColumn[]>>({});
  const [metaCached, setMetaCached] = useState(false);

  // History (E1.5)
  const [historyItems, setHistoryItems] = useState<HistoryEntry[]>([]);
  const [historySearch, setHistorySearch] = useState("");

  // --- bootstrap ------------------------------------------------------------

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

  // --- secrets & connection -------------------------------------------------

  const savePassword = useCallback(async () => {
    if (!password) return null;
    // The password crosses the IPC boundary exactly once, is stored in the
    // OS keychain, and only the opaque reference stays in frontend state.
    const ref = await invoke<string>("pg_secret_save", { password });
    setPassword("");
    setSecretRef(ref);
    return ref;
  }, [password]);

  const sshValue = useCallback((): SshParams | null => {
    if (!sshEnabled || !sshHost) return null;
    return {
      host: sshHost,
      port: sshPort,
      username: sshUser,
      keyPath: sshKeyPath,
      fingerprint: sshFingerprint,
    };
  }, [sshEnabled, sshHost, sshPort, sshUser, sshKeyPath, sshFingerprint]);

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
      ssh: sshValue(),
    };
  }, [password, savePassword, secretRef, host, port, database, username, tlsMode, tlsCaPath, environment, sshValue]);

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

  /** Live metadata when connected; pure cache lookups otherwise. */
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

  // --- transactions (E1.4) ----------------------------------------------------

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

  // --- explorer (E1.3) --------------------------------------------------------

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

  // --- query & history --------------------------------------------------------

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
      const msg = String(e);
      setStatus(`Error: ${msg}`);
      setResult(null);
      // Backend marks the session broken on network failures (E1.1);
      // reflect that here — the user must reconnect explicitly.
      if (msg.startsWith("Connection lost:")) {
        setConnected(false);
        setConnectedEnv(null);
        setInTx(false);
        setTxPrompt(false);
      }
    } finally {
      setRunning(false);
      refreshHistory(historySearch);
    }
  }, [sql, refreshHistory, historySearch]);

  const doCancel = useCallback(async () => {
    try {
      await invoke("pg_cancel");
      setStatus("Cancel requested");
    } catch (e) {
      setStatus(`Cancel error: ${e}`);
    }
  }, []);

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

  // --- profiles (E1.2) ----------------------------------------------------------

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
          sshJson: sshValue() ? JSON.stringify(sshValue()) : null,
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
  }, [profileId, profileName, environment, host, port, database, username, password, tlsMode, tlsCaPath, sshValue, refreshSaved]);

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
      if (c.sshJson) {
        try {
          const ssh = JSON.parse(c.sshJson) as SshParams;
          setSshEnabled(true);
          setSshHost(ssh.host);
          setSshPort(ssh.port || 22);
          setSshUser(ssh.username);
          setSshKeyPath(ssh.keyPath);
          setSshFingerprint(ssh.fingerprint ?? "");
        } catch {
          setSshEnabled(false);
        }
      } else {
        setSshEnabled(false);
        setSshHost("");
        setSshUser("");
        setSshKeyPath("");
        setSshFingerprint("");
      }
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
    setSshEnabled(false);
    setSshHost("");
    setSshUser("");
    setSshKeyPath("");
    setSshFingerprint("");
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

  // --- layout -------------------------------------------------------------------

  return (
    <div className="shell">
      <header className="titlebar">
        <span className="brand">TupleNest</span>
        <span className="muted">{info ? `v${info.version} · ${info.os}` : ""}</span>
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
          <SavedList
            saved={saved}
            activeId={profileId}
            onLoad={loadProfile}
            onNew={newProfile}
            onDelete={doDeleteProfile}
          />
          {(connected || schemas !== null) && (
            <ExplorerTree
              schemas={schemas}
              metaCached={metaCached}
              openSchemas={openSchemas}
              objects={objects}
              openTables={openTables}
              columns={columns}
              onToggleSchema={toggleSchema}
              onToggleTable={toggleTable}
              onInsertSelect={insertSelect}
            />
          )}
        </aside>
        <div className="main-col">
          <ConnectionForm
            isEdit={profileId !== null}
            profileName={profileName}
            environment={environment}
            host={host}
            port={port}
            database={database}
            username={username}
            password={password}
            hasSecret={secretRef !== null}
            tlsMode={tlsMode}
            tlsCaPath={tlsCaPath}
            connected={connected}
            status={status}
            stages={stages}
            sshEnabled={sshEnabled}
            sshHost={sshHost}
            sshPort={sshPort}
            sshUser={sshUser}
            sshKeyPath={sshKeyPath}
            sshFingerprint={sshFingerprint}
            onSshEnabled={setSshEnabled}
            onSshHost={setSshHost}
            onSshPort={setSshPort}
            onSshUser={setSshUser}
            onSshKeyPath={setSshKeyPath}
            onSshFingerprint={setSshFingerprint}
            onProfileName={setProfileName}
            onEnvironment={setEnvironment}
            onHost={setHost}
            onPort={setPort}
            onDatabase={setDatabase}
            onUsername={setUsername}
            onPassword={setPassword}
            onTlsMode={setTlsMode}
            onTlsCaPath={setTlsCaPath}
            onSave={doSaveProfile}
            onTest={doTest}
            onConnect={doConnect}
            onDisconnect={doDisconnect}
          />
          <QueryPanel
            sql={sql}
            onSqlChange={setSql}
            connected={connected}
            running={running}
            inTx={inTx}
            txPrompt={txPrompt}
            result={result}
            queryEpoch={queryEpoch}
            onRun={doRun}
            onCancel={doCancel}
            onBegin={doBegin}
            onCommit={doCommit}
            onRollback={doRollback}
            onCommitAndDisconnect={commitAndDisconnect}
            onRollbackAndDisconnect={rollbackAndDisconnect}
            onStayConnected={() => setTxPrompt(false)}
          />
          <HistoryPanel
            items={historyItems}
            search={historySearch}
            onSearch={setHistorySearch}
            onClear={clearHistory}
            onToggleFavorite={toggleFavorite}
            onLoad={setSql}
          />
          <p className="hint">
            Credentials never enter this WebView beyond one-time entry: they go
            straight to the OS keychain and only an opaque reference remains.
          </p>
        </div>
      </main>
    </div>
  );
}
