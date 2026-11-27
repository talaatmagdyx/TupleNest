import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import BackupPage, { sizeText, type BackupRecord } from "./BackupPage";
import type { PageContext } from "./context";
import type { ConnectionRecord } from "../ipc/types";

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);

const DEV = { id: "p1", name: "shop-dev", engine: "postgres", environment: "dev", database: "shop", host: "localhost" } as ConnectionRecord;
const PROD = { id: "p2", name: "orders-prod", engine: "postgres", environment: "prod", database: "orders", host: "db.internal" } as ConnectionRecord;
const LITE = { id: "p3", name: "local file", engine: "sqlite", environment: "dev", database: "x" } as ConnectionRecord;

const ctx = (over: Partial<PageContext> = {}): PageContext => ({
  live: true,
  engine: "postgres",
  env: "dev",
  liveProfile: DEV,
  saved: [DEV, PROD, LITE],
  snippets: [],
  currentSql: "",
  toast: vi.fn(),
  ...over,
});

const DONE: BackupRecord = {
  id: "b1",
  connectionId: "p1",
  kind: "backup",
  database: "shop",
  filePath: "/Users/me/Backups/shop-2026-11-20.dump",
  status: "done",
  bytes: 432_013_312,
  message: null,
  startedAt: 1_764_000_000,
  finishedAt: 1_764_000_100,
};
const FAILED: BackupRecord = { ...DONE, id: "b2", status: "failed", message: "pg_dump: error: connection refused\nmore", connectionId: null };

let handlers: Record<string, (a: Record<string, unknown>) => unknown>;
let events: Record<string, (e: { payload: unknown }) => void>;

beforeEach(() => {
  handlers = {
    backup_list: () => [DONE, FAILED],
    backup_tools: () => ({ pgDump: "/opt/homebrew/bin/pg_dump", pgRestore: "/opt/homebrew/bin/pg_restore", configured: null }),
    backup_start: () => ({ id: "run1", file: "/Users/me/Backups/shop-today.dump" }),
    backup_restore: () => ({ id: "run2", file: DONE.filePath }),
    backup_cancel: () => true,
    backup_tools_set: (a) => ({ pgDump: `${a.dir as string}/pg_dump`, pgRestore: `${a.dir as string}/pg_restore`, configured: a.dir }),
  };
  invokeMock.mockReset();
  invokeMock.mockImplementation((async (cmd: string, args?: Record<string, unknown>) => {
    const h = handlers[cmd];
    if (!h) throw new Error(`no handler for ${cmd}`);
    return h(args ?? {});
  }) as never);
  events = {};
  listenMock.mockImplementation((async (name: string, fn: (e: { payload: unknown }) => void) => {
    events[name] = fn;
    return () => {};
  }) as never);
});

const calls = (cmd: string) => invokeMock.mock.calls.filter((c) => c[0] === cmd).map((c) => c[1] as Record<string, unknown>);

describe("BackupPage", () => {
  it("sizes files the way people read them", () => {
    expect(sizeText(null)).toBe("");
    expect(sizeText(512)).toBe("512 B");
    expect(sizeText(1536)).toBe("1.5 KB");
    expect(sizeText(432_013_312)).toBe("412 MB");
  });

  it("lists recent runs and offers PostgreSQL profiles only", async () => {
    render(<BackupPage ctx={ctx()} />);
    expect(await screen.findByText(/^412 MB ·/)).toBeInTheDocument();
    expect(screen.getAllByText("shop-2026-11-20.dump")).toHaveLength(2);
    expect(screen.getByText(/deleted connection/)).toBeInTheDocument();
    expect(screen.getByText("pg_dump: error: connection refused")).toBeInTheDocument();
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["shop-dev · shop", "orders-prod · orders"]);
  });

  it("backs up the chosen profile and shows progress until it is done", async () => {
    const c = ctx();
    const user = userEvent.setup();
    render(<BackupPage ctx={c} />);
    await user.click(await screen.findByRole("button", { name: "Back up…" }));
    expect(calls("backup_start")[0]).toEqual({ connectionId: "p1", defaultName: expect.stringMatching(/^shop-\d{4}-\d{2}-\d{2}\.dump$/) });
    expect(await screen.findByText("Backing up shop-today.dump")).toBeInTheDocument();
    act(() => events["backup:progress"]({ payload: { id: "run1", tables: 3, line: 'pg_dump: dumping contents of table "public.orders"' } }));
    expect(screen.getByText(/3 tables so far · pg_dump: dumping/)).toBeInTheDocument();
    // Another run's events are not this one's.
    act(() => events["backup:progress"]({ payload: { id: "other", tables: 9, line: "x" } }));
    expect(screen.getByText(/3 tables so far/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(calls("backup_cancel")).toHaveLength(1);
    act(() => events["backup:done"]({ payload: { id: "run1", status: "cancelled", message: "Cancelled." } }));
    expect(c.toast).toHaveBeenCalledWith("Cancelled");
    expect(screen.queryByText(/Backing up/)).not.toBeInTheDocument();
  });

  it("shows why a run failed, and a refusal to start", async () => {
    const c = ctx();
    const user = userEvent.setup();
    render(<BackupPage ctx={c} />);
    await user.click(await screen.findByRole("button", { name: "Back up…" }));
    act(() => events["backup:done"]({ payload: { id: "run1", status: "failed", message: "pg_dump: error: permission denied" } }));
    expect(await screen.findByRole("alert")).toHaveTextContent("permission denied");
    expect(c.toast).toHaveBeenCalledWith("Failed");
    act(() => events["backup:done"]({ payload: { id: "x", status: "done", message: null } }));
    expect(c.toast).toHaveBeenCalledWith("Finished");
    act(() => events["backup:done"]({ payload: { id: "x", status: "failed", message: null } }));
    expect(screen.getByRole("alert")).toHaveTextContent("The run failed.");

    handlers.backup_start = () => Promise.reject("Backup and restore through an SSH tunnel are not supported yet.");
    await user.click(screen.getByRole("button", { name: "Back up…" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("SSH tunnel");
  });

  it("does nothing when the save panel is cancelled", async () => {
    handlers.backup_start = () => null;
    const user = userEvent.setup();
    render(<BackupPage ctx={ctx()} />);
    await user.click(await screen.findByRole("button", { name: "Back up…" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("restores a recorded backup into a dev profile with one confirmation", async () => {
    const user = userEvent.setup();
    render(<BackupPage ctx={ctx()} />);
    await user.click(await screen.findByRole("button", { name: "Restore shop-2026-11-20.dump" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Restore into shop-dev");
    await user.click(screen.getByRole("button", { name: "Restore" }));
    expect(calls("backup_restore")).toEqual([{ connectionId: "p1", backupId: "b1", confirm: null }]);
    expect(await screen.findByText(/Restoring shop-2026-11-20.dump/)).toBeInTheDocument();
  });

  it("asks for the database name before restoring into prod", async () => {
    const user = userEvent.setup();
    render(<BackupPage ctx={ctx({ liveProfile: PROD })} />);
    await user.click(await screen.findByRole("button", { name: "Restore from a file…" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("Restore into orders-prod (prod)");
    expect(dialog).toHaveTextContent("You will pick a backup file");
    const go = screen.getByRole("button", { name: "Restore" });
    expect(go).toBeDisabled();
    await user.type(screen.getByLabelText("Database name"), "order");
    expect(go).toBeDisabled();
    await user.type(screen.getByLabelText("Database name"), "s");
    await user.click(go);
    expect(calls("backup_restore")).toEqual([{ connectionId: "p2", backupId: null, confirm: "orders" }]);
  });

  it("backs out of a restore", async () => {
    const user = userEvent.setup();
    render(<BackupPage ctx={ctx()} />);
    await user.click(await screen.findByRole("button", { name: "Restore from a file…" }));
    await user.click(screen.getByRole("button", { name: "Don't restore" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(calls("backup_restore")).toHaveLength(0);
  });

  it("says when the tools are missing, and takes a folder for them", async () => {
    handlers.backup_tools = () => ({ pgDump: null, pgRestore: null, configured: null });
    const user = userEvent.setup();
    render(<BackupPage ctx={ctx()} />);
    expect(await screen.findByText(/pg_dump was not found on this computer/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back up…" })).toBeDisabled();
    await user.type(screen.getByLabelText("Tools folder"), "/opt/pg/bin");
    await user.click(screen.getByRole("button", { name: "Use this folder" }));
    expect(calls("backup_tools_set")).toEqual([{ dir: "/opt/pg/bin" }]);
    expect(await screen.findByText("Using the tools in /opt/pg/bin.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back up…" })).toBeEnabled();

    handlers.backup_tools_set = () => Promise.reject("/nope does not hold pg_dump or pg_restore.");
    await user.clear(screen.getByLabelText("Tools folder"));
    await user.click(screen.getByRole("button", { name: "Use this folder" }));
    expect(calls("backup_tools_set")[1]).toEqual({ dir: null });
    expect(await screen.findByRole("alert")).toHaveTextContent("does not hold");
  });

  it("names pg_restore when only it is missing, and survives a failed lookup", async () => {
    handlers.backup_tools = () => ({ pgDump: "/x/pg_dump", pgRestore: null, configured: null });
    const { unmount } = render(<BackupPage ctx={ctx()} />);
    expect(await screen.findByText(/pg_restore was not found/)).toBeInTheDocument();
    unmount();
    handlers.backup_tools = () => Promise.reject("boom");
    handlers.backup_list = () => Promise.reject("locked");
    const c = ctx();
    render(<BackupPage ctx={c} />);
    expect(await screen.findByText(/pg_dump was not found/)).toBeInTheDocument();
    await waitFor(() => expect(c.toast).toHaveBeenCalledWith("Recent backups did not load: locked"));
  });

  it("explains that a saved PostgreSQL connection is needed", async () => {
    handlers.backup_list = () => [];
    render(<BackupPage ctx={ctx({ saved: [LITE], liveProfile: null })} />);
    expect(await screen.findByText(/Save a PostgreSQL connection first/)).toBeInTheDocument();
    expect(await screen.findByText("None yet.")).toBeInTheDocument();
  });

  it("switches profile", async () => {
    const user = userEvent.setup();
    render(<BackupPage ctx={ctx({ liveProfile: null })} />);
    await user.selectOptions(await screen.findByLabelText("Connection"), "p2");
    await user.click(screen.getByRole("button", { name: "Back up…" }));
    expect(calls("backup_start")[0]).toMatchObject({ connectionId: "p2" });
  });
});
