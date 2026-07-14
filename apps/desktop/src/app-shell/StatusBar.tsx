type Props = {
  connected: boolean;
  isProd: boolean;
  connName: string;
  tlsMode: string;
  explorerSource: "live" | "cached" | "—";
  rowsInfo: string;
  txOpenSince: number | null; // epoch ms
  serverVersion: string | null;
  osLabel: string;
};

export default function StatusBar(p: Props) {
  const txSecs = p.txOpenSince ? Math.floor((Date.now() - p.txOpenSince) / 1000) : 0;
  const txLabel =
    txSecs >= 60 ? `${Math.floor(txSecs / 60)}m ${String(txSecs % 60).padStart(2, "0")}s` : `${txSecs}s`;
  return (
    <footer className="statusbar">
      <span className="item">
        <span
          className="dot"
          style={{ background: p.connected ? (p.isProd ? "#ef4d4d" : "#3fb950") : "#4a4f57" }}
        />
        {p.connected ? p.connName : "disconnected"}
      </span>
      <span className="bar-sep">|</span>
      <span className="item lock">{p.tlsMode === "disabled" ? "plaintext" : `🔒 ${p.tlsMode}`}</span>
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
          PostgreSQL {p.serverVersion}
          {p.osLabel ? ` · ${p.osLabel}` : ""}
        </span>
      )}
    </footer>
  );
}
