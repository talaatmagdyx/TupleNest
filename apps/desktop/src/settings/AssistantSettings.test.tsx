import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AssistantSettings, { OLLAMA_DEFAULT_URL } from "./AssistantSettings";
import { backend, type Backend } from "../test/backend";
import type { AssistantSettings as S } from "../assistant/api";

let be: Backend;
let current: S;

const BASE: S = {
  anthropicConfigured: false,
  ollamaEnabled: false,
  ollamaUrl: OLLAMA_DEFAULT_URL,
  ollamaAllowRemote: false,
  ollamaAllowCloud: false,
  defaultProvider: null,
  defaultModel: null,
};

const local = (name: string) => ({ name, cloud: false, remoteHost: null });

const isLocal =(u: string) => /^https?:\/\/(localhost|127\.|\[::1\])/.test(u);

beforeEach(() => {
  be = backend();
  current = { ...BASE };
  be.on("assistant_settings_get", () => current);
  // Mirrors the Rust side's rule: a remote URL needs the switch on.
  be.on("assistant_settings_set", (a) => {
    const s = a.settings as Omit<S, "anthropicConfigured">;
    if (!s.ollamaAllowRemote && !isLocal(s.ollamaUrl)) throw new Error(`${s.ollamaUrl} is not this computer.`);
    current = { ...current, ...s };
    return current;
  });
  be.on("assistant_key_save", (a) => {
    if (!(a.key as string).trim()) throw new Error("Paste an API key first.");
    current = { ...current, anthropicConfigured: true, defaultProvider: "anthropic", defaultModel: "claude-sonnet-5-5" };
    return current;
  });
  be.on("assistant_key_remove", () => {
    current = { ...current, anthropicConfigured: false, defaultProvider: null, defaultModel: null };
    return current;
  });
});

const mount = async (onChanged = vi.fn()) => {
  const user = userEvent.setup();
  render(<AssistantSettings onChanged={onChanged} />);
  await screen.findByRole("textbox", { name: "Ollama URL" });
  return { user, onChanged };
};

describe("Settings › Assistant — Anthropic key", () => {
  it("saves a masked key to the keychain and forgets it", async () => {
    const { user, onChanged } = await mount();
    const input = screen.getByLabelText("Anthropic API key") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(screen.getByText("No key")).toBeInTheDocument();
    await user.type(input, "sk-ant-abc");
    await user.click(screen.getByRole("button", { name: "Save key" }));
    expect(be.sent("assistant_key_save")).toEqual([{ key: "sk-ant-abc" }]);
    expect(await screen.findByText("Saved in the keychain.")).toBeInTheDocument();
    expect(screen.getByText("Key saved in the keychain")).toBeInTheDocument();
    expect(input.value).toBe("");
    expect(onChanged).toHaveBeenCalled();
    // The default-model picker now offers the Claude models.
    expect(screen.getByRole("combobox", { name: "Default model" })).toHaveValue("anthropic:claude-sonnet-5-5");
  });

  it("tests the typed key, then the stored one", async () => {
    be.on("assistant_anthropic_test", () => "The key works.");
    current = { ...BASE, anthropicConfigured: true };
    const { user } = await mount();
    await user.click(screen.getByRole("button", { name: "Test the key" }));
    expect(await screen.findByText("The key works.")).toBeInTheDocument();
    expect(be.sent("assistant_anthropic_test")).toEqual([{ key: null }]);
    await user.type(screen.getByLabelText("Anthropic API key"), "sk-new");
    await user.click(screen.getByRole("button", { name: "Test the key" }));
    await waitFor(() => expect(be.sent("assistant_anthropic_test")[1]).toEqual({ key: "sk-new" }));
  });

  it("puts a rejected key in plain words", async () => {
    be.on("assistant_anthropic_test", () => {
      throw new Error("The Anthropic API did not accept this key. Check it in Settings › Assistant.");
    });
    const { user } = await mount();
    expect(screen.getByRole("button", { name: "Test the key" })).toBeDisabled();
    await user.type(screen.getByLabelText("Anthropic API key"), "sk-bad");
    await user.click(screen.getByRole("button", { name: "Test the key" }));
    expect(await screen.findByText(/did not accept this key/)).toBeInTheDocument();
  });

  it("reports a save that failed", async () => {
    be.on("assistant_key_save", () => {
      throw new Error("keychain backend unavailable: locked");
    });
    const { user } = await mount();
    await user.type(screen.getByLabelText("Anthropic API key"), "sk-x");
    await user.click(screen.getByRole("button", { name: "Save key" }));
    expect(await screen.findByText(/keychain backend unavailable/)).toBeInTheDocument();
  });

  it("removes the provider, and the key with it", async () => {
    current = { ...BASE, anthropicConfigured: true, defaultProvider: "anthropic", defaultModel: "claude-sonnet-5-5" };
    const { user } = await mount();
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(be.sent("assistant_key_remove")).toHaveLength(1);
    expect(await screen.findByText(/deleted from the keychain/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
  });

  it("reports a remove that failed", async () => {
    current = { ...BASE, anthropicConfigured: true };
    be.on("assistant_key_remove", () => {
      throw new Error("keychain operation failed: denied");
    });
    const { user } = await mount();
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(await screen.findByText(/keychain operation failed/)).toBeInTheDocument();
  });
});

describe("Settings › Assistant — Ollama", () => {
  it("lists models on Test and turns Ollama on", async () => {
    be.on("assistant_ollama_test", () => [local("llama3.2:latest"), local("qwen2.5-coder:7b")]);
    const { user } = await mount();
    await user.click(screen.getByRole("button", { name: "Test Ollama" }));
    expect(await screen.findByText("Ollama is running: 2 models found.")).toBeInTheDocument();
    expect(be.sent("assistant_ollama_test")).toEqual([{ url: OLLAMA_DEFAULT_URL, allowRemote: false }]);
    await user.click(screen.getByRole("switch", { name: "Use Ollama" }));
    await waitFor(() => expect(current.ollamaEnabled).toBe(true));
    await user.selectOptions(screen.getByRole("combobox", { name: "Default model" }), "ollama:qwen2.5-coder:7b");
    await waitFor(() => expect(current).toMatchObject({ defaultProvider: "ollama", defaultModel: "qwen2.5-coder:7b" }));
  });

  it("marks cloud models, never offers them as the default, and remembers the opt-in", async () => {
    be.on("assistant_ollama_test", () => [
      local("llama3.2:latest"),
      { name: "glm-5.2:cloud", cloud: true, remoteHost: "https://ollama.com:443" },
    ]);
    current = { ...BASE, ollamaEnabled: true };
    const { user } = await mount();
    // Local models only: the claim is not made for cloud ones.
    expect(screen.queryByText("Nothing leaves this computer.")).not.toBeInTheDocument();
    expect(screen.getByText(/With a local model, nothing leaves this computer/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Test Ollama" }));
    expect(await screen.findByText(/1 of them runs on ollama.com/)).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Ollama models" });
    expect(list).toHaveTextContent("glm-5.2:cloud · cloud via ollama.com");
    expect(list).toHaveTextContent("llama3.2:latest · Ollama");
    const picker = screen.getByRole("combobox", { name: "Default model" });
    expect(picker.querySelector('option[value="ollama:glm-5.2:cloud"]')).toBeNull();
    expect(picker.querySelector('option[value="ollama:llama3.2:latest"]')).not.toBeNull();

    const optIn = screen.getByRole("checkbox", { name: /Allow Ollama cloud models/ });
    expect(optIn).not.toBeChecked();
    expect(optIn).toHaveAccessibleName(/sent to ollama.com/);
    await user.click(optIn);
    await waitFor(() => expect(current.ollamaAllowCloud).toBe(true));
    expect(screen.getByRole("checkbox", { name: /Allow Ollama cloud models/ })).toBeChecked();
  });

  it("says when Ollama has no models, or is not running", async () => {
    be.on("assistant_ollama_test", () => []);
    const { user } = await mount();
    await user.click(screen.getByRole("button", { name: "Test Ollama" }));
    expect(await screen.findByText(/has no models/)).toBeInTheDocument();
    be.on("assistant_ollama_test", () => {
      throw new Error("Ollama is not running at http://localhost:11434. Start the Ollama app, or run `ollama serve`.");
    });
    await user.click(screen.getByRole("button", { name: "Test Ollama" }));
    expect(await screen.findByText(/Ollama is not running/)).toBeInTheDocument();
  });

  it("refuses another computer until it is allowed, and says what that sends", async () => {
    const { user } = await mount();
    expect(screen.getByText(/nothing leaves this computer/)).toBeInTheDocument();
    const url = screen.getByRole("textbox", { name: "Ollama URL" });
    await user.clear(url);
    await user.type(url, "http://gpu-box.lan:11434");
    await user.click(screen.getByRole("button", { name: "Save URL" }));
    expect(await screen.findByText(/is not this computer/)).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "Allow a server on another computer" }));
    await waitFor(() => expect(current).toMatchObject({ ollamaAllowRemote: true, ollamaUrl: "http://gpu-box.lan:11434" }));
    expect(screen.getByText(/go to the server at this URL/)).toBeInTheDocument();

    // Turning it off with a remote URL saved falls back to this computer.
    await user.click(screen.getByRole("checkbox", { name: "Allow a server on another computer" }));
    await waitFor(() => expect(current).toMatchObject({ ollamaAllowRemote: false, ollamaUrl: OLLAMA_DEFAULT_URL }));
    expect(await screen.findByText("Set back to Ollama on this computer.")).toBeInTheDocument();
  });

  it("turns the switch off without moving a local URL", async () => {
    current = { ...BASE, ollamaAllowRemote: true };
    const { user } = await mount();
    await user.click(screen.getByRole("checkbox", { name: "Allow a server on another computer" }));
    await waitFor(() => expect(current.ollamaAllowRemote).toBe(false));
    expect(current.ollamaUrl).toBe(OLLAMA_DEFAULT_URL);
  });

  it("keeps the current Ollama default in the picker before any Test", async () => {
    current = { ...BASE, ollamaEnabled: true, defaultProvider: "ollama", defaultModel: "llama3.2" };
    await mount();
    expect(screen.getByRole("combobox", { name: "Default model" })).toHaveValue("ollama:llama3.2");
  });

  it("clears the default", async () => {
    current = { ...BASE, anthropicConfigured: true, defaultProvider: "anthropic", defaultModel: "claude-opus-5-5" };
    const { user } = await mount();
    await user.selectOptions(screen.getByRole("combobox", { name: "Default model" }), "");
    await waitFor(() => expect(current.defaultProvider).toBeNull());
  });
});

describe("Settings › Assistant — loading", () => {
  it("shows a load failure", async () => {
    be.on("assistant_settings_get", () => {
      throw new Error("store lock poisoned");
    });
    render(<AssistantSettings />);
    expect(await screen.findByText("store lock poisoned")).toBeInTheDocument();
  });

  it("says it is loading, then scrolls itself into view when asked", async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    render(<AssistantSettings focus />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    await screen.findByRole("textbox", { name: "Ollama URL" });
    expect(scroll).toHaveBeenCalled();
  });
});
