import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
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
    vi.mocked(saveDialog).mockResolvedValue("/tmp/plan.json");
    const user = await connected();
    await explain(user);
    const modal = document.querySelector(".explain-modal") as HTMLElement;
    await user.click(within(modal).getByRole("button", { name: /^Export/ }));
    const menu = modal.querySelector(".drop-menu") as HTMLElement;
    await user.click(within(menu).getByRole("button", { name: "JSON .json" }));
    await waitFor(() => expect(vi.mocked(writeTextFile)).toHaveBeenCalled());
    const [path, body] = vi.mocked(writeTextFile).mock.calls[0];
    expect(path).toBe("/tmp/plan.json");
    expect(JSON.parse(String(body))[0].Plan["Node Type"]).toBe("Seq Scan");
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
