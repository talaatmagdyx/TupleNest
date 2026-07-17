import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ask } from "@tauri-apps/plugin-dialog";
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
