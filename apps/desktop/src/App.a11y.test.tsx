import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { CONNECTION, backend, type Backend } from "./test/backend";

/** What a screen reader hears from the main window: the query outcome region,
 *  and the editor tabs that own the query panel. */

let be: Backend;
beforeEach(() => {
  be = backend();
});

const connected = async () => {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByText(CONNECTION.name);
  await user.keyboard("{Meta>}k{/Meta}");
  await user.type(await screen.findByPlaceholderText(/type a command/i), "Connect to local dev");
  await user.keyboard("{Enter}");
  await waitFor(() => expect(be.sent("pg_connect")).toHaveLength(1));
  return user;
};

const run = async (user: ReturnType<typeof userEvent.setup>, sql: string) => {
  const ta = screen.getByRole("textbox", { name: /sql editor/i });
  await user.click(ta);
  await user.clear(ta);
  await user.type(ta, sql);
  await user.click(screen.getByRole("button", { name: /^Run/ }));
};

const region = () => screen.getByRole("status", { name: "Query result" });

describe("App — query outcome live region", () => {
  it("is polite, atomic and empty before anything has run", async () => {
    await connected();
    expect(region()).toHaveAttribute("aria-live", "polite");
    expect(region()).toHaveAttribute("aria-atomic", "true");
    expect(region()).toBeEmptyDOMElement();
  });

  it("announces the row count once the run settles", async () => {
    const user = await connected();
    await run(user, "select 1");
    await waitFor(() => expect(region()).toHaveTextContent("2 rows"));
  });

  it("replaces the node on a repeat run, so the same words are read again", async () => {
    const user = await connected();
    await run(user, "select 1");
    await waitFor(() => expect(region()).toHaveTextContent("2 rows"));
    const before = region().firstElementChild;
    await run(user, "select 1");
    await waitFor(() => expect(be.sent("pg_query")).toHaveLength(2));
    await waitFor(() => expect(region().firstElementChild).not.toBe(before));
    expect(region()).toHaveTextContent(/^2 rows$/);
  });

  it("announces an error by its title", async () => {
    be.on("pg_query", () => {
      throw new Error('relation "nope" does not exist [SQLSTATE 42P01]\nThe table is not there.');
    });
    const user = await connected();
    await run(user, "select * from nope");
    await waitFor(() => expect(region()).toHaveTextContent('Error: relation "nope" does not exist [SQLSTATE 42P01]'));
  });

  it("announces a cancelled run as cancelled", async () => {
    be.on("pg_query", () => {
      throw new Error("Query cancelled [SQLSTATE 57014]\nThe operation was cancelled before it completed.");
    });
    const user = await connected();
    await run(user, "select pg_sleep(60)");
    await waitFor(() => expect(region()).toHaveTextContent(/^Cancelled$/));
  });
});

describe("App — editor tabs own the query panel", () => {
  it("labels the query panel by the selected tab", async () => {
    await connected();
    const editorTabs = screen.getByRole("tablist", { name: "Query tabs" });
    const tab = editorTabs.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')!;
    const panel = document.getElementById(tab.getAttribute("aria-controls")!)!;
    expect(panel).toHaveAttribute("role", "tabpanel");
    expect(panel).toHaveAttribute("aria-labelledby", tab.id);
  });
});
