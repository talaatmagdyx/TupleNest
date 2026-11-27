import { useEffect, useRef, useState } from "react";
import { errorText, listModels, PRIVACY_NOTE, type Action, type ModelOption } from "./api";
import { isSqlBlock, splitAnswer } from "./answer";
import CodeCard from "./CodeCard";
import { useAssistant, type Message } from "./useAssistant";

/** An action asked for from outside the panel: Fix from the error view. */
export type AssistantRequest = {
  /** Bumped per request, so the same Fix twice is two requests. */
  n: number;
  action: Action;
  sql: string;
  error?: string | null;
};

type Props = {
  /** The active editor tab's SQL. */
  sql: string;
  /** Environment of the live session, or null when not connected. */
  env: string | null;
  request: AssistantRequest | null;
  /** Bump to re-read the model list (after Settings changes it). */
  reloadKey?: number;
  onInsert: (sql: string) => void;
  onApply: (sql: string) => void;
  onOpenSettings: () => void;
  onClose: () => void;
  onToast: (text: string) => void;
};

const keyOf = (o: ModelOption) => `${o.provider}:${o.model}`;

const ACTION_WORDS: Record<Action, string> = {
  chat: "",
  explain: "Explain this query: what it does and why it might be slow.",
  fix: "Fix this error.",
  write: "",
};

export default function AssistantPanel(p: Props) {
  const [options, setOptions] = useState<ModelOption[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ollamaError, setOllamaError] = useState<string | null>(null);
  const [pick, setPick] = useState<string>("");
  const [mode, setMode] = useState<"chat" | "write">("chat");
  const [draft, setDraft] = useState("");
  const { messages, busy, send, stop, clear } = useAssistant();
  const handled = useRef<number | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    listModels()
      .then((m) => {
        if (!live) return;
        setOptions(m.options);
        setOllamaError(m.ollamaError);
        setLoadError(null);
        const preferred = m.options.find((o) => o.provider === m.defaultProvider && o.model === m.defaultModel);
        const first = preferred ?? m.options.find((o) => o.provider === m.defaultProvider) ?? m.options[0];
        setPick((cur) => (m.options.some((o) => keyOf(o) === cur) ? cur : first ? keyOf(first) : ""));
      })
      .catch((e) => {
        if (!live) return;
        setOptions([]);
        setLoadError(errorText(e));
      });
    return () => {
      live = false;
    };
  }, [p.reloadKey]);

  const chosen = options?.find((o) => keyOf(o) === pick) ?? null;

  const run = (action: Action, message: string, sql: string | null, error?: string | null) => {
    if (!chosen || busy) return;
    void send(chosen, { action, message: message || ACTION_WORDS[action], sql, error });
  };

  // A Fix asked for from the error view, once the model list is in.
  useEffect(() => {
    const r = p.request;
    if (!r || handled.current === r.n || !chosen || busy) return;
    handled.current = r.n;
    void send(chosen, { action: r.action, message: ACTION_WORDS[r.action], sql: r.sql, error: r.error });
  }, [p.request, chosen, busy, send]);

  useEffect(() => {
    const el = bodyRef.current;
    if (el && typeof el.scrollTo === "function") el.scrollTo({ top: el.scrollHeight });
  }, [messages]);

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    run(mode, text, mode === "write" ? null : p.sql);
  };

  const copy = (sql: string) => {
    navigator.clipboard.writeText(sql).then(
      () => p.onToast("Copied the statement"),
      () => p.onToast("Could not copy"),
    );
  };

  const empty = options !== null && options.length === 0;

  return (
    <aside className="assistant-panel" aria-label="Assistant">
      <div className="ap-head">
        <span className="ap-title">Assistant</span>
        <div className="grow" />
        {options && options.length > 0 && (
          <label className="ap-model">
            Model
            <select aria-label="Model" value={pick} onChange={(e) => setPick(e.target.value)} disabled={busy}>
              {(["anthropic", "ollama"] as const).map((prov) => {
                const group = options.filter((o) => o.provider === prov);
                if (!group.length) return null;
                return (
                  <optgroup key={prov} label={prov === "anthropic" ? "Claude · your key" : "Local · Ollama"}>
                    {group.map((o) => (
                      <option key={keyOf(o)} value={keyOf(o)}>
                        {o.label}
                      </option>
                    ))}
                  </optgroup>
                );
              })}
            </select>
          </label>
        )}
        {messages.length > 0 && (
          <button className="btn xs" onClick={clear} disabled={busy}>
            Clear
          </button>
        )}
        <button className="icon-btn" aria-label="Close the assistant" title="Close" onClick={p.onClose}>
          ×
        </button>
      </div>

      <div className="ap-body" ref={bodyRef}>
        {options === null && <div className="ap-muted">Loading models…</div>}
        {empty && (
          <div className="ap-empty">
            <div className="ap-empty-title">No assistant is set up</div>
            <p>
              Add your own Anthropic API key, or point TupleNest at Ollama running on this computer. Keys are
              kept in the OS keychain.
            </p>
            {loadError && <p className="ap-error">{loadError}</p>}
            {ollamaError && <p className="ap-error">{ollamaError}</p>}
            <button className="btn primary" onClick={p.onOpenSettings}>
              Open Settings › Assistant
            </button>
          </div>
        )}
        {!empty && options !== null && ollamaError && <div className="ap-warn">{ollamaError}</div>}
        {!empty && options !== null && messages.length === 0 && (
          <div className="ap-intro">
            <p>Ask about the query in the editor or the tables in this database, or describe the query you want.</p>
            <p className="ap-muted">Suggestions go into the editor only when you say so. Nothing runs until you press Run.</p>
          </div>
        )}
        {messages.map((m) => (
          <MessageView
            key={m.id}
            m={m}
            env={p.env}
            onInsert={p.onInsert}
            onApply={p.onApply}
            onCopy={copy}
            onOpenSettings={p.onOpenSettings}
          />
        ))}
      </div>

      <div className="ap-foot">
        {!empty && (
          <div className="ap-actions">
            <div className="seg ap-mode" role="group" aria-label="What to ask for">
              <button className={mode === "chat" ? "on" : ""} aria-pressed={mode === "chat"} onClick={() => setMode("chat")}>
                Ask
              </button>
              <button className={mode === "write" ? "on" : ""} aria-pressed={mode === "write"} onClick={() => setMode("write")}>
                Write SQL
              </button>
            </div>
            <button
              className="btn xs"
              disabled={!chosen || busy || !p.sql.trim()}
              onClick={() => run("explain", "", p.sql)}
            >
              Explain the query
            </button>
          </div>
        )}
        <form
          className="ap-input"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <textarea
            aria-label="Ask the assistant"
            placeholder={mode === "write" ? "Describe the query you want, in plain English" : "Ask about this query or the schema"}
            value={draft}
            rows={2}
            disabled={empty}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          {busy ? (
            <button type="button" className="btn xs" aria-label="Stop" onClick={stop}>
              Stop
            </button>
          ) : (
            <button type="submit" className="btn primary xs" aria-label="Send" disabled={!chosen || !draft.trim()}>
              Send
            </button>
          )}
        </form>
        <span className="ap-privacy">{PRIVACY_NOTE}</span>
      </div>
    </aside>
  );
}

function MessageView(p: {
  m: Message;
  env: string | null;
  onInsert: (sql: string) => void;
  onApply: (sql: string) => void;
  onCopy: (sql: string) => void;
  onOpenSettings: () => void;
}) {
  const { m } = p;
  if (m.role === "user") return <div className="ap-q">{m.text}</div>;
  const segments = splitAnswer(m.text);
  const streaming = m.status === "streaming";
  return (
    <div className="ap-a" aria-busy={streaming}>
      {segments.map((s, i) =>
        s.kind === "text" ? (
          <div key={i} className="ap-text">
            {s.text}
          </div>
        ) : isSqlBlock(s) ? (
          <CodeCard
            key={i}
            sql={s.code}
            env={p.env}
            baseSql={m.action === "fix" ? m.baseSql : undefined}
            streaming={streaming}
            onInsert={p.onInsert}
            onApply={p.onApply}
            onCopy={p.onCopy}
          />
        ) : (
          <pre key={i} className="ap-code">
            {s.code}
          </pre>
        ),
      )}
      {streaming && !m.text && <div className="ap-muted">Thinking…</div>}
      {m.status === "cancelled" && <div className="ap-muted">Stopped.</div>}
      {m.status === "error" && (
        <div className="ap-error" role="alert">
          {m.error}
          {m.error?.includes("Settings › Assistant") && (
            <button className="btn xs" onClick={p.onOpenSettings}>
              Open Settings
            </button>
          )}
        </div>
      )}
    </div>
  );
}
