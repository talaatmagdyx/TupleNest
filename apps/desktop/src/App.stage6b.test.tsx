import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { CONNECTION, backend, type Backend } from "./test/backend";

/**
 * The stage 6b pages, as App wires them: opened from the palette, drawn in
 * place of the editor, and closed back to it with the editor as it was.
 */

let be: Backend;
beforeEach(() => {
  be = backend();
});

const mount = async () => {
  const user = userEvent.setup();
  render(<App />);
  await screen.findAllByText(CONNECTION.name);
  return user;
};

const palette = async (user: ReturnType<typeof userEvent.setup>, term: string) => {
  await user.keyboard("{Meta>}k{/Meta}");
  await user.type(await screen.findByPlaceholderText(/type a command/i), term);
  await user.keyboard("{Enter}");
};

describe("App — first run", () => {
  it("opens what's new again from About", async () => {
    const user = await mount();
    await palette(user, "About TupleNest");
    await user.click(await screen.findByRole("button", { name: "What's new" }));
    expect(await screen.findByRole("dialog", { name: "What's new" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Got it" }));
    expect(screen.queryByRole("dialog", { name: "What's new" })).not.toBeInTheDocument();
  });

  it("opens the tour again from About", async () => {
    const user = await mount();
    await palette(user, "About TupleNest");
    await user.click(await screen.findByRole("button", { name: "Show the welcome tour" }));
    expect(await screen.findByText("STEP 1 OF 3")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Skip the tour" }));
    expect(screen.queryByText("STEP 1 OF 3")).not.toBeInTheDocument();
  });

  it("shows the tour on a first launch, with nothing saved yet", async () => {
    be.on("settings_get", () => null);
    be.on("connection_list", () => []);
    render(<App />);
    expect(await screen.findByText("STEP 1 OF 3")).toBeInTheDocument();
  });
});

describe("App — pages", () => {
  it("opens dashboards in place of the editor and goes back", async () => {
    const user = await mount();
    await palette(user, "Open dashboards");
    expect(await screen.findByRole("region", { name: "Dashboards" })).toBeInTheDocument();
    expect(await screen.findByText("No dashboards yet")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Back to the editor/ }));
    expect(screen.queryByRole("region", { name: "Dashboards" })).not.toBeInTheDocument();
  });

  it("opens dashboards and notebooks from the rail, and the same button closes them", async () => {
    const user = await mount();
    await user.click(screen.getByRole("button", { name: "Dashboards" }));
    expect(await screen.findByRole("region", { name: "Dashboards" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Notebooks" }));
    expect(await screen.findByRole("region", { name: "Notebooks" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Dashboards" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Notebooks" }));
    expect(screen.queryByRole("region", { name: "Notebooks" })).not.toBeInTheDocument();
  });

  it("opens notebooks", async () => {
    const user = await mount();
    await palette(user, "Open notebooks");
    expect(await screen.findByRole("region", { name: "Notebooks" })).toBeInTheDocument();
    expect(await screen.findByText("No notebooks yet")).toBeInTheDocument();
  });

  it("opens backup and restore from the palette", async () => {
    const user = await mount();
    await palette(user, "Backup and restore");
    expect(await screen.findByRole("region", { name: "Backup and restore" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Back up…" })).toBeEnabled();
  });

  it("opens users and roles, which needs a PostgreSQL session", async () => {
    const user = await mount();
    await palette(user, "Users and roles");
    expect(await screen.findByText(/Connect to a PostgreSQL database to see its roles/)).toBeInTheDocument();
  });
});
