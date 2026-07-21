import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { CONNECTION, PLAN, backend, type Backend } from "./test/backend";

/** Keyboard shortcuts, the transaction close prompt, and plan export. */

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
  const ta = screen.getByRole("textbox", { name: /sql editor/i });
  await user.click(ta);
  await user.clear(ta);
  await user.type(ta, sql);
};

describe("App — keyboard shortcuts", () => {
  it("runs the query on ⌘↵", async () => {
    const user = await connected();
    await type(user, "select 1");
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    await waitFor(() => expect(be.sent("pg_query")).toHaveLength(1));
  });

  it("formats on ⌘⇧F", async () => {
    const user = await connected();
    await type(user, "select a from t");
    await user.keyboard("{Meta>}{Shift>}f{/Shift}{/Meta}");
    const ta = screen.getByRole("textbox", { name: /sql editor/i }) as HTMLTextAreaElement;
    await waitFor(() => expect(ta.value).toContain("FROM"));
  });

  it("opens a new tab on ⌘T", async () => {
    const user = await mount();
    await user.keyboard("{Meta>}t{/Meta}");
    expect(await screen.findByText("untitled-2.sql")).toBeInTheDocument();
  });

  it("toggles the theme on ⌘⇧L", async () => {
    const user = await mount();
    await user.keyboard("{Meta>}{Shift>}l{/Shift}{/Meta}");
    await waitFor(() => expect(document.documentElement.getAttribute("data-tn-theme")).toBe("light"));
  });

  it("collapses the sidebar on ⌘B", async () => {
    // It stays mounted at zero width: unmounting would drop the tree's state
    // and re-fetch 13,000 relations on every toggle.
    const user = await mount();
    expect(document.querySelector(".sidebar")).not.toHaveClass("collapsed");
    await user.keyboard("{Meta>}b{/Meta}");
    await waitFor(() => expect(document.querySelector(".sidebar")).toHaveClass("collapsed"));
  });
});

describe("App — closing a transaction from the prompt", () => {
  const openTx = async () => {
    const user = await connected();
    await user.click(screen.getByRole("button", { name: /begin transaction/i }));
    await screen.findByText(/in transaction/i);
    await palette(user, "Disconnect");
    await screen.findByText(/you have an open transaction/i);
    return user;
  };

  it("commits and then disconnects", async () => {
    const user = await openTx();
    const dialog = screen.getByText(/you have an open transaction/i).closest(".modal") as HTMLElement;
    await user.click(within(dialog).getByRole("button", { name: /commit/i }));
    await waitFor(() => expect(be.sent("pg_commit")).toHaveLength(1));
    await waitFor(() => expect(screen.getAllByText("Not connected").length).toBeGreaterThan(0));
  });

  it("rolls back and then disconnects", async () => {
    const user = await openTx();
    const dialog = screen.getByText(/you have an open transaction/i).closest(".modal") as HTMLElement;
    await user.click(within(dialog).getByRole("button", { name: /roll ?back/i }));
    await waitFor(() => expect(be.sent("pg_rollback")).toHaveLength(1));
    await waitFor(() => expect(screen.getAllByText("Not connected").length).toBeGreaterThan(0));
  });

  it("stays connected when the commit fails — the work is still open", async () => {
    // Disconnecting on a failed commit abandons the transaction silently.
    const user = await openTx();
    be.on("pg_commit", () => {
      throw new Error("could not serialize access due to concurrent update");
    });
    const dialog = screen.getByText(/you have an open transaction/i).closest(".modal") as HTMLElement;
    await user.click(within(dialog).getByRole("button", { name: /commit/i }));
    await waitFor(() => expect(be.sent("pg_commit")).toHaveLength(1));
    expect(be.sent("pg_disconnect")).toHaveLength(1); // only the one from connecting
    expect(await screen.findByText(/commit error/i)).toBeInTheDocument();
  });
});

describe("App — exporting a plan", () => {
  const explain = async (user: ReturnType<typeof userEvent.setup>) => {
    be.on("pg_query", () => ({
      columns: [{ name: "QUERY PLAN", dbType: "json" }],
      totalRows: 1,
      storedRows: 1,
      truncated: false,
      rowsAffected: null,
    }));
    be.on("pg_rows", () => [[JSON.stringify(PLAN)]]);
    await type(user, "select * from pg_class");
    await user.click(screen.getByRole("button", { name: /^Explain$/ }));
    await screen.findAllByText(/Seq Scan on pg_class/);
  };

  it("writes the raw JSON, which is what pev2 and depesz read", async () => {
    const user = await connected();
    await explain(user);
    const modal = document.querySelector(".explain-modal") as HTMLElement;
    await user.click(within(modal).getByRole("button", { name: /^Export/ }));
    const menu = modal.querySelector(".drop-menu") as HTMLElement;
    await user.click(within(menu).getByRole("button", { name: "JSON .json" }));
    await waitFor(() => expect(be.sent("export_save")).toHaveLength(1));
    const args = be.sent("export_save")[0] as { contents: string; extensions: string[] };
    expect(args.extensions).toEqual(["json"]);
    expect(JSON.parse(args.contents)[0].Plan["Node Type"]).toBe("Seq Scan");
  });

  it("copies the plan to the clipboard", async () => {
    // setup.ts installs a configurable clipboard stub; spy on that rather than
    // reassigning the property.
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const user = await connected();
    await explain(user);
    const modal = document.querySelector(".explain-modal") as HTMLElement;
    await user.click(within(modal).getByRole("button", { name: /^Export/ }));
    const menu = modal.querySelector(".drop-menu") as HTMLElement;
    await user.click(within(menu).getByRole("button", { name: /JSON for pev2/ }));
    await waitFor(() => expect(write).toHaveBeenCalled());
    expect(String(write.mock.calls[0][0])).toContain("Seq Scan");
  });
});

/* The cheatsheet and the key handler used to be two hand-written lists of the
   same thing, and they drifted: the app bound ⌘⇧L, ⌘O, ⌘B and ⌘P while the
   screen whose job is naming the keys mentioned none of them. They now share
   lib/shortcuts. The risk left is someone adding a binding straight into the
   handler, where the cheatsheet would never hear about it — so this reads the
   source and says no. */
describe("App — the cheatsheet opens and closes", () => {
  it("opens on ? and closes on Escape", async () => {
    // Both halves matter: ? is the only way in, and an overlay that will not
    // close on Escape traps a keyboard user in it.
    //
    // Which layer does the closing: `Overlay` handles Escape itself and stops
    // propagation, so this still passes with App's own escape case removed.
    // The case is not dead — it cancels a running query and closes the
    // connection and export menus when no overlay is open — but the overlay
    // half of it is belt and braces, and this test does not prove it.
    const user = await connected();
    await user.click(screen.getByRole("textbox", { name: /sql editor/i }));
    await user.click(document.body);
    await user.keyboard("?");
    await waitFor(() => expect(screen.getByText("Keyboard shortcuts")).toBeInTheDocument());

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByText("Keyboard shortcuts")).not.toBeInTheDocument());
  });

  it("does not open while typing, because ? is an ordinary character", async () => {
    const user = await connected();
    await type(user, "select '?'");
    expect(screen.queryByText("Keyboard shortcuts")).not.toBeInTheDocument();
  });
});

describe("App — one list of shortcuts, not two", () => {
  it("compares no keys of its own; matching belongs to lib/shortcuts", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    // vitest runs with apps/desktop as the working directory.
    const src = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");

    // Anything of the shape `e.key === "x"` or `event.key.toLowerCase() === …`
    // inside App means a binding that lib/shortcuts does not know about.
    const strays = [...src.matchAll(/\w+\.key(?:\.toLowerCase\(\))?\s*===/g)];
    expect(
      strays.map((m) => src.slice(Math.max(0, m.index - 40), m.index + 40)),
      "add the binding to lib/shortcuts instead, so the cheatsheet shows it",
    ).toEqual([]);
  });

  it("shows every binding on the cheatsheet, including the ones it used to omit", async () => {
    const { SHORTCUTS } = await import("./lib/shortcuts");
    const ids = SHORTCUTS.map((s) => s.id);
    // The four the old hand-written list forgot.
    expect(ids).toEqual(expect.arrayContaining(["theme", "openConnection", "toggleExplorer", "search"]));
  });
});
