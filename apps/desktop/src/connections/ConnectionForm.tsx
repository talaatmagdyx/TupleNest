import type { TestStage } from "../ipc/types";
import { ModalHead, Overlay } from "../overlays/Overlays";

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
  testing: boolean;
  sshEnabled: boolean;
  sshHost: string;
  sshPort: number;
  sshUser: string;
  sshKeyPath: string;
  sshFingerprint: string;
  onSshEnabled: (v: boolean) => void;
  onSshHost: (v: string) => void;
  onSshPort: (v: number) => void;
  onSshUser: (v: string) => void;
  onSshKeyPath: (v: string) => void;
  onSshFingerprint: (v: string) => void;
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
  onSaveConnect: () => void;
  onClose: () => void;
};

/** Connection editor modal (HUD design, screen "Connection editor"). */
export default function ConnectionForm(p: Props) {
  return (
    <Overlay onClose={p.onClose}>
      <div className="modal" style={{ width: 620 }}>
        <ModalHead title={p.isEdit ? "Edit connection" : "New connection"} onClose={p.onClose} />
        <div className="modal-body">
          <div className="frow">
            <div className="field">
              <label>Name</label>
              <input value={p.profileName} onChange={(e) => p.onProfileName(e.target.value)} />
            </div>
            <div className="field" style={{ flex: "0 0 240px" }}>
              <label>Environment</label>
              <div className="seg">
                {["dev", "test", "staging", "prod"].map((env) => (
                  <button
                    key={env}
                    className={`${p.environment === env ? "on" : ""} ${env === "prod" ? "prod" : ""}`}
                    onClick={() => p.onEnvironment(env)}
                  >
                    {env}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="frow">
            <div className="field">
              <label>Host</label>
              <input className="mono" value={p.host} onChange={(e) => p.onHost(e.target.value)} />
            </div>
            <div className="field w90">
              <label>Port</label>
              <input
                className="mono"
                type="number"
                value={p.port}
                onChange={(e) => p.onPort(Number(e.target.value) || 5432)}
              />
            </div>
          </div>
          <div className="frow">
            <div className="field">
              <label>Database</label>
              <input className="mono" value={p.database} onChange={(e) => p.onDatabase(e.target.value)} />
            </div>
            <div className="field">
              <label>Username</label>
              <input className="mono" value={p.username} onChange={(e) => p.onUsername(e.target.value)} />
            </div>
          </div>
          <div className="field">
            <label>Password</label>
            <input
              type="password"
              placeholder={p.hasSecret ? "password saved in keychain" : "password (optional)"}
              value={p.password}
              onChange={(e) => p.onPassword(e.target.value)}
            />
            <div className="hint">🔒 Stored in the OS keychain — never in config files.</div>
          </div>
          <div className="frow">
            <div className="field" style={{ flex: "0 0 170px" }}>
              <label>TLS mode</label>
              <select value={p.tlsMode} onChange={(e) => p.onTlsMode(e.target.value)}>
                <option value="verify-full">verify-full</option>
                <option value="verify-ca">verify-ca</option>
                <option value="prefer">prefer</option>
                <option value="disabled">disabled</option>
              </select>
            </div>
            {(p.tlsMode === "verify-full" || p.tlsMode === "verify-ca") && (
              <div className="field">
                <label>CA file (optional)</label>
                <input
                  className="mono"
                  placeholder="/etc/ssl/ca.pem"
                  value={p.tlsCaPath}
                  onChange={(e) => p.onTlsCaPath(e.target.value)}
                />
              </div>
            )}
          </div>
          <div className="section-row">
            <span className="st">SSH tunnel</span>
            <button className={`toggle ${p.sshEnabled ? "on" : ""}`} onClick={() => p.onSshEnabled(!p.sshEnabled)}>
              <span className="knob" />
            </button>
          </div>
          {p.sshEnabled && (
            <>
              <div className="frow">
                <div className="field">
                  <label>SSH host</label>
                  <input className="mono" placeholder="bastion.internal" value={p.sshHost} onChange={(e) => p.onSshHost(e.target.value)} />
                </div>
                <div className="field w90">
                  <label>Port</label>
                  <input className="mono" type="number" value={p.sshPort} onChange={(e) => p.onSshPort(Number(e.target.value) || 22)} />
                </div>
              </div>
              <div className="frow">
                <div className="field">
                  <label>SSH user</label>
                  <input className="mono" placeholder="deploy" value={p.sshUser} onChange={(e) => p.onSshUser(e.target.value)} />
                </div>
                <div className="field">
                  <label>Private key path</label>
                  <input className="mono" placeholder="~/.ssh/id_ed25519" value={p.sshKeyPath} onChange={(e) => p.onSshKeyPath(e.target.value)} />
                </div>
              </div>
              <div className="field">
                <label>Host-key SHA256 fingerprint</label>
                <input className="mono" placeholder="empty → known_hosts" value={p.sshFingerprint} onChange={(e) => p.onSshFingerprint(e.target.value)} />
              </div>
            </>
          )}
          {(p.stages || p.testing) && (
            <div className="test-panel">
              <div className="tp-head">
                <span className="tp-title">Connection test</span>
                <span
                  className="mono"
                  style={{
                    fontSize: 10.5,
                    fontWeight: 700,
                    color: p.testing
                      ? "var(--tn-warning)"
                      : p.stages && p.stages.every((s) => s.passed)
                        ? "var(--tn-success)"
                        : "var(--tn-danger)",
                  }}
                >
                  {p.testing ? "running…" : p.stages && p.stages.every((s) => s.passed) ? "all stages passed" : "failed"}
                </span>
              </div>
              {(p.stages ?? []).map((s) => (
                <div key={s.name} className="stage-line">
                  <span className={s.passed ? "ok" : "fail"}>{s.passed ? "✓" : "✕"}</span>
                  <span className="sn">{s.name}</span>
                  <span className="ms">{s.durationMs} ms</span>
                  <span className="det">{s.detail ?? ""}</span>
                </div>
              ))}
              {p.testing && (
                <div className="stage-line">
                  <span className="spin" style={{ width: 11, height: 11 }} />
                  <span className="sn muted">testing…</span>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={p.onTest}>
            Test
          </button>
          <span className="muted" style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 200 }}>
            {p.status}
          </span>
          <div className="grow" />
          <button className="btn" onClick={p.onClose}>
            Cancel
          </button>
          <button className="btn" onClick={p.onSave}>
            Save
          </button>
          <button className="btn primary" onClick={p.onSaveConnect}>
            Save &amp; Connect
          </button>
        </div>
      </div>
    </Overlay>
  );
}
