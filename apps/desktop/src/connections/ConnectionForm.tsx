import type { TestStage } from "../ipc/types";

type Props = {
  isEdit: boolean;
  profileName: string;
  environment: string;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  hasSecret: boolean;
  tlsMode: string;
  tlsCaPath: string;
  connected: boolean;
  status: string;
  stages: TestStage[] | null;
  onProfileName: (v: string) => void;
  onEnvironment: (v: string) => void;
  onHost: (v: string) => void;
  onPort: (v: number) => void;
  onDatabase: (v: string) => void;
  onUsername: (v: string) => void;
  onPassword: (v: string) => void;
  onTlsMode: (v: string) => void;
  onTlsCaPath: (v: string) => void;
  onSave: () => void;
  onTest: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
};

/** Connection profile editor with staged test results (E1.2). */
export default function ConnectionForm(p: Props) {
  return (
    <section className="panel">
      <h2>{p.isEdit ? "Edit connection" : "New connection"}</h2>
      <div className="form-row">
        <input
          placeholder="profile name"
          value={p.profileName}
          onChange={(e) => p.onProfileName(e.target.value)}
        />
        <select value={p.environment} onChange={(e) => p.onEnvironment(e.target.value)}>
          <option value="dev">dev</option>
          <option value="test">test</option>
          <option value="staging">staging</option>
          <option value="prod">prod</option>
        </select>
      </div>
      <div className="form-row">
        <input placeholder="host" value={p.host} onChange={(e) => p.onHost(e.target.value)} />
        <input
          placeholder="port"
          type="number"
          value={p.port}
          onChange={(e) => p.onPort(Number(e.target.value) || 5432)}
          style={{ width: 80 }}
        />
        <input
          placeholder="database"
          value={p.database}
          onChange={(e) => p.onDatabase(e.target.value)}
        />
        <input
          placeholder="username"
          value={p.username}
          onChange={(e) => p.onUsername(e.target.value)}
        />
        <input
          placeholder={p.hasSecret ? "password saved in keychain" : "password (optional)"}
          type="password"
          value={p.password}
          onChange={(e) => p.onPassword(e.target.value)}
        />
      </div>
      <div className="form-row">
        <label className="muted">TLS</label>
        <select value={p.tlsMode} onChange={(e) => p.onTlsMode(e.target.value)}>
          <option value="verify-full">verify-full (default)</option>
          <option value="verify-ca">verify-ca</option>
          <option value="prefer">prefer (no verification)</option>
          <option value="disabled">disabled (local only)</option>
        </select>
        {(p.tlsMode === "verify-full" || p.tlsMode === "verify-ca") && (
          <input
            placeholder="CA file path (optional, PEM)"
            value={p.tlsCaPath}
            onChange={(e) => p.onTlsCaPath(e.target.value)}
            style={{ flex: 1 }}
          />
        )}
      </div>
      <div className="form-row">
        <button onClick={p.onSave}>Save</button>
        <button onClick={p.onTest}>Test</button>
        {p.connected ? (
          <button onClick={p.onDisconnect}>Disconnect</button>
        ) : (
          <button onClick={p.onConnect}>Connect</button>
        )}
        <span className="status">{p.status}</span>
      </div>
      {p.stages && (
        <ul className="stage-list">
          {p.stages.map((s) => (
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
  );
}
