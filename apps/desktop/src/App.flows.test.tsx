import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import App from "./App";
import { CONNECTION, LOST, PLAN, backend, type Backend } from "./test/backend";

let be: Backend;
beforeEach(() => {
  be = backend();
});

const mount = async () => {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByText(CONNECTION.name);
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
    await user.click(screen.getByRole("button", { name: /^Run anyway$/ }));
    await waitFor(() => expect(be.sent("pg_query")).toHaveLength(1));
  });

  it("sends nothing when the user backs out", async () => {
    const user = await connectedProd();
    await type(user, "delete from users");
    await user.click(screen.getByRole("button", { name: /^Run/ }));
    const dialog = (await screen.findByText(/no where clause/i)).closest(".modal") as HTMLElement;
    // The toolbar has a Cancel too — that one cancels a running query.
    await user.click(within(dialog).getByRole("button", { name: /^Cancel$/ }));
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
    expect(sent.params).toEqual([42]);
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
    be.on("pg_query", () => ({ columns: [{ name: "QUERY PLAN", dbType: "json" }], totalRows: 1, storedRows: 1, truncated: false, rowsAffected: null }));
    be.on("pg_rows", () => [[JSON.stringify(PLAN)]]);
    await user.click(screen.getByRole("button", { name: /^Explain$/ }));
  };

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
    await user.click(screen.getByRole("button", { name: /^Chart$/ }));
    expect(await screen.findByText("sum(n) by kind")).toBeInTheDocument();
    expect(screen.getByText("13,109")).toBeInTheDocument();
  });
});

describe("App — exporting", () => {
  it("writes the rows to the file the user picked", async () => {
    vi.mocked(saveDialog).mockResolvedValue("/tmp/out.csv");
    const user = await connected();
    await run(user, "select kind, n from t");
    await user.click(screen.getByRole("button", { name: /^Export/ }));
    const menu = document.querySelector(".drop-menu") as HTMLElement;
    await user.click(within(menu).getByRole("button", { name: "CSV .csv" }));
    await waitFor(() => expect(vi.mocked(writeTextFile)).toHaveBeenCalled());
    const [, body] = vi.mocked(writeTextFile).mock.calls[0];
    expect(body).toContain("kind,n");
    expect(body).toContain("13109");
  });

  it("writes nothing when the save dialog is dismissed", async () => {
    vi.mocked(saveDialog).mockResolvedValue(null);
    const user = await connected();
    await run(user, "select kind, n from t");
    await user.click(screen.getByRole("button", { name: /^Export/ }));
    const menu = document.querySelector(".drop-menu") as HTMLElement;
    await user.click(within(menu).getByRole("button", { name: "CSV .csv" }));
    await waitFor(() => expect(vi.mocked(saveDialog)).toHaveBeenCalled());
    expect(vi.mocked(writeTextFile)).not.toHaveBeenCalled();
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
    await user.click(await screen.findByText("select 1"));
    expect(screen.getByRole("textbox", { name: /sql editor/i })).toHaveValue("select 1");
  });

  it("clears everything but the favourites", async () => {
    const user = await mount();
    await user.click(screen.getByTitle("Query history"));
    await user.click(await screen.findByRole("button", { name: /^Clear$/ }));
    await waitFor(() => expect(be.sent("history_clear")).toHaveLength(1));
    expect(be.sent("history_clear")[0]).toEqual({ includeFavorites: false });
  });
});
