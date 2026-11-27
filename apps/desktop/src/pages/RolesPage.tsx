import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  PRIVILEGES,
  grantReadSql,
  looksReadOnly,
  revokeSql,
  roleSummary,
  writeGrants,
  type Role,
  type TablePrivileges,
} from "../lib/roles";
import PageHeader from "./PageHeader";
import { unsupported } from "../lib/engine";
import { errText } from "../lib/text";
import type { PageContext } from "./context";

type Matrix = { schema: string; tables: TablePrivileges[] };

/**
 * Users and roles, read-only: the roles on the server, and for the one
 * picked, what it may do to each table in the current schema — by
 * `has_table_privilege`, so grants through membership count.
 *
 * Nothing here changes a grant. The GRANT and REVOKE statements are text to
 * copy, and run (through the guard, on prod) only if pasted into a tab.
 */
export default function RolesPage(p: { ctx: PageContext }) {
  const { ctx } = p;
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [matrix, setMatrix] = useState<Matrix | null>(null);
  const [error, setError] = useState<string | null>(null);
  // PostgreSQL-only: what this engine lacks, said rather than tried.
  const lacking = ctx.live ? unsupported(ctx.engine, "roles") : null;
  const ready = ctx.live && lacking === null;

  useEffect(() => {
    if (!ready) return;
    invoke<Role[]>("pg_roles")
      .then((r) => {
        setRoles(r);
        setSelected((cur) => cur ?? r[0]?.name ?? null);
      })
      .catch((e: unknown) => setError(errText(e)));
  }, [ready]);

  useEffect(() => {
    if (!ready || !selected) return;
    let live = true;
    invoke<Matrix>("pg_role_privileges", { role: selected, schema: null })
      .then((m) => live && setMatrix(m))
      .catch((e: unknown) => live && setError(errText(e)));
    return () => {
      live = false;
    };
  }, [ready, selected]);

  if (!ready) {
    return (
      <section className="page" aria-label="Users and roles">
        <PageHeader
          title="Users and roles"
          sub="What each role may do to each table. Nothing here changes a grant."
          onBack={ctx.back}
        />
        <div className="page-empty">
          <p>{lacking ?? "Connect to a PostgreSQL database to see its roles and what each may do."}</p>
        </div>
      </section>
    );
  }

  const role = roles?.find((r) => r.name === selected) ?? null;
  const writes = matrix ? writeGrants(matrix.tables) : [];
  const warn = role && looksReadOnly(role) && (role.superuser || writes.length > 0);
  const copy = (text: string) =>
    navigator.clipboard.writeText(text).then(
      () => ctx.toast("Copied — nothing was run"),
      () => ctx.toast("Could not copy"),
    );

  return (
    <section className="page" aria-label="Users and roles">
      <PageHeader
        title="Users and roles"
        sub="What each role may do to each table. Nothing here changes a grant."
        onBack={ctx.back}
      />
      <div className="roles-cols">
        <nav className="roles-list" aria-label="Roles">
          {roles?.map((r) => (
            <button
              key={r.name}
              className={`roles-item ${r.name === selected ? "on" : ""}`}
              aria-current={r.name === selected}
              onClick={() => {
                setMatrix(null);
                setSelected(r.name);
              }}
            >
              <span className={`roles-initial ${r.superuser ? "super" : ""}`} aria-hidden>
                {r.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="roles-text">
                <span className="roles-name">{r.name}</span>
                <span className="page-sub">{roleSummary(r)}</span>
              </span>
            </button>
          ))}
          {roles?.length === 0 && <span className="page-sub">No roles to show.</span>}
        </nav>

        <div className="roles-detail">
          {error && (
            <div className="dash-error" role="alert">
              {error}
            </div>
          )}
          {role && (
            <>
              <div className="roles-head">
                <h2 className="mono">{role.name}</h2>
                {role.canLogin ? <span className="chip ok">can log in</span> : <span className="chip">group</span>}
                {role.superuser && <span className="chip danger">superuser</span>}
                {role.memberOf.length > 0 && <span className="page-sub">member of {role.memberOf.join(", ")}</span>}
              </div>
              {matrix && (
                <>
                  <span className="page-sub">
                    Tables in schema <b className="mono">{matrix.schema}</b>
                  </span>
                  <table className="roles-matrix">
                    <thead>
                      <tr>
                        <th scope="col">Object</th>
                        {PRIVILEGES.map((pv) => (
                          <th key={pv} scope="col">
                            {pv.toUpperCase()}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {matrix.tables.map((t) => (
                        <tr key={t.name}>
                          <td className="mono">{t.name}</td>
                          {PRIVILEGES.map((pv) => (
                            <td
                              key={pv}
                              className={t[pv] ? (pv !== "select" && warn ? "yes warn" : "yes") : "no"}
                              aria-label={`${pv} ${t[pv] ? "granted" : "not granted"}`}
                            >
                              {t[pv] ? "✓" : "·"}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {matrix.tables.length === 0 && <span className="page-sub">No tables in this schema.</span>}
                  {warn && (
                    <div className="roles-warn" role="note">
                      <b>Heads up:</b>{" "}
                      {role.superuser
                        ? `${role.name} looks like a read-only role, but it is a superuser: it can change anything.`
                        : `${role.name} looks like a read-only role, but it can ${writes
                            .map((w) => `${w.privs.join("/").toUpperCase()} ${w.table}`)
                            .join(", ")}.`}
                    </div>
                  )}
                  <div className="roles-sql">
                    <div className="roles-sql-head">
                      <span className="page-sub">
                        {writes.length > 0 ? "Revoke the writes" : "Grant read access"} — text to copy; nothing here runs it.
                      </span>
                      <div className="grow" />
                      <button
                        className="btn xs"
                        onClick={() =>
                          void copy(writes.length > 0 ? revokeSql(role.name, matrix.schema, writes) : grantReadSql(role.name, matrix.schema))
                        }
                      >
                        Copy
                      </button>
                    </div>
                    <pre className="d-code">
                      {writes.length > 0 ? revokeSql(role.name, matrix.schema, writes) : grantReadSql(role.name, matrix.schema)}
                    </pre>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
