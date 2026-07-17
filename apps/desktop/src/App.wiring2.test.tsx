import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { CONNECTION, RESULT, backend, type Backend } from "./test/backend";

/** The connection form's fields, the rail's tools, and the handlers reached
 *  from the grid and the History tab. */

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

const openForm = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(document.querySelector(".conn-open") as HTMLElement);
  await screen.findByRole("button", { name: /^Save & Connect$/ });
};

describe("App — the connection form", () => {
  it("carries every field through to the connection it opens", async () => {
    // Each field is wired separately, so a typo in any one of them silently
    // connects to the wrong place. This types all of them and checks what the
    // backend was actually asked for.
    const user = await mount();
    await openForm(user);

    const host = screen.getByLabelText("Host");
    await user.clear(host);
    await user.type(host, "db.internal");
    // `clear` does nothing to a number input, so the typing would land beside
    // the old value: set it outright.
    fireEvent.change(screen.getByLabelText("Port"), { target: { value: "6543" } });
    const db = screen.getByLabelText("Database");
    await user.clear(db);
    await user.type(db, "analytics");
    const usr = screen.getByLabelText("Username");
    await user.clear(usr);
    await user.type(usr, "reader");
    await user.selectOptions(screen.getByLabelText("TLS mode"), "verify-full");

    await user.click(screen.getByRole("button", { name: /^Save & Connect$/ }));
    await waitFor(() => expect(be.sent("pg_connect")).toHaveLength(1));
    const params = be.sent("pg_connect")[0].params as Record<string, unknown>;
    expect(params).toMatchObject({
      host: "db.internal",
      port: 6543,
      database: "analytics",
      username: "reader",
      tlsMode: "verify-full",
    });
  });

  it("keeps a sensible port when the field is emptied", async () => {
    // An empty number field is NaN, and NaN in a port is a connection that
    // fails with something unhelpful.
    const user = await mount();
    await openForm(user);
    fireEvent.change(screen.getByLabelText("Port"), { target: { value: "" } });
    await user.click(screen.getByRole("button", { name: /^Save & Connect$/ }));
    await waitFor(() => expect(be.sent("pg_connect")).toHaveLength(1));
    expect((be.sent("pg_connect")[0].params as { port: number }).port).toBe(5432);
  });

  it("names the environment, and marks prod as prod", async () => {
    const user = await mount();
    await openForm(user);
    await user.click(screen.getByRole("button", { name: "prod" }));
    await user.click(screen.getByRole("button", { name: /^Save & Connect$/ }));
    await waitFor(() => expect(be.sent("connection_save")).toHaveLength(1));
    const input = be.sent("connection_save")[0].input as { environment: string };
    expect(input.environment).toBe("prod");
  });

  it("sends the tunnel it was given, and nothing when the toggle is off", async () => {
    const user = await mount();
    await openForm(user);
    const toggle = screen.getByRole("switch", { name: /SSH tunnel/i });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");

    await user.type(screen.getByLabelText("SSH host"), "bastion.internal");
    // Both the server and the tunnel have a field labelled "Port"; this is the
    // tunnel's. (`clear` is a no-op on a number input, so the value is set.)
    const sshPort = document.querySelector("[id$='-sshport']") as HTMLInputElement;
    fireEvent.change(sshPort, { target: { value: "2222" } });
    await user.type(screen.getByLabelText("SSH user"), "deploy");
    await user.type(screen.getByLabelText("Private key path"), "~/.ssh/id_ed25519");
    await user.type(screen.getByLabelText(/fingerprint/i), "SHA256:abc");
    await user.click(screen.getByRole("button", { name: /^Save & Connect$/ }));

    await waitFor(() => expect(be.sent("connection_save")).toHaveLength(1));
    const input = be.sent("connection_save")[0].input as { sshJson: string };
    expect(JSON.parse(input.sshJson)).toMatchObject({
      host: "bastion.internal",
      port: 2222,
      username: "deploy",
      keyPath: "~/.ssh/id_ed25519",
      fingerprint: "SHA256:abc",
    });
  });

  it("takes a CA file for verify-full", async () => {
    const user = await mount();
    await openForm(user);
    await user.selectOptions(screen.getByLabelText("TLS mode"), "verify-full");
    await user.type(screen.getByLabelText(/CA file/i), "/etc/ssl/rds.pem");
    await user.click(screen.getByRole("button", { name: /^Save & Connect$/ }));
    await waitFor(() => expect(be.sent("connection_save")).toHaveLength(1));
    expect((be.sent("connection_save")[0].input as { tlsCaPath: string }).tlsCaPath).toBe("/etc/ssl/rds.pem");
  });

  it("says why the connection failed when saving and connecting", async () => {
    // Save & Connect is its own path: the save can succeed and the connect
    // still fail, and the user needs to know which.
    be.on("pg_connect", () => {
      throw new Error("could not connect to server: Connection refused");
    });
    const user = await mount();
    await openForm(user);
    await user.click(screen.getByRole("button", { name: /^Save & Connect$/ }));
    expect(await screen.findByText(/Connection refused/)).toBeInTheDocument();
    expect(screen.getAllByText("Not connected").length).toBeGreaterThan(0);
  });
});

describe("App — the rail's tools", () => {
  it("opens the server monitor and shows the server's numbers", async () => {
    const user = await connected();
    await user.click(screen.getByTitle("Server monitor"));
    await waitFor(() => expect(be.sent("pg_activity").length).toBeGreaterThan(0));
    // 900 hits of 1,000 reads.
    expect(await screen.findByText("90.0%")).toBeInTheDocument();
    expect(screen.getByText(/No other sessions/i)).toBeInTheDocument();
  });

  it("opens the ER diagram", async () => {
    be.on("pg_metadata", (a) => {
      const req = a.request as Record<string, unknown>;
      if (req.kind === "fk_graph") return { payload: { nodes: [], edges: [] }, cached: false };
      if (req.kind === "list_schemas") return { payload: ["public"], cached: false };
      return { payload: [], cached: false };
    });
    const user = await connected();
    await user.click(screen.getByTitle("ER diagram"));
    await waitFor(() => expect(document.querySelector(".modal")).toBeInTheDocument());
  });

  it("opens settings from the rail", async () => {
    const user = await mount();
    const rail = document.querySelector(".activity-rail") as HTMLElement;
    await user.click(within(rail).getByTitle("Settings"));
    expect(await screen.findByText(/Telemetry/i)).toBeInTheDocument();
  });

  it("offers the tools only with a session", async () => {
    // Both read live server state. Offline they would open and fail.
    await mount();
    expect(screen.getByTitle("Server monitor")).toBeDisabled();
    expect(screen.getByTitle("ER diagram")).toBeDisabled();
  });
});

describe("App — the palette's own items", () => {
  it("runs the query", async () => {
    const user = await connected();
    await palette(user, "Run query");
    await waitFor(() => expect(be.sent("pg_query")).toHaveLength(1));
  });

  it("opens the connection editor", async () => {
    const user = await mount();
    await palette(user, "Open connection…");
    expect(await screen.findByRole("button", { name: /^Save & Connect$/ })).toBeInTheDocument();
  });

  it("opens schema compare", async () => {
    const user = await mount();
    await palette(user, "Compare schemas");
    await waitFor(() => expect(document.querySelector(".modal")).toBeInTheDocument());
  });

  it("inserts a select for a table it knows", async () => {
    const user = await connected();
    await user.click(await screen.findByText("public"));
    await user.click(await screen.findByText("Tables"));
    await screen.findByText("users");
    await palette(user, "public.users");
    const ta = screen.getByRole("textbox", { name: /sql editor/i }) as HTMLTextAreaElement;
    await waitFor(() => expect(ta.value).toContain("users"));
    // Written, not run — the table could have four billion rows in it.
    expect(be.sent("pg_query")).toHaveLength(0);
  });

  it("loads a recent statement back into the editor", async () => {
    const user = await mount();
    await palette(user, "select 1");
    const ta = screen.getByRole("textbox", { name: /sql editor/i }) as HTMLTextAreaElement;
    await waitFor(() => expect(ta.value).toBe("select 1"));
  });
});

describe("App — the titlebar palette button", () => {
  it("opens the palette on an empty query", async () => {
    // Reopening it with the last search still in the box would show yesterday's
    // matches to someone who just clicked "search".
    const user = await mount();
    await user.keyboard("{Meta>}k{/Meta}");
    await user.type(await screen.findByPlaceholderText(/type a command/i), "zzz");
    await user.keyboard("{Escape}");
    await user.click(document.querySelector(".palette-btn") as HTMLElement);
    const box = (await screen.findByPlaceholderText(/type a command/i)) as HTMLInputElement;
    expect(box.value).toBe("");
  });
});

describe("App — the History tab", () => {
  const historyTab = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(await screen.findByRole("button", { name: /^History$/i }));
    await screen.findByText("select 1");
  };

  it("loads a past statement into the editor", async () => {
    const user = await connected();
    await historyTab(user);
    await user.click(screen.getByText("select 1"));
    const ta = screen.getByRole("textbox", { name: /sql editor/i }) as HTMLTextAreaElement;
    await waitFor(() => expect(ta.value).toBe("select 1"));
    expect(await screen.findByText(/Loaded into editor/i)).toBeInTheDocument();
  });

  it("clears the history, keeping favourites", async () => {
    const user = await connected();
    await historyTab(user);
    const pane = document.querySelector(".rtab-body, .qpanel") ?? document.body;
    await user.click(within(pane as HTMLElement).getByRole("button", { name: /^Clear$/ }));
    await waitFor(() => expect(be.sent("history_clear")).toHaveLength(1));
    expect(be.sent("history_clear")[0]).toEqual({ includeFavorites: false });
  });

  it("stars a statement through the store", async () => {
    const user = await connected();
    await historyTab(user);
    await user.click(screen.getByTitle("Favorite"));
    await waitFor(() => expect(be.sent("history_favorite")).toHaveLength(1));
    expect(be.sent("history_favorite")[0]).toEqual({ id: "h1", favorite: true });
  });
});

describe("App — inspecting a JSON cell", () => {
  it("opens the inspector for json, and not for a plain string", async () => {
    // A 40 KB jsonb blob is unreadable in a grid cell; a short text value is
    // fine where it is, and popping a panel for it would be noise.
    be.on("pg_query", () => ({
      ...RESULT,
      columns: [
        { name: "doc", dbType: "jsonb" },
        { name: "note", dbType: "text" },
      ],
      totalRows: 1,
      storedRows: 1,
    }));
    be.on("pg_rows", () => [[{ a: 1 }, "hello"]]);
    const user = await connected();
    await user.click(screen.getByRole("button", { name: /^Run/ }));
    await waitFor(() => expect(be.sent("pg_query")).toHaveLength(1));

    await user.click(await screen.findByText("hello"));
    expect(document.querySelector(".modal")).not.toBeInTheDocument();

    await user.click(screen.getByText(/"a"/));
    const modal = await waitFor(() => document.querySelector(".modal") as HTMLElement);
    // The column name is in the modal's own head, not just the grid behind it.
    expect(within(modal).getByText(/doc/)).toBeInTheDocument();
  });
});

describe("App — copying the selected cell", () => {
  /** Watch the clipboard.
   *
   * This has to happen after `userEvent.setup()`, which installs a clipboard
   * stub of its own — patch before it and setup quietly replaces the spy with
   * something nothing is watching. */
  const watchClipboard = () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    return writeText;
  };

  it("copies with ⌘C when nothing else is selected", async () => {
    const user = await connected();
    const writeText = watchClipboard();
    await user.click(screen.getByRole("button", { name: /^Run/ }));
    await waitFor(() => expect(be.sent("pg_query")).toHaveLength(1));
    await user.click(await screen.findByText("4132"));
    await user.keyboard("{Meta>}c{/Meta}");
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("4132"));
    expect(await screen.findByText(/Copied cell: 4132/)).toBeInTheDocument();
  });

  it("leaves a text selection to the browser", async () => {
    // ⌘C with text highlighted means "copy that text". Overriding it would
    // silently replace what the user actually selected.
    const user = await connected();
    const writeText = watchClipboard();
    await user.click(screen.getByRole("button", { name: /^Run/ }));
    await waitFor(() => expect(be.sent("pg_query")).toHaveLength(1));
    await user.click(await screen.findByText("4132"));

    const node = screen.getByText("4132").firstChild ?? screen.getByText("4132");
    const range = document.createRange();
    range.selectNodeContents(node);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);

    await user.keyboard("{Meta>}c{/Meta}");
    expect(writeText).not.toHaveBeenCalled();
    window.getSelection()!.removeAllRanges();
  });
});
