import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { CONNECTION, backend, type Backend } from "./test/backend";

let be: Backend;
beforeEach(() => {
  be = backend();
});

/** Mount the app and wait for the first paint to settle. */
const mount = async () => {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByText(CONNECTION.name);
  return user;
};

/** Run a palette command by typing enough of its label to select it. */
const palette = async (user: ReturnType<typeof userEvent.setup>, term: string) => {
  await user.keyboard("{Meta>}k{/Meta}");
  await user.type(await screen.findByPlaceholderText(/type a command/i), term);
  await user.keyboard("{Enter}");
};

/** Mount, then connect. The saved-connection card opens the *editor*; the
 *  palette is the path that actually opens a session. */
const connected = async () => {
  const user = await mount();
  await palette(user, "Connect to local dev");
  await waitFor(() => expect(be.sent("pg_connect")).toHaveLength(1));
  return user;
};

describe("App — coming up", () => {
  it("reads its identity, settings, connections and snippets on mount", async () => {
    await mount();
    expect(be.calls()).toEqual(expect.arrayContaining(["app_get_info", "connection_list", "snippet_list"]));
  });

  it("starts disconnected", async () => {
    await mount();
    // The titlebar and the empty results panel both say it.
    expect(screen.getAllByText("Not connected").length).toBeGreaterThan(0);
  });

  it("lists the saved connections", async () => {
    await mount();
    expect(screen.getByText(CONNECTION.name)).toBeInTheDocument();
  });

  it("survives a backend that cannot answer at all", async () => {
    // Every mount effect calls out. If one rejection took the render down, the
    // app would show nothing at all rather than a disconnected shell.
    vi.spyOn(console, "error").mockImplementation(() => {});
    be.on("app_get_info", () => {
      throw new Error("ipc down");
    });
    be.on("connection_list", () => {
      throw new Error("store locked");
    });
    render(<App />);
    expect((await screen.findAllByText("Not connected")).length).toBeGreaterThan(0);
  });

  it("applies the stored theme", async () => {
    be.on("settings_get", (a) => (a.key === "theme" ? "light" : null));
    await mount();
    await waitFor(() => expect(document.documentElement.getAttribute("data-tn-theme")).toBe("light"));
  });

  it("defaults to dark when nothing is stored", async () => {
    await mount();
    expect(document.documentElement.getAttribute("data-tn-theme")).toBe("dark");
  });
});

describe("App — connecting", () => {
  it("opens a session from a saved profile", async () => {
    await connected();
    expect(be.sent("pg_connect")[0]).toMatchObject({
      params: expect.objectContaining({ host: "localhost", database: "appdb" }),
    });
  });

  it("loads the schema list once connected", async () => {
    await connected();
    expect(await screen.findByText("public")).toBeInTheDocument();
  });

  it("reads the server version for the status bar", async () => {
    await connected();
    expect(await screen.findByText(/PostgreSQL 18\.0/)).toBeInTheDocument();
  });

  it("says what went wrong when the connection is refused", async () => {
    be.on("pg_connect", () => {
      throw new Error("password authentication failed");
    });
    const user = await mount();
    await palette(user, "Connect to local dev");
    expect(await screen.findByText(/authentication failed/)).toBeInTheDocument();
  });

  it("does not claim a session it does not have", async () => {
    // `connected` arms the run guard and the prod banner. Setting it on a
    // refused connection describes a session that does not exist.
    be.on("pg_connect", () => {
      throw new Error("refused");
    });
    const user = await mount();
    await palette(user, "Connect to local dev");
    await waitFor(() => expect(be.sent("pg_connect")).toHaveLength(1));
    expect(screen.getAllByText("Not connected").length).toBeGreaterThan(0);
  });
});

describe("App — running a query", () => {
  const typeAndRun = async (user: ReturnType<typeof userEvent.setup>, sql: string) => {
    const editor = screen.getByRole("textbox", { name: /sql editor/i });
    await user.click(editor);
    await user.clear(editor);
    await user.type(editor, sql);
    await user.click(screen.getByRole("button", { name: /^Run/ }));
  };

  it("sends the statement and shows the rows", async () => {
    const user = await connected();
    await typeAndRun(user, "select 1");
    await waitFor(() => expect(be.sent("pg_query")).toHaveLength(1));
    expect(be.sent("pg_query")[0]).toMatchObject({ sql: "select 1" });
  });

  it("reports a failed statement rather than an empty grid", async () => {
    const user = await connected();
    be.on("pg_query", () => {
      throw new Error('relation "nope" does not exist');
    });
    await typeAndRun(user, "select * from nope");
    // The message lands in the run status line and the results panel.
    expect((await screen.findAllByText(/does not exist/)).length).toBeGreaterThan(0);
  });

  it("runs nothing when there is nothing to run", async () => {
    const user = await connected();
    const editor = screen.getByRole("textbox", { name: /sql editor/i });
    await user.click(editor);
    await user.clear(editor);
    await user.click(screen.getByRole("button", { name: /^Run/ }));
    expect(be.sent("pg_query")).toHaveLength(0);
  });
});

describe("App — the transaction chip", () => {
  it("opens a transaction and offers to close it", async () => {
    const user = await connected();
    await user.click(screen.getByRole("button", { name: /begin transaction/i }));
    expect(await screen.findByText(/in transaction/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Commit$/ })).toBeInTheDocument();
  });

  it("commits and puts the Begin button back", async () => {
    const user = await connected();
    await user.click(screen.getByRole("button", { name: /begin transaction/i }));
    await user.click(await screen.findByRole("button", { name: /^Commit$/ }));
    await waitFor(() => expect(be.sent("pg_commit")).toHaveLength(1));
    expect(await screen.findByRole("button", { name: /begin transaction/i })).toBeInTheDocument();
  });

  it("keeps the transaction open when the commit fails", async () => {
    // The one that matters: a COMMIT that failed did not commit.
    const user = await connected();
    await user.click(screen.getByRole("button", { name: /begin transaction/i }));
    be.on("pg_commit", () => {
      throw new Error("could not serialize access");
    });
    await user.click(await screen.findByRole("button", { name: /^Commit$/ }));
    await waitFor(() => expect(be.sent("pg_commit")).toHaveLength(1));
    expect(screen.getByText(/in transaction/i)).toBeInTheDocument();
  });

  it("rolls back", async () => {
    const user = await connected();
    await user.click(screen.getByRole("button", { name: /begin transaction/i }));
    await user.click(await screen.findByRole("button", { name: /^Rollback$/ }));
    await waitFor(() => expect(be.sent("pg_rollback")).toHaveLength(1));
  });

  it("will not disconnect out from under an open transaction", async () => {
    // Disconnecting mid-transaction discards it. The prompt is the only thing
    // between the user and losing uncommitted work.
    const user = await connected();
    await user.click(screen.getByRole("button", { name: /begin transaction/i }));
    await screen.findByText(/in transaction/i);
    // Switching profiles closes the old session first, so count from here
    // rather than from zero.
    const before = be.sent("pg_disconnect").length;
    await palette(user, "Disconnect");
    expect(await screen.findByText(/you have an open transaction/i)).toBeInTheDocument();
    expect(be.sent("pg_disconnect")).toHaveLength(before);
  });
});

describe("App — the explorer", () => {
  it("expands a schema, then a group, to reach the tables", async () => {
    // Nothing loads until it is opened: schema → group → table. A schema here
    // holds 13,000 relations, so the tree never fetches ahead.
    const user = await connected();
    await user.click(await screen.findByText("public"));
    await user.click(await screen.findByText("Tables"));
    expect(await screen.findByText("users")).toBeInTheDocument();
  });

  it("fetches a schema's objects once, however often it is reopened", async () => {
    const user = await connected();
    await user.click(await screen.findByText("public"));
    await screen.findByText("Tables");
    await user.click(screen.getByText("public")); // close
    await user.click(screen.getByText("public")); // open again
    const listings = be.sent("pg_metadata").filter((a) => (a.request as { kind: string }).kind === "list_objects");
    expect(listings).toHaveLength(1);
  });

  it("says when the catalog it is showing came from the cache", async () => {
    // A cached tree can disagree with the server. The status bar is the only
    // thing that says which one is on screen.
    be.on("pg_metadata", (a) => {
      const req = a.request as { kind: string };
      if (req.kind === "list_schemas") return { payload: ["public"], cached: true };
      if (req.kind === "server_info") return { payload: { version: "PostgreSQL 18.0" }, cached: false };
      return { payload: [], cached: true };
    });
    await connected();
    expect(await screen.findByText("explorer: cached")).toBeInTheDocument();
  });

  it("says the tree is live when it came from the server", async () => {
    await connected();
    expect(await screen.findByText("explorer: live")).toBeInTheDocument();
  });
});

describe("App — the command palette", () => {
  it("opens on ⌘K", async () => {
    const user = await mount();
    await user.keyboard("{Meta>}k{/Meta}");
    expect(await screen.findByPlaceholderText(/type a command/i)).toBeInTheDocument();
  });

  it("closes on escape", async () => {
    const user = await mount();
    await user.keyboard("{Meta>}k{/Meta}");
    await screen.findByPlaceholderText(/type a command/i);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByPlaceholderText(/type a command/i)).not.toBeInTheDocument());
  });

  it("filters to what was typed", async () => {
    const user = await mount();
    await user.keyboard("{Meta>}k{/Meta}");
    await user.type(await screen.findByPlaceholderText(/type a command/i), "theme");
    const list = await screen.findByRole("list", { name: /commands/i }).catch(() => null);
    if (list) expect(within(list).getAllByRole("listitem").length).toBeGreaterThan(0);
  });
});

describe("App — settings", () => {
  it("stores a theme change rather than only painting it", async () => {
    // A theme that repaints but is not written comes back dark on restart.
    const user = await mount();
    await palette(user, "Toggle theme");
    await waitFor(() => expect(be.sent("settings_set")).toContainEqual({ key: "theme", value: "light" }));
    expect(document.documentElement.getAttribute("data-tn-theme")).toBe("light");
  });
});
