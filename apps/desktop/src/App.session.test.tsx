import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ask } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import App from "./App";
import { CONNECTION, backend, type Backend } from "./test/backend";

/** Save & Connect, the offline catalog, and the disconnect guard. */

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

const editor = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(document.querySelector(".conn-open") as HTMLElement);
  await screen.findByText("Edit connection");
};

describe("App — Save & Connect", () => {
  it("saves before connecting, so a working connection is kept", async () => {
    // Connecting without saving means a profile you got working is gone the
    // moment the window closes.
    const user = await mount();
    await editor(user);
    await user.click(screen.getByRole("button", { name: /^Save & Connect$/ }));
    await waitFor(() => expect(be.sent("pg_connect")).toHaveLength(1));
    expect(be.sent("connection_save")).toHaveLength(1);
  });

  it("does not connect when the save fails", async () => {
    // The profile is the thing being connected. If it did not save, connecting
    // would open a session for something that no longer exists on disk.
    const user = await mount();
    await editor(user);
    be.on("connection_save", () => {
      throw new Error("UNIQUE constraint failed: connections.name");
    });
    await user.click(screen.getByRole("button", { name: /^Save & Connect$/ }));
    expect(await screen.findByText(/UNIQUE constraint/)).toBeInTheDocument();
    expect(be.sent("pg_connect")).toHaveLength(0);
  });

  it("closes the editor once it is connected", async () => {
    const user = await mount();
    await editor(user);
    await user.click(screen.getByRole("button", { name: /^Save & Connect$/ }));
    await waitFor(() => expect(screen.queryByText("Edit connection")).not.toBeInTheDocument());
  });
});

describe("App — the catalog while offline", () => {
  it("reads the cache rather than the server when there is no session", async () => {
    // The tree is worth having offline. `pg_metadata` needs a live session;
    // `pg_metadata_cached` takes the connection params and reads the local copy.
    const user = await mount();
    be.on("pg_metadata_cached", () => ({ payload: ["public"], cached: true }));
    await editor(user);
    const dialog = screen.getByText("Edit connection").closest(".modal") as HTMLElement;
    // The toolbar has a Cancel too — that one cancels a running query.
    await user.click(within(dialog).getByRole("button", { name: /^Cancel$/ }));
    expect(be.sent("pg_metadata")).toHaveLength(0);
  });

  it("sends no secret to the cache — it is a local read", async () => {
    // The cached path takes connection params only to key the lookup. Passing
    // a keychain reference to it would be handing out a credential for nothing.
    const user = await connected();
    await palette(user, "Disconnect");
    await waitFor(() => expect(be.sent("pg_disconnect")).toHaveLength(2));
    const cached = be.sent("pg_metadata_cached");
    expect(cached.length).toBeGreaterThan(0);
    expect((cached[0].params as { secretRef: unknown }).secretRef).toBeNull();
  });
});

describe("App — disconnecting", () => {
  it("closes the session and empties the tree", async () => {
    // A tree left on screen after disconnect describes a database nobody is
    // connected to.
    const user = await connected();
    expect(await screen.findByText("public")).toBeInTheDocument();
    await palette(user, "Disconnect");
    await waitFor(() => expect(screen.getAllByText("Not connected").length).toBeGreaterThan(0));
    expect(screen.queryByText("public")).not.toBeInTheDocument();
  });

  it("drops the result with the session", async () => {
    // The rows live in the backend's store, which the disconnect just closed.
    // Leaving the grid up offers scrolling into rows that are gone.
    const user = await connected();
    const ta = screen.getByRole("textbox", { name: /sql editor/i });
    await user.click(ta);
    await user.clear(ta);
    await user.type(ta, "select kind, n from t");
    await user.click(screen.getByRole("button", { name: /^Run/ }));
    await waitFor(() => expect(be.sent("pg_query")).toHaveLength(1));
    await palette(user, "Disconnect");
    await waitFor(() => expect(screen.getAllByText("Not connected").length).toBeGreaterThan(0));
  });
});

describe("App — an empty workspace", () => {
  it("offers a way in when there are no connections at all", async () => {
    // A first run with an empty sidebar and no prompt is a dead end.
    be.on("connection_list", () => []);
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByText(/no connections yet/i)).toBeInTheDocument();
    // The empty state's own button, not the sidebar's "+" in the header.
    const empty = document.querySelector(".conn-empty") as HTMLElement;
    await user.click(within(empty).getByRole("button"));
    expect(await screen.findByRole("button", { name: /^Save & Connect$/ })).toBeInTheDocument();
  });
});

describe("App — the history panel", () => {
  it("clears the history from the rail, keeping favourites", async () => {
    const user = await mount();
    await user.click(screen.getByTitle("Query history"));
    await user.click(await screen.findByRole("button", { name: /^Clear$/ }));
    await waitFor(() => expect(be.sent("history_clear")).toHaveLength(1));
    expect(be.sent("history_clear")[0]).toEqual({ includeFavorites: false });
    expect(await screen.findByText(/favorites kept/i)).toBeInTheDocument();
  });

  it("stars an entry, and asks the store rather than flipping locally", async () => {
    const user = await mount();
    await user.click(screen.getByTitle("Query history"));
    await screen.findByText("select 1");
    await user.click(screen.getByTitle("Favorite"));
    await waitFor(() => expect(be.sent("history_favorite")).toHaveLength(1));
    // The value is carried through, not toggled blind from a local copy.
    expect(be.sent("history_favorite")[0]).toEqual({ id: "h1", favorite: true });
  });
});

describe("App — deleting the connected profile", () => {
  it("forgets the profile the session belongs to", async () => {
    // Deleting the profile you are connected through leaves the session
    // pointing at a row that no longer exists.
    vi.mocked(ask).mockResolvedValue(true);
    const user = await connected();
    await user.click(screen.getByRole("button", { name: `Delete ${CONNECTION.name}` }));
    await waitFor(() => expect(be.sent("connection_delete")).toHaveLength(1));
  });
});

// Audit TN-024. The UI's transaction flag follows only the Begin button. A
// BEGIN typed in the editor was invisible to every way of leaving the session
// except closing the window.
describe("App — a transaction opened by typing BEGIN", () => {
  const typedBegin = () => be.on("pg_in_transaction", () => true);

  it("is asked about before Disconnect drops the session", async () => {
    const user = await connected();
    typedBegin();
    const before = be.sent("pg_disconnect").length;
    await palette(user, "Disconnect");
    expect(await screen.findByText(/open transaction|uncommitted/i)).toBeInTheDocument();
    expect(be.sent("pg_in_transaction").length).toBeGreaterThan(0);
    expect(be.sent("pg_disconnect")).toHaveLength(before);
  });

  it("is asked about before the connection switcher replaces the session", async () => {
    const user = await connected();
    typedBegin();
    await palette(user, "Connect to prod db");
    expect(await screen.findByText(/open transaction|uncommitted/i)).toBeInTheDocument();
    expect(be.sent("pg_connect")).toHaveLength(1);
  });

  it("holds an update back", async () => {
    const { check } = await import("@tauri-apps/plugin-updater");
    const downloadAndInstall = vi.fn();
    vi.mocked(check).mockResolvedValue({ version: "0.2.0", body: "fixes", downloadAndInstall } as never);
    const user = await connected();
    typedBegin();
    const toast = (await waitFor(() => {
      const t = document.querySelector(".update-toast");
      expect(t).not.toBeNull();
      return t;
    })) as HTMLElement;
    await user.click(within(toast).getByRole("button", { name: /restart|update|install/i }));
    expect(await screen.findByText(/Commit or roll back your transaction before updating/)).toBeInTheDocument();
    expect(downloadAndInstall).not.toHaveBeenCalled();
  });

  it("does not get in the way when there is no transaction", async () => {
    const user = await connected();
    const before = be.sent("pg_disconnect").length;
    await palette(user, "Disconnect");
    await waitFor(() => expect(be.sent("pg_disconnect").length).toBeGreaterThan(before));
    expect(screen.queryByText(/open transaction|uncommitted/i)).not.toBeInTheDocument();
  });

  it("lets the session go when the server cannot even be asked", async () => {
    // The check failing means the session is already gone; there is nothing
    // left to protect, and refusing to disconnect would trap the user.
    const user = await connected();
    be.on("pg_in_transaction", () => {
      throw new Error("connection closed");
    });
    const before = be.sent("pg_disconnect").length;
    await palette(user, "Disconnect");
    await waitFor(() => expect(be.sent("pg_disconnect").length).toBeGreaterThan(before));
  });
});

// Audit P3: a killed backend used to go unnoticed until the next statement.
describe("App — the server ends the session while the window is idle", () => {
  const LOST_EVENT =
    "Connection lost: the server ended this session (an administrator terminated it, or the server is " +
    "shutting down): terminating connection due to administrator command [SQLSTATE 57P01] — the session " +
    "was closed. Reconnect to continue; nothing was re-run.";

  /** What pg.rs emits; delivered to whatever App registered. */
  const serverEndsSession = async (generation: number) => {
    const calls = vi.mocked(listen).mock.calls.filter(([name]) => name === "pg:connection-lost");
    expect(calls.length).toBeGreaterThan(0);
    const cb = calls[calls.length - 1][1] as (e: unknown) => void;
    await act(async () =>
      cb({ event: "pg:connection-lost", id: 1, payload: { generation, message: LOST_EVENT, sqlstate: "57P01" } }),
    );
  };

  it("shows the connection as lost, with Reconnect, without running anything", async () => {
    be.on("pg_connect", () => ({ environment: "dev", readOnly: false, generation: 5 }));
    const user = await connected();
    const sentBefore = be.calls().length;
    await serverEndsSession(5);
    const dialog = (await screen.findByRole("button", { name: "Reconnect" })).closest(".connlost") as HTMLElement;
    expect(within(dialog).getByText(/terminating connection due to administrator command/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/rolled back by the server/)).not.toBeInTheDocument();
    expect(screen.getAllByText("Not connected").length).toBeGreaterThan(0);
    // No query was sent to find out, and nothing was disconnected: the backend
    // already closed the slot.
    expect(be.calls().slice(sentBefore)).not.toContain("pg_query");
    expect(be.calls().slice(sentBefore)).not.toContain("pg_disconnect");
    await user.click(within(dialog).getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(be.sent("pg_connect")).toHaveLength(2));
  });

  it("says the open transaction was rolled back, and drops the transaction", async () => {
    be.on("pg_connect", () => ({ environment: "dev", readOnly: false, generation: 6 }));
    const user = await connected();
    await user.click(screen.getByRole("button", { name: /begin transaction/i }));
    await screen.findByText("IN TRANSACTION");
    await serverEndsSession(6);
    expect(await screen.findByText(/open transaction was rolled back by the server/)).toBeInTheDocument();
    expect(screen.queryByText("IN TRANSACTION")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Commit" })).not.toBeInTheDocument();
  });

  it("stays quiet about a session the user disconnected", async () => {
    be.on("pg_connect", () => ({ environment: "dev", readOnly: false, generation: 7 }));
    const user = await connected();
    const before = be.sent("pg_disconnect").length;
    await palette(user, "Disconnect");
    await waitFor(() => expect(be.sent("pg_disconnect").length).toBeGreaterThan(before));
    await serverEndsSession(7);
    expect(screen.queryByRole("button", { name: "Reconnect" })).not.toBeInTheDocument();
  });
});
