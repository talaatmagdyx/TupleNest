import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { baseName } from "../lib/save";
import { errText } from "../lib/text";
import { DialogTitle, Overlay } from "../overlays/Overlays";
import type { ConnectionRecord } from "../ipc/types";
import { isPostgres, type PageContext } from "./context";
import PageHeader from "./PageHeader";

export type BackupRecord = {
  id: string;
  connectionId: string | null;
  kind: "backup" | "restore";
  database: string;
  filePath: string;
  status: "running" | "done" | "failed" | "cancelled";
  bytes: number | null;
  message: string | null;
  startedAt: number;
  finishedAt: number | null;
};

type Tools = { pgDump: string | null; pgRestore: string | null; configured: string | null };
type Started = { id: string; file: string };
type Running = Started & { kind: "backup" | "restore"; tables: number; line: string };

export function sizeText(bytes: number | null): string {
  if (bytes === null) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 10 || u === 0 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Backup and restore with the user's own pg_dump and pg_restore.
 *
 * The page never names a path: the backend opens the save or open panel, or
 * restores a file it recorded itself. The password never leaves the backend
 * (a private PGPASSFILE for the child). Restoring into prod or staging asks
 * for the database name typed back, and the backend checks it again.
 */
export default function BackupPage(p: { ctx: PageContext }) {
  const { ctx } = p;
  const toast = ctx.toast;
  const profiles = ctx.saved.filter(isPostgres);
  const [profileId, setProfileId] = useState<string>(
    (ctx.liveProfile && isPostgres(ctx.liveProfile) ? ctx.liveProfile.id : profiles[0]?.id) ?? "",
  );
  const profile = profiles.find((c) => c.id === profileId) ?? null;
  const [tools, setTools] = useState<Tools | null>(null);
  const [folder, setFolder] = useState("");
  const [list, setList] = useState<BackupRecord[]>([]);
  const [running, setRunning] = useState<Running | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<{ backup: BackupRecord | null; target: ConnectionRecord } | null>(null);

  const refresh = useCallback(async () => {
    try {
      setList(await invoke<BackupRecord[]>("backup_list"));
    } catch (e) {
      toast(`Recent backups did not load: ${errText(e)}`);
    }
  }, [toast]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading on mount is what an effect is for
    void refresh();
    invoke<Tools>("backup_tools")
      .then((t) => {
        setTools(t);
        setFolder(t.configured ?? "");
      })
      .catch(() => setTools({ pgDump: null, pgRestore: null, configured: null }));
  }, [refresh]);

  useEffect(() => {
    const progress = listen<{ id: string; tables: number; line: string }>("backup:progress", (e) =>
      setRunning((r) => (r && r.id === e.payload.id ? { ...r, tables: e.payload.tables, line: e.payload.line } : r)),
    );
    const done = listen<{ id: string; status: string; message: string | null }>("backup:done", (e) => {
      setRunning((r) => (r && r.id === e.payload.id ? null : r));
      if (e.payload.status === "failed") setError(e.payload.message ?? "The run failed.");
      toast(e.payload.status === "done" ? "Finished" : e.payload.status === "cancelled" ? "Cancelled" : "Failed");
      void refresh();
    });
    return () => {
      void progress.then((stop) => stop());
      void done.then((stop) => stop());
    };
  }, [refresh, toast]);

  const start = async (kind: "backup" | "restore", run: () => Promise<Started | null>) => {
    setError(null);
    try {
      const started = await run();
      if (started) {
        setRunning({ ...started, kind, tables: 0, line: "" });
        void refresh();
      }
    } catch (e) {
      setError(errText(e));
    }
  };

  const backup = () =>
    profile &&
    start("backup", () =>
      invoke<Started | null>("backup_start", {
        connectionId: profile.id,
        defaultName: `${profile.database}-${today()}.dump`,
      }),
    );

  const setToolsFolder = async (dir: string | null) => {
    try {
      const t = await invoke<Tools>("backup_tools_set", { dir });
      setTools(t);
      setError(null);
    } catch (e) {
      setError(errText(e));
    }
  };

  const nameOf = (id: string | null) => ctx.saved.find((c) => c.id === id)?.name ?? "deleted connection";

  return (
    <section className="page" aria-label="Backup and restore">
      <PageHeader
        title="Backup and restore"
        sub="Uses pg_dump and pg_restore from your PostgreSQL install. Files stay on this computer."
        onBack={ctx.back}
      />

      <div className="bk-cols">
        <div className="bk-main">
          {profiles.length === 0 ? (
            <div className="page-empty">
              <p>Save a PostgreSQL connection first: backups are made from a saved connection.</p>
            </div>
          ) : (
            <div className="page-strip">
              <label>
                Connection
                <select aria-label="Connection" value={profileId} onChange={(e) => setProfileId(e.target.value)}>
                  {profiles.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} · {c.database}
                    </option>
                  ))}
                </select>
              </label>
              <div className="grow" />
              <button className="btn primary" disabled={!profile || !!running || !tools?.pgDump} onClick={() => void backup()}>
                Back up…
              </button>
              <button
                className="btn"
                disabled={!profile || !!running || !tools?.pgRestore}
                onClick={() => profile && setRestoring({ backup: null, target: profile })}
              >
                Restore from a file…
              </button>
            </div>
          )}

          {running && (
            <div className="bk-run" role="status" aria-live="polite">
              <div className="bk-run-head">
                <b>
                  {running.kind === "backup" ? "Backing up" : "Restoring"} {baseName(running.file)}
                </b>
                <div className="grow" />
                <button className="btn xs" onClick={() => void invoke("backup_cancel")}>
                  Cancel
                </button>
              </div>
              <div className="bk-bar">
                <span />
              </div>
              <span className="page-sub">
                {running.tables} table{running.tables === 1 ? "" : "s"} so far{running.line ? ` · ${running.line}` : ""}
              </span>
            </div>
          )}

          {error && (
            <div className="dash-error" role="alert">
              {error}
            </div>
          )}

          {tools && (!tools.pgDump || !tools.pgRestore || tools.configured) && (
            <form
              className="page-strip"
              onSubmit={(e) => {
                e.preventDefault();
                void setToolsFolder(folder.trim() || null);
              }}
            >
              <span className="page-sub">
                {!tools.pgDump || !tools.pgRestore
                  ? `${!tools.pgDump ? "pg_dump" : "pg_restore"} was not found on this computer. Install the PostgreSQL client tools, or give the folder that holds them.`
                  : `Using the tools in ${tools.configured}.`}
              </span>
              <label>
                Folder
                <input aria-label="Tools folder" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="/opt/homebrew/opt/libpq/bin" />
              </label>
              <button className="btn" type="submit">
                Use this folder
              </button>
            </form>
          )}
        </div>

        <aside className="bk-list" aria-label="Recent backups">
          <span className="welcome-label">Recent backups</span>
          {list.length === 0 && <span className="page-sub">None yet.</span>}
          {list.map((b) => (
            <div key={b.id} className="bk-item">
              <div className="bk-item-text">
                <span className="mono">{baseName(b.filePath)}</span>
                <span className="page-sub">
                  {b.kind === "restore" ? "restore · " : ""}
                  {b.status === "done" ? sizeText(b.bytes) : b.status} · {new Date(b.startedAt * 1000).toLocaleString()} ·{" "}
                  {nameOf(b.connectionId)}
                </span>
                {b.status === "failed" && b.message && <span className="page-sub">{b.message.split("\n")[0]}</span>}
              </div>
              {b.kind === "backup" && b.status === "done" && (
                <button
                  className="btn xs"
                  disabled={!profile || !!running || !tools?.pgRestore}
                  aria-label={`Restore ${baseName(b.filePath)}`}
                  onClick={() => profile && setRestoring({ backup: b, target: profile })}
                >
                  Restore…
                </button>
              )}
            </div>
          ))}
          <span className="page-sub">Restoring into a prod or staging connection asks you to type the database name first.</span>
        </aside>
      </div>

      {restoring && (
        <RestoreConfirm
          target={restoring.target}
          file={restoring.backup ? baseName(restoring.backup.filePath) : null}
          onCancel={() => setRestoring(null)}
          onRestore={(confirm) => {
            const r = restoring;
            setRestoring(null);
            void start("restore", () =>
              invoke<Started | null>("backup_restore", {
                connectionId: r.target.id,
                backupId: r.backup?.id ?? null,
                confirm,
              }),
            );
          }}
        />
      )}
    </section>
  );
}

/** The worst guard case's confirmation, for a restore: on prod or staging
 *  the database name has to be typed before the button wakes up. */
export function RestoreConfirm(p: {
  target: ConnectionRecord;
  file: string | null;
  onCancel: () => void;
  onRestore: (confirm: string | null) => void;
}) {
  const guarded = p.target.environment === "prod" || p.target.environment === "staging";
  const [typed, setTyped] = useState("");
  const ok = !guarded || typed.trim() === p.target.database;
  return (
    <Overlay onClose={p.onCancel} center alert>
      <div className="modal dialog guard">
        {guarded && <div className="danger-strip" aria-hidden />}
        <DialogTitle>
          Restore into {p.target.name}
          {guarded ? ` (${p.target.environment})` : ""}
        </DialogTitle>
        <p>
          {p.file ? (
            <>
              <b className="mono">{p.file}</b> will be restored
            </>
          ) : (
            "You will pick a backup file, and it will be restored"
          )}{" "}
          into the database <b className="mono">{p.target.database}</b> on {p.target.host}. Objects it creates that
          already exist fail; nothing is dropped first.
        </p>
        {guarded && (
          <label className="d-confirm">
            <span>
              Type <b className="mono">{p.target.database}</b> to confirm
            </span>
            <input
              className="mono"
              aria-label="Database name"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
            />
          </label>
        )}
        <div className="d-actions end">
          <button className="btn primary" autoFocus onClick={p.onCancel}>
            Don&apos;t restore
          </button>
          <button className="btn danger outline" disabled={!ok} onClick={() => p.onRestore(guarded ? typed.trim() : null)}>
            Restore
          </button>
        </div>
      </div>
    </Overlay>
  );
}
