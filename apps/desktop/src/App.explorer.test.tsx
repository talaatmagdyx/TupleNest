import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { CONNECTION, backend, type Backend } from "./test/backend";

/** The explorer's own actions: schema view, partitions, and the palette items
 *  that come from the catalog. */

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

/** A backend whose metadata answers can be extended per test. */
const meta = (extra: Record<string, (req: Record<string, unknown>) => unknown> = {}) => {
  be.on("pg_metadata", (a) => {
    const req = a.request as Record<string, unknown>;
    const kind = req.kind as string;
    if (extra[kind]) return extra[kind](req);
    if (kind === "list_schemas") return { payload: ["public"], cached: false };
    if (kind === "server_info") return { payload: { version: "PostgreSQL 18.0" }, cached: false };
    if (kind === "list_objects") {
      return { payload: [{ name: "users", kind: "table", isPartitioned: false, partitionCount: 0 }], cached: false };
    }
    if (kind === "describe_object") {
      return { payload: { columns: [{ name: "id", dbType: "int8", nullable: false, primaryKey: true }] }, cached: false };
    }
    return { payload: [], cached: false };
  });
};

/** Connect with the metadata answers already in place: the tree fetches each
 *  node once, so an override installed after connecting never gets asked. */
const connectedWith = async (extra: Parameters<typeof meta>[0] = {}) => {
  const user = await mount();
  meta(extra);
  await palette(user, "Connect to local dev");
  await waitFor(() => expect(be.sent("pg_connect")).toHaveLength(1));
  return user;
};

const connected = () => connectedWith();

/** Expand public → Tables. */
const tables = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByText("public"));
  await user.click(await screen.findByText("Tables"));
  await screen.findByText("users");
};

describe("App — the explorer's table actions", () => {
  it("puts a SELECT for the table into the editor rather than running it", async () => {
    // Double-clicking a 4-billion-row table should not run anything. It writes
    // the query and leaves the decision with the user.
    const user = await connected();
    await tables(user);
    await user.dblClick(screen.getByText("users"));
    const ta = screen.getByRole("textbox", { name: /sql editor/i }) as HTMLTextAreaElement;
    await waitFor(() => expect(ta.value).toContain("users"));
    expect(be.sent("pg_query")).toHaveLength(0);
  });

  it("opens the details panel for a table", async () => {
    const user = await connectedWith({
      object_details: (req) => ({
        payload: {
          name: req.name,
          kind: "table",
          sections: [{ label: "Storage", rows: [{ k: "Total size", v: "12 MB" }] }],
        },
        cached: false,
      }),
    });
    await tables(user);
    await user.click(screen.getByTitle(/Details —/));
    expect(await screen.findByText("12 MB")).toBeInTheDocument();
  });
});

describe("App — partitions", () => {
  it("opens the partition overview for a partitioned table", async () => {
    const user = await connectedWith({
      list_objects: () => ({
        payload: [{ name: "events", kind: "table", isPartitioned: true, partitionCount: 3 }],
        cached: false,
      }),
      partition_overview: () => ({
        payload: {
          partitioned: true,
          strategy: "RANGE",
          partitionKey: "created_at",
          items: [
            {
              name: "events_2024",
              bounds: "FOR VALUES FROM ('2024-01-01') TO ('2025-01-01')",
              size: "1024 kB",
              rows: 10,
              rowsKnown: true,
              isPartitioned: false,
              partitionCount: 0,
            },
          ],
        },
        cached: false,
      }),
    });
    await user.click(await screen.findByText("public"));
    await user.click(await screen.findByText("Tables"));
    await screen.findByText("events");
    await user.click(screen.getByTitle(/3 direct partitions/));
    expect(await screen.findByText("events_2024")).toBeInTheDocument();
    expect(screen.getByText(/created_at/)).toBeInTheDocument();
  });

  it("shows why the overview could not be read", async () => {
    const user = await connectedWith({
      list_objects: () => ({
        payload: [{ name: "events", kind: "table", isPartitioned: true, partitionCount: 3 }],
        cached: false,
      }),
      partition_overview: () => {
        throw new Error("permission denied for table events");
      },
    });
    await user.click(await screen.findByText("public"));
    await user.click(await screen.findByText("Tables"));
    await screen.findByText("events");
    await user.click(screen.getByTitle(/3 direct partitions/));
    expect(await screen.findByText(/permission denied/)).toBeInTheDocument();
  });
});

describe("App — the palette knows the catalog", () => {
  it("offers a table it has loaded", async () => {
    const user = await connected();
    await tables(user);
    await user.keyboard("{Meta>}k{/Meta}");
    await user.type(await screen.findByPlaceholderText(/type a command/i), "users");
    expect((await screen.findAllByText(/public\.users/)).length).toBeGreaterThan(0);
  });

  it("offers a saved snippet, and loads it into the editor", async () => {
    be.on("snippet_list", () => [{ id: "s1", name: "recent signups", body: "select * from users", tags: null }]);
    const user = await mount();
    await palette(user, "recent signups");
    const ta = screen.getByRole("textbox", { name: /sql editor/i }) as HTMLTextAreaElement;
    await waitFor(() => expect(ta.value).toBe("select * from users"));
  });

  it("offers a recent statement from history", async () => {
    const user = await mount();
    await user.keyboard("{Meta>}k{/Meta}");
    await user.type(await screen.findByPlaceholderText(/type a command/i), "select 1");
    expect(await screen.findByText("select 1")).toBeInTheDocument();
  });
});

describe("App — the update toast", () => {
  it("says nothing when there is no update", async () => {
    await mount();
    expect(screen.queryByText(/update/i)).not.toBeInTheDocument();
  });

  /** An update the toast is offering. */
  const offered = async (install: () => Promise<void> = async () => {}) => {
    const { check } = await import("@tauri-apps/plugin-updater");
    vi.mocked(check).mockResolvedValue({
      version: "0.2.0",
      body: "fixes",
      downloadAndInstall: vi.fn(install),
    } as never);
    const user = await mount();
    const button = await screen.findByRole("button", { name: /restart|update|install/i });
    return { user, button };
  };

  it("installs the update it found, then relaunches", async () => {
    // The toast holds the update object it was offered rather than re-checking
    // on click: a second check can race and install a different build.
    const { relaunch } = await import("@tauri-apps/plugin-process");
    vi.mocked(relaunch).mockClear();
    const { user, button } = await offered();
    await user.click(button);
    await waitFor(() => expect(vi.mocked(relaunch)).toHaveBeenCalled());
  });

  it("un-sticks the button when the download fails", async () => {
    // Left on "Updating…", the only way out is to restart the app — for an
    // update that did not happen.
    const { user, button } = await offered(async () => {
      throw new Error("network unreachable");
    });
    await user.click(button);
    expect(await screen.findByText(/Update failed: .*network unreachable/)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /restart|update|install/i })).toBeEnabled();
  });

  it("says nothing when the check itself fails", async () => {
    // No endpoint, offline, or a dev build. None of that is the user's problem.
    const { check } = await import("@tauri-apps/plugin-updater");
    vi.mocked(check).mockRejectedValue(new Error("no releases endpoint"));
    await mount();
    expect(screen.queryByText(/0\.2\.0/)).not.toBeInTheDocument();
  });

  it("will not update out from under an open transaction", async () => {
    // Relaunching mid-transaction drops it. The prompt is the only warning.
    const { check } = await import("@tauri-apps/plugin-updater");
    vi.mocked(check).mockResolvedValue({
      version: "0.2.0",
      body: "fixes",
      downloadAndInstall: vi.fn(async () => {}),
    } as never);
    const user = await mount();
    meta();
    await palette(user, "Connect to local dev");
    await waitFor(() => expect(be.sent("pg_connect")).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: /begin transaction/i }));
    await screen.findByText(/in transaction/i);

    const update = await screen.findByRole("button", { name: /restart|update|install/i });
    await user.click(update);
    expect(await screen.findByText(/commit or roll back/i)).toBeInTheDocument();
  });
});
