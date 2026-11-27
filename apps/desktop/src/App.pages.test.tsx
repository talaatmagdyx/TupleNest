/** The pages that take the editor's place (history, saved queries), and the
 *  rail and palette entries that reach them and the other redesigned views. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { check } from "@tauri-apps/plugin-updater";
import App from "./App";
import { CONNECTION, backend, type Backend } from "./test/backend";

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

const editor = () => screen.getByRole("textbox", { name: /sql editor/i }) as HTMLTextAreaElement;

describe("App — the saved queries page", () => {
  beforeEach(() => {
    be.on("snippet_list", () => [{ id: "s1", name: "weekly", body: "select 'weekly'", tags: null }]);
  });

  it("opens from the rail, and puts a snippet in the editor", async () => {
    const user = await mount();
    await user.click(screen.getByTitle("Saved queries"));
    expect(screen.getByTitle("Saved queries")).toHaveAttribute("aria-current", "page");
    await user.click(await screen.findByTitle("Open “weekly” in the editor"));
    expect(editor().value).toBe("select 'weekly'");
    expect(screen.queryByRole("region", { name: "Saved queries" })).not.toBeInTheDocument();
    expect(await screen.findByText(/Inserted snippet "weekly"/)).toBeInTheDocument();
  });

  it("starts a new query from the page", async () => {
    const user = await mount();
    await user.click(screen.getByTitle("Saved queries"));
    await user.click(await screen.findByRole("button", { name: "New query" }));
    expect(screen.queryByRole("region", { name: "Saved queries" })).not.toBeInTheDocument();
    expect(editor()).toBeInTheDocument();
  });

  it("goes back on Escape", async () => {
    const user = await mount();
    await user.click(screen.getByTitle("Saved queries"));
    await user.click(await screen.findByRole("button", { name: "New query" }));
    await user.click(screen.getByTitle("Saved queries"));
    screen.getByRole("button", { name: "New query" }).focus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: "Saved queries" })).not.toBeInTheDocument();
  });

  it("is reachable from the palette, as is history", async () => {
    const user = await mount();
    await palette(user, "Show saved queries");
    expect(await screen.findByRole("region", { name: "Saved queries" })).toBeInTheDocument();
    await palette(user, "Show query history");
    expect(await screen.findByRole("region", { name: "Query history" })).toBeInTheDocument();
    // Anything else from the palette acts on the editor, so brings it back.
    await palette(user, "New query tab");
    expect(editor()).toBeInTheDocument();
  });
});

describe("App — the palette's assistant entry", () => {
  it("opens the assistant with what was typed", async () => {
    const user = await mount();
    await user.keyboard("{Meta>}k{/Meta}");
    await user.type(await screen.findByPlaceholderText(/type a command/i), "zzz why slow");
    await user.click(screen.getByRole("option", { name: /Ask the assistant/ }));
    expect(await screen.findByRole("complementary", { name: "Assistant" })).toBeInTheDocument();
    expect(be.sent("assistant_ask")).toHaveLength(0);
  });
});

describe("App — the audit log from the rail", () => {
  it("opens without a session: the log is local", async () => {
    be.on("audit_list", () => []);
    const user = await mount();
    await user.click(screen.getByTitle("Audit log"));
    expect(await screen.findByRole("dialog", { name: "Audit log" })).toBeInTheDocument();
    await waitFor(() => expect(be.sent("audit_list").length).toBeGreaterThan(0));
  });
});

describe("App — table details", () => {
  const tables = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(await screen.findByText("public"));
    await user.click(await screen.findByText("Tables"));
    await screen.findByText("users");
  };

  const meta = () =>
    be.on("pg_metadata", (a) => {
      const req = a.request as { kind: string; name?: string };
      if (req.kind === "list_schemas") return { payload: ["public"], cached: false };
      if (req.kind === "list_objects") return { payload: [{ name: "users", kind: "table" }], cached: false };
      if (req.kind === "object_details") {
        return { payload: { title: "users", kind: "table", sections: [] }, cached: false };
      }
      if (req.kind === "describe_object") {
        return {
          payload: { columns: [{ name: "id", dbType: "int8", nullable: false, primaryKey: true, comment: null }] },
          cached: false,
        };
      }
      return { payload: [], cached: false };
    });

  const connect = async () => {
    const user = await mount();
    await palette(user, "Connect to local dev");
    await waitFor(() => expect(be.sent("pg_connect")).toHaveLength(1));
    return user;
  };

  it("shows the columns, and queries the table", async () => {
    meta();
    const user = await connect();
    await tables(user);
    await user.click(screen.getByTitle(/Details —/));
    await user.click(await screen.findByRole("tab", { name: "Structure" }));
    expect(await screen.findByText("primary key")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show in ER diagram" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Query this table" }));
    expect(editor().value).toMatch(/select \* from .*users.* limit 100/);
    expect(screen.queryByRole("tab", { name: "Structure" })).not.toBeInTheDocument();
  });

  it("opens the ER diagram from the details", async () => {
    meta();
    const user = await connect();
    await tables(user);
    await user.click(screen.getByTitle(/Details —/));
    await user.click(await screen.findByRole("tab", { name: "Structure" }));
    await user.click(await screen.findByRole("button", { name: "Show in ER diagram" }));
    await waitFor(() => expect(screen.queryByRole("tab", { name: "Structure" })).not.toBeInTheDocument());
  });
});

describe("App — checking for updates from About", () => {
  const about = async () => {
    const user = await mount();
    await palette(user, "About TupleNest");
    await screen.findByRole("dialog", { name: "About TupleNest" });
    return user;
  };

  it("says when there is nothing newer", async () => {
    const user = await about();
    vi.mocked(check).mockResolvedValueOnce(null);
    await user.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText("TupleNest is up to date")).toBeInTheDocument();
  });

  it("offers an update it finds", async () => {
    const user = await about();
    vi.mocked(check).mockResolvedValueOnce({ version: "9.9.9", body: "faster" } as Awaited<ReturnType<typeof check>>);
    await user.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText("Update available")).toBeInTheDocument();
  });

  it("says when the check itself failed", async () => {
    const user = await about();
    vi.mocked(check).mockRejectedValueOnce(new Error("offline"));
    await user.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText(/Could not check for updates: .*offline/)).toBeInTheDocument();
  });
});

describe("App — settings from the assistant", () => {
  it("opens on the Assistant section", async () => {
    const user = await mount();
    await user.keyboard("{Meta>}j{/Meta}");
    await user.click(await screen.findByRole("button", { name: "Open Settings › Assistant" }));
    const nav = await screen.findByRole("navigation", { name: "Settings sections" });
    expect(within(nav).getByRole("button", { name: "Assistant" })).toHaveAttribute("aria-current", "page");
  });
});
