import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { CONNECTION, LOST, backend, type Backend } from "./test/backend";

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

const connected = async () => {
  const user = await mount();
  await palette(user, "Connect to local dev");
  await waitFor(() => expect(be.sent("pg_connect")).toHaveLength(1));
  return user;
};

const type = async (user: ReturnType<typeof userEvent.setup>, sql: string) => {
  const editor = screen.getByRole("textbox", { name: /sql editor/i });
  await user.click(editor);
  await user.clear(editor);
  await user.type(editor, sql);
};

const run = async (user: ReturnType<typeof userEvent.setup>, sql: string) => {
  await type(user, sql);
  await user.click(screen.getByRole("button", { name: /^Run/ }));
  await waitFor(() => expect(be.sent("pg_query").length).toBeGreaterThan(0));
};

/** Connect to the production profile. The write guard is a production rule —
 *  on dev it never fires. */
const connectedProd = async () => {
  const user = await mount();
  await palette(user, "Connect to prod db");
  await waitFor(() => expect(be.sent("pg_connect")).toHaveLength(1));
  return user;
};

describe("App — the write guard", () => {
  it("stops an unqualified DELETE against production", async () => {
    // `delete from users` with no WHERE empties the table. On prod the guard
    // is the only thing between a slip of the hand and every row.
    const user = await connectedProd();
    await type(user, "delete from users");
    await user.click(screen.getByRole("button", { name: /^Run/ }));
    expect(await screen.findByText(/no where clause/i)).toBeInTheDocument();
    expect(be.sent("pg_query")).toHaveLength(0);
  });

  it("runs it once the user confirms", async () => {
    const user = await connectedProd();
    await type(user, "delete from users");
    await user.click(screen.getByRole("button", { name: /^Run/ }));
    await screen.findByText(/no where clause/i);
    // Every row of a prod table: the name is typed back before it runs.
    const run = screen.getByRole("button", { name: /^Run anyway$/ });
    expect(run).toBeDisabled();
    await user.type(screen.getByRole("textbox", { name: "Type users to confirm" }), "users");
    await user.click(run);
    await waitFor(() => expect(be.sent("pg_query")).toHaveLength(1));
  });

  it("sends nothing when the user backs out", async () => {
    const user = await connectedProd();
    await type(user, "delete from users");
    await user.click(screen.getByRole("button", { name: /^Run/ }));
    const dialog = (await screen.findByText(/no where clause/i)).closest(".modal") as HTMLElement;
    await user.click(within(dialog).getByRole("button", { name: /^Don't run it$/ }));
    expect(be.sent("pg_query")).toHaveLength(0);
  });

  it("lets a qualified DELETE straight through", async () => {
    const user = await connectedProd();
    await run(user, "delete from users where id = 1");
    expect(be.sent("pg_query")[0]).toMatchObject({ sql: "delete from users where id = 1" });
  });

  it("does not second-guess the same statement on dev", async () => {
    // The guard is deliberately scoped to production. Prompting on every dev
    // DELETE trains people to click through it, which is how it stops working
    // on the one connection where it matters.
    const user = await connected();
    await run(user, "delete from users");
    expect(be.sent("pg_query")).toHaveLength(1);
  });
});

describe("App — query parameters", () => {
  it("asks for the values before running a parameterised query", async () => {
    const user = await connected();
    await type(user, "select * from users where id = $1");
    await user.click(screen.getByRole("button", { name: /^Run/ }));
    expect(await screen.findByText(/placeholder/i)).toBeInTheDocument();
    expect(be.sent("pg_query")).toHaveLength(0);
  });

  it("binds them as parameters rather than pasting them into the SQL", async () => {
    const user = await connected();
    await type(user, "select * from users where id = $1");
    await user.click(screen.getByRole("button", { name: /^Run/ }));
    const box = await screen.findByPlaceholderText(/value \(empty = null\)/i);
    await user.type(box, "42");
    await user.click(screen.getByRole("button", { name: /run with values/i }));
    await waitFor(() => expect(be.sent("pg_query")).toHaveLength(1));
    const sent = be.sent("pg_query")[0];
    expect(sent.params).toEqual(["42"]); // the text as typed: the server parses it (TN-018)
    expect(sent.sql).toContain("$1");
  });
});

describe("App — a session that goes away", () => {
  it("says the connection was lost rather than that the query was bad", async () => {
    // A dropped socket is not a SQL error, and offering to fix the query
    // sends the user looking in the wrong place.
    const user = await connected();
    be.on("pg_query", () => {
      throw new Error(LOST);
    });
    await type(user, "select 1");
    await user.click(screen.getByRole("button", { name: /^Run/ }));
    expect((await screen.findAllByText(/connection lost/i)).length).toBeGreaterThan(0);
  });

  it("does not silently re-run the statement on reconnect", async () => {
    // Re-running a write the user never asked to repeat is how a transfer
    // happens twice.
    const user = await connected();
    be.on("pg_query", () => {
      throw new Error(LOST);
    });
    await type(user, "insert into t values (1)");
    await user.click(screen.getByRole("button", { name: /^Run/ }));
    await screen.findAllByText(/connection lost/i);
    const before = be.sent("pg_query").length;
    await user.click(screen.getByRole("button", { name: /reconnect/i }));
    await waitFor(() => expect(be.sent("pg_connect").length).toBeGreaterThan(1));
    expect(be.sent("pg_query")).toHaveLength(before);
  });
});

describe("App — EXPLAIN", () => {
  const explain = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole("button", { name: /^Explain$/ }));
  };

  it("leaves the last Run's rows on the grid", async () => {
    // EXPLAIN used to replace the backend row store, so the app cleared the
    // grid: looking at a plan threw away the result it was asked about.
    const user = await connected();
    await run(user, "select kind, n from t");
    expect(await screen.findByText("13109")).toBeInTheDocument();
    await explain(user);
    await screen.findAllByText(/Seq Scan on pg_class/);
    const q = be.sent("pg_query");
    expect(q[q.length - 1]).toMatchObject({ detached: true });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.querySelector(".modal")).not.toBeInTheDocument());
    expect(screen.getByRole("grid", { name: "Query results" })).toBeInTheDocument();
    expect(screen.getByText("13109")).toBeInTheDocument();
  });

  it("walks the plan onto the screen", async () => {
    const user = await connected();
    await type(user, "select * from pg_class");
    await explain(user);
    expect((await screen.findAllByText(/Seq Scan on pg_class/)).length).toBeGreaterThan(0);
    expect(screen.getByText("Plan nodes")).toBeInTheDocument();
  });

  it("turns ANALYZE on for a SELECT", async () => {
    const user = await connected();
    await type(user, "select * from pg_class");
    await explain(user);
    await screen.findAllByText(/Seq Scan on pg_class/);
    const q = be.sent("pg_query");
    expect(q[q.length - 1].sql).toContain("ANALYZE");
  });

  it("leaves ANALYZE off for a DELETE — it would really delete", async () => {
    const user = await connected();
    await type(user, "delete from users where id = 1");
    await explain(user);
    await waitFor(() => expect(be.sent("pg_query").length).toBeGreaterThan(0));
    const q = be.sent("pg_query");
    expect(q[q.length - 1].sql).not.toContain("ANALYZE");
  });

  it("leaves ANALYZE off for a query that writes, whatever its first word", async () => {
    // TN-003. `select … into` creates a table; a WITH can carry a DELETE.
    // Both start like a query, and ANALYZE would have executed them.
    const user = await connected();
    await type(user, "select * into copy_of_users from users");
    await explain(user);
    await waitFor(() => expect(be.sent("pg_query").length).toBeGreaterThan(0));
    const q = be.sent("pg_query");
    expect(q[q.length - 1].sql).not.toContain("ANALYZE");
  });

  it("will not run ANALYZE on production for a statement Run would stop", async () => {
    const user = await connectedProd();
    await type(user, "delete from users");
    await explain(user);
    await waitFor(() => expect(be.sent("pg_query")).toHaveLength(1));
    expect(be.sent("pg_query")[0].sql).not.toContain("ANALYZE");

    // Tick the box and ask again: the statement would now really run.
    await user.click(await screen.findByRole("button", { name: /^ANALYZE/ }));
    await user.click(screen.getByRole("button", { name: "Re-run" }));
    expect(await screen.findByText(/ANALYZE would run this for real/)).toBeInTheDocument();
    expect(be.sent("pg_query")).toHaveLength(1);
  });

  it("shows the error rather than a blank plan", async () => {
    const user = await connected();
    await type(user, "select * from nope");
    be.on("pg_query", () => {
      throw new Error('relation "nope" does not exist');
    });
    await user.click(screen.getByRole("button", { name: /^Explain$/ }));
    expect(await screen.findByText(/does not exist/)).toBeInTheDocument();
  });
});

describe("App — the chart", () => {
  it("sums the numeric column by the text one", async () => {
    const user = await connected();
    await run(user, "select kind, n from t");
    await user.click(screen.getByRole("tab", { name: /^Chart$/ }));
    expect(await screen.findByText("sum(n) by kind")).toBeInTheDocument();
    expect(screen.getByText("13,109")).toBeInTheDocument();
  });
});

describe("App — exporting", () => {
  it("has the backend write every page, and never names a path", async () => {
    const user = await connected();
    await run(user, "select kind, n from t");
    await user.click(screen.getByRole("button", { name: /^Export/ }));
    const menu = document.querySelector(".drop-menu") as HTMLElement;
    await user.click(within(menu).getByRole("menuitem", { name: "CSV .csv" }));
    await waitFor(() => expect(be.sent("export_finish")).toHaveLength(1));
    expect(be.sent("export_result_page")).toEqual([
      { kind: "csv", mode: "spreadsheet-safe", offset: 0, limit: 2, total: 2 },
    ]);
    // The WebView supplies a suggested name, never a path — the TAURI-01
    // invariant, which streaming must not quietly reintroduce.
    for (const args of [...be.sent("export_begin"), ...be.sent("export_result_page")]) {
      expect(args).not.toHaveProperty("path");
    }
  });

  it("refuses to run SQL while an export is still reading the result", async () => {
    // pg_rows pages from the backend's single result store. A query run
    // mid-export replaced it, and the file got the old header over the new
    // query's rows — and still said "Saved".
    const user = await connected();
    await run(user, "select kind, n from t");
    let release!: () => void;
    be.on("export_result_page", () => new Promise<number>((r) => (release = () => r(2))));
    await user.click(screen.getByRole("button", { name: /^Export/ }));
    const menu = document.querySelector(".drop-menu") as HTMLElement;
    await user.click(within(menu).getByRole("menuitem", { name: "CSV .csv" }));
    await waitFor(() => expect(be.sent("export_result_page").length).toBeGreaterThan(0));
    const before = be.sent("pg_query").length;
    await user.click(screen.getByRole("button", { name: /^Run/ }));
    expect(await screen.findByText(/wait for the export to finish/i)).toBeInTheDocument();
    expect(be.sent("pg_query")).toHaveLength(before);
    release();
    await waitFor(() => expect(be.sent("export_finish")).toHaveLength(1));
  });

  it("surfaces a cancelled save without error (backend returns null)", async () => {
    be.on("export_begin", () => null);
    const user = await connected();
    await run(user, "select kind, n from t");
    await user.click(screen.getByRole("button", { name: /^Export/ }));
    const menu = document.querySelector(".drop-menu") as HTMLElement;
    await user.click(within(menu).getByRole("menuitem", { name: "CSV .csv" }));
    await waitFor(() => expect(be.sent("export_begin")).toHaveLength(1));
    // No throw, no crash — cancelling is normal.
  });
});

describe("App — tabs", () => {
  it("opens a new tab", async () => {
    const user = await mount();
    await user.click(screen.getByTitle(/new tab/i));
    expect(await screen.findByText("untitled-2.sql")).toBeInTheDocument();
  });

  it("keeps each tab's text apart", async () => {
    const user = await connected();
    await type(user, "select 1");
    await user.click(screen.getByTitle(/new tab/i));
    await type(user, "select 2");
    await user.click(screen.getByText("untitled-1.sql"));
    expect(screen.getByRole("textbox", { name: /sql editor/i })).toHaveValue("select 1");
  });
});

describe("App — snippets", () => {
  /**
   * The name is asked for by an in-app modal, not `window.prompt` — the
   * webview's prompt returns null without drawing anything, which the caller
   * reads as "cancelled", so the feature could never save.
   */
  const nameBox = () => screen.getByLabelText("Name") as HTMLInputElement;

  it("suggests the query as the name, so it is one keystroke to save", async () => {
    const user = await connected();
    await type(user, "select * from users");
    await palette(user, "Save current query as snippet");
    expect(await screen.findByText("Save snippet")).toBeInTheDocument();
    expect(nameBox().value).toBe("select * from users");
  });

  it("saves the current query under the name given", async () => {
    const user = await connected();
    await type(user, "select * from users");
    await palette(user, "Save current query as snippet");
    await screen.findByText("Save snippet");
    await user.clear(nameBox());
    await user.type(nameBox(), "recent users");
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    await waitFor(() => expect(be.sent("snippet_save")).toHaveLength(1));
    expect(be.sent("snippet_save")[0]).toMatchObject({ name: "recent users", body: "select * from users" });
  });

  it("saves on Enter", async () => {
    const user = await connected();
    await type(user, "select * from users");
    await palette(user, "Save current query as snippet");
    await screen.findByText("Save snippet");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(be.sent("snippet_save")).toHaveLength(1));
  });

  it("saves nothing when the prompt is dismissed", async () => {
    const user = await connected();
    await type(user, "select * from users");
    await palette(user, "Save current query as snippet");
    const dialog = (await screen.findByText("Save snippet")).closest(".modal") as HTMLElement;
    // The toolbar has a Cancel too — that one cancels a running query.
    await user.click(within(dialog).getByRole("button", { name: /^Cancel$/ }));
    expect(be.sent("snippet_save")).toHaveLength(0);
  });

  it("will not save a nameless snippet — it could never be found again", async () => {
    const user = await connected();
    await type(user, "select * from users");
    await palette(user, "Save current query as snippet");
    await screen.findByText("Save snippet");
    await user.clear(nameBox());
    expect(screen.getByRole("button", { name: /^Save$/ })).toBeDisabled();
    await user.keyboard("{Enter}");
    expect(be.sent("snippet_save")).toHaveLength(0);
  });

  it("refuses to open the prompt for an empty editor", async () => {
    const user = await connected();
    await type(user, "  ");
    await palette(user, "Save current query as snippet");
    expect(screen.queryByText("Save snippet")).not.toBeInTheDocument();
    expect(be.sent("snippet_save")).toHaveLength(0);
  });
});

describe("App — history", () => {
  it("loads a past statement back into the editor", async () => {
    const user = await mount();
    await user.click(screen.getByTitle("Query history"));
    // History is a page now: the row picks the statement, and the detail
    // pane beside it puts it in the editor.
    const list = await screen.findByRole("list", { name: "Statements" });
    await user.click(await within(list).findByText("select 1"));
    await user.click(screen.getByRole("button", { name: "Open in editor" }));
    expect(screen.getByRole("textbox", { name: /sql editor/i })).toHaveValue("select 1");
    expect(screen.queryByRole("region", { name: "Query history" })).not.toBeInTheDocument();
  });

  it("goes back to the editor on Escape, and from the rail", async () => {
    const user = await mount();
    await user.click(screen.getByTitle("Query history"));
    const main = document.querySelector(".main-col") as HTMLElement;
    expect(await screen.findByRole("region", { name: "Query history" })).toBeInTheDocument();
    // Hidden, not unmounted: the editor keeps its state for the way back.
    expect(main).not.toBeVisible();
    await user.click(screen.getByLabelText("Search history"));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: "Query history" })).not.toBeInTheDocument();
    expect(document.querySelector(".main-col")).toBe(main);
    expect(main).toBeVisible();

    // The rail: the active page's own button, or Explorer.
    await user.click(screen.getByTitle("Query history"));
    await user.click(screen.getByTitle("Query history"));
    expect(screen.queryByRole("region", { name: "Query history" })).not.toBeInTheDocument();
    await user.click(screen.getByTitle("Query history"));
    await user.click(screen.getByTitle(/Explorer/));
    expect(screen.queryByRole("region", { name: "Query history" })).not.toBeInTheDocument();
    expect(screen.getByTitle(/Explorer/)).toHaveAttribute("aria-current", "page");
  });

  it("goes back to the editor on Escape when focus is outside the page", async () => {
    const user = await mount();
    await user.click(screen.getByTitle("Query history"));
    await screen.findByRole("region", { name: "Query history" });
    (document.activeElement as HTMLElement | null)?.blur();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: "Query history" })).not.toBeInTheDocument();
  });

  it("saves a statement from the history page as a snippet", async () => {
    const user = await mount();
    await user.click(screen.getByTitle("Query history"));
    await screen.findByRole("list", { name: "Statements" });
    await user.click(screen.getByRole("button", { name: "Save as query" }));
    const name = await screen.findByLabelText("Name");
    expect(name).toHaveValue("select 1");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(be.sent("snippet_save")).toHaveLength(1));
    expect(be.sent("snippet_save")[0]).toMatchObject({ name: "select 1", body: "select 1" });
  });

  it("clears everything but the favourites", async () => {
    const user = await mount();
    await user.click(screen.getByTitle("Query history"));
    await user.click(await screen.findByRole("button", { name: /^Clear$/ }));
    await waitFor(() => expect(be.sent("history_clear")).toHaveLength(1));
    expect(be.sent("history_clear")[0]).toEqual({ includeFavorites: false });
  });
});
