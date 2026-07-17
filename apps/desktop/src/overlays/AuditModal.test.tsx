import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import AuditModal from "./AuditModal";

const invokeMock = vi.mocked(invoke);
beforeEach(() => invokeMock.mockReset());

const entry = (sqlText: string) => ({
  connectionKey: "prod-db",
  environment: "prod",
  sqlText,
  at: 1_700_000_000,
});

describe("AuditModal", () => {
  it("asks the backend for the log on open", async () => {
    invokeMock.mockResolvedValue([]);
    render(<AuditModal onClose={vi.fn()} />);
    expect(invokeMock).toHaveBeenCalledWith("audit_list", { limit: 300 });
  });

  it("explains the empty state rather than showing a blank panel", async () => {
    invokeMock.mockResolvedValue([]);
    render(<AuditModal onClose={vi.fn()} />);
    expect(await screen.findByText(/No audited statements yet/)).toBeInTheDocument();
  });

  it("shows the full statement text — the point of the audit log", async () => {
    // History redacts prod SQL; the audit log is the deliberate exception.
    invokeMock.mockResolvedValue([entry("delete from users where id = 5")]);
    render(<AuditModal onClose={vi.fn()} />);
    expect(await screen.findByText("delete from users where id = 5")).toBeInTheDocument();
  });

  it("attributes each statement to its connection", async () => {
    invokeMock.mockResolvedValue([entry("select 1")]);
    render(<AuditModal onClose={vi.fn()} />);
    expect(await screen.findByText("prod-db")).toBeInTheDocument();
  });

  it("surfaces a backend failure instead of an empty log", async () => {
    // An empty audit log and a broken audit log must not look the same.
    //
    // `mockReturnValueOnce`, not `mockReturnValue`: a persistent mock keeps the
    // rejected promise armed after the test, and the runtime then reports it as
    // unhandled and fails the file. That — not React's act() — was what made
    // this branch look untestable.
    const rejected = Promise.reject(new Error("db locked"));
    rejected.catch(() => {});
    invokeMock.mockReturnValueOnce(rejected);
    render(<AuditModal onClose={vi.fn()} />);
    expect(await screen.findByText(/db locked/)).toBeInTheDocument();
    expect(screen.queryByText(/No audited statements yet/)).not.toBeInTheDocument();
  });

  it("claims nothing before the log arrives", async () => {
    // "No audited statements" while the query is still in flight would be a
    // lie about production activity — the one place that must not happen.
    invokeMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 0));
      return [];
    });
    render(<AuditModal onClose={vi.fn()} />);
    expect(screen.queryByText(/No audited statements yet/)).not.toBeInTheDocument();
    expect(await screen.findByText(/No audited statements yet/)).toBeInTheDocument();
  });

  it("lists several statements", async () => {
    invokeMock.mockResolvedValue([entry("select 1"), entry("select 2")]);
    render(<AuditModal onClose={vi.fn()} />);
    expect(await screen.findByText("select 1")).toBeInTheDocument();
    expect(screen.getByText("select 2")).toBeInTheDocument();
  });

  it("closes", async () => {
    invokeMock.mockResolvedValue([]);
    const onClose = vi.fn();
    render(<AuditModal onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });
});
