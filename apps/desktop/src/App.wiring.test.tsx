import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { CONNECTION, RESULT, backend, type Backend } from "./test/backend";

/** The chart tab, global search, the intel modal, and saving a password. */

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

/** Run whatever is in the editor and wait for the grid. */
const run = async (user: ReturnType<typeof userEvent.setup>, sql: string) => {
  const ta = screen.getByRole("textbox", { name: /sql editor/i });
  await user.click(ta);
  await user.clear(ta);
  await user.type(ta, sql);
  await user.click(screen.getByRole("button", { name: /^Run/ }));
  await waitFor(() => expect(be.sent("pg_query").length).toBeGreaterThan(0));
};

describe("App — the chart tab", () => {
  it("plots a label column against a numeric one", async () => {
    const user = await connected();
    await run(user, "select kind, n from t");
    await user.click(await screen.findByRole("button", { name: /^Chart$/i }));
    await waitFor(() => expect(document.querySelectorAll(".chart-row")).toHaveLength(2));
    const chart = document.querySelector(".chart-pane") as HTMLElement;
    expect(within(chart).getByText("13,109")).toBeInTheDocument();
  });

  it("says so rather than drawing an empty axis when nothing is plottable", async () => {
    // Two text columns have nothing to measure. A blank chart panel reads as
    // a bug; saying why is the honest answer.
    be.on("pg_query", () => ({
      ...RESULT,
      columns: [
        { name: "a", dbType: "text" },
        { name: "b", dbType: "text" },
      ],
    }));
    be.on("pg_rows", () => [["x", "y"]]);
    const user = await connected();
    await run(user, "select a, b from t");
    await user.click(await screen.findByRole("button", { name: /^Chart$/i }));
    expect(await screen.findByText(/Chart needs a result with one text column and one numeric column/i)).toBeInTheDocument();
  });

  it("does not chart an empty result", async () => {
    be.on("pg_query", () => ({ ...RESULT, storedRows: 0, totalRows: 0 }));
    be.on("pg_rows", () => []);
    const user = await connected();
    await run(user, "select kind, n from t where false");
    await user.click(await screen.findByRole("button", { name: /^Chart$/i }));
    expect(be.sent("pg_rows")).toHaveLength(0);
  });

  it("builds the chart once and keeps it while you switch tabs", async () => {
    // Re-fetching up to 100k rows because someone clicked back from the grid
    // would be a long pause for no new information.
    const user = await connected();
    await run(user, "select kind, n from t");
    await user.click(await screen.findByRole("button", { name: /^Chart$/i }));
    await waitFor(() => expect(document.querySelectorAll(".chart-row")).toHaveLength(2));
    // The chart reads in bulk; the grid reads a 200-row window. Only the bulk
    // read is the expensive one, and only it must not happen twice.
    const bulk = () => be.sent("pg_rows").filter((a) => (a.limit as number) > 200);
    expect(bulk()).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: /^Results$/i }));
    await user.click(screen.getByRole("button", { name: /^Chart$/i }));
    expect(bulk()).toHaveLength(1);
  });
});

describe("App — global search", () => {
  it("opens the details for the hit you pick", async () => {
    be.on("pg_metadata", (a) => {
      const req = a.request as Record<string, unknown>;
      if (req.kind === "search_objects") {
        return {
          payload: { items: [{ schema: "public", name: "users", kind: "table", column: "" }], truncated: false },
          cached: false,
        };
      }
      if (req.kind === "object_details") {
        return {
          payload: {
            name: "users",
            kind: "table",
            sections: [{ label: "Storage", rows: [{ k: "Total size", v: "1200 MB" }] }],
          },
          cached: false,
        };
      }
      if (req.kind === "list_schemas") return { payload: ["public"], cached: false };
      if (req.kind === "server_info") return { payload: { version: "PostgreSQL 18.0" }, cached: false };
      return { payload: [], cached: false };
    });
    const user = await connected();
    await user.keyboard("{Meta>}p{/Meta}");
    await user.type(await screen.findByPlaceholderText(/Table, view, sequence/i), "users");
    const hit = await waitFor(() => document.querySelector(".hit") as HTMLElement);
    await user.click(hit);
    expect(await screen.findByText("1200 MB")).toBeInTheDocument();
  });
});

describe("App — find usages & rename", () => {
  it("jumps to the tab a usage was found in", async () => {
    const user = await connected();
    await user.keyboard("{Meta>}t{/Meta}");
    await waitFor(() => expect(document.querySelectorAll(".qtab")).toHaveLength(2));
    await run(user, "select * from orders");
    await palette(user, "Find usages");
    const dialog = await waitFor(() => document.querySelector(".modal") as HTMLElement);
    await user.type(within(dialog).getAllByRole("textbox")[0], "orders");
    // The usage it finds is in the second tab — the one just written.
    expect(await within(dialog).findByText(/untitled-2/)).toBeInTheDocument();
  });
});

describe("App — the password", () => {
  /** Open the editor and type a password into it. */
  const typePassword = async (user: ReturnType<typeof userEvent.setup>, pw: string) => {
    await user.click(document.querySelector(".conn-open") as HTMLElement);
    await screen.findByRole("button", { name: /^Save & Connect$/ });
    const field = document.querySelector('input[type="password"]') as HTMLInputElement;
    await user.type(field, pw);
    return field;
  };

  it("puts a typed password in the keychain and connects with the reference", async () => {
    // The session never gets the password itself: it is handed over once, and
    // what travels with the connection is an opaque reference to it.
    const user = await mount();
    await typePassword(user, "hunter2");
    await user.click(screen.getByRole("button", { name: /^Save & Connect$/ }));
    await waitFor(() => expect(be.sent("pg_secret_save")).toHaveLength(1));
    expect(be.sent("pg_secret_save")[0]).toEqual({ password: "hunter2" });
    await waitFor(() => expect(be.sent("pg_connect")).toHaveLength(1));
    const params = be.sent("pg_connect")[0].params as Record<string, unknown>;
    expect(params.secretRef).toBe("ref-1");
    expect(JSON.stringify(params)).not.toContain("hunter2");
  });

  it("clears the typed password once the keychain has it", async () => {
    // Leaving it in the form means it is in the DOM, and it gets sent again on
    // the next connect — minting a second keychain entry for the same login.
    const user = await mount();
    const field = await typePassword(user, "hunter2");
    await user.click(screen.getByRole("button", { name: /^Save & Connect$/ }));
    await waitFor(() => expect(be.sent("pg_secret_save")).toHaveLength(1));
    await waitFor(() => expect(field.value).toBe(""));
  });

  it("does not touch the keychain when no new password was typed", async () => {
    // Reconnecting with a saved profile reuses the reference it already has.
    const user = await mount();
    await user.click(document.querySelector(".conn-open") as HTMLElement);
    await user.click(await screen.findByRole("button", { name: /^Save & Connect$/ }));
    await waitFor(() => expect(be.sent("pg_connect")).toHaveLength(1));
    expect(be.sent("pg_secret_save")).toHaveLength(0);
  });
});
