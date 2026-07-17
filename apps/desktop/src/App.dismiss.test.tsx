import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { CONNECTION, PROD, RESULT, backend, type Backend } from "./test/backend";

/** The remaining dismissals, and the handlers that only fire from inside a
 *  modal: the transaction prompt, the import wizard, and rename. */

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

const connected = async (profile = CONNECTION.name) => {
  const user = await mount();
  await palette(user, `Connect to ${profile}`);
  await waitFor(() => expect(be.sent("pg_connect")).toHaveLength(1));
  return user;
};

const close = async (user: ReturnType<typeof userEvent.setup>) => {
  const modal = document.querySelector(".modal") as HTMLElement;
  await user.click(within(modal).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(document.querySelector(".modal")).not.toBeInTheDocument());
};

const meta = () =>
  be.on("pg_metadata", (a) => {
    const req = a.request as Record<string, unknown>;
    if (req.kind === "list_schemas") return { payload: ["public"], cached: false };
    if (req.kind === "server_info") return { payload: { version: "PostgreSQL 18.0" }, cached: false };
    if (req.kind === "list_objects") {
      return { payload: [{ name: "users", kind: "table", isPartitioned: false, partitionCount: 0 }], cached: false };
    }
    if (req.kind === "object_details") {
      return {
        payload: { name: "users", kind: "table", sections: [{ label: "Storage", rows: [{ k: "Size", v: "12 MB" }] }] },
        cached: false,
      };
    }
    if (req.kind === "describe_object") {
      return { payload: { columns: [{ name: "id", dbType: "int8", nullable: false, primaryKey: true }] }, cached: false };
    }
    return { payload: [], cached: false };
  });

const tables = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByText("public"));
  await user.click(await screen.findByText("Tables"));
  await screen.findByText("users");
};

describe("App — the empty sidebar", () => {
  it("goes straight to a new profile when there is nothing to connect to", async () => {
    // With no saved connections there is no menu worth opening.
    be.on("connection_list", () => []);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText(/no connections yet/i);
    // The explorer's own prompt, not the sidebar's.
    const tree = document.querySelector(".explorer-empty") as HTMLElement;
    await user.click(within(tree).getByRole("button", { name: /New connection/i }));
    expect(await screen.findByRole("button", { name: /^Save & Connect$/ })).toBeInTheDocument();
  });

  it("opens the switcher when there are profiles to pick from", async () => {
    // With something saved, the same button should offer it rather than making
    // the user retype a connection they already have.
    const user = await mount();
    const tree = document.querySelector(".explorer-empty") as HTMLElement;
    await user.click(within(tree).getByRole("button", { name: /New connection/i }));
    await waitFor(() => expect(document.querySelector(".conn-menu")).toBeInTheDocument());
  });
});

describe("App — the transaction prompt", () => {
  /** Disconnect with a transaction open, which raises the prompt. */
  const prompted = async () => {
    const user = await connected();
    await user.click(screen.getByRole("button", { name: /begin transaction/i }));
    await screen.findByText(/in transaction/i);
    await palette(user, "Disconnect");
    await screen.findByText(/commit or roll back/i);
    return user;
  };

  it("commits, then disconnects", async () => {
    const user = await prompted();
    await user.click(screen.getByRole("button", { name: /^Commit & disconnect$/i }));
    await waitFor(() => expect(be.sent("pg_commit")).toHaveLength(1));
    await waitFor(() => expect(be.sent("pg_disconnect").length).toBeGreaterThan(1));
  });

  it("rolls back, then disconnects", async () => {
    const user = await prompted();
    await user.click(screen.getByRole("button", { name: /^Rollback & disconnect$/i }));
    await waitFor(() => expect(be.sent("pg_rollback")).toHaveLength(1));
    await waitFor(() => expect(be.sent("pg_disconnect").length).toBeGreaterThan(1));
  });

  it("stays put, keeping the transaction and the session", async () => {
    // The third option matters most: the user opened this by accident and
    // wants neither outcome.
    const user = await prompted();
    await user.click(screen.getByRole("button", { name: /^Stay connected$/i }));
    await waitFor(() => expect(screen.queryByText(/commit or roll back/i)).not.toBeInTheDocument());
    expect(be.sent("pg_commit")).toHaveLength(0);
    expect(be.sent("pg_rollback")).toHaveLength(0);
    expect(await screen.findByText(/in transaction/i)).toBeInTheDocument();
  });
});

describe("App — the import wizard", () => {
  it("refreshes the tree and the history once the rows have landed", async () => {
    // An import creates a table and writes statements. Leaving the old tree and
    // history up means neither shows what just happened.
    const user = await connected();
    meta();
    await palette(user, "Import CSV");
    const modal = await waitFor(() => document.querySelector(".modal") as HTMLElement);

    const file = new File(["id,name\n1,ada\n"], "people.csv", { type: "text/csv" });
    const input = modal.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, file);
    await within(modal).findByText(/ada/);

    const before = be.sent("history_list").length;
    await user.click(within(modal).getByRole("button", { name: /^Import/i }));
    expect(await screen.findByText(/Imported 1 rows? into/i)).toBeInTheDocument();
    await waitFor(() => expect(be.sent("history_list").length).toBeGreaterThan(before));
    // The tree was dropped, so it will be read again rather than kept stale.
    expect(screen.queryByText("Tables")).not.toBeInTheDocument();
  });
});

describe("App — dismissing the rest", () => {
  it("closes the object details", async () => {
    const user = await mount();
    meta();
    await palette(user, "Connect to local dev");
    await waitFor(() => expect(be.sent("pg_connect")).toHaveLength(1));
    await tables(user);
    await user.click(screen.getByTitle(/Details —/));
    await screen.findByText("12 MB");
    await close(user);
  });

  it("closes the partition overview", async () => {
    const user = await mount();
    be.on("pg_metadata", (a) => {
      const req = a.request as Record<string, unknown>;
      if (req.kind === "list_schemas") return { payload: ["public"], cached: false };
      if (req.kind === "list_objects") {
        return { payload: [{ name: "events", kind: "table", isPartitioned: true, partitionCount: 2 }], cached: false };
      }
      if (req.kind === "partition_overview") {
        return {
          payload: { partitioned: true, strategy: "RANGE", partitionKey: "created_at", items: [] },
          cached: false,
        };
      }
      return { payload: [], cached: false };
    });
    await palette(user, "Connect to local dev");
    await user.click(await screen.findByText("public"));
    await user.click(await screen.findByText("Tables"));
    await screen.findByText("events");
    await user.click(screen.getByTitle(/2 direct partitions/));
    await screen.findByText(/created_at/);
    await close(user);
  });

  it("closes the schema view", async () => {
    const user = await mount();
    meta();
    await palette(user, "Connect to local dev");
    await waitFor(() => expect(be.sent("pg_connect")).toHaveLength(1));
    await tables(user);
    await palette(user, "Describe public.users");
    const modal = await waitFor(() => document.querySelector(".modal") as HTMLElement);
    await within(modal).findByText("id");
    await close(user);
  });

  it("closes the cell inspector", async () => {
    be.on("pg_query", () => ({ ...RESULT, columns: [{ name: "doc", dbType: "jsonb" }], totalRows: 1, storedRows: 1 }));
    be.on("pg_rows", () => [[{ a: 1 }]]);
    const user = await connected();
    await user.click(screen.getByRole("button", { name: /^Run/ }));
    await waitFor(() => expect(be.sent("pg_query")).toHaveLength(1));
    await user.click(await screen.findByText(/"a"/));
    await waitFor(() => expect(document.querySelector(".modal")).toBeInTheDocument());
    await close(user);
  });

  it("dismisses the update toast without installing", async () => {
    // "Later" has to mean later, not never and not now.
    const { check } = await import("@tauri-apps/plugin-updater");
    const downloadAndInstall = vi.fn();
    vi.mocked(check).mockResolvedValue({ version: "0.2.0", body: "fixes", downloadAndInstall } as never);
    const user = await mount();
    await screen.findByRole("button", { name: /restart|update|install/i });
    const toast = document.querySelector(".update-toast") as HTMLElement;
    await user.click(within(toast).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByText(/0\.2\.0/)).not.toBeInTheDocument());
    expect(downloadAndInstall).not.toHaveBeenCalled();
  });
});

describe("App — the write guard", () => {
  it("lets you back out of a statement it stopped", async () => {
    // The guard exists to create a pause. Cancel is the outcome it is for.
    const user = await connected(PROD.name);
    const ta = screen.getByRole("textbox", { name: /sql editor/i });
    await user.click(ta);
    await user.clear(ta);
    await user.type(ta, "delete from users");
    await user.click(screen.getByRole("button", { name: /^Run/ }));
    await screen.findByText(/no WHERE clause/i);
    const modal = document.querySelector(".modal.dialog") as HTMLElement;
    await user.click(within(modal).getByRole("button", { name: /^Cancel$/ }));
    await waitFor(() => expect(document.querySelector(".modal")).not.toBeInTheDocument());
    expect(be.sent("pg_query")).toHaveLength(0);
  });
});

describe("App — rename from find usages", () => {
  /** Open the intel modal with `sql` in the current tab, and search for a name. */
  const usages = async (sql: string, needle: string) => {
    const user = await connected();
    const ta = screen.getByRole("textbox", { name: /sql editor/i });
    await user.click(ta);
    await user.clear(ta);
    await user.type(ta, sql);
    await palette(user, "Find usages");
    const modal = await waitFor(() => document.querySelector(".modal") as HTMLElement);
    await user.type(within(modal).getByPlaceholderText(/Identifier/i), needle);
    return { user, modal };
  };

  it("rewrites the name in the tab it was found in", async () => {
    const { user, modal } = await usages("select * from orders", "orders");
    await within(modal).findByText(/untitled-1/);
    await user.type(within(modal).getByPlaceholderText(/Rename to/i), "sales_orders");
    await user.click(within(modal).getByRole("button", { name: /^Rename/ }));
    const ta = screen.getByRole("textbox", { name: /sql editor/i }) as HTMLTextAreaElement;
    await waitFor(() => expect(ta.value).toBe("select * from sales_orders"));
  });

  it("will not rename until it has both names", async () => {
    // An empty replacement would delete every usage of the identifier.
    const { modal } = await usages("select * from orders", "orders");
    expect(within(modal).getByRole("button", { name: /^Rename/ })).toBeDisabled();
  });

  it("jumps to the tab holding the usage, and closes", async () => {
    const user = await connected();
    await user.keyboard("{Meta>}t{/Meta}");
    await waitFor(() => expect(document.querySelectorAll(".qtab")).toHaveLength(2));
    const ta = screen.getByRole("textbox", { name: /sql editor/i });
    await user.click(ta);
    await user.clear(ta);
    await user.type(ta, "select * from orders");
    // Go back to the first tab, so the jump has somewhere to take us.
    await user.click(screen.getAllByRole("button", { name: /untitled-1/ })[0]);

    await palette(user, "Find usages");
    const modal = await waitFor(() => document.querySelector(".modal") as HTMLElement);
    await user.type(within(modal).getByPlaceholderText(/Identifier/i), "orders");
    await user.click(await within(modal).findByText(/untitled-2/));

    await waitFor(() => expect(document.querySelector(".modal")).not.toBeInTheDocument());
    const editor = screen.getByRole("textbox", { name: /sql editor/i }) as HTMLTextAreaElement;
    expect(editor.value).toBe("select * from orders");
  });
});
