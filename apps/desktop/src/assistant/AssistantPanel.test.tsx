import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { listen } from "@tauri-apps/api/event";
import AssistantPanel, { type AssistantRequest } from "./AssistantPanel";
import { backend, type Backend } from "../test/backend";
import { CHUNK_EVENT, PRIVACY_NOTE } from "./api";

type ChunkCb = (e: { payload: { id: string; text: string } }) => void;
let chunk: ChunkCb | null = null;
let be: Backend;

const CONFIGURED = {
  options: [
    { provider: "anthropic", model: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 · your key" },
    { provider: "anthropic", model: "claude-opus-5-5", label: "Claude Opus 5.5 · your key" },
    { provider: "ollama", model: "llama3.2:latest", label: "llama3.2:latest · Ollama" },
  ],
  defaultProvider: "ollama",
  defaultModel: "llama3.2:latest",
  ollamaError: null,
};

/** Answer every `assistant_ask` by streaming `text` in two pieces. */
const answerWith = (text: string, out: { cancelled: boolean } = { cancelled: false }) =>
  be.on("assistant_ask", async (a) => {
    const id = a.id as string;
    // Events arrive while the call is still open, as Tauri delivers them.
    chunk?.({ payload: { id, text: text.slice(0, 5) } });
    await Promise.resolve();
    chunk?.({ payload: { id, text: text.slice(5) } });
    return out;
  });

beforeEach(() => {
  be = backend();
  chunk = null;
  vi.mocked(listen).mockImplementation((async (ev: string, cb: ChunkCb) => {
    if (ev === CHUNK_EVENT) chunk = cb;
    return () => {};
  }) as never);
});

const props = (over: Partial<React.ComponentProps<typeof AssistantPanel>> = {}) => ({
  sql: "select * from orders",
  env: "dev",
  request: null,
  onInsert: vi.fn(),
  onApply: vi.fn(),
  onOpenSettings: vi.fn(),
  onClose: vi.fn(),
  onToast: vi.fn(),
  ...over,
});

describe("AssistantPanel — empty state", () => {
  it("says nothing is set up and links to Settings › Assistant", async () => {
    const p = props();
    render(<AssistantPanel {...p} />);
    expect(await screen.findByText("No assistant is set up")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Model" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Ask the assistant" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Open Settings › Assistant" }));
    expect(p.onOpenSettings).toHaveBeenCalled();
    expect(screen.getByText(PRIVACY_NOTE)).toBeInTheDocument();
  });

  it("shows why the model list could not be read", async () => {
    be.on("assistant_models", () => {
      throw new Error("store lock poisoned");
    });
    render(<AssistantPanel {...props()} />);
    expect(await screen.findByText("store lock poisoned")).toBeInTheDocument();
  });

  it("shows an Ollama problem in the empty state", async () => {
    be.on("assistant_models", () => ({ ...CONFIGURED, options: [], ollamaError: "Ollama is not running at x." }));
    render(<AssistantPanel {...props()} />);
    expect(await screen.findByText("Ollama is not running at x.")).toBeInTheDocument();
  });
});

describe("AssistantPanel — asking", () => {
  beforeEach(() => be.on("assistant_models", () => CONFIGURED));

  it("lists configured models grouped by provider, starting on the default", async () => {
    render(<AssistantPanel {...props()} />);
    const select = (await screen.findByRole("combobox", { name: "Model" })) as HTMLSelectElement;
    expect(select.value).toBe("ollama:llama3.2:latest");
    expect(within(select).getAllByRole("option")).toHaveLength(3);
    expect(select.querySelectorAll("optgroup")).toHaveLength(2);
  });

  it("falls back to the first model when the default is gone", async () => {
    be.on("assistant_models", () => ({ ...CONFIGURED, defaultProvider: null, defaultModel: null }));
    render(<AssistantPanel {...props()} />);
    const select = (await screen.findByRole("combobox", { name: "Model" })) as HTMLSelectElement;
    expect(select.value).toBe("anthropic:claude-sonnet-5-5");
  });

  it("streams an answer and offers its SQL as a card that never runs", async () => {
    answerWith("Here:\n```sql\nselect id from orders;\n```");
    const p = props();
    const user = userEvent.setup();
    render(<AssistantPanel {...p} />);
    await user.selectOptions(await screen.findByRole("combobox", { name: "Model" }), "anthropic:claude-opus-5-5");
    await user.type(screen.getByRole("textbox", { name: "Ask the assistant" }), "ids please{Enter}");

    expect(await screen.findByText("select id from orders;")).toBeInTheDocument();
    expect(screen.getByText("ids please")).toBeInTheDocument();
    expect(screen.getByText("Read-only")).toBeInTheDocument();
    const sent = be.sent("assistant_ask")[0];
    expect(sent).toMatchObject({ provider: "anthropic", model: "claude-opus-5-5" });
    expect(sent.input).toMatchObject({ action: "chat", message: "ids please", sql: "select * from orders", turns: [] });

    await user.click(screen.getByRole("button", { name: "Insert into editor" }));
    expect(p.onInsert).toHaveBeenCalledWith("select id from orders;");
    // Inserting is an editor change: nothing is sent to the database.
    expect(be.calls()).not.toContain("pg_query");
  });

  it("copies a statement", async () => {
    answerWith("```sql\nselect 2\n```");
    const p = props();
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    render(<AssistantPanel {...p} />);
    await screen.findByRole("combobox", { name: "Model" });
    await user.type(screen.getByRole("textbox", { name: "Ask the assistant" }), "two{Enter}");
    await user.click(await screen.findByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith("select 2");
    await waitFor(() => expect(p.onToast).toHaveBeenCalledWith("Copied the statement"));
  });

  it("says when the copy failed", async () => {
    answerWith("```sql\nselect 2\n```");
    const p = props();
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("no"));
    render(<AssistantPanel {...p} />);
    await screen.findByRole("combobox", { name: "Model" });
    await user.type(screen.getByRole("textbox", { name: "Ask the assistant" }), "two{Enter}");
    await user.click(await screen.findByRole("button", { name: "Copy" }));
    await waitFor(() => expect(p.onToast).toHaveBeenCalledWith("Could not copy"));
  });

  it("sends earlier turns with a follow-up", async () => {
    answerWith("First answer");
    const user = userEvent.setup();
    render(<AssistantPanel {...props()} />);
    const box = await screen.findByRole("textbox", { name: "Ask the assistant" });
    await screen.findByRole("combobox", { name: "Model" });
    await user.type(box, "one{Enter}");
    await screen.findByText("First answer");
    await user.type(box, "two{Enter}");
    await waitFor(() => expect(be.sent("assistant_ask")).toHaveLength(2));
    expect(be.sent("assistant_ask")[1].input).toMatchObject({
      turns: [
        { role: "user", text: "one" },
        { role: "assistant", text: "First answer" },
      ],
    });
  });

  it("Write SQL does not send the editor", async () => {
    answerWith("```sql\ndelete from t\n```");
    const user = userEvent.setup();
    render(<AssistantPanel {...props({ env: "prod" })} />);
    await screen.findByRole("combobox", { name: "Model" });
    await user.click(screen.getByRole("button", { name: "Write SQL" }));
    expect(screen.getByRole("textbox", { name: "Ask the assistant" })).toHaveAttribute(
      "placeholder",
      "Describe the query you want, in plain English",
    );
    await user.type(screen.getByRole("textbox", { name: "Ask the assistant" }), "add a row{Enter}");
    expect(await screen.findByText("Writes data")).toBeInTheDocument();
    expect(screen.getByText(/On PROD it still asks before it runs/)).toBeInTheDocument();
    expect(be.sent("assistant_ask")[0].input).toMatchObject({ action: "write", sql: null });
    await user.click(screen.getByRole("button", { name: "Ask" }));
    expect(screen.getByRole("textbox", { name: "Ask the assistant" })).toHaveAttribute(
      "placeholder",
      "Ask about this query or the schema",
    );
  });

  it("explains the editor's query", async () => {
    answerWith("It scans orders.");
    const user = userEvent.setup();
    render(<AssistantPanel {...props()} />);
    await screen.findByRole("combobox", { name: "Model" });
    await user.click(screen.getByRole("button", { name: "Explain the query" }));
    expect(await screen.findByText("It scans orders.")).toBeInTheDocument();
    expect(be.sent("assistant_ask")[0].input).toMatchObject({ action: "explain", sql: "select * from orders" });
  });

  it("cannot explain an empty editor", async () => {
    render(<AssistantPanel {...props({ sql: "  " })} />);
    await screen.findByRole("combobox", { name: "Model" });
    expect(screen.getByRole("button", { name: "Explain the query" })).toBeDisabled();
  });

  it("shows an error, with a way to Settings when it names them", async () => {
    be.on("assistant_ask", () => {
      throw new Error("The Anthropic API did not accept this key. Check it in Settings › Assistant.");
    });
    const p = props();
    const user = userEvent.setup();
    render(<AssistantPanel {...p} />);
    await screen.findByRole("combobox", { name: "Model" });
    await user.type(screen.getByRole("textbox", { name: "Ask the assistant" }), "hi{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("did not accept this key");
    await user.click(screen.getByRole("button", { name: "Open Settings" }));
    expect(p.onOpenSettings).toHaveBeenCalled();
  });

  it("stops a running answer", async () => {
    let finish: (v: { cancelled: boolean }) => void = () => {};
    be.on("assistant_ask", () => new Promise((r) => (finish = r)));
    const user = userEvent.setup();
    render(<AssistantPanel {...props()} />);
    await screen.findByRole("combobox", { name: "Model" });
    await user.type(screen.getByRole("textbox", { name: "Ask the assistant" }), "long one{Enter}");
    expect(await screen.findByText("Thinking…")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Stop" }));
    const id = be.sent("assistant_ask")[0].id;
    expect(be.sent("assistant_cancel")).toEqual([{ id }]);
    await act(async () => finish({ cancelled: true }));
    expect(await screen.findByText("Stopped.")).toBeInTheDocument();
  });

  it("clears the conversation and closes", async () => {
    answerWith("hello there");
    const p = props();
    const user = userEvent.setup();
    render(<AssistantPanel {...p} />);
    await screen.findByRole("combobox", { name: "Model" });
    await user.type(screen.getByRole("textbox", { name: "Ask the assistant" }), "hi{Enter}");
    await screen.findByText("hello there");
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryByText("hello there")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close the assistant" }));
    expect(p.onClose).toHaveBeenCalled();
  });

  it("sends with the Send button, and Shift+Enter makes a new line", async () => {
    answerWith("ok then");
    const user = userEvent.setup();
    render(<AssistantPanel {...props()} />);
    await screen.findByRole("combobox", { name: "Model" });
    const box = screen.getByRole("textbox", { name: "Ask the assistant" });
    await user.type(box, "line one{Shift>}{Enter}{/Shift}line two");
    expect(be.sent("assistant_ask")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("ok then")).toBeInTheDocument();
    expect(be.sent("assistant_ask")[0].input).toMatchObject({ message: "line one\nline two" });
  });

  it("does not send an empty message", async () => {
    const user = userEvent.setup();
    render(<AssistantPanel {...props()} />);
    await screen.findByRole("combobox", { name: "Model" });
    await user.type(screen.getByRole("textbox", { name: "Ask the assistant" }), "   {Enter}");
    expect(be.sent("assistant_ask")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("shows a non-SQL block as plain code", async () => {
    answerWith("Run:\n```bash\nollama pull llama3.2\n```");
    const user = userEvent.setup();
    render(<AssistantPanel {...props()} />);
    await screen.findByRole("combobox", { name: "Model" });
    await user.type(screen.getByRole("textbox", { name: "Ask the assistant" }), "how{Enter}");
    expect(await screen.findByText("ollama pull llama3.2")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Insert into editor" })).not.toBeInTheDocument();
  });

  it("warns about Ollama while Claude still works", async () => {
    be.on("assistant_models", () => ({ ...CONFIGURED, ollamaError: "Ollama is not running." }));
    render(<AssistantPanel {...props()} />);
    expect(await screen.findByText("Ollama is not running.")).toBeInTheDocument();
  });
});

describe("AssistantPanel — Fix", () => {
  beforeEach(() => be.on("assistant_models", () => CONFIGURED));

  const fix: AssistantRequest = {
    n: 1,
    action: "fix",
    sql: "select\n  sum(o.totl)\nfrom orders o",
    error: "column o.totl does not exist [SQLSTATE 42703]",
  };

  it("sends the error, shows the fix as a diff, and applies it without running", async () => {
    answerWith("The column is total:\n```sql\nselect\n  sum(o.total)\nfrom orders o\n```");
    const p = props({ request: fix });
    const user = userEvent.setup();
    render(<AssistantPanel {...p} />);

    const diff = await screen.findByRole("group", { name: "Changes to the query" });
    expect(within(diff).getByText("sum(o.totl)", { exact: false }).closest("div")).toHaveClass("ap-diff-del");
    expect(within(diff).getByText("sum(o.total)", { exact: false }).closest("div")).toHaveClass("ap-diff-add");
    expect(screen.getByText("Fix this error.")).toBeInTheDocument();
    expect(be.sent("assistant_ask")[0].input).toMatchObject({
      action: "fix",
      sql: fix.sql,
      error: fix.error,
    });

    expect(screen.queryByRole("button", { name: "Insert into editor" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Apply the fix" }));
    expect(p.onApply).toHaveBeenCalledWith("select\n  sum(o.total)\nfrom orders o");
    expect(be.calls()).not.toContain("pg_query");
  });

  it("asks once per request, and again for the next one", async () => {
    answerWith("```sql\nselect 1\n```");
    const p = props({ request: fix });
    const { rerender } = render(<AssistantPanel {...p} />);
    await screen.findByRole("button", { name: "Apply the fix" });
    rerender(<AssistantPanel {...p} request={{ ...fix }} />);
    expect(be.sent("assistant_ask")).toHaveLength(1);
    rerender(<AssistantPanel {...p} request={{ ...fix, n: 2 }} />);
    await waitFor(() => expect(be.sent("assistant_ask")).toHaveLength(2));
  });

  it("re-reads the models when Settings change them", async () => {
    const p = props();
    const { rerender } = render(<AssistantPanel {...p} reloadKey={0} />);
    await screen.findByRole("combobox", { name: "Model" });
    rerender(<AssistantPanel {...p} reloadKey={1} />);
    await waitFor(() => expect(be.sent("assistant_models")).toHaveLength(2));
  });
});
