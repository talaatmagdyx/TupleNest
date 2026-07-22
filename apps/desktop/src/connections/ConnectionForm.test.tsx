import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ConnectionForm, { isLocalHost } from "./ConnectionForm";
import type { TestStage } from "../ipc/types";

const base = {
  isEdit: false,
  profileName: "customer_analytics",
  environment: "dev",
  readOnly: false,
  onReadOnly: vi.fn(),
  statementTimeoutSec: 0,
  onStatementTimeoutSec: vi.fn(),
  host: "localhost",
  port: 5432,
  database: "appdb",
  username: "appuser",
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
    expect(screen.getByDisplayValue("customer_analytics")).toBeInTheDocument();
    expect(screen.getByDisplayValue("localhost")).toBeInTheDocument();
    expect(screen.getByDisplayValue("5432")).toBeInTheDocument();
  });

  it("reports edits to each field", async () => {
    // Reached by its label, not by position — which only works because the
    // label is tied to the input, and is the point of the association.
    const onHost = vi.fn();
    render(<ConnectionForm {...base} host="" onHost={onHost} />);
    await userEvent.type(screen.getByLabelText("Host"), "d");
    expect(onHost).toHaveBeenCalledWith("d");
  });

  it("gives every field a label its input is tied to", () => {
    // Regression guard for the accessibility pass: a screen reader should read
    // each of these by name, and clicking the label should focus the field.
    render(<ConnectionForm {...base} />);
    for (const name of ["Host", "Port", "Database", "Username", "Password"]) {
      expect(screen.getByLabelText(name), name).toBeInTheDocument();
    }
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

  it("warns that prefer is unsafe for a REMOTE host", () => {
    render(<ConnectionForm {...base} tlsMode="prefer" host="db.prod.internal" />);
    const warn = screen.getByRole("note");
    expect(warn).toHaveTextContent(/does not guarantee encryption/i);
    expect(warn).toHaveTextContent("db.prod.internal");
  });

  it("does NOT warn about prefer for a local host", () => {
    render(<ConnectionForm {...base} tlsMode="prefer" host="localhost" />);
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("does NOT warn when a verify mode is chosen for a remote host", () => {
    render(<ConnectionForm {...base} tlsMode="verify-full" host="db.prod.internal" />);
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });
});

describe("isLocalHost", () => {
  it("treats loopback names/addresses and the empty field as local", () => {
    for (const h of ["", "localhost", "127.0.0.1", "::1", "[::1]", "app.localhost", "  LocalHost  "]) {
      expect(isLocalHost(h)).toBe(true);
    }
  });

  it("treats everything else as remote (conservative — a false remote is only a nudge)", () => {
    for (const h of ["db.prod.internal", "10.0.0.5", "example.com", "127.0.0.1.evil.com"]) {
      expect(isLocalHost(h)).toBe(false);
    }
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

describe("ConnectionForm — identifier fields resist OS text substitution", () => {
  /* Found by using the app on macOS: with "capitalize words automatically" on,
     a typed `postgres` became `Postgres` the moment the field lost focus.
     PostgreSQL role names are case-sensitive, so the connection then failed at
     the auth stage and looked for all the world like a wrong password — the OS
     had quietly edited the text and nothing on screen said so. The same trap
     applies to a hostname, a database name, and an SSH key path. */
  const identifierFields = (container: HTMLElement) =>
    Array.from(container.querySelectorAll("input.mono")) as HTMLInputElement[];

  it("turns off autocapitalise, autocorrect and spellcheck on every one", () => {
    const { container } = render(<ConnectionForm {...base} sshEnabled />);
    const fields = identifierFields(container);
    // Host, port, database, username, and the SSH block at minimum.
    expect(fields.length).toBeGreaterThanOrEqual(5);
    for (const el of fields) {
      expect(el.getAttribute("autocapitalize")).toBe("none");
      expect(el.getAttribute("autocorrect")).toBe("off");
      expect(el.getAttribute("spellcheck")).toBe("false");
    }
  });

  it("leaves the free-text name field alone", () => {
    // The profile name is prose a human picks — capitalising "Prod replica" is
    // helpful there, and it is never sent to the server.
    const { container } = render(<ConnectionForm {...base} />);
    const name = container.querySelector("input:not(.mono):not([type=password])");
    expect(name?.getAttribute("autocapitalize")).toBeNull();
  });
});

describe("ConnectionForm — query timeout", () => {
  const box = () => screen.getByLabelText(/query timeout/i);

  it("shows nothing rather than a 0 when there is no limit", () => {
    // A literal 0 in the box reads like a setting; an empty box with a
    // "none" placeholder reads like the absence of one.
    render(<ConnectionForm {...base} statementTimeoutSec={0} />);
    expect((box() as HTMLInputElement).value).toBe("");
    expect(screen.getByText(/means no limit/i)).toBeInTheDocument();
  });

  it("says what the server will do once a limit is set", () => {
    render(<ConnectionForm {...base} statementTimeoutSec={30} />);
    expect((box() as HTMLInputElement).value).toBe("30");
    expect(screen.getByText(/cancels any statement still running/i)).toBeInTheDocument();
  });

  it("reports whole seconds as the user types", async () => {
    // The field is controlled and `base` holds the value at 0, so each
    // keystroke starts from an empty box — assert per keystroke rather than
    // pretending the digits accumulate.
    const onStatementTimeoutSec = vi.fn();
    render(<ConnectionForm {...base} onStatementTimeoutSec={onStatementTimeoutSec} />);
    await userEvent.type(box(), "9");
    expect(onStatementTimeoutSec).toHaveBeenLastCalledWith(9);
  });

  it("rounds a fractional entry to whole seconds", async () => {
    const onStatementTimeoutSec = vi.fn();
    render(<ConnectionForm {...base} statementTimeoutSec={0} onStatementTimeoutSec={onStatementTimeoutSec} />);
    await userEvent.type(box(), "2.7");
    for (const [v] of onStatementTimeoutSec.mock.calls) {
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it("never reports a negative timeout", async () => {
    // `SET statement_timeout = -1` is an error: it would break the connection
    // rather than the query.
    const onStatementTimeoutSec = vi.fn();
    render(<ConnectionForm {...base} onStatementTimeoutSec={onStatementTimeoutSec} />);
    await userEvent.type(box(), "-5");
    for (const call of onStatementTimeoutSec.mock.calls) {
      expect(call[0]).toBeGreaterThanOrEqual(0);
    }
  });
});

