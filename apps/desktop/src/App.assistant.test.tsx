import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { listen } from "@tauri-apps/api/event";
import App from "./App";
import { CONNECTION, backend, type Backend } from "./test/backend";
import { CHUNK_EVENT } from "./assistant/api";

/** The assistant wired into the app: toggles, Fix from the error view, and
 *  the rule that nothing it writes runs without the user's Run. */

type ChunkCb = (e: { payload: { id: string; text: string } }) => void;
let chunk: ChunkCb | null = null;
let be: Backend;

beforeEach(() => {
  be = backend();
  chunk = null;
  vi.mocked(listen).mockImplementation((async (ev: string, cb: ChunkCb) => {
    if (ev === CHUNK_EVENT) chunk = cb;
    return () => {};
  }) as never);
});

const configure = (answer: string) => {
  be.on("assistant_models", () => ({
    options: [{ provider: "anthropic", model: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 · your key" }],
    defaultProvider: "anthropic",
    defaultModel: "claude-sonnet-5-5",
    ollamaError: null,
  }));
  be.on("assistant_ask", async (a) => {
    chunk?.({ payload: { id: a.id as string, text: answer } });
    return { cancelled: false };
  });
};

const mount = async () => {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByText(CONNECTION.name);
  return user;
};

const editor = () => screen.getByRole("textbox", { name: /sql editor/i }) as HTMLTextAreaElement;

const type = async (user: ReturnType<typeof userEvent.setup>, sql: string) => {
  await user.click(editor());
  await user.clear(editor());
  await user.type(editor(), sql);
};

describe("App — assistant", () => {
  it("opens and closes from the title bar and with ⌘J", async () => {
    const user = await mount();
    expect(screen.queryByRole("complementary", { name: "Assistant" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Assistant/ }));
    expect(await screen.findByRole("complementary", { name: "Assistant" })).toBeInTheDocument();
    await user.keyboard("{Meta>}j{/Meta}");
    expect(screen.queryByRole("complementary", { name: "Assistant" })).not.toBeInTheDocument();
    await user.keyboard("{Meta>}j{/Meta}");
    expect(await screen.findByRole("complementary", { name: "Assistant" })).toBeInTheDocument();
  });

  it("goes from the empty state to Settings › Assistant", async () => {
    const user = await mount();
    await user.keyboard("{Meta>}j{/Meta}");
    await user.click(await screen.findByRole("button", { name: "Open Settings › Assistant" }));
    expect(await screen.findByRole("heading", { name: "Assistant" })).toBeInTheDocument();
    expect(screen.getByLabelText("Anthropic API key")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByLabelText("Anthropic API key")).not.toBeInTheDocument());
  });

  it("fixes a failed query in the editor and does not run it", async () => {
    configure("The column is total:\n```sql\nselect total from orders\n```");
    be.on("pg_query", () => {
      throw new Error("Undefined column [SQLSTATE 42703]\ncolumn \"totl\" does not exist");
    });
    const user = await mount();
    await user.keyboard("{Meta>}k{/Meta}");
    await user.type(await screen.findByPlaceholderText(/type a command/i), "Connect to local dev");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(be.sent("pg_connect")).toHaveLength(1));
    await type(user, "select totl from orders");
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    await user.click(await screen.findByRole("button", { name: "Fix with the assistant" }));

    await waitFor(() => expect(be.sent("assistant_ask")).toHaveLength(1));
    expect(be.sent("assistant_ask")[0].input).toMatchObject({
      action: "fix",
      sql: "select totl from orders",
      error: expect.stringContaining("SQLSTATE 42703"),
    });
    await user.click(await screen.findByRole("button", { name: "Apply the fix" }));
    expect(editor().value).toBe("select total from orders");
    expect(await screen.findByText(/nothing runs until you press Run/)).toBeInTheDocument();
    // One run: the user's own, before the fix.
    expect(be.sent("pg_query")).toHaveLength(1);
  });

  it("inserts a suggestion after what the editor holds", async () => {
    configure("```sql\nselect 2\n```");
    const user = await mount();
    await type(user, "select 1");
    await user.keyboard("{Meta>}j{/Meta}");
    await user.type(await screen.findByRole("textbox", { name: "Ask the assistant" }), "another{Enter}");
    await user.click(await screen.findByRole("button", { name: "Insert into editor" }));
    expect(editor().value).toBe("select 1\n\nselect 2");
    expect(be.calls()).not.toContain("pg_query");
  });

  it("puts a suggestion into an empty editor as is", async () => {
    configure("```sql\nselect 3\n```");
    const user = await mount();
    await user.clear(editor());
    await user.keyboard("{Meta>}j{/Meta}");
    await user.type(await screen.findByRole("textbox", { name: "Ask the assistant" }), "three{Enter}");
    await user.click(await screen.findByRole("button", { name: "Insert into editor" }));
    expect(editor().value).toBe("select 3");
  });
});
