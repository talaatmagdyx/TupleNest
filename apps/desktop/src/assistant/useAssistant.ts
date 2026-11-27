import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  ask,
  cancel,
  CHUNK_EVENT,
  errorText,
  type Action,
  type ChunkPayload,
  type ModelOption,
  type Role,
} from "./api";

export type Message = {
  id: string;
  role: Role;
  text: string;
  action: Action;
  /** For a Fix: the editor text the fix is meant to replace, for the diff. */
  baseSql?: string;
  status: "streaming" | "done" | "error" | "cancelled";
  error?: string;
};

export type SendInput = {
  action: Action;
  /** What the user typed, or the action's own wording. */
  message: string;
  sql?: string | null;
  error?: string | null;
};

let seq = 0;
const nextId = () => `a${Date.now().toString(36)}-${(seq++).toString(36)}`;

/**
 * One panel conversation. Answers stream in on `assistant:chunk` events; the
 * `assistant_ask` call itself resolves when the answer is complete.
 */
export function useAssistant() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    const stop = listen<ChunkPayload>(CHUNK_EVENT, (e) => {
      const { id, text } = e.payload;
      setMessages((ms) => ms.map((m) => (m.id === id ? { ...m, text: m.text + text } : m)));
    });
    return () => {
      void stop.then((off) => off());
    };
  }, []);

  const send = useCallback(async (pick: ModelOption, input: SendInput) => {
    // Earlier finished turns of this conversation, as the model saw them.
    const turns = messagesRef.current
      .filter((m) => m.status === "done" && m.text.trim())
      .map((m) => ({ role: m.role, text: m.text }));
    const id = nextId();
    const user: Message = { id: `${id}-q`, role: "user", text: input.message, action: input.action, status: "done" };
    const answer: Message = {
      id,
      role: "assistant",
      text: "",
      action: input.action,
      baseSql: input.action === "fix" ? input.sql ?? "" : undefined,
      status: "streaming",
    };
    setMessages((ms) => [...ms, user, answer]);
    setBusy(id);
    try {
      const out = await ask(id, pick.provider, pick.model, {
        action: input.action,
        message: input.message,
        sql: input.sql ?? null,
        error: input.error ?? null,
        turns,
      });
      setMessages((ms) => ms.map((m) => (m.id === id ? { ...m, status: out.cancelled ? "cancelled" : "done" } : m)));
    } catch (e) {
      setMessages((ms) => ms.map((m) => (m.id === id ? { ...m, status: "error", error: errorText(e) } : m)));
    } finally {
      setBusy(null);
    }
  }, []);

  const stop = useCallback(() => {
    if (busy) void cancel(busy);
  }, [busy]);

  const clear = useCallback(() => setMessages([]), []);

  return { messages, busy: busy !== null, send, stop, clear };
}
