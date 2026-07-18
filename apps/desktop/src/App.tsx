import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { kbd } from "./lib/platform";
import { errText } from "./lib/text";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { ask } from "@tauri-apps/plugin-dialog";
import Titlebar from "./app-shell/Titlebar";
import StatusBar from "./app-shell/StatusBar";
import ActivityRail, { type RailView } from "./app-shell/ActivityRail";
import HistoryPanel from "./history/HistoryPanel";
import SavedList from "./connections/SavedList";
import ConnectionForm from "./connections/ConnectionForm";
import ExplorerTree from "./explorer/ExplorerTree";
import TabsBar from "./editor/TabsBar";
import QueryPanel, { type ChartDatum, type ResultTab } from "./editor/QueryPanel";
import {
  About,
  Cheatsheet,
  ConnLost,
  Guard,
  Inspector,
  NamePrompt,
  Palette,
  Settings,
  TxPrompt,
  type PaletteItem,
} from "./overlays/Overlays";
import { BrandMark } from "./lib/icons";
import type { Catalog, CatalogTable } from "./lib/complete";
import { summarizePlan, type PlanSummary } from "./lib/intel";
import {
  planFilename,
  planToJson,
  planToMarkdown,
  planToText,
  rawExtension,
  type ExportablePlan,
} from "./lib/explain";
import { FILTERS, baseName, saveText } from "./lib/save";
import { MAX_CHART_ROWS, aggregateChart, chartSubtitle, chartTitle, pickChartColumns } from "./lib/chart";
import IntelModal from "./overlays/IntelModal";
import ImportModal from "./overlays/ImportModal";
import DetailsModal, { type ObjectDetails } from "./overlays/DetailsModal";
import { useQueryTabs } from "./hooks/useQueryTabs";
import { useSearch } from "./hooks/useSearch";
import { useHealth } from "./hooks/useHealth";
import { useConnectionForm } from "./hooks/useConnectionForm";
import { useQuery } from "./hooks/useQuery";
import { defaultSearchPath } from "./lib/nodes";
import { useTransaction } from "./hooks/useTransaction";
import { useExplain } from "./hooks/useExplain";
import { useRowEdits } from "./hooks/useRowEdits";
import { useHistory } from "./hooks/useHistory";
import { useExplorerTree } from "./hooks/useExplorerTree";
import { useConnection } from "./hooks/useConnection";
import { suggestName, useSnippets } from "./hooks/useSnippets";
import HealthModal, { type HealthTab } from "./overlays/HealthModal";
import SearchModal from "./overlays/SearchModal";
import PartitionsModal from "./overlays/PartitionsModal";
import { analyzeEditability } from "./lib/dml";
import EditReviewModal from "./overlays/EditReviewModal";
import SchemaModal, { type SchemaExtra } from "./overlays/SchemaModal";
import MonitorModal from "./overlays/MonitorModal";
import DiagramModal from "./overlays/DiagramModal";
import AuditModal from "./overlays/AuditModal";
import ExplainModal from "./overlays/ExplainModal";
import { UpdateToast } from "./overlays/Overlays";
import { ParamPrompt } from "./overlays/Overlays";
import {
  coerceParam,
  fetchAllRows,
  formatSQL,
  rowCountNote,
  toCSV,
  toJSONExport,
  toMarkdown,
} from "./lib/sql";
import type {
  AppInfo,
  ConnectionRecord,
  DbColumn,
  MetadataOut,
  PartitionOverview,
  PgParams,
  SearchHit,
  SshParams,
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
  | "about"
  | "inspect"
  | "monitor"
  | "params"
  | "diagram"
  | "intel"
  | "import"
  | "details"
  | "health"
  | "search"
  | "parts"
  | "snippetName"
  | "audit";

export default function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [telemetry, setTelemetry] = useState(false);

  // The connection form and profile identity move as one unit, so they live
  // in one hook. Destructured to keep every read site unchanged; writes go
  // through `form.set`.
  const form = useConnectionForm();
  const {
    host, port, database, username, password, secretRef, tlsMode, tlsCaPath,
    sshEnabled, sshHost, sshPort, sshUser, sshKeyPath, sshFingerprint,
    profileId, profileName, environment,
  } = form;

  const [saved, setSaved] = useState<ConnectionRecord[]>([]);

  // The session. `connected` follows the server, never the form — the hook
  // owns that rule.
  const session = useConnection();
  const { connected, connectedEnv, serverVersion, status, setStatus, stages, testing, testSummary } = session;
  const [updateInfo, setUpdateInfo] = useState<{ version: string; notes: string } | null>(null);
  // Execution and its result state live in a hook; App keeps the overlays.
  const query = useQuery();
  const { running, result, lastError, ranSql } = query;
  const queryEpoch = query.epoch;
  /** Recent EXPLAIN summaries, oldest first — Phase 3 plan comparison. */
  const [plans, setPlans] = useState<{ label: string; summary: PlanSummary }[]>([]);
  /** Server major version, so options the server is too old for are disabled
   *  rather than offered and rejected. */
  const serverMajor = useMemo(() => {
    const m = /^(\d+)/.exec(serverVersion ?? "");
    return m ? Number(m[1]) : undefined;
  }, [serverVersion]);
  // `inTx` is a claim about the server, so it only moves when the server
  // confirms. The hook owns that rule.
  const tx = useTransaction();
  const { inTx } = tx;
  const txOpenSince = tx.openSince;
  /** Now, refreshed once a second while a transaction is open. The status
   *  bar reads the clock from here so that it stays a pure function of props. */
  const [now, setNow] = useState(() => Date.now());

  // Workspace / UI
  // Tabs live in a hook so their invariants (valid active index, dirty means
  // "user edited", never zero tabs) are stated and tested in one place.
  const { tabs, activeTab, setActiveTab, setActiveSql, newTab, closeTab, setTabs } = useQueryTabs();
  const [overlay, setOverlay] = useState<OverlayKind>(null);
  const [paletteQ, setPaletteQ] = useState("");
  const [paletteIdx, setPaletteIdx] = useState(0);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(272);
  const sidebarDragRef = useRef<{ x: number; w: number } | null>(null);
  const [railView, setRailView] = useState<RailView>("explorer");
  const [connMenu, setConnMenu] = useState(false);
  const [exportMenu, setExportMenu] = useState(false);
  // CSV export neutralizes spreadsheet formulas by default (security FILE-01).
  const [csvSafe, setCsvSafe] = useState(true);
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
  const [snippetName, setSnippetName] = useState("");
  const {
    explain,
    opts: explainOpts,
    setOpts: setExplainOpts,
    busy: explainBusy,
    run: runExplainRaw,
  } = useExplain(serverMajor);

  // Explorer
  const [schemas, setSchemas] = useState<string[] | null>(null);
  const [details, setDetails] = useState<{
    schema: string;
    data: ObjectDetails | null;
    error: string | null;
  } | null>(null);

  // Health + global search
  const health = useHealth();
  // Search lives in a hook: the keystroke race it guards against is a real
  // invariant, and it is worth stating once and testing.
  const search = useSearch();
  const [parts, setParts] = useState<{
    schema: string;
    table: string;
    data: PartitionOverview | null;
    error: string | null;
  } | null>(null);

  const {
    items: historyItems,
    search: historySearch,
    setSearch: setHistorySearch,
    refresh: refreshHistory,
    toggleFavorite: toggleHistoryFavorite,
    clear: clearHistory,
  } = useHistory();

  const { items: snippets, refresh: refreshSnippets, save: saveSnippetRecord } = useSnippets();

  const showToast = useCallback((t: string) => {
    setToast(t);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2100);
  }, []);
  // The dismiss timer must die with the component. It was the one timer in
  // the codebase with no unmount cleanup — every other setTimeout/setInterval
  // here clears itself — and CI caught it: a toast shown in the last 2.1s of
  // a test file fired setToast(null) after jsdom was torn down, and React
  // walked into `window is not defined`. In the app it is the classic
  // setState-after-unmount; in tests it failed the suite. Same bug, one line.
  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    []
  );

  /* ---------------- bootstrap ---------------- */

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
    invoke<boolean | null>("settings_get", { key: "telemetry" })
      .then((v) => setTelemetry(!!v))
      .catch(() => {});
    /* `refreshSaved` awaits the IPC call before it sets anything, so nothing
       here is synchronous — the rule follows the setState inside it but not the
       await in front of it. Loading on mount is what an effect is for. */
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshSaved();
    void refreshSnippets();
  }, [refreshSaved, refreshSnippets]);

  useEffect(() => {
    document.documentElement.setAttribute("data-tn-theme", theme);
  }, [theme]);

  /* macOS's menu bar owns "About TupleNest", but the About box lives here, so
     the menu item only emits and this opens it. Without this the menu bar fell
     through to the system's bare version panel — a second, worse About. */
  useEffect(() => {
    const stop = listen("menu:about", () => setOverlay("about"));
    return () => {
      void stop.then((off) => off());
    };
  }, []);

  useEffect(() => {
    if (!txOpenSince) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
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


  const savePassword = useCallback(async () => {
    if (!password) return null;
    const ref = await invoke<string>("pg_secret_save", { password });
    form.set("password", "");
    form.set("secretRef", ref);
    return ref;
  }, [password, form]);

  /** Params for the backend, saving the password to the keychain first if the
   *  user typed a new one. The shape itself is the hook's business. */
  const withSecret = useCallback(async (): Promise<PgParams> => {
    const ref = password ? await savePassword() : secretRef;
    return form.toParams(ref);
  }, [password, savePassword, secretRef, form]);

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

  /** The lazy schema tree. Declared after `metaFetch` because it takes it. */
  const tree = useExplorerTree(metaFetch, setStatus);
  const { openNodes, objects, columns, indexes, constraints, partitions, types, routines, metaCached, setMetaCached } = tree;
  const toggleNode = tree.toggle;

  /** A new connection is a new catalog. */
  const resetExplorer = useCallback(() => {
    setSchemas(null);
    tree.reset();
  }, [tree]);

  /** Load the catalog for a session the hook has just opened. */
  const afterConnect = useCallback(() => {
    resetExplorer();
    invoke<MetadataOut<string[]>>("pg_metadata", { request: { kind: "list_schemas" } })
      .then((r) => {
        setSchemas(r.payload);
        setMetaCached(r.cached);
      })
      .catch((e) => setStatus(`Explorer error: ${errText(e)}`));
  }, [resetExplorer, setMetaCached, setStatus]);

  const doConnect = useCallback(async () => {
    const out = await session.connect(await withSecret(), environment);
    if (!out.ok) {
      showToast(out.message.slice(0, 90));
      return;
    }
    afterConnect();
    showToast(`Connected — ${username}@${host}/${database}`);
  }, [session, withSecret, environment, afterConnect, showToast, username, host, database]);

  const reallyDisconnect = useCallback(async () => {
    await session.disconnect();
    query.reset();
    tx.forget(); // the session is gone; the transaction went with it
    setOverlay(null);
    resetExplorer();
  }, [session, resetExplorer, query, tx]);

  const doDisconnect = useCallback(async () => {
    if (inTx) {
      setOverlay("txPrompt");
      return;
    }
    await reallyDisconnect();
  }, [inTx, reallyDisconnect]);

  const loadProfile = useCallback(
    (c: ConnectionRecord) => {
      // Field copying, ssh parsing and the "never restore the password" rule
      // all live in the hook now.
      form.load(c);
      if (connected) return;
      resetExplorer();
      // Cached metadata is keyed by the target, not the credentials.
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
    [form, connected, resetExplorer, setMetaCached]
  );

  /** Titlebar switcher: load profile AND connect (HUD behavior). */
  const selectProfile = useCallback(
    async (c: ConnectionRecord) => {
      setConnMenu(false);
      if (inTx) {
        setOverlay("txPrompt");
        return;
      }
      await session.disconnect();
      loadProfile(c);
      const ssh = c.sshJson ? (JSON.parse(c.sshJson) as SshParams) : null;
      const out = await session.connect(
        {
          host: c.host,
          port: c.port,
          database: c.database,
          username: c.username,
          secretRef: c.secretRef,
          // A profile saved before TLS existed has no mode. Defaulting to
          // verify-full fails closed rather than silently downgrading.
          tlsMode: c.tlsMode || "verify-full",
          tlsCaPath: c.tlsCaPath,
          environment: c.environment,
          readOnly: c.readOnly,
          ssh,
        },
        c.environment ?? "dev",
      );
      if (!out.ok) {
        showToast(out.message.slice(0, 90));
        return;
      }
      afterConnect();
      showToast(`Connected — ${c.name}`);
    },
    [inTx, session, loadProfile, afterConnect, showToast]
  );

  /* ---------------- test / save profile ---------------- */

  const doTest = useCallback(async () => {
    await session.test(await withSecret());
  }, [session, withSecret]);

  const doSaveProfile = useCallback(async (): Promise<ConnectionRecord | null> => {
    try {
      const rec = await invoke<ConnectionRecord>("connection_save", {
        input: {
          id: profileId,
          name: profileName || `${username || "user"}@${host}/${database}`,
          environment,
          color: null,
          readOnly: form.readOnly,
          host,
          port,
          database,
          username,
          password: password || null,
          tlsMode,
          tlsCaPath: tlsCaPath || null,
          sshJson: form.ssh() ? JSON.stringify(form.ssh()) : null,
        },
      });
      form.set("password", "");
      form.set("profileId", rec.id);
      form.set("profileName", rec.name);
      form.set("secretRef", rec.secretRef);
      setStatus(`Saved "${rec.name}"`);
      await refreshSaved();
      return rec;
    } catch (e) {
      setStatus(`Save error: ${errText(e)}`);
      return null;
    }
  }, [profileId, profileName, environment, host, port, database, username, password, tlsMode, tlsCaPath, form, refreshSaved, setStatus]);

  const saveAndConnect = useCallback(async () => {
    const rec = await doSaveProfile();
    if (!rec) return;
    setOverlay(null);
    await doConnect();
  }, [doSaveProfile, doConnect]);

  const newProfile = useCallback(() => {
    form.set("profileId", null);
    form.set("profileName", "");
    form.set("secretRef", null);
    form.set("password", "");
    form.set("sshEnabled", false);
    form.set("sshHost", "");
    form.set("sshUser", "");
    form.set("sshKeyPath", "");
    form.set("sshFingerprint", "");
    session.clearTest();
    setStatus("");
    setOverlay("connEditor");
    setConnMenu(false);
  }, [form, session, setStatus]);

  const editProfile = useCallback(
    (c: ConnectionRecord) => {
      loadProfile(c);
      session.clearTest();
      setOverlay("connEditor");
    },
    [loadProfile, session]
  );

  const doDeleteProfile = useCallback(
    async (c: ConnectionRecord) => {
      // The × is small and sits next to the row you click to open. Deleting a
      // profile takes its keychain reference with it, so it cannot be undone
      // by retyping the host — ask first.
      //
      // `ask` from the dialog plugin, not `window.confirm`: the webview's
      // confirm returns true without ever drawing a dialog, so a guard built
      // on it deletes silently while looking like it asked.
      const ok = await ask(`Delete the connection "${c.name}"?`, {
        title: "Delete connection",
        kind: "warning",
        okLabel: "Delete",
        cancelLabel: "Keep",
      });
      if (!ok) return;
      try {
        await invoke("connection_delete", { id: c.id });
        if (profileId === c.id) form.set("profileId", null);
        showToast(`Deleted "${c.name}"`);
        await refreshSaved();
      } catch (e) {
        setStatus(`Delete error: ${errText(e)}`);
      }
    },
    [profileId, refreshSaved, showToast, form, setStatus]
  );

  /* ---------------- explorer ---------------- */

  /** Everything the server knows about one object. Always fetched live —
   *  sizes and scan counters are the whole point, and a cached copy of either
   *  is just a stale number wearing a confident face. */
  const showDetails = useCallback(
    async (schema: string, name: string, kind: string) => {
      setDetails({ schema, data: null, error: null });
      setOverlay("details");
      try {
        const r = await invoke<MetadataOut<ObjectDetails>>("pg_metadata", {
          request: { kind: "object_details", schema, name, objectKind: kind },
        });
        setDetails({ schema, data: r.payload, error: null });
      } catch (e) {
        setDetails({ schema, data: null, error: String(e) });
      }
    },
    []
  );

  /** Open the health report on a tab. The fetching and caching live in the
   *  hook; App only owns which overlay is on screen. */
  const loadHealth = useCallback(
    (tab: HealthTab) => {
      setOverlay("health");
      void health.load(tab);
    },
    [health],
  );


  /** Partitions of one table, with bounds and sizes. */
  const showPartitions = useCallback(async (schema: string, table: string) => {
    setParts({ schema, table, data: null, error: null });
    setOverlay("parts");
    try {
      const r = await invoke<MetadataOut<PartitionOverview>>("pg_metadata", {
        request: { kind: "partition_overview", schema, table },
      });
      setParts({ schema, table, data: r.payload, error: null });
    } catch (e) {
      setParts({ schema, table, data: null, error: String(e) });
    }
  }, []);

  /** Put generated DDL in a tab instead of running it.
   *
   *  Everything routed through here is destructive or long-running. The app's
   *  job is to write the statement correctly; deciding to run it is the
   *  user's, and they need to see it first to make that decision. */
  const openScript = useCallback(
    (name: string, sql: string) => {
      newTab({ name, sql, dirty: true });
      setOverlay(null);
      showToast("Opened as a script — nothing was executed.");
    },
    [newTab, showToast],
  );


  /* ---------------- completion catalog ---------------- */

  const searchPath = useMemo(() => defaultSearchPath(schemas), [schemas]);

  const catalog: Catalog | undefined = useMemo(() => {
    if (!schemas) return undefined;
    const tables: CatalogTable[] = [];
    for (const [schema, objs] of Object.entries(objects)) {
      for (const o of objs) tables.push({ schema, name: o.name, kind: o.kind });
    }
    return { schemas, tables, columns, searchPath };
  }, [schemas, objects, columns, searchPath]);

  /** Load object lists / column lists the editor needs but the explorer
   *  hasn't lazily opened yet. Guarded so each key is fetched once. */
  const { prefetchSchemaObjects, prefetchTables } = tree;

  // Warm the default schema's object list so `from <tab>` works immediately.
  useEffect(() => {
    if (connected && schemas) void prefetchSchemaObjects(searchPath[0]);
  }, [connected, schemas, searchPath, prefetchSchemaObjects]);



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
  }, [tabs, activeTab, setActiveSql, showToast]);

  /** Open the name prompt for the current query. `window.prompt` cannot be
   *  used here — see NamePrompt. */
  const saveSnippet = useCallback(() => {
    const body = tabs[activeTab]?.sql ?? "";
    if (!body.trim()) {
      showToast("Nothing to save");
      return;
    }
    setSnippetName(suggestName(body));
    setOverlay("snippetName");
  }, [tabs, activeTab, showToast]);

  const commitSnippet = useCallback(async () => {
    const body = tabs[activeTab]?.sql ?? "";
    const name = snippetName.trim();
    if (!name || !body.trim()) return;
    setOverlay(null);
    const out = await saveSnippetRecord({ name, body });
    showToast(out.ok ? `Saved snippet "${name}"` : out.message.slice(0, 70));
  }, [tabs, activeTab, snippetName, showToast, saveSnippetRecord]);

  /* ---------------- tabs ---------------- */




  /* ---------------- run / transactions / explain ---------------- */

  const currentSql = tabs[activeTab]?.sql ?? "";

  const doRun = useCallback(
    async (force = false, boundParams?: unknown[]) => {
      const sql = tabs[activeTab]?.sql ?? "";
      if (!connected) return;
      // The hook decides what is needed and reports back; App owns the
      // overlays, so nothing here has to re-derive that from state.
      const out = await query.run(sql, { env: connectedEnv, force, params: boundParams });
      if (out.kind === "needs-guard") {
        setGuardSql(sql);
        setOverlay("guard");
        return;
      }
      if (out.kind === "needs-params") {
        setParamValues(Array(out.count).fill(""));
        setOverlay("params");
        return;
      }
      if (out.kind === "blocked") return;

      setChart(null);
      if (out.kind === "ok") {
        setResultTab("results");
        // The tab matches what the server just ran, so it is no longer dirty.
        setTabs((ts) => {
          const o = [...ts];
          if (o[activeTab]) o[activeTab] = { ...o[activeTab], dirty: false };
          return o;
        });
      } else if (out.connectionLost) {
        session.markLost();
        tx.forget(); // no server left to hold a transaction open
        setConnLostDetail(out.message);
        setOverlay("connLost");
      }
      void refreshHistory();
    },
    [tabs, activeTab, connected, connectedEnv, query, tx, setTabs, refreshHistory, session]
  );

  /* ---------------- safe row editing ---------------- */

  const {
    edits,
    stage: stageEdit,
    discard: discardEdits,
    reviewOpen,
    setReviewOpen,
    applying,
    applyError,
    apply: applyRowEdits,
  } = useRowEdits(queryEpoch);

  /** Whether the current result maps back to editable rows of exactly one table. */
  const editability = useMemo(
    () => (result && result.columns.length > 0 ? analyzeEditability(ranSql, result.columns, catalog) : null),
    [result, ranSql, catalog]
  );
  const editTarget = editability?.editable ? editability.target : null;

  /** Apply the staged edits and tell the user what became of them. The hook
   *  owns the transaction; this owns what the rest of the app does after. */
  const applyEdits = useCallback(async () => {
    const out = await applyRowEdits({ target: editTarget, inTx });
    if (out.kind === "noop" || out.kind === "error") return;
    void refreshHistory();
    if (out.kind === "staged") {
      showToast(`${out.count} statement(s) staged in your transaction`);
      return; // their transaction, their commit — and no re-read, see below
    }
    showToast(`Applied ${out.count} statement${out.count === 1 ? "" : "s"}`);
    // Re-read so the grid shows what is actually stored. Only safe once the
    // commit has landed: re-reading inside the user's open transaction would
    // show uncommitted rows as though they were.
    void doRun(true);
  }, [applyRowEdits, editTarget, inTx, doRun, refreshHistory, showToast]);

  const doCancel = useCallback(async () => {
    try {
      await invoke("pg_cancel");
      showToast("Cancel requested");
    } catch (e) {
      showToast(`Cancel error: ${String(e).slice(0, 60)}`);
    }
  }, [showToast]);

  /**
   * Refuse to end a transaction from a tab that did not start it.
   *
   * One session serves every tab, so a COMMIT here would commit whatever the
   * owning tab has pending — work that is not on screen. Naming the owner is
   * the point: "you are about to commit something you cannot see" is only
   * useful if it says where to look.
   */
  const notOwner = useCallback((): string | null => {
    const cur = tabs[activeTab];
    if (!tx.owner || !cur || tx.owner.tabId === cur.id) return null;
    return `The open transaction belongs to ${tx.owner.tabName}. Switch to that tab to commit or roll it back.`;
  }, [tx.owner, tabs, activeTab]);

  const doBegin = useCallback(async () => {
    const cur = tabs[activeTab];
    if (!cur) return;
    const r = await tx.begin({ tabId: cur.id, tabName: cur.name });
    showToast(r.ok ? `Transaction started in ${cur.name}` : String(r.message).slice(0, 80));
  }, [tx, showToast, tabs, activeTab]);

  const doCommit = useCallback(async () => {
    const wrong = notOwner();
    if (wrong) return showToast(wrong.slice(0, 90));
    const r = await tx.commit();
    showToast(r.ok ? "COMMIT" : `Commit error: ${String(r.message).slice(0, 70)}`);
  }, [tx, showToast, notOwner]);

  const doRollback = useCallback(async () => {
    const wrong = notOwner();
    if (wrong) return showToast(wrong.slice(0, 90));
    const r = await tx.rollback();
    showToast(r.ok ? "ROLLBACK" : `Rollback error: ${String(r.message).slice(0, 70)}`);
  }, [tx, showToast, notOwner]);

  /**
   * Closing the window with a transaction open.
   *
   * Disconnect and profile-switch both prompted; closing the window did not,
   * so ⌘Q or the red button dropped the session and threw away uncommitted
   * work without a word. It is the same decision, reached by a different door,
   * and it deserves the same three-way prompt.
   *
   * `inTx` is read through a ref so the listener is registered once. Re-running
   * this effect on every transaction change would leave a window with no
   * handler for the moment between unlisten and re-listen.
   */
  const inTxRef = useRef(inTx);
  // In an effect, not during render: writing a ref while rendering is the
  // thing that makes a component not re-render when you expect it to, and the
  // compiler lint is right to refuse it.
  useEffect(() => {
    inTxRef.current = inTx;
  }, [inTx]);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    const stop = win.onCloseRequested((e) => {
      if (!inTxRef.current) return;
      e.preventDefault();
      setClosing(true);
      setOverlay("txPrompt");
    });
    return () => {
      void stop.then((off) => off());
    };
  }, []);

  /** Close for real. `destroy` rather than `close`: `close` would fire
   *  onCloseRequested again and we would prompt about a transaction the user
   *  has just finished deciding. */
  const finishClose = useCallback(async () => {
    await getCurrentWindow().destroy();
  }, []);

  const commitAndDisconnect = useCallback(async () => {
    const r = await tx.commit();
    if (!r.ok) {
      // Still open on the server. Disconnecting now would abandon it silently,
      // so stop and let the user see what happened.
      showToast(`Commit error: ${String(r.message).slice(0, 70)}`);
      setOverlay(null);
      return;
    }
    await reallyDisconnect();
    showToast("Committed & disconnected");
  }, [tx, reallyDisconnect, showToast]);

  const rollbackAndDisconnect = useCallback(async () => {
    // Best-effort: we are dropping the session either way, and an unreachable
    // server has already rolled it back for us.
    await tx.rollback();
    tx.forget();
    await reallyDisconnect();
    showToast("Rolled back & disconnected");
  }, [tx, reallyDisconnect, showToast]);

  /**
   * Run EXPLAIN for the active tab and show it.
   *
   * The hook owns the statement and the plan; this decides what the rest of
   * the app does about it — open the modal (on start, so a slow ANALYZE shows
   * a spinner rather than nothing), keep the summary for comparison, and drop
   * the backend row store, which EXPLAIN has just overwritten with its output.
   */
  const runExplain = useCallback(
    async (override?: unknown) => {
      const title = tabs[activeTab]?.name ?? "query";
      const out = await runExplainRaw({
        sql: tabs[activeTab]?.sql ?? "",
        title,
        connected,
        override,
        onStart: () => setOverlay("explain"),
      });
      if (out.kind !== "ok") return;
      query.reset(); // EXPLAIN replaced the backend row store
      // Phase 3: keep the last few summaries so two runs can be compared.
      if (out.root) {
        const summary = summarizePlan(out.root);
        setPlans((ps) => [...ps, { label: `${title} · ${new Date().toLocaleTimeString()}`, summary }].slice(-6));
      }
    },
    [tabs, activeTab, connected, runExplainRaw, query],
  );

  /** Everything the exporters need from the current plan. */
  const exportablePlan = useCallback((): ExportablePlan | null => {
    if (!explain) return null;
    return {
      sql: explain.sql,
      statement: explain.statement,
      options: explainOpts,
      raw: explain.raw,
      nodes: explain.nodes ?? [],
      stats: explain.stats,
    };
  }, [explain, explainOpts]);

  const renderPlan = (kind: "json" | "txt" | "md", p: ExportablePlan) =>
    kind === "json" ? planToJson(p) : kind === "txt" ? planToText(p) : planToMarkdown(p);

  const exportPlan = useCallback(
    async (kind: "json" | "txt" | "md") => {
      const p = exportablePlan();
      if (!p) return;
      // A raw TEXT/YAML/XML payload isn't JSON, whatever menu item was clicked —
      // don't hand it a .json extension.
      const ext = kind === "json" ? rawExtension(p.options) : kind;
      try {
        const path = await saveText(planFilename(explain?.title ?? "query", ext), renderPlan(kind, p), FILTERS[ext]);
        if (path) showToast(`Saved ${baseName(path)}`);
      } catch (e) {
        showToast(`Export failed: ${String(e).slice(0, 60)}`);
      }
    },
    [exportablePlan, explain, showToast]
  );

  const copyPlan = useCallback(
    async (kind: "json" | "txt" | "md") => {
      const p = exportablePlan();
      if (!p) return;
      await navigator.clipboard.writeText(renderPlan(kind, p));
      showToast(`Plan ${kind.toUpperCase()} copied`);
    },
    [exportablePlan, showToast]
  );

  /* ---------------- export / chart ---------------- */

  /** Export the result grid to a file the user picks. This used to copy to the
   *  clipboard, which is not what "Export" means — and silently truncated
   *  usefulness for anything larger than a paste. */
  const doExport = useCallback(
    async (kind: "csv" | "json" | "md") => {
      setExportMenu(false);
      if (!result || result.columns.length === 0) return;
      showToast("Collecting rows…");
      const rows = await fetchAllRows(result.storedRows);
      const csvMode = csvSafe ? "spreadsheet-safe" : "raw";
      const text =
        kind === "csv" ? toCSV(result.columns, rows, csvMode) : kind === "json" ? toJSONExport(result.columns, rows) : toMarkdown(result.columns, rows);
      const ext = kind === "md" ? "md" : kind;
      const name = `${(tabs[activeTab]?.name ?? "result").replace(/\.sql$/i, "")}-${new Date()
        .toISOString()
        .slice(0, 19)
        .replace(/[:T]/g, "-")}.${ext}`;
      try {
        const path = await saveText(name, text, FILTERS[ext]);
        if (path) showToast(`Saved ${baseName(path)} — ${rowCountNote(rows.length, result)}`);
      } catch (e) {
        showToast(`Export failed: ${String(e).slice(0, 60)}`);
      }
    },
    [result, showToast, tabs, activeTab, csvSafe]
  );

  const doCopyResult = useCallback(
    async (kind: "csv" | "json" | "md") => {
      setExportMenu(false);
      if (!result || result.columns.length === 0) return;
      const rows = await fetchAllRows(result.storedRows);
      const csvMode = csvSafe ? "spreadsheet-safe" : "raw";
      const text =
        kind === "csv" ? toCSV(result.columns, rows, csvMode) : kind === "json" ? toJSONExport(result.columns, rows) : toMarkdown(result.columns, rows);
      await navigator.clipboard.writeText(text);
      showToast(`${kind.toUpperCase()} copied — ${rowCountNote(rows.length, result)}`);
    },
    [result, showToast, csvSafe]
  );

  const buildChart = useCallback(async () => {
    const pick = result && result.storedRows > 0 ? pickChartColumns(result.columns) : null;
    if (!result || !pick) {
      setChart(null);
      return;
    }
    const rows = await fetchAllRows(Math.min(result.storedRows, MAX_CHART_ROWS));
    setChart({
      title: chartTitle(result.columns, pick),
      sub: chartSubtitle(rows.length, result.totalRows),
      data: aggregateChart(rows, pick.label, pick.value),
    });
  }, [result]);

  const pickResultTab = useCallback(
    (t: ResultTab) => {
      setResultTab(t);
      if (t === "chart" && !chart) void buildChart();
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

  // Sidebar width drag
  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!sidebarDragRef.current) return;
      const w = sidebarDragRef.current.w + (e.clientX - sidebarDragRef.current.x);
      setSidebarWidth(Math.max(200, Math.min(480, w)));
    };
    const up = () => {
      sidebarDragRef.current = null;
      document.body.style.cursor = "";
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
    return () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
  }, []);

  // Clicking the active rail view collapses the sidebar; another view expands.
  const handleRailView = useCallback(
    (v: RailView) => {
      if (v === railView && !sidebarCollapsed) setSidebarCollapsed(true);
      else {
        setRailView(v);
        setSidebarCollapsed(false);
      }
    },
    [railView, sidebarCollapsed]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const tag = (e.target as HTMLElement | null)?.tagName ?? "";
      const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if (mod && e.key === "Enter") {
        e.preventDefault();
        void doRun();
      } else if (mod && e.shiftKey && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        doFormat();
      } else if (mod && e.shiftKey && (e.key === "l" || e.key === "L")) {
        e.preventDefault();
        void applyTheme(theme === "dark" ? "light" : "dark");
      } else if (mod && (e.key === "o" || e.key === "O")) {
        e.preventDefault();
        setOverlay("connEditor");
      } else if (mod && (e.key === "b" || e.key === "B")) {
        e.preventDefault();
        setSidebarCollapsed((v) => !v);
      } else if (mod && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setPaletteQ("");
        setPaletteIdx(0);
        setOverlay("palette");
      } else if (mod && (e.key === "p" || e.key === "P")) {
        // Only useful against a live server: the search reads pg_catalog.
        e.preventDefault();
        if (connected) {
          search.reset();
          setOverlay("search");
        }
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
        else if (running) void doCancel();
        else {
          setConnMenu(false);
          setExportMenu(false);
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [doRun, newTab, overlay, running, doCancel, showToast, doFormat, applyTheme, theme, connected, search]);

  /**
   * Everything the palette can do.
   *
   * A `useMemo`, not a `useCallback` called from the JSX. It was the latter,
   * which meant the memo did nothing: the list was rebuilt on every render of
   * App — and App re-renders once a second while a transaction is open. The
   * loop below walks every object in every loaded schema, twice, so on a
   * database with thousands of relations that was thousands of allocations a
   * second to draw a list nobody had opened.
   */
  const paletteItems = useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = [
      { icon: "▶", label: "Run query", type: "Action", kbd: kbd("mod", "enter"), exec: () => doRun() },
      { icon: "⧉", label: "Format SQL", type: "Action", kbd: kbd("mod", "shift", "F"), exec: doFormat },
      { icon: "✎", label: "Save current query as snippet", type: "Action", exec: saveSnippet },
      { icon: "＋", label: "New query tab", type: "Action", kbd: kbd("mod", "T"), exec: newTab },
      { icon: "◐", label: "Toggle theme", type: "Action", kbd: kbd("mod", "shift", "L"), exec: () => applyTheme(theme === "dark" ? "light" : "dark") },
      { icon: "⛁", label: "Open connection…", type: "Action", kbd: kbd("mod", "O"), exec: () => setOverlay("connEditor") },
      { icon: "＋", label: "New connection…", type: "Action", exec: newProfile },
      { icon: "⌥", label: "Show EXPLAIN plan", type: "Action", exec: () => runExplain() },
      { icon: "⤓", label: "Import CSV…", type: "Action", exec: () => setOverlay("import") },
      { icon: "⌕", label: "Find usages & rename…", type: "Action", exec: () => setOverlay("intel") },
      { icon: "⇄", label: "Compare schemas…", type: "Action", exec: () => setOverlay("intel") },
      { icon: "◫", label: "Compare EXPLAIN plans…", type: "Action", exec: () => setOverlay("intel") },
      { icon: "⚙", label: "Open settings", type: "Action", exec: () => setOverlay("settings") },
      { icon: "◈", label: "About TupleNest", type: "Action", exec: () => setOverlay("about") },
    ];

    /** Needs a live server: every one of these reads the catalog or the
     *  session. Offline they would open and immediately fail. */
    const live: PaletteItem[] = !connected
      ? []
      : [
          { icon: "⌕", label: "Find anything (all schemas)…", type: "Action", kbd: kbd("mod", "P"), exec: () => setOverlay("search") },
          { icon: "◱", label: "Index health (unused & recoverable)…", type: "Action", exec: () => loadHealth("indexes") },
          { icon: "☰", label: "Vacuum & bloat…", type: "Action", exec: () => loadHealth("tables") },
          { icon: "⏱", label: "Top queries…", type: "Action", exec: () => loadHealth("queries") },
          { icon: "📊", label: "Server monitor (sessions & locks)", type: "Action", exec: () => setOverlay("monitor") },
          { icon: "◫", label: "ER diagram (relationships)", type: "Action", exec: () => setOverlay("diagram") },
          // The log only records statements run against prod.
          ...(connectedEnv === "prod"
            ? [{ icon: "🛡", label: "Prod audit log", type: "Action", exec: () => setOverlay("audit") } as PaletteItem]
            : []),
          { icon: "⏻", label: "Disconnect current session", type: "Action", exec: doDisconnect },
          ...(inTx
            ? [
                { icon: "✓", label: "Commit transaction", type: "Action", exec: doCommit } as PaletteItem,
                { icon: "↩", label: "Rollback transaction", type: "Action", exec: doRollback } as PaletteItem,
              ]
            : [{ icon: "▣", label: "Begin transaction", type: "Action", exec: doBegin } as PaletteItem]),
        ];

    const connections: PaletteItem[] = saved.map((c) => ({
      icon: "⇄",
      label: `Connect to ${c.name}`,
      type: "Connection",
      exec: () => selectProfile(c),
    }));

    const catalogItems: PaletteItem[] = Object.entries(objects).flatMap(([schema, objs]) =>
      objs.flatMap((o): PaletteItem[] => [
        {
          icon: o.kind === "view" || o.kind === "matview" ? "V" : "T",
          label: `${schema}.${o.name}`,
          type: "Table",
          exec: () => insertSelect(schema, o.name),
        },
        {
          icon: "▤",
          label: `Describe ${schema}.${o.name}`,
          type: "Table",
          exec: () => describeObject(schema, o.name),
        },
      ]),
    );

    const snippetItems: PaletteItem[] = snippets.map((sn) => ({
      icon: "✎",
      label: sn.name,
      type: "Snippet",
      exec: () => {
        setActiveSql(sn.body);
        showToast(`Inserted snippet "${sn.name}"`);
      },
    }));

    const recent: PaletteItem[] = historyItems
      .slice(0, 6)
      .filter((h): h is typeof h & { sqlText: string } => !!h.sqlText)
      .map((h) => ({
        icon: "↺",
        label: h.sqlText.slice(0, 70),
        type: "Recent",
        exec: () => setActiveSql(h.sqlText),
      }));

    return [...items, ...live, ...connections, ...catalogItems, ...snippetItems, ...recent];
  }, [doRun, doFormat, saveSnippet, newTab, applyTheme, theme, newProfile, runExplain, connected, connectedEnv, inTx, doDisconnect, doBegin, doCommit, doRollback, saved, selectProfile, objects, insertSelect, describeObject, snippets, historyItems, setActiveSql, showToast, loadHealth]);

  /* ---------------- render ---------------- */

  const activeProfile = saved.find((c) => c.id === profileId) ?? null;
  const isProd = connected && connectedEnv === "prod";
  // HUD design: two-state label — live when connected, cached otherwise.
  const explorerSource: "live" | "cached" | "—" =
    connected && !metaCached ? "live" : schemas !== null || metaCached ? "cached" : "—";

  /* ---------------- auto-update ---------------- */

  // Held so the toast's "Update" button installs the very update we found,
  // rather than re-checking and racing.
  const pendingUpdate = useRef<Update | null>(null);
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const up = await check();
        if (!up || cancelled) return;
        pendingUpdate.current = up;
        setUpdateInfo({ version: up.version, notes: up.body ?? "" });
      } catch {
        // No endpoint configured, offline, or a dev build — never bother the
        // user about a failed update check.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const installUpdate = useCallback(async () => {
    const up = pendingUpdate.current;
    if (!up) return;
    if (inTx) {
      showToast("Commit or roll back your transaction before updating");
      return;
    }
    setUpdating(true);
    try {
      showToast("Downloading update…");
      await up.downloadAndInstall();
      await relaunch();
    } catch (e) {
      setUpdating(false);
      showToast(`Update failed: ${String(e).slice(0, 60)}`);
    }
  }, [inTx, showToast]);

  return (
    <div className={`shell ${connected ? `env-frame env-${connectedEnv ?? "dev"}` : ""}`}>
      {connected && <div className="env-glow" aria-hidden />}
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
        sidebarCollapsed={sidebarCollapsed}
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
          collapsed={sidebarCollapsed}
          connected={connected}
          onView={handleRailView}
          onMonitor={() => setOverlay("monitor")}
          onDiagram={() => setOverlay("diagram")}
          onSettings={() => setOverlay("settings")}
        />
        <aside
          className={`sidebar ${sidebarCollapsed ? "collapsed" : ""}`}
          style={{ width: sidebarCollapsed ? 0 : sidebarWidth }}
        >
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
                open={openNodes}
                onToggle={toggleNode}
                objects={objects}
                columns={columns}
                indexes={indexes}
                constraints={constraints}
                partitions={partitions}
                types={types}
                routines={routines}
                onInsertSelect={insertSelect}
                onDescribe={describeObject}
                onDetails={showDetails}
                onPartitions={showPartitions}
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
                  await clearHistory();
                  showToast("Cleared history — favorites kept");
                }}
                onToggleFavorite={(h) => toggleHistoryFavorite(h.id, !h.favorite)}
                onLoad={(sql) => {
                  setActiveSql(sql);
                  showToast("Loaded into editor");
                }}
              />
            </>
          )}
        </aside>
        {!sidebarCollapsed && (
          <div
            className="sidebar-resize"
            title="Drag to resize"
            onMouseDown={(e) => {
              sidebarDragRef.current = { x: e.clientX, w: sidebarWidth };
              document.body.style.cursor = "col-resize";
            }}
          />
        )}
        <main className="main-col">
          <TabsBar tabs={tabs} active={activeTab} onSelect={setActiveTab} onClose={closeTab} onNew={() => newTab()} />
          {tabs.length === 0 ? (
            <div className="onboard">
              <div className="card">
                <div className="onboard-glyph">
                  <BrandMark size={32} />
                </div>
                <div className="big">No query open</div>
                <p>
                  Open a new query tab, pick a table from the Explorer to insert a select, or jump
                  anywhere with the command palette.
                </p>
                <div className="row">
                  {/* Not `onClick={newTab}` — that hands the MouseEvent to
                      newTab as its init options. */}
                  <button className="btn primary" onClick={() => newTab()}>
                    New query <span className="kbd">{kbd("mod", "T")}</span>
                  </button>
                  <button className="btn" onClick={() => setOverlay("palette")}>
                    Command palette <span className="kbd">{kbd("mod", "K")}</span>
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
              status={query.status}
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
              onCopyResult={doCopyResult}
              csvSafe={csvSafe}
              onCsvSafe={setCsvSafe}
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
                // `totalRows`, not `storedRows`. The grid keeps the first
                // 100,000; the query may have matched five million. Counting
                // "of 100,000" turns the cap into the answer and hides that
                // there is anything else — the one number a person reads to
                // decide whether they have seen it all.
                setRowsInfo(result ? `rows ${a.toLocaleString()}–${b.toLocaleString()} of ${rowCountNote(result.storedRows, result)}` : "")
              }
              catalog={catalog}
              onPrefetchTables={prefetchTables}
              onPrefetchSchema={prefetchSchemaObjects}
              editTarget={editTarget}
              editReason={editability && !editability.editable ? editability.reason : null}
              edits={edits}
              onStageEdit={stageEdit}
              onReviewEdits={() => setReviewOpen(true)}
              onDiscardEdits={discardEdits}
              history={{
                items: historyItems,
                search: historySearch,
                onSearch: setHistorySearch,
                onClear: async () => {
                  await clearHistory();
                  showToast("Cleared history — favorites kept");
                },
                onToggleFavorite: (h) => toggleHistoryFavorite(h.id, !h.favorite),
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
        now={now}
        serverVersion={serverVersion}
        osLabel={info?.os ?? ""}
      />

      {toast && <div className="toast">{toast}</div>}

      {overlay === "palette" && (
        <Palette
          items={paletteItems}
          q={paletteQ}
          idx={paletteIdx}
          onQ={setPaletteQ}
          onIdx={setPaletteIdx}
          onPick={(it) => {
            setOverlay(null);
            void it.exec();
          }}
          onClose={() => setOverlay(null)}
        />
      )}
      {overlay === "connEditor" && (
        <ConnectionForm
          isEdit={profileId !== null}
          profileName={profileName}
          environment={environment}
          readOnly={form.readOnly}
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
          onSshEnabled={(v) => form.set("sshEnabled", v)}
          onSshHost={(v) => form.set("sshHost", v)}
          onSshPort={(v) => form.set("sshPort", v)}
          onSshUser={(v) => form.set("sshUser", v)}
          onSshKeyPath={(v) => form.set("sshKeyPath", v)}
          onSshFingerprint={(v) => form.set("sshFingerprint", v)}
          onProfileName={(v) => form.set("profileName", v)}
          onEnvironment={(v) => form.set("environment", v)}
          onReadOnly={(v) => form.set("readOnly", v)}
          onHost={(v) => form.set("host", v)}
          onPort={(v) => form.set("port", v)}
          onDatabase={(v) => form.set("database", v)}
          onUsername={(v) => form.set("username", v)}
          onPassword={(v) => form.set("password", v)}
          onTlsMode={(v) => form.set("tlsMode", v)}
          onTlsCaPath={(v) => form.set("tlsCaPath", v)}
          onSave={doSaveProfile}
          onTest={doTest}
          onSaveConnect={saveAndConnect}
          onClose={() => setOverlay(null)}
        />
      )}
      {overlay === "txPrompt" && (
        <TxPrompt
          closing={closing}
          onCommit={async () => {
            await commitAndDisconnect();
            if (closing) await finishClose();
          }}
          onRollback={async () => {
            await rollbackAndDisconnect();
            if (closing) await finishClose();
          }}
          onStay={() => {
            setClosing(false);
            setOverlay(null);
          }}
        />
      )}
      {overlay === "import" && (
        <ImportModal
          schemas={schemas ?? ["public"]}
          env={connectedEnv}
          inTx={inTx}
          onDone={(m) => {
            showToast(m);
            resetExplorer();
            void refreshHistory();
          }}
          onClose={() => setOverlay(null)}
        />
      )}
      {overlay === "details" && details && (
        <DetailsModal
          schema={details.schema}
          details={details.data}
          error={details.error}
          onClose={() => setOverlay(null)}
        />
      )}
      {overlay === "health" && (
        <HealthModal
          tab={health.tab}
          onTab={loadHealth}
          indexes={health.indexes}
          tables={health.tables}
          queries={health.queries}
          error={health.error}
          // Opened as a tab, never executed. Dropping 580 indexes is not a
          // thing an app should offer to do on one click, and the comments at
          // the top of the script are the point of generating it.
          onOpenScript={(sql) => openScript("drop-unused-indexes.sql", sql)}
          onClose={() => setOverlay(null)}
        />
      )}
      {overlay === "parts" && parts && (
        <PartitionsModal
          schema={parts.schema}
          table={parts.table}
          data={parts.data}
          error={parts.error}
          onOpenScript={openScript}
          onClose={() => setOverlay(null)}
        />
      )}
      {overlay === "search" && (
        <SearchModal
          results={search.results}
          busy={search.busy}
          error={search.error}
          onSearch={search.run}
          onPick={(h: SearchHit) => {
            setOverlay(null);
            void showDetails(h.schema, h.name, h.kind === "column" ? "table" : h.kind);
          }}
          onClose={() => setOverlay(null)}
        />
      )}
      {overlay === "intel" && (
        <IntelModal
          tabs={tabs.map((t) => ({ name: t.name, sql: t.sql }))}
          catalog={catalog}
          plans={plans}
          onJump={(tabIndex) => setActiveTab(tabIndex)}
          onRename={(tabIndex, sql) =>
            setTabs((ts) => {
              const out = [...ts];
              if (out[tabIndex]) out[tabIndex] = { ...out[tabIndex], sql, dirty: true };
              return out;
            })
          }
          onClose={() => setOverlay(null)}
        />
      )}
      {reviewOpen && editTarget && edits.length > 0 && (
        <EditReviewModal
          target={editTarget}
          edits={edits}
          env={connectedEnv}
          applying={applying}
          error={applyError}
          onApply={applyEdits}
          onDiscard={discardEdits}
          onClose={() => setReviewOpen(false)}
        />
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
            void doRun(true);
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
          onAbout={() => setOverlay("about")}
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
            void doRun(true, paramValues.map(coerceParam));
          }}
          onCancel={() => setOverlay(null)}
        />
      )}
      {overlay === "monitor" && (
        // `connectedEnv` and not the form's `environment`: the form may have
        // been edited since, and a kill is aimed at the live session.
        <MonitorModal env={connectedEnv} onToast={showToast} onClose={() => setOverlay(null)} />
      )}
      {overlay === "diagram" && (
        <DiagramModal
          schema={(schemas ?? []).includes("public") ? "public" : schemas?.[0] ?? "public"}
          onClose={() => setOverlay(null)}
        />
      )}
      {overlay === "audit" && <AuditModal onClose={() => setOverlay(null)} />}
      {overlay === "snippetName" && (
        <NamePrompt
          title="Save snippet"
          label="Name"
          value={snippetName}
          onChange={setSnippetName}
          onSave={commitSnippet}
          onCancel={() => setOverlay(null)}
        />
      )}
      {overlay === "cheatsheet" && <Cheatsheet onClose={() => setOverlay(null)} />}
      {overlay === "about" && (
        <About
          version={info?.version ?? ""}
          os={info?.os ?? ""}
          onClose={() => setOverlay(null)}
        />
      )}
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
          busy={updating}
          onUpdate={installUpdate}
          onDismiss={() => setUpdateInfo(null)}
        />
      )}
      {overlay === "explain" && explain && (
        <ExplainModal
          title={explain.title}
          sql={explain.sql}
          statement={explain.statement}
          raw={explain.raw}
          stale={JSON.stringify(explain.ranOpts) !== JSON.stringify(explainOpts)}
          options={explainOpts}
          serverMajor={serverMajor}
          nodes={explain.nodes}
          stats={explain.stats}
          suggestion={explain.suggestion}
          error={explain.error}
          busy={explainBusy}
          onOptions={setExplainOpts}
          onRerun={() => runExplain(explainOpts)}
          onExport={exportPlan}
          onCopy={copyPlan}
          onClose={() => setOverlay(null)}
        />
      )}
    </div>
  );
}
