import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ConnectionForm from "./ConnectionForm";
import type { TestStage } from "../ipc/types";

const base = {
  isEdit: false,
  profileName: "engagement_database",
  environment: "dev",
  host: "localhost",
  port: 5432,
  database: "omniserve",
  username: "omniserve",
  password: "",
  hasSecret: false,
  tlsMode: "prefer",
  tlsCaPath: "",
  connected: false,
  status: "",
  stages: null as TestStage[] | null,
  testing: false,
  testSummary: "",
  sshEnabled: false,
  sshHost: "",
  sshPort: 22,
  sshUser: "",
  sshKeyPath: "",
  sshFingerprint: "",
  onSshEnabled: vi.fn(),
  onSshHost: vi.fn(),
  onSshPort: vi.fn(),
  onSshUser: vi.fn(),
  onSshKeyPath: vi.fn(),
  onSshFingerprint: vi.fn(),
  onProfileName: vi.fn(),
  onEnvironment: vi.fn(),
  onHost: vi.fn(),
  onPort: vi.fn(),
  onDatabase: vi.fn(),
  onUsername: vi.fn(),
  onPassword: vi.fn(),
  onTlsMode: vi.fn(),
  onTlsCaPath: vi.fn(),
  onSave: vi.fn(),
  onTest: vi.fn(),
  onSaveConnect: vi.fn(),
  onClose: vi.fn(),
};

const stage = (name: string, passed: boolean, detail: string | null = null): TestStage => ({
  name,
  passed,
  durationMs: 12,
  detail,
});

describe("ConnectionForm — shape", () => {
  it("titles for a new connection", () => {
    render(<ConnectionForm {...base} />);
    expect(screen.getByText("New connection")).toBeInTheDocument();
  });

  it("titles for an edit", () => {
    render(<ConnectionForm {...base} isEdit />);
    expect(screen.getByText("Edit connection")).toBeInTheDocument();
  });

  it("shows the values it was given", () => {
    render(<ConnectionForm {...base} />);
    expect(screen.getByDisplayValue("engagement_database")).toBeInTheDocument();
    expect(screen.getByDisplayValue("localhost")).toBeInTheDocument();
    expect(screen.getByDisplayValue("5432")).toBeInTheDocument();
  });

  it("reports edits to each field", async () => {
    // The labels are not tied to their inputs (no htmlFor/id), so they cannot
    // be used as queries — see the note at the bottom of this file.
    const onHost = vi.fn();
    render(<ConnectionForm {...base} host="" onHost={onHost} />);
    await userEvent.type(screen.getAllByRole("textbox")[1], "d");
    expect(onHost).toHaveBeenCalledWith("d");
  });

  it("closes and saves", async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    const onSaveConnect = vi.fn();
    render(<ConnectionForm {...base} onSave={onSave} onClose={onClose} onSaveConnect={onSaveConnect} />);
    await userEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    await userEvent.click(screen.getByRole("button", { name: /Save & Connect/ }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onSave).toHaveBeenCalled();
    expect(onSaveConnect).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});

describe("ConnectionForm — password", () => {
  it("never shows the password as plain text", () => {
    const { container } = render(<ConnectionForm {...base} password="hunter2" />);
    expect(container.querySelector('input[type="password"]')).toHaveValue("hunter2");
  });

  it("says the password is already in the keychain rather than looking empty", () => {
    // Blank + "optional" would read as "no password set", which is wrong and
    // invites someone to retype it.
    render(<ConnectionForm {...base} hasSecret />);
    expect(screen.getByPlaceholderText("password saved in keychain")).toBeInTheDocument();
  });

  it("marks the password optional when there is none", () => {
    render(<ConnectionForm {...base} />);
    expect(screen.getByPlaceholderText("password (optional)")).toBeInTheDocument();
  });
});

describe("ConnectionForm — TLS", () => {
  it("shows the CA field only when the mode needs one", () => {
    const { rerender } = render(<ConnectionForm {...base} tlsMode="prefer" />);
    expect(screen.queryByPlaceholderText("/etc/ssl/ca.pem")).not.toBeInTheDocument();
    rerender(<ConnectionForm {...base} tlsMode="verify-full" />);
    expect(screen.getByPlaceholderText("/etc/ssl/ca.pem")).toBeInTheDocument();
  });

  it("changes mode", async () => {
    const onTlsMode = vi.fn();
    render(<ConnectionForm {...base} onTlsMode={onTlsMode} />);
    await userEvent.selectOptions(screen.getByRole("combobox"), "verify-full");
    expect(onTlsMode).toHaveBeenCalledWith("verify-full");
  });
});

describe("ConnectionForm — SSH", () => {
  it("hides the tunnel fields until it is enabled", () => {
    render(<ConnectionForm {...base} />);
    expect(screen.queryByPlaceholderText("bastion.internal")).not.toBeInTheDocument();
  });

  it("shows them when enabled", () => {
    render(<ConnectionForm {...base} sshEnabled />);
    expect(screen.getByPlaceholderText("bastion.internal")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("~/.ssh/id_ed25519")).toBeInTheDocument();
  });

  it("explains that an empty fingerprint falls back to known_hosts", () => {
    // Host-key pinning is the security boundary; the placeholder is the only
    // place that says what blank means.
    render(<ConnectionForm {...base} sshEnabled />);
    expect(screen.getByPlaceholderText("empty → known_hosts")).toBeInTheDocument();
  });

  it("reports tunnel edits", async () => {
    const onSshHost = vi.fn();
    render(<ConnectionForm {...base} sshEnabled onSshHost={onSshHost} />);
    await userEvent.type(screen.getByPlaceholderText("bastion.internal"), "b");
    expect(onSshHost).toHaveBeenCalledWith("b");
  });
});

describe("ConnectionForm — connection test", () => {
  it("runs a test", async () => {
    const onTest = vi.fn();
    render(<ConnectionForm {...base} onTest={onTest} />);
    await userEvent.click(screen.getByRole("button", { name: /^Test$/ }));
    expect(onTest).toHaveBeenCalled();
  });

  it("shows each stage with its timing", () => {
    render(<ConnectionForm {...base} stages={[stage("DNS", true), stage("TCP", true)]} />);
    expect(screen.getByText("DNS")).toBeInTheDocument();
    expect(screen.getAllByText("12 ms")).toHaveLength(2);
  });

  it("marks a failed stage, and says why", () => {
    render(<ConnectionForm {...base} stages={[stage("TLS", false, "certificate verify failed")]} />);
    expect(screen.getByText("✕")).toBeInTheDocument();
    expect(screen.getByText("certificate verify failed")).toBeInTheDocument();
  });

  it("marks a passing stage", () => {
    render(<ConnectionForm {...base} stages={[stage("DNS", true)]} />);
    expect(screen.getByText("✓")).toBeInTheDocument();
  });

  it("says it is testing rather than showing a stale result", () => {
    render(<ConnectionForm {...base} testing />);
    expect(screen.getByText("testing…")).toBeInTheDocument();
  });

  it("shows the status line", () => {
    render(<ConnectionForm {...base} status="saved" />);
    expect(screen.getByText("saved")).toBeInTheDocument();
  });
});

/* Note for a follow-up: every `<label>` in this form is a sibling of its
   input rather than tied to it with htmlFor/id. Clicking a label does not
   focus its field, and a screen reader announces the inputs unlabelled. The
   tests above have to select fields positionally because of it, which is
   exactly the smell. It is the app-wide `.field` pattern, so fixing it is a
   broader change than this file. */
