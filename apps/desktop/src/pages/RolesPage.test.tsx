import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import RolesPage from "./RolesPage";
import type { PageContext } from "./context";
import type { Role } from "../lib/roles";

const invokeMock = vi.mocked(invoke);

const ctx = (over: Partial<PageContext> = {}): PageContext => ({
  live: true,
  engine: "postgres",
  env: "prod",
  liveProfile: null,
  saved: [],
  snippets: [],
  currentSql: "",
  toast: vi.fn(),
  ...over,
});

const r = (name: string, over: Partial<Role> = {}): Role => ({
  name,
  canLogin: true,
  superuser: false,
  createRole: false,
  createDb: false,
  replication: false,
  bypassRls: false,
  memberOf: [],
  ...over,
});

const ROLES = [
  r("app"),
  r("reporting", { memberOf: ["readonly"] }),
  r("readonly", { canLogin: false }),
  r("readonly_admin", { superuser: true }),
];

const table = (name: string, update = false) => ({ name, kind: "r", select: true, insert: false, update, delete: false, truncate: false });

let handlers: Record<string, (a: Record<string, unknown>) => unknown>;
beforeEach(() => {
  handlers = {
    pg_roles: () => ROLES,
    pg_role_privileges: (a) => ({
      schema: "public",
      tables: a.role === "reporting" ? [table("customers", true), table("orders")] : a.role === "app" ? [] : [table("orders")],
    }),
  };
  invokeMock.mockReset();
  invokeMock.mockImplementation((async (cmd: string, args?: Record<string, unknown>) => {
    const h = handlers[cmd];
    if (!h) throw new Error(`no handler for ${cmd}`);
    return h(args ?? {});
  }) as never);
});

describe("RolesPage", () => {
  it("lists roles and shows the first one's privileges in the current schema", async () => {
    render(<RolesPage ctx={ctx()} />);
    expect(await screen.findByRole("heading", { name: "app" })).toBeInTheDocument();
    expect(screen.getByText("can log in")).toBeInTheDocument();
    expect(await screen.findByText("No tables in this schema.")).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("pg_role_privileges", { role: "app", schema: null });
    expect(screen.getByText(/GRANT SELECT ON ALL TABLES IN SCHEMA "public" TO "app"/)).toBeInTheDocument();
  });

  it("warns when a role that looks read-only can write, and offers the REVOKE as text", async () => {
    const c = ctx();
    const user = userEvent.setup();
    render(<RolesPage ctx={c} />);
    await user.click(await screen.findByRole("button", { name: /reporting/ }));
    expect(await screen.findByRole("note")).toHaveTextContent("reporting looks like a read-only role, but it can UPDATE customers.");
    expect(screen.getByText("member of readonly", { selector: ".roles-head span" })).toBeInTheDocument();
    expect(screen.getAllByLabelText("update granted")).toHaveLength(1);
    expect(screen.getByText(/REVOKE UPDATE ON "public"."customers" FROM "reporting";/)).toBeInTheDocument();
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(write.mock.calls[0][0]).toContain('REVOKE UPDATE ON "public"."customers" FROM "reporting";');
    await waitFor(() => expect(c.toast).toHaveBeenCalledWith("Copied — nothing was run"));
    // Nothing that changes a grant was sent.
    expect(invokeMock.mock.calls.map((x) => x[0])).not.toContain("pg_query");

    write.mockRejectedValueOnce(new Error("denied"));
    await user.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(c.toast).toHaveBeenCalledWith("Could not copy"));
  });

  it("warns about a read-only-looking superuser, and not about a plain group", async () => {
    const user = userEvent.setup();
    render(<RolesPage ctx={ctx()} />);
    await user.click(await screen.findByRole("button", { name: /readonly_admin/ }));
    expect((await screen.findAllByRole("note"))[0]).toHaveTextContent("it is a superuser");
    expect(screen.getByText("superuser", { selector: ".chip" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^readonly\s*group$/ }));
    await screen.findByText("orders");
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    expect(screen.getByText("group", { selector: ".chip" })).toBeInTheDocument();
  });

  it("offers ALTER ROLE … NOSUPERUSER, not a REVOKE that would do nothing, for a superuser", async () => {
    handlers.pg_roles = () => [r("postgres", { superuser: true })];
    handlers.pg_role_privileges = () => ({ schema: "public", tables: [table("orders", true)] });
    const user = userEvent.setup();
    render(<RolesPage ctx={ctx()} />);
    expect(await screen.findByText(/Table grants do not apply to postgres/)).toBeInTheDocument();
    expect(screen.getByText('ALTER ROLE "postgres" NOSUPERUSER;')).toBeInTheDocument();
    expect(screen.queryByText(/REVOKE UPDATE/)).not.toBeInTheDocument();
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(write.mock.calls[0][0]).toBe('ALTER ROLE "postgres" NOSUPERUSER;');
    expect(invokeMock.mock.calls.map((x) => x[0])).not.toContain("pg_query");
  });

  it("asks for a PostgreSQL connection first", () => {
    render(<RolesPage ctx={ctx({ live: false })} />);
    expect(screen.getByText(/Connect to a PostgreSQL database/)).toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("says why on SQLite, which has no roles, and asks nothing", () => {
    render(<RolesPage ctx={ctx({ engine: "sqlite" })} />);
    expect(screen.getByText(/SQLite has no users, roles or grants/)).toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("shows the server's error", async () => {
    handlers.pg_roles = () => Promise.reject("permission denied for table pg_authid");
    render(<RolesPage ctx={ctx()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("permission denied");
  });

  it("shows an error for one role's privileges, and an empty role list", async () => {
    handlers.pg_role_privileges = () => Promise.reject("role does not exist");
    const { unmount } = render(<RolesPage ctx={ctx()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("role does not exist");
    unmount();
    handlers.pg_roles = () => [];
    render(<RolesPage ctx={ctx()} />);
    expect(await screen.findByText("No roles to show.")).toBeInTheDocument();
  });
});
