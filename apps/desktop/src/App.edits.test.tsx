import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { CONNECTION, PROD, backend, type Backend } from "./test/backend";

/** Staging a cell edit, reviewing it, and applying it. */

let be: Backend;
beforeEach(() => {
  be = backend();
});

const mount = async () => {
  const user = userEvent.setup();
  render(<App />);
  await screen.findAllByText(CONNECTION.name);
  return user;
};

const palette = async (user: ReturnType<typeof userEvent.setup>, term: string) => {
  await user.keyboard("{Meta>}k{/Meta}");
  await user.type(await screen.findByPlaceholderText(/type a command/i), term);
  await user.keyboard("{Enter}");
};

/** A two-column result from one table. Whether it is editable is not decided
 *  by anything in here — the app parses the SQL and looks the table up in the
 *  catalog, so the tree has to have loaded the columns first. */
const EDITABLE = {
  columns: [
    { name: "id", dbType: "int8" },
    { name: "email", dbType: "text" },
  ],
  totalRows: 1,
  storedRows: 1,
  truncated: false,
  rowsAffected: null,
};

const meta = () =>
  be.on("pg_metadata", (a) => {
    const req = a.request as Record<string, unknown>;
    if (req.kind === "describe_object") {
      return {
        payload: {
          columns: [
            { name: "id", dbType: "int8", nullable: false, primaryKey: true },
            { name: "email", dbType: "text", nullable: true, primaryKey: false },
          ],
        },
        cached: false,
      };
    }
    if (req.kind === "server_info") return { payload: { version: "PostgreSQL 18.0" }, cached: false };
    if (req.kind === "list_schemas") return { payload: ["public"], cached: false };
    if (req.kind === "list_objects") {
      return { payload: [{ name: "users", kind: "table", isPartitioned: false, partitionCount: 0 }], cached: false };
    }
    return { payload: [], cached: false };
  });

/** Run `select id, email from users` and get an editable grid up. */
const withGrid = async (profile = CONNECTION.name) => {
  const user = await mount();
  meta();
  await palette(user, `Connect to ${profile}`);
  await waitFor(() => expect(be.sent("pg_connect")).toHaveLength(1));
  be.on("pg_query", () => EDITABLE);
  be.on("pg_rows", () => [[1, "a@b.c"]]);

  // The grid is editable only once the catalog knows the table's columns and
  // which of them is the key. That arrives with the tree, not the result.
  await user.click(await screen.findByText("public"));
  await user.click(await screen.findByText("Tables"));
  await user.click(await screen.findByText("users"));
  await user.click(await screen.findByText("Columns"));
  await screen.findByText("PK");

  const ta = screen.getByRole("textbox", { name: /sql editor/i });
  await user.click(ta);
  await user.clear(ta);
  await user.type(ta, "select id, email from users");
  await user.click(screen.getByRole("button", { name: /^Run/ }));
  await waitFor(() => expect(be.sent("pg_query")).toHaveLength(1));
  return user;
};

/** Change the email cell to `next` and stage it. */
const editCell = async (user: ReturnType<typeof userEvent.setup>, next: string) => {
  await user.dblClick(await screen.findByTitle(/a@b\.c — double-click to edit/));
  const input = document.querySelector("input.g-edit") as HTMLInputElement;
  await user.clear(input);
  await user.type(input, next);
  await user.keyboard("{Enter}");
};

describe("App — applying staged edits", () => {
  it("re-reads the grid once the write has committed", async () => {
    // The grid is showing what the row used to be. Without the re-read it
    // keeps showing that, and the user cannot tell the write happened.
    const user = await withGrid();
    await editCell(user, "new@b.c");
    await user.click(await screen.findByRole("button", { name: /review/i }));
    await user.click(await screen.findByRole("button", { name: /^Apply/i }));
    await waitFor(() => expect(be.sent("pg_query").length).toBeGreaterThan(1));
    expect(await screen.findByText(/Applied 1 statement$/)).toBeInTheDocument();
  });

  it("does not re-read inside the user's open transaction", async () => {
    // Re-reading here would show uncommitted rows as though they were stored.
    // The statements are staged; the commit is the user's to make.
    const user = await withGrid();
    await user.click(screen.getByRole("button", { name: /begin transaction/i }));
    await screen.findByText(/in transaction/i);
    const before = be.sent("pg_query").length;
    await editCell(user, "new@b.c");
    await user.click(await screen.findByRole("button", { name: /review/i }));
    await user.click(await screen.findByRole("button", { name: /^Apply/i }));
    expect(await screen.findByText(/staged in your transaction/i)).toBeInTheDocument();
    // The UPDATE goes out — inside their transaction, uncommitted, bracketed
    // by a savepoint so a failure cannot half-apply. What must not happen is
    // the re-read after it, which would show them their own uncommitted row as
    // though it were stored. Assert that directly rather than counting calls:
    // the count is a proxy that moves whenever the write path gains a
    // statement, and it is the SELECT specifically that would be the bug.
    const after = be.sent("pg_query").slice(before).map((c) => String(c.sql));
    expect(after.some((sql) => /^\s*select/i.test(sql))).toBe(false);
    expect(after.filter((sql) => /^\s*update/i.test(sql))).toHaveLength(1);
  });

  it("keeps the edits when the write fails", async () => {
    // Discarding them on failure would throw away the user's typing for a
    // problem they can often fix and retry.
    const user = await withGrid();
    await editCell(user, "new@b.c");
    await user.click(await screen.findByRole("button", { name: /review/i }));
    be.on("pg_query", () => {
      throw new Error('duplicate key value violates unique constraint "users_email_key"');
    });
    await user.click(await screen.findByRole("button", { name: /^Apply/i }));
    expect(await screen.findByText(/duplicate key/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Apply/i })).toBeEnabled();
  });

  it("discards the staged edits on request", async () => {
    const user = await withGrid();
    await editCell(user, "new@b.c");
    await user.click(await screen.findByRole("button", { name: /review/i }));
    // The grid toolbar has a Discard of its own; this is the dialog's.
    const dialog = document.querySelector(".modal") as HTMLElement;
    await user.click(within(dialog).getByRole("button", { name: /discard/i }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Apply/i })).not.toBeInTheDocument());
    expect(be.sent("pg_query")).toHaveLength(1);
  });

  it("names the environment it is about to write to", async () => {
    // The same two clicks against prod and against dev should not look alike.
    const user = await withGrid(PROD.name);
    await editCell(user, "new@b.c");
    await user.click(await screen.findByRole("button", { name: /review/i }));
    const dialog = document.querySelector(".modal") as HTMLElement;
    expect(within(dialog).getAllByText(/prod/i).length).toBeGreaterThan(0);
  });
});

describe("App — the re-read after applying", () => {
  it("re-runs the statement behind the grid, not whatever the editor holds now", async () => {
    // The re-read used to call the general run path with `force`, reading the
    // editor's current text. Type a DELETE after staging an edit, apply, and
    // that DELETE ran on prod with the guard skipped.
    const user = await withGrid(PROD.name);
    await editCell(user, "new@b.c");
    const ta = screen.getByRole("textbox", { name: /sql editor/i });
    await user.click(ta);
    await user.clear(ta);
    await user.type(ta, "delete from users");
    await user.click(await screen.findByRole("button", { name: /review/i }));
    await user.click(await screen.findByRole("button", { name: /^Apply/i }));
    await waitFor(() => expect(be.sent("pg_query").length).toBeGreaterThan(2));
    const sqls = be.sent("pg_query").map((a) => String((a as { sql: string }).sql));
    expect(sqls).not.toContain("delete from users");
    expect(sqls[sqls.length - 1]).toBe("select id, email from users");
  });
});

describe("App — nothing runs inside the app's own write", () => {
  it("refuses Cmd+Enter while row edits are applying", async () => {
    // Apply holds BEGIN…COMMIT on the shared session. A statement run then
    // landed between them: committed with the edits, or rolled back with them
    // after the status bar had already reported it done.
    const user = await withGrid();
    await editCell(user, "new@b.c");
    const ta = screen.getByRole("textbox", { name: /sql editor/i });
    await user.click(ta);
    await user.clear(ta);
    await user.type(ta, "delete from audit_log where id = 7");
    await user.click(await screen.findByRole("button", { name: /review/i }));
    let release!: (v: unknown) => void;
    be.on("pg_query", (a) => {
      if (/^update/i.test(String(a.sql))) return new Promise((r) => (release = r));
      return { ...EDITABLE, rowsAffected: 1 };
    });
    await user.click(await screen.findByRole("button", { name: /^Apply/i }));
    await waitFor(() => expect(be.sent("pg_query").some((x) => /^update/i.test(String(x.sql)))).toBe(true));
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    expect(await screen.findByText(/writing in its own transaction/i)).toBeInTheDocument();
    release({ ...EDITABLE, rowsAffected: 1 });
    await waitFor(() => expect(be.sent("pg_commit").length).toBeGreaterThan(0));
    const sqls = be.sent("pg_query").map((x) => String(x.sql));
    expect(sqls).not.toContain("delete from audit_log where id = 7");
  });
});

describe("App — leaving a cell editor", () => {
  it("keeps the edit when you click away rather than pressing Enter", async () => {
    // Clicking elsewhere is how people leave a field. Throwing the edit away
    // there loses work that looked committed.
    const user = await withGrid();
    await user.dblClick(await screen.findByTitle(/a@b\.c — double-click to edit/));
    const input = document.querySelector("input.g-edit") as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "blur@b.c");
    fireEvent.blur(input);
    // The cell shows the pending value, and the edit is staged for review.
    expect(await screen.findByTitle("a@b.c → blur@b.c (pending)")).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: /review/i }));
    const dialog = document.querySelector(".modal") as HTMLElement;
    expect(within(dialog).getByText(/blur@b\.c/)).toBeInTheDocument();
  });

  it("closes the review without discarding the edits", async () => {
    // Closing the window is not the same as saying "throw these away".
    const user = await withGrid();
    await editCell(user, "new@b.c");
    await user.click(await screen.findByRole("button", { name: /review/i }));
    const dialog = document.querySelector(".modal") as HTMLElement;
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(document.querySelector(".modal")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: /review/i })).toBeInTheDocument();
  });
});

describe("App — describing an object from the palette", () => {
  it("opens the schema for a table the catalog knows", async () => {
    const user = await mount();
    be.on("pg_metadata", (a) => {
      const req = a.request as Record<string, unknown>;
      if (req.kind === "list_schemas") return { payload: ["public"], cached: false };
      if (req.kind === "list_objects") {
        return { payload: [{ name: "users", kind: "table", isPartitioned: false, partitionCount: 0 }], cached: false };
      }
      if (req.kind === "describe_object") {
        return {
          payload: {
            columns: [{ name: "id", dbType: "int8", nullable: false, primaryKey: true }],
            indexes: [{ name: "users_pkey", def: "CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)" }],
            rowsEstimate: 4213662,
            totalSize: "1200 MB",
            comment: "the people",
          },
          cached: false,
        };
      }
      return { payload: [], cached: false };
    });
    await palette(user, "Connect to local dev");
    await waitFor(() => expect(be.sent("pg_connect")).toHaveLength(1));
    await user.click(await screen.findByText("public"));
    await user.click(await screen.findByText("Tables"));
    await screen.findByText("users");
    await palette(user, "Describe public.users");
    expect(await screen.findByText("users_pkey")).toBeInTheDocument();
    expect(screen.getByText("the people")).toBeInTheDocument();
  });

  it("says why the description could not be read", async () => {
    const user = await mount();
    be.on("pg_metadata", (a) => {
      const req = a.request as Record<string, unknown>;
      if (req.kind === "list_schemas") return { payload: ["public"], cached: false };
      if (req.kind === "list_objects") {
        return { payload: [{ name: "users", kind: "table", isPartitioned: false, partitionCount: 0 }], cached: false };
      }
      if (req.kind === "describe_object") throw new Error("permission denied for table users");
      return { payload: [], cached: false };
    });
    await palette(user, "Connect to local dev");
    await user.click(await screen.findByText("public"));
    await user.click(await screen.findByText("Tables"));
    await screen.findByText("users");
    await palette(user, "Describe public.users");
    expect(await screen.findByText(/Describe failed: .*permission denied/)).toBeInTheDocument();
  });
});

// Audit TN-007. Leaving a session by any door must clear what it put on screen.
describe("App — nothing follows you to another connection", () => {
  it("drops the grid and the staged edits when the titlebar switcher changes connection", async () => {
    // The dev rows used to stay up under the PRODUCTION banner, with the edit
    // still staged: Review and Apply would have sent its UPDATE to prod.
    const user = await withGrid();
    await editCell(user, "new@b.c");
    expect(await screen.findByRole("button", { name: /review/i })).toBeInTheDocument();

    await palette(user, "Connect to prod db");
    await waitFor(() => expect(be.sent("pg_connect")).toHaveLength(2));
    await screen.findByText(/Connected — prod db/);

    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
    expect(screen.queryByTitle(/a@b\.c/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /review/i })).not.toBeInTheDocument();
  });

  it("does not bring the old edit back when the same query is run on the new connection", async () => {
    const user = await withGrid();
    await editCell(user, "new@b.c");
    await palette(user, "Connect to prod db");
    await waitFor(() => expect(be.sent("pg_connect")).toHaveLength(2));

    await user.click(screen.getByRole("button", { name: /^Run/ }));
    await screen.findByRole("grid");
    // The row is there again, as prod returned it, with nothing staged on it.
    expect(await screen.findByTitle(/a@b\.c — double-click to edit/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /review/i })).not.toBeInTheDocument();
    expect(be.sent("pg_query").every((q) => !/^\s*update/i.test(String(q.sql)))).toBe(true);
  });

  it("drops them when the form connects over a live session", async () => {
    // Save & Connect while connected replaces the session just the same.
    const user = await withGrid();
    await editCell(user, "new@b.c");
    await user.click(document.querySelector(".conn-open") as HTMLElement);
    await screen.findByText("Edit connection");
    await user.click(screen.getByRole("button", { name: /^Save & Connect$/ }));
    await waitFor(() => expect(be.sent("pg_connect")).toHaveLength(2));

    await waitFor(() => expect(screen.queryByRole("grid")).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /review/i })).not.toBeInTheDocument();
  });

  it("keeps the grid when a connect from the form fails — the old session is still the session", async () => {
    const user = await withGrid();
    be.on("pg_connect", () => {
      throw new Error("connection refused");
    });
    await user.click(document.querySelector(".conn-open") as HTMLElement);
    await screen.findByText("Edit connection");
    await user.click(screen.getByRole("button", { name: /^Save & Connect$/ }));
    await waitFor(() => expect(be.sent("pg_connect")).toHaveLength(2));
    expect(screen.getByRole("grid")).toBeInTheDocument();
  });
});
