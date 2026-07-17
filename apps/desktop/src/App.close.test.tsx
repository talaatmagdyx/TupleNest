import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { CONNECTION, PROD, PLAN, backend, type Backend } from "./test/backend";

/** Every overlay can be dismissed, and the handlers that hang off the shell. */

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

/** Click the modal's own close button. The glyph is aria-hidden, so it is
 *  found by its label rather than by the × a sighted user sees. */
const close = async (user: ReturnType<typeof userEvent.setup>) => {
  const modal = document.querySelector(".modal") as HTMLElement;
  await user.click(within(modal).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(document.querySelector(".modal")).not.toBeInTheDocument());
};

/** An overlay with no way out but Escape is a trap for anyone reaching for
 *  the mouse. Each of these must close on its own × . */
describe("App — every overlay closes", () => {
  it("closes settings", async () => {
    const user = await mount();
    await palette(user, "Open settings");
    await close(user);
  });

  it("closes the import wizard", async () => {
    const user = await mount();
    await palette(user, "Import CSV");
    await close(user);
  });

  it("closes find usages", async () => {
    const user = await mount();
    await palette(user, "Find usages");
    await close(user);
  });

  it("closes the cheatsheet", async () => {
    const user = await mount();
    await palette(user, "Open settings");
    await close(user);
    await user.keyboard("{Escape}");
    await user.keyboard("?");
    await screen.findByText("Keyboard shortcuts");
    await close(user);
  });

  it("closes the server monitor", async () => {
    const user = await connected();
    await palette(user, "Server monitor");
    await waitFor(() => expect(be.sent("pg_activity").length).toBeGreaterThan(0));
    await close(user);
  });

  it("closes the ER diagram", async () => {
    be.on("pg_metadata", (a) => {
      const req = a.request as Record<string, unknown>;
      if (req.kind === "fk_graph") return { payload: { nodes: [], edges: [] }, cached: false };
      if (req.kind === "list_schemas") return { payload: ["public"], cached: false };
      return { payload: [], cached: false };
    });
    const user = await connected();
    await palette(user, "ER diagram");
    await close(user);
  });

  it("closes the audit log", async () => {
    const user = await connected(PROD.name);
    await palette(user, "Prod audit log");
    await close(user);
  });

  it("closes the health report", async () => {
    be.on("pg_metadata", (a) => {
      const req = a.request as Record<string, unknown>;
      if (req.kind === "index_health") {
        return { payload: { items: [], droppableBytes: 0, droppableIndexes: 0 }, cached: false };
      }
      if (req.kind === "list_schemas") return { payload: ["public"], cached: false };
      return { payload: [], cached: false };
    });
    const user = await connected();
    await palette(user, "Index health");
    await close(user);
  });

  it("closes the global search", async () => {
    const user = await connected();
    await user.keyboard("{Meta>}p{/Meta}");
    await waitFor(() => expect(document.querySelector(".modal")).toBeInTheDocument());
    await close(user);
  });
});

describe("App — the titlebar", () => {
  it("toggles the sidebar from the button", async () => {
    const user = await mount();
    const bar = () => document.querySelector(".sidebar") as HTMLElement;
    await user.click(screen.getByTitle("Toggle sidebar"));
    await waitFor(() => expect(bar().style.width).toBe("0px"));
    await user.click(screen.getByTitle("Toggle sidebar"));
    await waitFor(() => expect(bar().style.width).not.toBe("0px"));
  });

  it("toggles the theme from the button", async () => {
    const user = await mount();
    const before = document.documentElement.getAttribute("data-tn-theme");
    await user.click(screen.getByTitle("Toggle theme"));
    await waitFor(() => expect(document.documentElement.getAttribute("data-tn-theme")).not.toBe(before));
  });

  it("opens settings from the button", async () => {
    const user = await mount();
    // The rail has a Settings too; this is the titlebar's.
    const titlebar = document.querySelector(".titlebar") as HTMLElement;
    await user.click(within(titlebar).getByTitle("Settings"));
    expect(await screen.findByText(/Telemetry/i)).toBeInTheDocument();
  });
});

describe("App — connecting", () => {
  it("says why the connection failed, and stays disconnected", async () => {
    // A silent failure leaves the titlebar saying "Not connected" with no
    // reason, and the user re-clicking a button that will never work.
    be.on("pg_connect", () => {
      throw new Error('password authentication failed for user "appuser"');
    });
    const user = await mount();
    await palette(user, "Connect to local dev");
    expect(await screen.findByText(/password authentication failed/)).toBeInTheDocument();
    expect(screen.getAllByText("Not connected").length).toBeGreaterThan(0);
  });

  it("will not switch profiles out from under an open transaction", async () => {
    // Switching disconnects, and disconnecting rolls back. The prompt is the
    // only thing between the user and losing their work.
    const user = await connected();
    await user.click(screen.getByRole("button", { name: /begin transaction/i }));
    await screen.findByText(/in transaction/i);
    await user.click(document.querySelector(".conn-switch > button") as HTMLElement);
    const menu = document.querySelector(".conn-menu") as HTMLElement;
    await user.click(within(menu).getByRole("button", { name: /prod db/i }));
    expect(await screen.findByText(/commit or roll back/i)).toBeInTheDocument();
    // The switch did not happen.
    expect(be.sent("pg_connect")).toHaveLength(1);
  });
});

describe("App — the offline catalog", () => {
  it("browses the tree from the cache with no session open", async () => {
    // Opening a profile while offline fills the tree from the local copy, and
    // expanding a node there must keep reading the cache: `pg_metadata` needs
    // a live session and would only throw.
    const user = await mount();
    be.on("pg_metadata_cached", (a) => {
      const req = (a.request ?? {}) as Record<string, unknown>;
      if (req.kind === "list_schemas") return { payload: ["public"], cached: true };
      if (req.kind === "list_objects") {
        return { payload: [{ name: "users", kind: "table", isPartitioned: false, partitionCount: 0 }], cached: true };
      }
      return { payload: [], cached: true };
    });

    await user.click(document.querySelector(".conn-open") as HTMLElement);
    const dialog = await waitFor(() => document.querySelector(".modal") as HTMLElement);
    await user.click(within(dialog).getByRole("button", { name: /^Cancel$/ }));

    await user.click(await screen.findByText("public"));
    await user.click(await screen.findByText("Tables"));
    expect(await screen.findByText("users")).toBeInTheDocument();
    expect(be.sent("pg_metadata")).toHaveLength(0);
  });
});

describe("App — the EXPLAIN plan", () => {
  const explained = async () => {
    be.on("pg_query", () => ({
      columns: [{ name: "QUERY PLAN", dbType: "json" }],
      totalRows: 1,
      storedRows: 1,
      truncated: false,
      rowsAffected: null,
    }));
    be.on("pg_rows", () => [[JSON.stringify(PLAN)]]);
    const user = await connected();
    await palette(user, "Show EXPLAIN plan");
    // The node name appears on the plan tree and again in the raw JSON tab.
    await waitFor(() => expect(document.querySelector(".modal")).toBeInTheDocument());
    await within(document.querySelector(".modal") as HTMLElement).findAllByText(/Seq Scan/);
    return user;
  };

  it("says so when the plan could not be saved", async () => {
    // A failed save that says nothing looks exactly like a successful one.
    const { save } = await import("@tauri-apps/plugin-dialog");
    vi.mocked(save).mockRejectedValueOnce(new Error("disk full"));
    const user = await explained();
    const modal = document.querySelector(".modal") as HTMLElement;
    // Export is a menu; the format is picked from inside it.
    await user.click(within(modal).getByRole("button", { name: /Export/i }));
    // The menu offers JSON twice: save it, or copy it. This is the save.
    const menu = await waitFor(() => document.querySelector(".drop-menu") as HTMLElement);
    await user.click(within(menu).getAllByRole("button", { name: /json/i })[0]);
    expect(await screen.findByText(/Export failed: .*disk full/)).toBeInTheDocument();
  });

  it("re-runs the plan with the options it was given", async () => {
    const user = await explained();
    const before = be.sent("pg_query").length;
    const modal = document.querySelector(".modal") as HTMLElement;
    await user.click(within(modal).getByRole("button", { name: /re-?run/i }));
    await waitFor(() => expect(be.sent("pg_query").length).toBeGreaterThan(before));
  });

  it("closes", async () => {
    const user = await explained();
    await close(user);
  });
});
