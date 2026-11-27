import { invoke } from "@tauri-apps/api/core";

/**
 * The assistant's IPC surface. Every network request is made by the Rust
 * side (src-tauri/src/assistant); the WebView only sends what the user typed
 * and the editor's text, and never sees the API key or its keychain ref.
 */

export type Provider = "anthropic" | "ollama";
export type Action = "chat" | "explain" | "fix" | "write";
export type Role = "user" | "assistant";

/** Event each piece of an answer arrives on (`CHUNK_EVENT` in Rust). */
export const CHUNK_EVENT = "assistant:chunk";
export type ChunkPayload = { id: string; text: string };

/** Shown in the panel footer. Says what the Rust side enforces. */
export const PRIVACY_NOTE = "Sends the query and table names. Row data is never sent.";

export type AssistantSettings = {
  anthropicConfigured: boolean;
  ollamaEnabled: boolean;
  ollamaUrl: string;
  ollamaAllowRemote: boolean;
  defaultProvider: Provider | null;
  defaultModel: string | null;
};

export type AssistantSettingsInput = Omit<AssistantSettings, "anthropicConfigured">;

export type ModelOption = { provider: Provider; model: string; label: string };
export type ModelsOut = {
  options: ModelOption[];
  defaultProvider: Provider | null;
  defaultModel: string | null;
  ollamaError: string | null;
};

export type AskInput = {
  action: Action;
  message: string;
  sql?: string | null;
  error?: string | null;
  turns?: { role: Role; text: string }[];
};

export const ANTHROPIC_MODELS: { model: string; label: string }[] = [
  { model: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { model: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { model: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
];

export const getSettings = () => invoke<AssistantSettings>("assistant_settings_get");
export const setSettings = (settings: AssistantSettingsInput) =>
  invoke<AssistantSettings>("assistant_settings_set", { settings });
export const saveKey = (key: string) => invoke<AssistantSettings>("assistant_key_save", { key });
export const removeKey = () => invoke<AssistantSettings>("assistant_key_remove");
export const testAnthropic = (key: string | null) => invoke<string>("assistant_anthropic_test", { key });
export const testOllama = (url: string, allowRemote: boolean) =>
  invoke<string[]>("assistant_ollama_test", { url, allowRemote });
export const listModels = () => invoke<ModelsOut>("assistant_models");
export const ask = (id: string, provider: Provider, model: string, input: AskInput) =>
  invoke<{ cancelled: boolean }>("assistant_ask", { id, provider, model, input });
export const cancel = (id: string) => invoke<boolean>("assistant_cancel", { id });

/** Tauri rejects with the command's error string; anything else is stringified. */
export function errorText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
}
