import { beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { CONNECTION, backend, type Backend } from "./test/backend";

/**
 * The overlays, driven through the command palette.
 *
 * Each is its own modal with its own tests; what is being checked here is the
 * wiring — that the command opens the right one, that it is given what it
 * needs, and that closing it puts things back.
 */

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

describe("App — overlays that need no connection", () => {
  it("opens the settings panel", async () => {
    const user = await mount();
    await palette(user, "Open settings");
    expect(await screen.findByText(/appearance|theme/i)).toBeInTheDocument();
  });

  it("stores a telemetry change rather than only ticking the box", async () => {
    const user = await mount();
    await palette(user, "Open settings");
    const box = await screen.findByRole("switch", { name: /telemetry/i });
    expect(box).toHaveAttribute("aria-checked", "false");
    await user.click(box);
    await waitFor(() => expect(be.sent("settings_set")).toContainEqual({ key: "telemetry", value: true }));
  });

  it("opens the import wizard", async () => {
    const user = await mount();
    await palette(user, "Import CSV");
    expect((await screen.findAllByText(/csv/i)).length).toBeGreaterThan(0);
  });

  // Three palette commands open one modal. Asserting only that the modal is
  // there passed even when every command dumped the user on find-usages, which
  // is what "Compare schemas…" actually did until it was caught by hand. The
  // assertion is on the *selected* pane.
  it("opens find-usages on the find-usages pane", async () => {
    const user = await mount();
    await palette(user, "Find usages");
    expect(await screen.findByPlaceholderText(/Identifier — table, column/)).toBeInTheDocument();
  });

  it("opens Compare schemas on the schema-diff pane", async () => {
    const user = await mount();
    await palette(user, "Compare schemas");
    expect(await screen.findByText(/Pick two different schemas/)).toBeInTheDocument();
  });

  it("opens Compare EXPLAIN plans on the plan-compare pane", async () => {
    const user = await mount();
    await palette(user, "Compare EXPLAIN plans");
    expect(await screen.findByRole("button", { name: /Plan compare/ })).toHaveClass("on");
  });

  it("closes an overlay again", async () => {
    const user = await mount();
    await palette(user, "Open settings");
    await screen.findByRole("button", { name: "Close" });
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument());
  });
});

describe("App — overlays that need a session", () => {
  it("does not offer the server monitor while disconnected", async () => {
    // Every one of these reads live server state. Offering them with no
    // session is a command that can only fail.
    const user = await mount();
    await user.keyboard("{Meta>}k{/Meta}");
    await user.type(await screen.findByPlaceholderText(/type a command/i), "Server monitor");
    expect(screen.queryByText(/Server monitor \(sessions/)).not.toBeInTheDocument();
  });

  it("opens the server monitor once connected", async () => {
    // This used to stub `pg_admin_sessions` and `pg_admin_locks` — neither of
    // which exists. The real command is `pg_activity`, so the modal threw while
    // rendering and the assertion passed on the word "sessions" in the tab
    // behind it. It is in the fake backend now.
    const user = await connected();
    await palette(user, "Server monitor");
    await waitFor(() => expect(be.sent("pg_activity").length).toBeGreaterThan(0));
    expect(await screen.findByText(/No other sessions/i)).toBeInTheDocument();
  });

  it("re-reads the catalog after an import instead of stranding the explorer", async () => {
    // An import can create a table, so the tree has to be re-read. It used to
    // only be *dropped*: `schemas` went null and nothing re-fetched it, so the
    // explorer sat on "Loading schemas…" forever and every schema picker in the
    // app — Schema diff included — came up empty. Found by hand on a real
    // 250k-row import, not by a test.
    const user = await connected();
    const listSchemas = () =>
      be.sent("pg_metadata").filter((a) => (a.request as { kind: string }).kind === "list_schemas").length;
    const before = listSchemas();

    await palette(user, "Import CSV");
    const text = "id,name\n1,Ada\n";
    const file = new File([text], "people.csv", { type: "text/csv" });
    Object.defineProperty(file, "text", { value: async () => text, configurable: true });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => {
      fireEvent.change(input);
    });
    await user.click(await screen.findByRole("button", { name: /Import 1 row/ }));

    await waitFor(() => expect(listSchemas()).toBeGreaterThan(before));
    expect(screen.queryByText(/Loading schemas/)).not.toBeInTheDocument();
  });

  it("opens the ER diagram", async () => {
    const user = await connected();
    be.on("pg_metadata", (a) => {
      const req = a.request as { kind: string };
      if (req.kind === "list_schemas") return { payload: ["public"], cached: false };
      if (req.kind === "server_info") return { payload: { version: "PostgreSQL 18.0" }, cached: false };
      if (req.kind === "fk_graph") return { payload: { nodes: [], edges: [] }, cached: false };
      return { payload: [], cached: false };
    });
    be.on("pg_relationships", () => []);
    await palette(user, "ER diagram");
    expect((await screen.findAllByText(/relationships/i)).length).toBeGreaterThan(0);
  });

  it("opens index health", async () => {
    const user = await connected();
    be.on("pg_metadata", (a) => {
      const req = a.request as { kind: string };
      if (req.kind === "list_schemas") return { payload: ["public"], cached: false };
      if (req.kind === "server_info") return { payload: { version: "PostgreSQL 18.0" }, cached: false };
      if (req.kind === "index_health") {
        return { payload: { totalBytes: 0, totalCount: 0, rows: [] }, cached: false };
      }
      return { payload: [], cached: false };
    });
    await palette(user, "Index health");
    expect(await screen.findByRole("button", { name: /indexes/i })).toBeInTheDocument();
  });

  it("opens global search", async () => {
    const user = await connected();
    await palette(user, "Find anything");
    expect(await screen.findByPlaceholderText(/sequence, index or column/i)).toBeInTheDocument();
  });

  it("opens the prod audit log only on production", async () => {
    // The audit log is the record of what was run against prod. On dev there
    // is nothing to audit, so the command is not offered.
    const user = await connected();
    await user.keyboard("{Meta>}k{/Meta}");
    await user.type(await screen.findByPlaceholderText(/type a command/i), "Prod audit");
    expect(screen.queryByText("Prod audit log")).not.toBeInTheDocument();
  });
});
