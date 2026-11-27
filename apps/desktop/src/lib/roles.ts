/**
 * Users and roles: what a role list and a privilege matrix say, and the
 * GRANT/REVOKE text the page offers to copy. Nothing here runs SQL.
 */
import { qualifiedName, quoteIdent } from "./dml";

export type Role = {
  name: string;
  canLogin: boolean;
  superuser: boolean;
  createRole: boolean;
  createDb: boolean;
  replication: boolean;
  bypassRls: boolean;
  memberOf: string[];
};

export type TablePrivileges = {
  name: string;
  kind: string;
  select: boolean;
  insert: boolean;
  update: boolean;
  delete: boolean;
  truncate: boolean;
};

export const PRIVILEGES = ["select", "insert", "update", "delete", "truncate"] as const;
export type Privilege = (typeof PRIVILEGES)[number];
export const WRITES: Privilege[] = ["insert", "update", "delete", "truncate"];

/** A name that says "only reads": readonly, read_only, reporting, viewer,
 *  app_ro… — and not one that also says it writes (read_write). */
const readOnlyName = (name: string) =>
  /read|report|viewer|analyst|(^|_)(ro|bi)($|_)/i.test(name) && !/writ/i.test(name);

/**
 * Does this role look like one that should only read? By its own name, or
 * by being a member of a role whose name says so, or of `pg_read_all_data`.
 * A heuristic, and said as one on the page.
 */
export function looksReadOnly(role: Role): boolean {
  return (
    readOnlyName(role.name) || role.memberOf.some(readOnlyName)
  );
}

/** Each table the role can write, with the writes it has. */
export function writeGrants(tables: TablePrivileges[]): { table: string; privs: Privilege[] }[] {
  return tables
    .map((t) => ({ table: t.name, privs: WRITES.filter((p) => t[p]) }))
    .filter((t) => t.privs.length > 0);
}

/** How the role list describes a role: "login · member of readonly". */
export function roleSummary(role: Role): string {
  const parts = [role.superuser ? "superuser" : role.canLogin ? "login" : "group"];
  if (role.memberOf.length) parts.push(`member of ${role.memberOf.join(", ")}`);
  return parts.join(" · ");
}

/** REVOKE text for the writes `writeGrants` found. A grant made to a group
 *  the role belongs to is revoked from the group, not the role — said in a
 *  comment, since which group cannot be told from here. */
export function revokeSql(role: string, schema: string, grants: { table: string; privs: Privilege[] }[]): string {
  const lines = grants.map(
    (g) => `REVOKE ${g.privs.map((p) => p.toUpperCase()).join(", ")} ON ${qualifiedName(schema, g.table)} FROM ${quoteIdent(role)};`,
  );
  return [
    "-- Copy and review before running. If a write comes from a role this one is a member of,",
    "-- revoke it there instead: REVOKE … FROM that role.",
    ...lines,
  ].join("\n");
}

/** GRANT text for read access to every table in the schema. */
export function grantReadSql(role: string, schema: string): string {
  return [
    `GRANT USAGE ON SCHEMA ${quoteIdent(schema)} TO ${quoteIdent(role)};`,
    `GRANT SELECT ON ALL TABLES IN SCHEMA ${quoteIdent(schema)} TO ${quoteIdent(role)};`,
  ].join("\n");
}
