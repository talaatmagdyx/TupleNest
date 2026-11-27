import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { CONNECTION, backend, type Backend } from "./test/backend";
import type { ConnectionRecord } from "./ipc/types";

/** A SQLite session: what is offered, what is hidden and why, and what is
 *  sent to the backend. */

const LITE = {
  ...CONNECTION,
  id: "s1",
  name: "local file",
  engine: "sqlite",
  host: "",
  port: 0,
  username: "",
  database: "/data/app.db",
  tlsMode: "disabled",
} as unknown as ConnectionRecord;

let be: Backend;
beforeEach(() => {
  be = backend();
  be.on("connection_list", () => [CONNECTION, LITE]);
  be.on("pg_connect", () => ({ engine: "sqlite", environment: "dev", generation: 1 }));
});

const mount = async () => {
  const user = userEvent.setup();
  render(<App />);
  await screen.findAllByText(LITE.name);
  return user;
};

const openPalette = async (user: ReturnType<typeof userEvent.setup>, term: string) => {
  await user.keyboard("{Meta>}k{/Meta}");
  await user.type(await screen.findByPlaceholderText(/type a command/i), term);
};

const palette = async (user: ReturnType<typeof userEvent.setup>, term: string) => {
  await openPalette(user, term);
  await user.keyboard("{Enter}");
};

const connectLite = async () => {
  const user = await mount();
  await palette(user, `Connect to ${LITE.name}`);
  await waitFor(() => expect(be.sent("pg_connect")).toHaveLength(1));
  return user;
};

describe("App — SQLite", () => {
  it("shows SQLite profiles with their badge and file", async () => {
    await mount();
    const card = screen.getAllByText(LITE.name)[0].closest(".conn-card") as HTMLElement;
    expect(within(card).getByText("SQ")).toBeInTheDocument();
    expect(within(card).getByText("/data/app.db")).toBeInTheDocument();
  });

  it("connects with the engine and the file, and nothing about a server", async () => {
    await connectLite();
    const params = be.sent("pg_connect")[0].params as Record<string, unknown>;
    expect(params.engine).toBe("sqlite");
    expect(params.database).toBe("/data/app.db");
    // The title-bar pill names the engine.
    const pill = document.querySelector(".conn-switch .engine-pill");
    expect(pill?.textContent).toBe("SQ");
  });

  it("hides the PostgreSQL-only commands, and says why the monitor is off", async () => {
    const user = await connectLite();
    await openPalette(user, "Server monitor");
    expect(screen.queryByText("Server monitor (sessions & locks)")).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    for (const term of ["Index health", "Vacuum", "Top queries", "Compare schemas", "Compare EXPLAIN", "Import CSV"]) {
      await openPalette(user, term);
      // Anchored: the palette's "Ask the assistant: “…”" entry quotes the term.
      expect(screen.queryByText(new RegExp(`^${term}`)), term).not.toBeInTheDocument();
      await user.keyboard("{Escape}");
    }
    const rail = screen.getByTitle(/^Server monitor — SQLite has no server/);
    expect(rail).toBeDisabled();
    // What does work on SQLite is still offered.
    await openPalette(user, "ER diagram");
    expect(screen.getByText("ER diagram (relationships)")).toBeInTheDocument();
  });

  it("explains with EXPLAIN QUERY PLAN, as rows in the grid", async () => {
    const user = await connectLite();
    await palette(user, "Show EXPLAIN plan");
    await waitFor(() =>
      expect(be.sent("pg_query").map((a) => a.sql)).toContain("EXPLAIN QUERY PLAN select now(), version()"),
    );
    // Not the PostgreSQL plan view: nothing was run detached.
    expect(be.sent("pg_query").some((a) => a.detached)).toBe(false);
  });

  it("saves a new SQLite profile from the engine picker", async () => {
    const user = await mount();
    await palette(user, "New connection");
    const picker = within(await screen.findByRole("group", { name: "Database engine" }));
    await user.click(picker.getByRole("button", { name: /SQLite/ }));
    await user.type(screen.getByLabelText("Database file"), "/data/new.db");
    await user.click(screen.getByRole("switch", { name: "Create a new file" }));
    be.on("sqlite_choose_file", () => "/data/picked.db");
    await user.click(screen.getByRole("button", { name: "Choose…" }));
    await waitFor(() => expect(screen.getByLabelText("Database file")).toHaveValue("/data/picked.db"));
    // A new file is chosen with the save panel.
    expect(be.sent("sqlite_choose_file")[0]).toEqual({ create: true });
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    await waitFor(() => expect(be.sent("connection_save")).toHaveLength(1));
    const input = be.sent("connection_save")[0].input as Record<string, unknown>;
    expect(input.engine).toBe("sqlite");
    expect(input.database).toBe("/data/picked.db");
    expect(input.name).toBe("picked.db");
    expect(input.password).toBeNull();
  });

  it("a PostgreSQL session still has every panel", async () => {
    be.on("pg_connect", () => ({ engine: "postgres", environment: "dev", generation: 1 }));
    const user = await mount();
    await palette(user, `Connect to ${CONNECTION.name}`);
    await waitFor(() => expect(be.sent("pg_connect")).toHaveLength(1));
    await openPalette(user, "Server monitor");
    expect(screen.getByText("Server monitor (sessions & locks)")).toBeInTheDocument();
  });
});
