import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ConnectionForm from "./ConnectionForm";
import type { TestStage } from "../ipc/types";

const base = {
  isEdit: false,
  profileName: "",
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
  tlsMode: "verify-full",
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
  sshPassphrase: "",
  hasSshPassphrase: false,
  onSshPassphrase: vi.fn(),
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

const picker = () => within(screen.getByRole("group", { name: "Database engine" }));

describe("ConnectionForm — engine picker", () => {
  it("offers PostgreSQL and SQLite; the rest say when, and cannot be picked", () => {
    render(<ConnectionForm {...base} onEngine={vi.fn()} />);
    const cards = picker().getAllByRole("button");
    expect(cards.map((c) => c.textContent)).toEqual([
      "PGPostgreSQLAvailable",
      "SQSQLiteAvailable",
      "MYMySQL / MariaDBComing next",
      "MSSQL ServerPlanned",
      "MGMongoDBPlanned",
      "RDRedisPlanned",
    ]);
    expect(cards.filter((c) => !(c as HTMLButtonElement).disabled).map((c) => c.textContent)).toEqual([
      "PGPostgreSQLAvailable",
      "SQSQLiteAvailable",
    ]);
  });

  it("marks the chosen engine, PostgreSQL by default", () => {
    render(<ConnectionForm {...base} onEngine={vi.fn()} />);
    expect(picker().getByRole("button", { name: /PostgreSQL/ })).toHaveAttribute("aria-pressed", "true");
    expect(picker().getByRole("button", { name: /SQLite/ })).toHaveAttribute("aria-pressed", "false");
  });

  it("switches engine on a click, and never to one still to come", async () => {
    const onEngine = vi.fn();
    render(<ConnectionForm {...base} onEngine={onEngine} />);
    await userEvent.click(picker().getByRole("button", { name: /SQLite/ }));
    expect(onEngine).toHaveBeenCalledWith("sqlite");
    await userEvent.click(picker().getByRole("button", { name: /MySQL/ }));
    expect(onEngine).toHaveBeenCalledTimes(1);
  });

  it("without a handler the picker shows the engine and cannot change it", () => {
    render(<ConnectionForm {...base} />);
    expect(picker().getByRole("button", { name: /SQLite/ })).toBeDisabled();
  });
});

describe("ConnectionForm — SQLite", () => {
  const sqlite = { ...base, engine: "sqlite" as const, database: "/data/app.db", onEngine: vi.fn() };

  it("asks for a file, not a server", () => {
    render(<ConnectionForm {...sqlite} onChooseFile={vi.fn()} onCreateFile={vi.fn()} />);
    expect(screen.getByLabelText("Database file")).toHaveValue("/data/app.db");
    expect(screen.getByRole("button", { name: "Choose…" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Create a new file" })).toBeInTheDocument();
    for (const gone of ["Host", "Port", "Username", "Password", "TLS mode"]) {
      expect(screen.queryByLabelText(gone)).not.toBeInTheDocument();
    }
    expect(screen.queryByRole("switch", { name: "SSH tunnel" })).not.toBeInTheDocument();
    // The policy that applies to every engine is still there.
    expect(screen.getByRole("switch", { name: "Read-only connection" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Environment" })).toBeInTheDocument();
    expect(screen.getByText(/query_only/)).toBeInTheDocument();
  });

  it("types a path, opens the chooser and toggles creating the file", async () => {
    const onDatabase = vi.fn();
    const onChooseFile = vi.fn();
    const onCreateFile = vi.fn();
    render(
      <ConnectionForm
        {...sqlite}
        database=""
        onDatabase={onDatabase}
        onChooseFile={onChooseFile}
        onCreateFile={onCreateFile}
      />,
    );
    await userEvent.type(screen.getByLabelText("Database file"), "x");
    expect(onDatabase).toHaveBeenCalledWith("x");
    await userEvent.click(screen.getByRole("button", { name: "Choose…" }));
    expect(onChooseFile).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("switch", { name: "Create a new file" }));
    expect(onCreateFile).toHaveBeenCalledWith(true);
  });

  it("a read-only connection never creates a file", () => {
    render(<ConnectionForm {...sqlite} readOnly createFile onCreateFile={vi.fn()} />);
    const toggle = screen.getByRole("switch", { name: "Create a new file" });
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("A read-only connection never creates a file.")).toBeInTheDocument();
  });

  it("without the dialog there is still the text field", () => {
    render(<ConnectionForm {...sqlite} />);
    expect(screen.getByLabelText("Database file")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Choose…" })).not.toBeInTheDocument();
  });

  it("says what a timeout does here", () => {
    render(<ConnectionForm {...sqlite} statementTimeoutSec={30} />);
    expect(screen.getByText(/is interrupted/)).toBeInTheDocument();
  });
});
