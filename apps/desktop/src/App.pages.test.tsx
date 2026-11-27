import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { CONNECTION, backend } from "./test/backend";

/**
 * The stage 6b pages, as App wires them: opened from the palette, drawn in
 * place of the editor, and closed back to it with the editor as it was.
 */

beforeEach(() => {
  backend();
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

describe("App — pages", () => {
  it("opens dashboards in place of the editor and goes back", async () => {
    const user = await mount();
    await palette(user, "Open dashboards");
    expect(await screen.findByRole("region", { name: "Dashboards" })).toBeInTheDocument();
    expect(await screen.findByText("No dashboards yet")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Back to the editor/ }));
    expect(screen.queryByRole("region", { name: "Dashboards" })).not.toBeInTheDocument();
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
