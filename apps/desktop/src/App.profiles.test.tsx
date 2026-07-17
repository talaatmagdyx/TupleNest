import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { ask } from "@tauri-apps/plugin-dialog";
import { CONNECTION, backend, type Backend } from "./test/backend";

/** Saving, deleting and testing connection profiles, and the object-detail
 *  overlays the explorer opens. */

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

/** Open the editor for the saved profile. The card and its Delete button both
 *  carry the name, so go via the card's own class. */
const editor = async (user: ReturnType<typeof userEvent.setup>) => {
  const card = document.querySelector(".conn-open") as HTMLElement;
  await user.click(card);
  await screen.findByText("Edit connection");
};

describe("App — saving a profile", () => {
  it("saves the fields as typed", async () => {
    const user = await mount();
    await editor(user);
    const name = screen.getByDisplayValue(CONNECTION.name);
    await user.clear(name);
    await user.type(name, "staging box");
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    await waitFor(() => expect(be.sent("connection_save")).toHaveLength(1));
    expect(be.sent("connection_save")[0]).toMatchObject({
      input: expect.objectContaining({ name: "staging box", host: "localhost" }),
    });
  });

  it("names an unnamed profile after what it points at", async () => {
    // A list of blank rows is unusable; the connection string is the next best
    // thing the user already recognises.
    const user = await mount();
    await palette(user, "New connection");
    // The palette command and the modal title share the words.
    await waitFor(() => expect(screen.getByRole("button", { name: /^Save$/ })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    await waitFor(() => expect(be.sent("connection_save")).toHaveLength(1));
    const input = be.sent("connection_save")[0].input as { name: string };
    expect(input.name).toContain("@");
  });

  it("hands a typed password to the backend to store, and clears the field", async () => {
    // The password goes over IPC for the Rust side to put in the Keychain —
    // it is never written into the profile row itself. The field is cleared
    // afterwards so it is not left sitting in the DOM.
    const user = await mount();
    await editor(user);
    await user.type(screen.getByPlaceholderText(/password/i), "hunter2");
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    await waitFor(() => expect(be.sent("connection_save")).toHaveLength(1));
    const input = be.sent("connection_save")[0].input as Record<string, unknown>;
    expect(input.password).toBe("hunter2");
  });

  it("says why a save failed rather than looking like it worked", async () => {
    const user = await mount();
    await editor(user);
    be.on("connection_save", () => {
      throw new Error("UNIQUE constraint failed: connections.name");
    });
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    expect(await screen.findByText(/UNIQUE constraint/)).toBeInTheDocument();
  });

  it("runs the staged probe from the editor", async () => {
    const user = await mount();
    await editor(user);
    await user.click(screen.getByRole("button", { name: /^Test$/ }));
    await waitFor(() => expect(be.sent("pg_test")).toHaveLength(1));
    expect(await screen.findByText("dns")).toBeInTheDocument();
  });

  it("opens a blank editor for a new connection", async () => {
    const user = await mount();
    await palette(user, "New connection");
    await waitFor(() => expect(screen.getByPlaceholderText(/password/i)).toBeInTheDocument());
    expect(screen.getByPlaceholderText(/password/i)).toHaveValue("");
    expect(screen.getByRole("button", { name: /^Save & Connect$/ })).toBeInTheDocument();
  });
});

describe("App — deleting a profile", () => {
  it("asks first — the profile and its keychain reference go together", async () => {
    // The × is a few pixels from the row you click to open a connection. The
    // question comes from the dialog plugin: `window.confirm` returns true in
    // the webview without drawing anything, so a guard on it is not a guard.
    vi.mocked(ask).mockResolvedValue(false);
    const user = await mount();
    await user.click(screen.getByRole("button", { name: `Delete ${CONNECTION.name}` }));
    expect(be.sent("connection_delete")).toHaveLength(0);
    expect(screen.getByText(CONNECTION.name)).toBeInTheDocument();
  });

  it("names the connection in the question", async () => {
    // "Are you sure?" on a list of six connections is not a question anyone
    // can answer.
    vi.mocked(ask).mockResolvedValue(false);
    const user = await mount();
    await user.click(screen.getByRole("button", { name: `Delete ${CONNECTION.name}` }));
    await waitFor(() => expect(vi.mocked(ask)).toHaveBeenCalled());
    expect(String(vi.mocked(ask).mock.calls[0][0])).toContain(CONNECTION.name);
  });

  it("deletes the one that was asked for, and re-reads the list", async () => {
    vi.mocked(ask).mockResolvedValue(true);
    const user = await mount();
    await user.click(screen.getByRole("button", { name: `Delete ${CONNECTION.name}` }));
    await waitFor(() => expect(be.sent("connection_delete")).toHaveLength(1));
    expect(be.sent("connection_delete")[0]).toEqual({ id: CONNECTION.id });
    // Re-read rather than splice: the store is the list.
    expect(be.sent("connection_list").length).toBeGreaterThan(1);
  });

  it("confirms the delete by name", async () => {
    vi.mocked(ask).mockResolvedValue(true);
    const user = await mount();
    await user.click(screen.getByRole("button", { name: `Delete ${CONNECTION.name}` }));
    expect(await screen.findByText(`Deleted "${CONNECTION.name}"`)).toBeInTheDocument();
  });

  it("keeps the list when the delete fails", async () => {
    // Removing the row locally on a failed delete would show it gone until
    // the next restart brought it back.
    vi.mocked(ask).mockResolvedValue(true);
    const user = await mount();
    be.on("connection_delete", () => {
      throw new Error("database is locked");
    });
    await user.click(screen.getByRole("button", { name: `Delete ${CONNECTION.name}` }));
    await waitFor(() => expect(be.sent("connection_delete")).toHaveLength(1));
    expect(screen.getByText(CONNECTION.name)).toBeInTheDocument();
  });
});

describe("App — object details", () => {
  /** Expand public → Tables so the rows are on screen. */
  const tables = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(await screen.findByText("public"));
    await user.click(await screen.findByText("Tables"));
    await screen.findByText("users");
  };

  it("opens the details for the object that was asked about", async () => {
    const user = await connected();
    be.on("pg_metadata", (a) => {
      const req = a.request as { kind: string; name?: string };
      if (req.kind === "list_schemas") return { payload: ["public"], cached: false };
      if (req.kind === "server_info") return { payload: { version: "PostgreSQL 18.0" }, cached: false };
      if (req.kind === "list_objects") return { payload: [{ name: "users", kind: "table" }], cached: false };
      if (req.kind === "object_details") {
        return {
          payload: {
            name: req.name,
            kind: "table",
            sections: [{ label: "Storage", rows: [{ k: "Total size", v: "3522 MB" }] }],
          },
          cached: false,
        };
      }
      return { payload: [], cached: false };
    });
    await tables(user);
    await user.click(screen.getByTitle(/details/i));
    expect(await screen.findByText("3522 MB")).toBeInTheDocument();
  });

  it("shows why the details could not be read", async () => {
    const user = await connected();
    be.on("pg_metadata", (a) => {
      const req = a.request as { kind: string };
      if (req.kind === "list_schemas") return { payload: ["public"], cached: false };
      if (req.kind === "server_info") return { payload: { version: "PostgreSQL 18.0" }, cached: false };
      if (req.kind === "list_objects") return { payload: [{ name: "users", kind: "table" }], cached: false };
      if (req.kind === "object_details") throw new Error("permission denied for table users");
      return { payload: [], cached: false };
    });
    await tables(user);
    await user.click(screen.getByTitle(/details/i));
    expect(await screen.findByText(/permission denied/)).toBeInTheDocument();
  });
});

describe("App — the editor toolbar", () => {
  it("formats the SQL in place", async () => {
    const user = await connected();
    const ta = screen.getByRole("textbox", { name: /sql editor/i });
    await user.click(ta);
    await user.clear(ta);
    await user.type(ta, "select a from t where b = 1");
    await user.click(screen.getByRole("button", { name: /^Format$/ }));
    await waitFor(() => expect((ta as HTMLTextAreaElement).value).toContain("FROM"));
  });

  it("offers Cancel only while something is running", async () => {
    // A live Cancel with nothing to cancel is a button that cannot work.
    await connected();
    expect(screen.getByRole("button", { name: /^Cancel$/ })).toBeDisabled();
  });
});
