import { useEffect, useState } from "react";
import type { Engine } from "../lib/engine";

type Props = {
  /** The live session's engine. Absent is PostgreSQL. A SQLite session is a
   *  local file: no TLS to report, and its version is SQLite's. */
  engine?: Engine;
  connected: boolean;
  isProd: boolean;
  connName: string;
  tlsMode: string;
  explorerSource: "live" | "cached" | "—";
  rowsInfo: string;
  txOpenSince: number | null; // epoch ms
  serverVersion: string | null;
  osLabel: string;
  /** Commit and time this bundle was built, so the window can identify itself.
   *  Optional and hidden when empty — a checkout without git history has
   *  nothing honest to put here. */
  buildLabel?: string;
};

export default function StatusBar(p: Props) {
  // The clock ticks here, not in App: a tick re-renders this bar only, not
  // the whole window once a second for as long as a transaction is open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!p.txOpenSince) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [p.txOpenSince]);
  // `now` is as of the last tick, so it can trail a transaction that just opened.
  const txSecs = p.txOpenSince ? Math.max(0, Math.floor((now - p.txOpenSince) / 1000)) : 0;
  const txLabel =
    txSecs >= 60 ? `${Math.floor(txSecs / 60)}m ${String(txSecs % 60).padStart(2, "0")}s` : `${txSecs}s`;
  const sqlite = p.engine === "sqlite";
  return (
    <footer className={`statusbar ${p.connected ? "" : "off"}`}>
      <span className="item">
        <span
          className="dot"
          style={{
            backgroundColor: p.connected ? (p.isProd ? "var(--tn-danger)" : "var(--tn-success)") : "var(--tn-tm)",
          }}
        />
        {p.connected ? p.connName : "disconnected"}
      </span>
      <span className="bar-sep">|</span>
      <span className="item lock">
        {sqlite ? "local file" : p.tlsMode === "disabled" ? "plaintext" : `🔒 ${p.tlsMode}`}
      </span>
      <span className="bar-sep">|</span>
      <span className="item">explorer: {p.explorerSource}</span>
      {p.rowsInfo && (
        <>
          <span className="bar-sep">|</span>
          <span className="item">{p.rowsInfo}</span>
        </>
      )}
      <div className="grow" />
      {p.txOpenSince && <span className="item txwarn">⚠ tx open {txLabel}</span>}
      {p.serverVersion && (
        <span className="item">
          {sqlite ? "SQLite" : "PostgreSQL"} {p.serverVersion}
          {p.osLabel ? ` · ${p.osLabel}` : ""}
        </span>
      )}
      {p.buildLabel && (
        <>
          <span className="bar-sep">|</span>
          <span className="item build" title="The build this window is running">
            {p.buildLabel}
          </span>
        </>
      )}
    </footer>
  );
}
