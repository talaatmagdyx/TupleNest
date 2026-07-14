import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Titlebar from "./app-shell/Titlebar";
import StatusBar from "./app-shell/StatusBar";
import ActivityRail, { type RailView } from "./app-shell/ActivityRail";
import HistoryPanel from "./history/HistoryPanel";
import SavedList from "./connections/SavedList";
import ConnectionForm from "./connections/ConnectionForm";
import ExplorerTree from "./explorer/ExplorerTree";
import TabsBar, { type QueryTab } from "./editor/TabsBar";
import QueryPanel, { type ChartDatum, type ResultTab } from "./editor/QueryPanel";
import {
  Cheatsheet,
  ConnLost,
  Guard,
  Inspector,
  Palette,
  Settings,
  TxPrompt,
  type PaletteItem,
} from "./overlays/Overlays";
import SchemaModal, { type SchemaExtra } from "./overlays/SchemaModal";
import MonitorModal from "./overlays/MonitorModal";
import DiagramModal from "./overlays/DiagramModal";
import AuditModal from "./overlays/AuditModal";
import ExplainModal, { type PlanNode, type PlanStats } from "./overlays/ExplainModal";
import { UpdateToast } from "./overlays/Overlays";
import { ParamPrompt } from "./overlays/Overlays";
import {
  coerceParam,
  fetchAllRows,
  formatSQL,
  looksLikeSelect,
  needsGuard,
  paramCount,
  toCSV,
  toJSONExport,
  toMarkdown,
} from "./lib/sql";
import type {
  AppInfo,
  ConnectionRecord,
  DbColumn,
  DbObject,
  HistoryEntry,
  MetadataOut,
  PgParams,
  QueryResult,
  SnippetRecord,
  SshParams,
  TestReport,
  TestStage,
} from "./ipc/types";

type OverlayKind =
  | null
  | "palette"
  | "connEditor"
  | "txPrompt"
  | "guard"
  | "connLost"
  | "settings"
  | "explain"
  | "schema"
  | "cheatsheet"
  | "inspect"
  | "monitor"
  | "params"
  | "diagram"
  | "audit";

export default function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [telemetry, setTelemetry] = useState(false);

  // Connection form
  const [host, setHost] = useState("localhost");
  const [port, setPort] = useState(5432);
  const [database, setDatabase] = useState("postgres");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [secretRef, setSecretRef] = useState<string | null>(null);
  const [tlsMode, setTlsMode] = useState("verify-full");
  const [tlsCaPath, setTlsCaPath] = useState("");
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
  const [status, setStatus] = useState("");
  const [stages, setStages] = useState<TestStage[] | null>(null);
  const [testing, setTesting] = useState(false);
  const [testSummary, setTestSummary] = useState("");
  const [updateInfo, setUpdateInfo] = useState<{ version: string; notes: string } | null>(null);
  const [connected, setConnected] = useState(false);
  const [connectedEnv, setConnectedEnv] = useState<string | null>(null);
  const [serverVersion, setServerVersion] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [queryEpoch, setQueryEpoch] = useState(0);
  const [runStatus, setRunStatus] = useState<{ icon: string; text: string; color: string } | null>(null);
  const [inTx, setInTx] = useState(false);
  const [txOpenSince, setTxOpenSince] = useState<number | null>(null);
  const [, setTick] = useState(0); // re-render for tx timer

  // Workspace / UI
  const [tabs, setTabs] = useState<QueryTab[]>([
    { name: "untitled-1.sql", sql: "select now(), version()", dirty: false },
  ]);
  const [activeTab, setActiveTab] = useState(0);
  const untitledSeq = useRef(2);
  const [overlay, setOverlay] = useState<OverlayKind>(null);
  const [paletteQ, setPaletteQ] = useState("");
  const [paletteIdx, setPaletteIdx] = useState(0);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [railView, setRailView] = useState<RailView>("explorer");
  const [connMenu, setConnMenu] = useState(false);
  const [exportMenu, setExportMenu] = useState(false);
  const [resultTab, setResultTab] = useState<ResultTab>("results");
  const [editorH, setEditorH] = useState(200);
  const dragRef = useRef<{ y: number; h: number } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [inspectText, setInspectText] = useState("");
  const copyable = useRef<string | null>(null);
  const [guardSql, setGuardSql] = useState<string | null>(null);
  const [paramValues, setParamValues] = useState<string[]>([]);
  const [connLostDetail, setConnLostDetail] = useState("");
  const [rowsInfo, setRowsInfo] = useState("");
  const [chart, setChart] = useState<{ title: string; sub: string; data: ChartDatum[] } | null>(null);
  const [schemaTarget, setSchemaTarget] = useState<{ schema: string; name: string; kind: string } | null>(null);
  const [schemaCols, setSchemaCols] = useState<DbColumn[] | null>(null);
  const [schemaExtra, setSchemaExtra] = useState<SchemaExtra | null>(null);
  const [inspectCol, setInspectCol] = useState<string | undefined>(undefined);
  const [explain, setExplain] = useState<{
    title: string;
    analyzed: boolean;
    nodes: PlanNode[] | null;
    stats: PlanStats;
    suggestion: string | null;
    error: string | null;
  } | null>(null);

  // Explorer
  const [schemas, setSchemas] = useState<string[] | null>(null);
  const [openSchemas, setOpenSchemas] = useState<Record<string, boolean>>({});
  const [objects, setObjects] = useState<Record<string, DbObject[]>>({});
  const [openTables, setOpenTables] = useState<Record<string, boolean>>({});
  const [columns, setColumns] = useState<Record<string, DbColumn[]>>({});
  const [metaCached, setMetaCached] = useState(false);

  // History
  const [historyItems, setHistoryItems] = useState<HistoryEntry[]>([]);
  const [historySearch, setHistorySearch] = useState("");

  // Snippets (Phase 2)
  const [snippets, setSnippets] = useState<SnippetRecord[]>([]);

  const showToast = useCallback((t: string) => {
    setToast(t);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2100);
  }, []);

  /* ---------------- bootstrap ---------------- */

  const refreshHistory = useCallback(async (search: string) => {
    try {
      setHistoryItems(await invoke<HistoryEntry[]>("history_list", { search: search || null, limit: 50 }));
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

  const refreshSnippets = useCallback(async () => {
    try {
      setSnippets(await invoke<SnippetRecord[]>("snippet_list"));
    } catch (e) {
      console.error(e);
    }
  }, []);


  useEffect(() => {
    invoke<AppInfo>("app_get_info").then(setInfo).catch(console.error);
    invoke<"dark" | "light" | null>("settings_get", { key: "theme" })
      .then((t) => t && setTheme(t))
      .catch(() => {});
    invoke<boolean | null>("settings_get", { key: "telemetry" })
      .then((v) => setTelemetry(!!v))
      .catch(() => {});
    refreshSaved();
    refreshSnippets();
  }, [refreshSaved, refreshSnippets]);

  useEffect(() => {
    document.documentElement.setAttribute("data-tn-theme", theme);
  }, [theme]);

  useEffect(() => {
    if (!txOpenSince) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [txOpenSince]);

  const applyTheme = useCallback(async (t: "dark" | "light") => {
    setTheme(t);
    await invoke("settings_set", { key: "theme", value: t }).catch(() => {});
  }, []);

  const applyTelemetry = useCallback(async (v: boolean) => {
    setTelemetry(v);
    await invoke("settings_set", { key: "telemetry", value: v }).catch(() => {});
  }, []);

  /* ---------------- params & connection ---------------- */

  const sshValue = useCallback((): SshParams | null => {
    if (!sshEnabled || !sshHost) return null;
    return { host: sshHost, port: sshPort, username: sshUser, keyPath: sshKeyPath, fingerprint: sshFingerprint };
  }, [sshEnabled, sshHost, sshPort, sshUser, sshKeyPath, sshFingerprint]);

  const savePassword = useCallback(async () => {
    if (!password) return null;
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
      ssh: sshValue(),
    };
  }, [password, savePassword, secretRef, host, port, database, username, tlsMode, tlsCaPath, environment, sshValue]);

  const resetExplorer = useCallback(() => {
    setSchemas(null);
    setOpenSchemas({});
    setObjects({});
    setOpenTables({});
    setColumns({});
    setMetaCached(false);
  }, []);

  const metaFetch = useCallback(
    async (request: Record<string, unknown>): Promise<MetadataOut<unknown> | null> => {
      if (connected) return await invoke<MetadataOut<unknown>>("pg_metadata", { request });
      return await invoke<MetadataOut<unknown> | null>("pg_metadata_cached", {
        params: { host, port, database, username, secretRef: null, tlsMode, tlsCaPath: null },
        request,
      });
    },
    [connected, host, port, database, username, tlsMode]
  );

  const loadServerVersion = useCallback(async () => {
    try {
      const r = await invoke<MetadataOut<{ version: string }>>("pg_metadata", {
        request: { kind: "server_info" },
      });
      const m = /PostgreSQL ([\d.]+)/.exec(r.payload.version ?? "");
      setServerVersion(m ? m[1] : null);
    } catch {
      setServerVersion(null);
    }
  }, []);

  const afterConnect = useCallback(
    (env: string) => {
      setConnected(true);
      setConnectedEnv(env);
      setStatus("Connected");
      resetExplorer();
      invoke<MetadataOut<string[]>>("pg_metadata", { request: { kind: "list_schemas" } })
        .then((r) => {
          setSchemas(r.payload);
          setMetaCached(r.cached);
        })
        .catch((e) => setStatus(`Explorer error: ${e}`));
      loadServerVersion();
    },
    [resetExplorer, loadServerVersion]
  );

  const doConnect = useCallback(async () => {
    setStatus("Connecting…");
    try {
      await invoke("pg_connect", { params: await withSecret() });
      afterConnect(environment);
      showToast(`Connected — ${username}@${host}/${database}`);
    } catch (e) {
      setStatus(`Error: ${e}`);
      showToast(String(e).slice(0, 90));
    }
  }, [withSecret, environment, afterConnect, showToast, username, host, database]);

  const reallyDisconnect = useCallback(async () => {
    await invoke("pg_disconnect").catch(() => {});
    setConnected(false);
    setConnectedEnv(null);
    setServerVersion(null);
    setResult(null);
    setLastError(null);
    setRunStatus(null);
    setInTx(false);
    setTxOpenSince(null);
    setOverlay(null);
    resetExplorer();
    setStatus("Disconnected");
  }, [resetExplorer]);

  const doDisconnect = useCallback(async () => {
    if (inTx) {
      setOverlay("txPrompt");
      return;
    }
    await reallyDisconnect();
  }, [inTx, reallyDisconnect]);

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
      if (connected) return;
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

  /** Titlebar switcher: load profile AND connect (HUD behavior). */
  const selectProfile = useCallback(
    async (c: ConnectionRecord) => {
      setConnMenu(false);
      if (inTx) {
        setOverlay("txPrompt");
        return;
      }
      await invoke("pg_disconnect").catch(() => {});
      setConnected(false);
      loadProfile(c);
      setStatus("Connecting…");
      try {
        const ssh = c.sshJson ? (JSON.parse(c.sshJson) as SshParams) : null;
        await invoke("pg_connect", {
          params: {
            host: c.host,
            port: c.port,
            database: c.database,
            username: c.username,
            secretRef: c.secretRef,
            tlsMode: c.tlsMode || "verify-full",
            tlsCaPath: c.tlsCaPath,
            environment: c.environment,
            ssh,
          },
        });
        afterConnect(c.environment ?? "dev");
        showToast(`Connected — ${c.name}`);
      } catch (e) {
        setStatus(`Error: ${e}`);
        showToast(String(e).slice(0, 90));
      }
    },
    [inTx, loadProfile, afterConnect, showToast]
  );

  /* ---------------- test / save profile ---------------- */

  const doTest = useCallback(async () => {
    setTesting(true);
    setStages(null);
    setStatus("Testing…");
    try {
      const report = await invoke<TestReport>("pg_test", { params: await withSecret() });
      // Progressive reveal (HUD design): stages appear one by one.
      setStages([]);
      setTestSummary("");
      report.stages.forEach((s, i) => {
        setTimeout(() => {
          setStages((prev) => [...(prev ?? []), s]);
          if (i === report.stages.length - 1) {
            setTesting(false);
            const failed = report.stages.filter((x) => !x.passed);
            const summary =
              failed.length === 0
                ? `OK — server ${report.serverVersion ?? "?"}`
                : `FAILED at ${failed[0].name}`;
            setTestSummary(summary);
            setStatus(summary);
          }
        }, 160 * (i + 1));
      });
      if (report.stages.length === 0) setTesting(false);
    } catch (e) {
      setTesting(false);
      setStatus(`Error: ${e}`);
    }
  }, [withSecret]);

  const doSaveProfile = useCallback(async (): Promise<ConnectionRecord | null> => {
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
      return rec;
    } catch (e) {
      setStatus(`Save error: ${e}`);
      return null;
    }
  }, [profileId, profileName, environment, host, port, database, username, password, tlsMode, tlsCaPath, sshValue, refreshSaved]);

  const saveAndConnect = useCallback(async () => {
    const rec = await doSaveProfile();
    if (!rec) return;
    setOverlay(null);
    await doConnect();
  }, [doSaveProfile, doConnect]);

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
    setStages(null);
    setStatus("");
    setOverlay("connEditor");
    setConnMenu(false);
  }, []);

  const editProfile = useCallback(
    (c: ConnectionRecord) => {
      loadProfile(c);
      setStages(null);
      setOverlay("connEditor");
    },
    [loadProfile]
  );

  const doDeleteProfile = useCallback(
    async (c: ConnectionRecord) => {
      try {
        await invoke("connection_delete", { id: c.id });
        if (profileId === c.id) setProfileId(null);
        showToast(`Deleted "${c.name}"`);
        await refreshSaved();
      } catch (e) {
        setStatus(`Delete error: ${e}`);
      }
    },
    [profileId, refreshSaved, showToast]
  );

  /* ---------------- explorer ---------------- */

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
          } else setObjects((m) => ({ ...m, [schema]: [] }));
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
          } else setColumns((m) => ({ ...m, [key]: [] }));
        } catch (e) {
          setStatus(`Explorer error: ${e}`);
        }
      }
    },
    [openTables, columns, metaFetch]
  );

  const setActiveSql = useCallback(
    (sql: string, opts?: { markClean?: boolean }) => {
      setTabs((ts) => {
        const out = [...ts];
        if (out.length === 0) return [{ name: "untitled-1.sql", sql, dirty: false }];
        out[activeTab] = { ...out[activeTab], sql, dirty: !opts?.markClean };
        return out;
      });
    },
    [activeTab]
  );

  const insertSelect = useCallback(
    (schema: string, name: string) => {
      setActiveSql(`select * from "${schema}"."${name}" limit 100`);
      showToast(`Inserted select for ${schema}.${name}`);
    },
    [setActiveSql, showToast]
  );

  const describeObject = useCallback(
    async (schema: string, name: string) => {
      const kind = (objects[schema] ?? []).find((o) => o.name === name)?.kind ?? "table";
      setSchemaTarget({ schema, name, kind });
      setSchemaCols(null);
      setSchemaExtra(null);
      setOverlay("schema");
      try {
        const r = await metaFetch({ kind: "describe_object", schema, name });
        if (r) {
          const payload = r.payload as {
            columns: DbColumn[];
            indexes?: { name: string; def: string }[];
            rowsEstimate?: number | null;
            totalSize?: string | null;
            comment?: string | null;
          };
          setSchemaCols(payload.columns);
          setSchemaExtra({
            indexes: payload.indexes ?? [],
            rowsEstimate: payload.rowsEstimate ?? null,
            totalSize: payload.totalSize ?? null,
            comment: payload.comment ?? null,
          });
        }
      } catch (e) {
        showToast(`Describe failed: ${String(e).slice(0, 60)}`);
      }
    },
    [objects, metaFetch, showToast]
  );

  const doFormat = useCallback(() => {
    const sql = tabs[activeTab]?.sql ?? "";
    if (!sql.trim()) return;
    setActiveSql(formatSQL(sql));
    showToast("Formatted");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, activeTab, setActiveSql, showToast]);

  const saveSnippet = useCallback(async () => {
    const body = tabs[activeTab]?.sql ?? "";
    if (!body.trim()) {
      showToast("Nothing to save");
      return;
    }
    const name = window.prompt("Snippet name:", body.slice(0, 40).replace(/\s+/g, " ").trim());
    if (!name) return;
    try {
      await invoke("snippet_save", { id: null, name, body, tags: null });
      await refreshSnippets();
      showToast(`Saved snippet "${name}"`);
    } catch (e) {
      showToast(String(e).slice(0, 70));
    }
  }, [tabs, activeTab, showToast, refreshSnippets]);

  /* ---------------- tabs ---------------- */

  const newTab = useCallback(() => {
    setTabs((ts) => [...ts, { name: `untitled-${untitledSeq.current++}.sql`, sql: "", dirty: false }]);
    setTabs((ts) => {
      setActiveTab(ts.length - 1);
      return ts;
    });
  }, []);

  const closeTab = useCallback(
    (i: number) => {
      setTabs((ts) => {
        const out = ts.filter((_, x) => x !== i);
        setActiveTab((a) => Math.max(0, Math.min(a >= i ? a - 1 : a, out.length - 1)));
        return out;
      });
    },
    []
  );

  /* ---------------- run / transactions / explain ---------------- */

  const currentSql = tabs[activeTab]?.sql ?? "";

  const doRun = useCallback(
    async (force = false, boundParams?: unknown[]) => {
      const sql = tabs[activeTab]?.sql ?? "";
      if (!sql.trim() || !connected) return;
      if (!force && needsGuard(sql, connectedEnv)) {
        setGuardSql(sql);
        setOverlay("guard");
        return;
      }
      // Phase 3: if the SQL has $n placeholders and none were supplied, prompt.
      const pc = paramCount(sql);
      if (pc > 0 && boundParams === undefined) {
        setParamValues(Array(pc).fill(""));
        setOverlay("params");
        return;
      }
      setRunning(true);
      setRunStatus(null);
      setChart(null);
      try {
        const r = await invoke<QueryResult>("pg_query", {
          sql,
          params: boundParams ?? null,
        });
        setResult(r);
        setLastError(null);
        setQueryEpoch((n) => n + 1);
        setResultTab("results");
        setTabs((ts) => {
          const out = [...ts];
          if (out[activeTab]) out[activeTab] = { ...out[activeTab], dirty: false };
          return out;
        });
        const text =
          r.columns.length > 0
            ? `${r.totalRows.toLocaleString()} row(s) in ${r.elapsedMs}ms${
                r.truncated ? ` (first ${r.storedRows.toLocaleString()} kept for scrolling)` : ""
              }`
            : `${r.rowsAffected ?? 0} row(s) affected in ${r.elapsedMs}ms`;
        setRunStatus({ icon: "✓", text, color: "var(--tn-success)" });
      } catch (e) {
        const msg = String(e);
        setResult(null);
        setLastError(msg);
        setRunStatus({ icon: "✕", text: msg, color: "var(--tn-danger)" });
        if (msg.startsWith("Connection lost:")) {
          setConnected(false);
          setConnectedEnv(null);
          setInTx(false);
          setTxOpenSince(null);
          setConnLostDetail(msg);
          setOverlay("connLost");
        }
      } finally {
        setRunning(false);
        refreshHistory(historySearch);
      }
    },
    [tabs, activeTab, connected, connectedEnv, refreshHistory, historySearch]
  );

  const doCancel = useCallback(async () => {
    try {
      await invoke("pg_cancel");
      showToast("Cancel requested");
    } catch (e) {
      showToast(`Cancel error: ${String(e).slice(0, 60)}`);
    }
  }, [showToast]);

  const doBegin = useCallback(async () => {
    try {
      await invoke("pg_begin");
      setInTx(true);
      setTxOpenSince(Date.now());
      showToast("Transaction started");
    } catch (e) {
      showToast(String(e).slice(0, 80));
    }
  }, [showToast]);

  const doCommit = useCallback(async () => {
    try {
      await invoke("pg_commit");
      setInTx(false);
      setTxOpenSince(null);
      showToast("COMMIT");
    } catch (e) {
      showToast(`Commit error: ${String(e).slice(0, 70)}`);
    }
  }, [showToast]);

  const doRollback = useCallback(async () => {
    try {
      await invoke("pg_rollback");
      setInTx(false);
      setTxOpenSince(null);
      showToast("ROLLBACK");
    } catch (e) {
      showToast(`Rollback error: ${String(e).slice(0, 70)}`);
    }
  }, [showToast]);

  const commitAndDisconnect = useCallback(async () => {
    try {
      await invoke("pg_commit");
    } catch (e) {
      showToast(`Commit error: ${String(e).slice(0, 70)}`);
      setOverlay(null);
      return;
    }
    setInTx(false);
    setTxOpenSince(null);
    await reallyDisconnect();
    showToast("Committed & disconnected");
  }, [reallyDisconnect, showToast]);

  const rollbackAndDisconnect = useCallback(async () => {
    await invoke("pg_rollback").catch(() => {});
    setInTx(false);
    setTxOpenSince(null);
    await reallyDisconnect();
    showToast("Rolled back & disconnected");
  }, [reallyDisconnect, showToast]);

  type RawPlan = Record<string, unknown> & { Plans?: RawPlan[] };

  const runExplain = useCallback(async () => {
    const sql = tabs[activeTab]?.sql ?? "";
    if (!sql.trim() || !connected) return;
    const analyzed = looksLikeSelect(sql);
    setExplain({ title: tabs[activeTab]?.name ?? "query", analyzed, nodes: null, stats: [], suggestion: null, error: null });
    setOverlay("explain");
    try {
      const stmt = `explain (${analyzed ? "analyze, " : ""}format json, buffers) ${sql}`;
      await invoke<QueryResult>("pg_query", { sql: stmt });
      const rows = await invoke<unknown[][]>("pg_rows", { offset: 0, limit: 1 });
      const cell = rows[0]?.[0];
      const parsed = typeof cell === "string" ? JSON.parse(cell) : cell;
      const root = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, unknown>;
      const plan = root["Plan"] as RawPlan;
      const total = (plan["Actual Total Time"] as number) ?? (plan["Total Cost"] as number) ?? 1;
      const nodes: PlanNode[] = [];
      let hotIdx = 0;
      let hotVal = -1;
      const walk = (n: RawPlan, depth: number) => {
        const ms = (n["Actual Total Time"] as number) ?? null;
        const cost = (n["Total Cost"] as number) ?? 0;
        const metric = ms ?? cost;
        const rel = n["Relation Name"] ? ` on ${n["Relation Name"]}` : "";
        const detailBits = [
          n["Index Name"] ? `index: ${n["Index Name"]}` : null,
          n["Filter"] ? `filter: ${n["Filter"]}` : null,
          n["Hash Cond"] ? `cond: ${n["Hash Cond"]}` : null,
          n["Sort Key"] ? `sort key: ${(n["Sort Key"] as string[]).join(", ")}` : null,
          n["Actual Rows"] !== undefined ? `rows ${(n["Actual Rows"] as number).toLocaleString()}` : n["Plan Rows"] !== undefined ? `est rows ${(n["Plan Rows"] as number).toLocaleString()}` : null,
        ].filter(Boolean);
        const i = nodes.length;
        nodes.push({
          kind: String(n["Node Type"] ?? "node"),
          title: `${n["Node Type"]}${rel}`,
          detail: detailBits.join(" · "),
          ms,
          pct: Math.min(100, (metric / total) * 100),
          indent: depth,
          hot: false,
        });
        if ((n["Node Type"] as string)?.includes("Seq Scan") && metric > hotVal) {
          hotVal = metric;
          hotIdx = i;
        }
        (n.Plans ?? []).forEach((c) => walk(c, depth + 1));
      };
      walk(plan, 0);
      if (hotVal > 0 && nodes.length > 1) nodes[hotIdx].hot = true;
      const stats: PlanStats = [];
      if (root["Planning Time"] !== undefined) stats.push({ label: "Planning time", value: `${(root["Planning Time"] as number).toFixed(2)} ms` });
      if (root["Execution Time"] !== undefined) stats.push({ label: "Execution time", value: `${(root["Execution Time"] as number).toFixed(1)} ms` });
      stats.push({ label: "Plan nodes", value: String(nodes.length) });
      const hot = nodes.find((n) => n.hot);
      const suggestion = hot
        ? `${hot.title} dominates this plan. An index matching its filter could avoid the full scan.`
        : null;
      setExplain({ title: tabs[activeTab]?.name ?? "query", analyzed, nodes, stats, suggestion, error: null });
      setResult(null); // explain replaced the backend row store
      setRunStatus(null);
    } catch (e) {
      setExplain((x) => (x ? { ...x, error: String(e) } : x));
    }
  }, [tabs, activeTab, connected]);

  /* ---------------- export / chart ---------------- */

  const doExport = useCallback(
    async (kind: "csv" | "json" | "md") => {
      setExportMenu(false);
      if (!result || result.columns.length === 0) return;
      showToast("Collecting rows…");
      const rows = await fetchAllRows(result.storedRows);
      const text =
        kind === "csv" ? toCSV(result.columns, rows) : kind === "json" ? toJSONExport(result.columns, rows) : toMarkdown(result.columns, rows);
      await navigator.clipboard.writeText(text);
      showToast(`${kind.toUpperCase()} copied to clipboard — ${rows.length.toLocaleString()} rows`);
    },
    [result, showToast]
  );

  const buildChart = useCallback(async () => {
    if (!result || result.columns.length === 0 || result.storedRows === 0) {
      setChart(null);
      return;
    }
    const isNum = (t: string) => /int|numeric|float|double|real|money/.test(t);
    const li = result.columns.findIndex((c) => !isNum(c.dbType));
    const vi = result.columns.findIndex((c) => isNum(c.dbType));
    if (li < 0 || vi < 0) {
      setChart(null);
      return;
    }
    const rows = await fetchAllRows(Math.min(result.storedRows, 50_000));
    const agg = new Map<string, number>();
    for (const r of rows) {
      const k = r[li] === null || r[li] === undefined ? "null" : String(r[li]);
      const v = Number(r[vi]);
      if (!Number.isFinite(v)) continue;
      agg.set(k, (agg.get(k) ?? 0) + v);
    }
    const data = [...agg.entries()]
      .map(([label, v]) => ({ label, v }))
      .sort((a, b) => b.v - a.v)
      .slice(0, 12);
    setChart({
      title: `sum(${result.columns[vi].name}) by ${result.columns[li].name}`,
      sub: `aggregated from ${rows.length.toLocaleString()} rows · bar`,
      data,
    });
  }, [result]);

  const pickResultTab = useCallback(
    (t: ResultTab) => {
      setResultTab(t);
      if (t === "chart" && !chart) buildChart();
    },
    [chart, buildChart]
  );

  /* ---------------- splitter / shortcuts / palette ---------------- */

  const onSplitStart = useCallback(
    (e: React.MouseEvent) => {
      dragRef.current = { y: e.clientY, h: editorH };
      document.body.style.cursor = "row-resize";
    },
    [editorH]
  );

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!dragRef.current) return;
      setEditorH(Math.max(120, Math.min(480, dragRef.current.h + (e.clientY - dragRef.current.y))));
    };
    const up = () => {
      dragRef.current = null;
      document.body.style.cursor = "";
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
    return () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const tag = (e.target as HTMLElement | null)?.tagName ?? "";
      const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if (mod && e.key === "Enter") {
        e.preventDefault();
        doRun();
      } else if (mod && e.shiftKey && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        doFormat();
      } else if (mod && e.shiftKey && (e.key === "l" || e.key === "L")) {
        e.preventDefault();
        applyTheme(theme === "dark" ? "light" : "dark");
      } else if (mod && (e.key === "o" || e.key === "O")) {
        e.preventDefault();
        setOverlay("connEditor");
      } else if (mod && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setPaletteQ("");
        setPaletteIdx(0);
        setOverlay("palette");
      } else if (mod && (e.key === "t" || e.key === "T")) {
        e.preventDefault();
        newTab();
      } else if (mod && (e.key === "c" || e.key === "C")) {
        const noSel = !window.getSelection || String(window.getSelection()) === "";
        if (copyable.current !== null && noSel && !typing) {
          navigator.clipboard.writeText(copyable.current).catch(() => {});
          showToast(`Copied cell: ${copyable.current.slice(0, 48)}`);
        }
      } else if (e.key === "?" && !typing) {
        e.preventDefault();
        setOverlay("cheatsheet");
      } else if (e.key === "Escape") {
        if (overlay) setOverlay(null);
        else if (running) doCancel();
        else {
          setConnMenu(false);
          setExportMenu(false);
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [doRun, newTab, overlay, running, doCancel, showToast, doFormat, applyTheme, theme]);

  const paletteItems = useCallback((): PaletteItem[] => {
    const items: PaletteItem[] = [
      { icon: "▶", label: "Run query", type: "Action", kbd: "⌘↵", exec: () => doRun() },
      { icon: "⧉", label: "Format SQL", type: "Action", kbd: "⌘⇧F", exec: doFormat },
      { icon: "✎", label: "Save current query as snippet", type: "Action", exec: saveSnippet },
      { icon: "＋", label: "New query tab", type: "Action", kbd: "⌘T", exec: newTab },
      { icon: "◐", label: "Toggle theme", type: "Action", kbd: "⌘⇧L", exec: () => applyTheme(theme === "dark" ? "light" : "dark") },
      { icon: "⛁", label: "Open connection…", type: "Action", kbd: "⌘O", exec: () => setOverlay("connEditor") },
      { icon: "＋", label: "New connection…", type: "Action", exec: newProfile },
      { icon: "⌥", label: "Show EXPLAIN plan", type: "Action", exec: runExplain },
      { icon: "⚙", label: "Open settings", type: "Action", exec: () => setOverlay("settings") },
    ];
    if (connected) {
      items.push({ icon: "📊", label: "Server monitor (sessions & locks)", type: "Action", exec: () => setOverlay("monitor") });
      items.push({ icon: "◫", label: "ER diagram (relationships)", type: "Action", exec: () => setOverlay("diagram") });
      if (connectedEnv === "prod")
        items.push({ icon: "🛡", label: "Prod audit log", type: "Action", exec: () => setOverlay("audit") });
      items.push({ icon: "⏻", label: "Disconnect current session", type: "Action", exec: doDisconnect });
      if (!inTx) items.push({ icon: "▣", label: "Begin transaction", type: "Action", exec: doBegin });
      else {
        items.push({ icon: "✓", label: "Commit transaction", type: "Action", exec: doCommit });
        items.push({ icon: "↩", label: "Rollback transaction", type: "Action", exec: doRollback });
      }
    }
    for (const c of saved) {
      items.push({ icon: "⇄", label: `Connect to ${c.name}`, type: "Connection", exec: () => selectProfile(c) });
    }
    for (const [schema, objs] of Object.entries(objects)) {
      for (const o of objs) {
        items.push({
          icon: o.kind === "view" || o.kind === "matview" ? "V" : "T",
          label: `${schema}.${o.name}`,
          type: "Table",
          exec: () => insertSelect(schema, o.name),
        });
        items.push({
          icon: "▤",
          label: `Describe ${schema}.${o.name}`,
          type: "Table",
          exec: () => describeObject(schema, o.name),
        });
      }
    }
    for (const sn of snippets) {
      items.push({
        icon: "✎",
        label: sn.name,
        type: "Snippet",
        exec: () => {
          setActiveSql(sn.body);
          showToast(`Inserted snippet "${sn.name}"`);
        },
      });
    }
    for (const h of historyItems.slice(0, 6)) {
      if (h.sqlText) {
        items.push({
          icon: "↺",
          label: h.sqlText.slice(0, 70),
          type: "Recent",
          exec: () => setActiveSql(h.sqlText!),
        });
      }
    }
    return items;
  }, [doRun, doFormat, saveSnippet, newTab, applyTheme, theme, newProfile, runExplain, connected, connectedEnv, inTx, doDisconnect, doBegin, doCommit, doRollback, saved, selectProfile, objects, insertSelect, describeObject, snippets, historyItems, setActiveSql, showToast]);

  /* ---------------- render ---------------- */

  const activeProfile = saved.find((c) => c.id === profileId) ?? null;
  const isProd = connected && connectedEnv === "prod";
  // HUD design: two-state label — live when connected, cached otherwise.
  const explorerSource: "live" | "cached" | "—" =
    connected && !metaCached ? "live" : schemas !== null || metaCached ? "cached" : "—";

  // Dormant updater hook: a future Tauri updater event can surface the toast.
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__tuplenestUpdate = setUpdateInfo;
  }, []);

  return (
    <div className="shell">
      <Titlebar
        theme={theme}
        connected={connected}
        activeName={activeProfile?.name ?? profileName ?? "No connection"}
        activeUserHost={host ? `${username || "?"}@${host}:${port}` : ""}
        activeEnv={connected ? (connectedEnv ?? "dev") : environment}
        saved={saved}
        activeId={profileId}
        connMenu={connMenu}
        onToggleConnMenu={() => setConnMenu((v) => !v)}
        onSelectProfile={selectProfile}
        onNewConnection={newProfile}
        onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
        onOpenPalette={() => {
          setPaletteQ("");
          setPaletteIdx(0);
          setOverlay("palette");
        }}
        onToggleTheme={() => applyTheme(theme === "dark" ? "light" : "dark")}
        onOpenSettings={() => setOverlay("settings")}
      />
      {isProd && (
        <div className="prod-banner">
          ⚠ PRODUCTION — changes are live. Query text is excluded from history.
        </div>
      )}
      <div className="body">
        <ActivityRail
          view={railView}
          connected={connected}
          onView={setRailView}
          onMonitor={() => setOverlay("monitor")}
          onDiagram={() => setOverlay("diagram")}
          onSettings={() => setOverlay("settings")}
        />
        <aside className={`sidebar ${sidebarCollapsed ? "collapsed" : ""}`}>
          {railView === "explorer" ? (
            <>
              <SavedList
                saved={saved}
                activeId={profileId}
                connected={connected}
                onLoad={editProfile}
                onNew={newProfile}
                onDelete={doDeleteProfile}
              />
              <div className="side-sep" />
              <ExplorerTree
                schemas={schemas}
                metaCached={metaCached}
                connected={connected}
                openSchemas={openSchemas}
                objects={objects}
                openTables={openTables}
                columns={columns}
                onToggleSchema={toggleSchema}
                onToggleTable={toggleTable}
                onInsertSelect={insertSelect}
                onDescribe={describeObject}
                onConnect={saved.length ? () => setConnMenu(true) : newProfile}
              />
            </>
          ) : (
            <>
              <div className="side-head">
                <span className="label">History</span>
              </div>
              <HistoryPanel
                items={historyItems}
                search={historySearch}
                onSearch={setHistorySearch}
                onClear={async () => {
                  await invoke("history_clear", { includeFavorites: false }).catch(() => {});
                  refreshHistory(historySearch);
                  showToast("Cleared history — favorites kept");
                }}
                onToggleFavorite={async (h) => {
                  await invoke("history_favorite", { id: h.id, favorite: !h.favorite }).catch(() => {});
                  refreshHistory(historySearch);
                }}
                onLoad={(sql) => {
                  setActiveSql(sql);
                  showToast("Loaded into editor");
                }}
              />
            </>
          )}
        </aside>
        <main className="main-col">
          <TabsBar tabs={tabs} active={activeTab} onSelect={setActiveTab} onClose={closeTab} onNew={newTab} />
          {tabs.length === 0 ? (
            <div className="onboard">
              <div className="card">
                <div className="onboard-glyph">
                  <span className="brand-glyph" style={{ width: 26, height: 26 }} />
                </div>
                <div className="big">No query open</div>
                <p>
                  Open a new query tab, pick a table from the Explorer to insert a select, or jump
                  anywhere with the command palette.
                </p>
                <div className="row">
                  <button className="btn primary" onClick={newTab}>
                    New query <span className="kbd">⌘T</span>
                  </button>
                  <button className="btn" onClick={() => setOverlay("palette")}>
                    Command palette <span className="kbd">⌘K</span>
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <QueryPanel
              sql={currentSql}
              onSqlChange={(s) => setActiveSql(s)}
              connected={connected}
              running={running}
              inTx={inTx}
              editorH={editorH}
              onSplitStart={onSplitStart}
              status={runStatus}
              result={result}
              lastError={lastError}
              queryEpoch={queryEpoch}
              resultTab={resultTab}
              onResultTab={pickResultTab}
              onRun={() => doRun()}
              onCancel={doCancel}
              onBegin={doBegin}
              onCommit={doCommit}
              onRollback={doRollback}
              onExplain={runExplain}
              onFormat={doFormat}
              exportMenu={exportMenu}
              onToggleExport={() => setExportMenu((v) => !v)}
              onExport={doExport}
              chart={chart}
              onInspect={(t, col) => {
                setInspectText(t);
                setInspectCol(col);
                setOverlay("inspect");
              }}
              onCopyable={(v) => {
                copyable.current = v;
              }}
              onToast={showToast}
              onVisibleRows={(a, b) =>
                setRowsInfo(result ? `rows ${a.toLocaleString()}–${b.toLocaleString()} of ${result.storedRows.toLocaleString()}` : "")
              }
              history={{
                items: historyItems,
                search: historySearch,
                onSearch: setHistorySearch,
                onClear: async () => {
                  await invoke("history_clear", { includeFavorites: false }).catch(() => {});
                  refreshHistory(historySearch);
                  showToast("Cleared history — favorites kept");
                },
                onToggleFavorite: async (h) => {
                  await invoke("history_favorite", { id: h.id, favorite: !h.favorite }).catch(() => {});
                  refreshHistory(historySearch);
                },
                onLoad: (sql) => {
                  setActiveSql(sql);
                  showToast("Loaded into editor");
                },
              }}
            />
          )}
        </main>
      </div>
      <StatusBar
        connected={connected}
        isProd={isProd}
        connName={activeProfile?.name ?? `${username || "?"}@${host}`}
        tlsMode={tlsMode}
        explorerSource={explorerSource}
        rowsInfo={result && result.columns.length > 0 ? rowsInfo : ""}
        txOpenSince={txOpenSince}
        serverVersion={serverVersion}
        osLabel={info?.os ?? ""}
      />

      {toast && <div className="toast">{toast}</div>}

      {overlay === "palette" && (
        <Palette
          items={paletteItems()}
          q={paletteQ}
          idx={paletteIdx}
          onQ={setPaletteQ}
          onIdx={setPaletteIdx}
          onPick={(it) => {
            setOverlay(null);
            it.exec();
          }}
          onClose={() => setOverlay(null)}
        />
      )}
      {overlay === "connEditor" && (
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
          testing={testing}
          testSummary={testSummary}
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
          onSaveConnect={saveAndConnect}
          onClose={() => setOverlay(null)}
        />
      )}
      {overlay === "txPrompt" && (
        <TxPrompt onCommit={commitAndDisconnect} onRollback={rollbackAndDisconnect} onStay={() => setOverlay(null)} />
      )}
      {overlay === "guard" && guardSql && (
        <Guard
          sql={guardSql}
          onCancel={() => {
            setGuardSql(null);
            setOverlay(null);
          }}
          onRun={() => {
            setGuardSql(null);
            setOverlay(null);
            doRun(true);
          }}
        />
      )}
      {overlay === "connLost" && (
        <ConnLost
          detail={connLostDetail}
          onReconnect={async () => {
            setOverlay(null);
            await doConnect();
          }}
          onClose={() => setOverlay(null)}
        />
      )}
      {overlay === "settings" && (
        <Settings
          theme={theme}
          telemetry={telemetry}
          onTheme={applyTheme}
          onTelemetry={applyTelemetry}
          onClose={() => setOverlay(null)}
        />
      )}
      {overlay === "params" && (
        <ParamPrompt
          count={paramValues.length}
          values={paramValues}
          onChange={(i, v) => setParamValues((vs) => vs.map((x, j) => (j === i ? v : x)))}
          onRun={() => {
            setOverlay(null);
            doRun(true, paramValues.map(coerceParam));
          }}
          onCancel={() => setOverlay(null)}
        />
      )}
      {overlay === "monitor" && <MonitorModal onToast={showToast} onClose={() => setOverlay(null)} />}
      {overlay === "diagram" && (
        <DiagramModal
          schema={(schemas ?? []).includes("public") ? "public" : schemas?.[0] ?? "public"}
          onClose={() => setOverlay(null)}
        />
      )}
      {overlay === "audit" && <AuditModal onClose={() => setOverlay(null)} />}
      {overlay === "cheatsheet" && <Cheatsheet onClose={() => setOverlay(null)} />}
      {overlay === "inspect" && (
        <Inspector text={inspectText} colName={inspectCol} onClose={() => setOverlay(null)} />
      )}
      {overlay === "schema" && schemaTarget && (
        <SchemaModal
          schema={schemaTarget.schema}
          name={schemaTarget.name}
          kind={schemaTarget.kind}
          columns={schemaCols}
          extra={schemaExtra}
          onClose={() => setOverlay(null)}
        />
      )}
      {updateInfo && (
        <UpdateToast
          version={updateInfo.version}
          notes={updateInfo.notes}
          onUpdate={() => {
            setUpdateInfo(null);
            showToast("Restarting to update…");
          }}
          onDismiss={() => setUpdateInfo(null)}
        />
      )}
      {overlay === "explain" && explain && (
        <ExplainModal
          title={explain.title}
          analyzed={explain.analyzed}
          nodes={explain.nodes}
          stats={explain.stats}
          suggestion={explain.suggestion}
          error={explain.error}
          onClose={() => setOverlay(null)}
        />
      )}
    </div>
  );
}
