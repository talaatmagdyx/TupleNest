import { describe, expect, it } from "vitest";
import { grantReadSql, looksReadOnly, revokeSql, roleSummary, writeGrants, type Role, type TablePrivileges } from "./roles";

const role = (name: string, over: Partial<Role> = {}): Role => ({
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

const t = (name: string, over: Partial<TablePrivileges> = {}): TablePrivileges => ({
  name,
  kind: "r",
  select: true,
  insert: false,
  update: false,
  delete: false,
  truncate: false,
  ...over,
});

describe("roles", () => {
  it("knows a role that should only read, by name or by membership", () => {
    for (const name of ["readonly", "read_only", "reporting", "app_ro", "bi", "viewer", "analysts"]) {
      expect(looksReadOnly(role(name)), name).toBe(true);
    }
    for (const name of ["app", "writer", "read_write", "etl", "robert", "bingo"]) {
      expect(looksReadOnly(role(name)), name).toBe(false);
    }
    expect(looksReadOnly(role("alice", { memberOf: ["readonly"] }))).toBe(true);
    expect(looksReadOnly(role("alice", { memberOf: ["pg_read_all_data"] }))).toBe(true);
    expect(looksReadOnly(role("alice", { memberOf: ["writer"] }))).toBe(false);
  });

  it("finds the writes in a matrix", () => {
    expect(writeGrants([t("orders"), t("customers", { update: true, truncate: true })])).toEqual([
      { table: "customers", privs: ["update", "truncate"] },
    ]);
  });

  it("summarises a role the way the list shows it", () => {
    expect(roleSummary(role("app"))).toBe("login");
    expect(roleSummary(role("readonly", { canLogin: false }))).toBe("group");
    expect(roleSummary(role("postgres", { superuser: true }))).toBe("superuser");
    expect(roleSummary(role("reporting", { memberOf: ["readonly", "bi"] }))).toBe("login · member of readonly, bi");
  });

  it("writes GRANT and REVOKE text with every name quoted", () => {
    expect(revokeSql('re"port', "public", [{ table: "customers", privs: ["update", "delete"] }])).toBe(
      [
        "-- Copy and review before running. If a write comes from a role this one is a member of,",
        "-- revoke it there instead: REVOKE … FROM that role.",
        'REVOKE UPDATE, DELETE ON "public"."customers" FROM "re""port";',
      ].join("\n"),
    );
    expect(grantReadSql("reporting", "sales")).toBe(
      'GRANT USAGE ON SCHEMA "sales" TO "reporting";\nGRANT SELECT ON ALL TABLES IN SCHEMA "sales" TO "reporting";',
    );
  });
});
