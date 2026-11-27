import { useEffect, useRef, useState } from "react";
import {
  ANTHROPIC_MODELS,
  errorText,
  getSettings,
  removeKey,
  saveKey,
  setSettings,
  testAnthropic,
  testOllama,
  type AssistantSettings as Settings,
  type Provider,
} from "../assistant/api";

type Note = { ok: boolean; text: string } | null;

export const OLLAMA_DEFAULT_URL = "http://localhost:11434";

/**
 * Settings › Assistant. The key goes straight to the Rust side and into the
 * OS keychain; this component never holds it after Save, and is never told
 * the stored one — only whether there is one.
 */
export default function AssistantSettings(p: { onChanged?: () => void; focus?: boolean }) {
  const [s, setS] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [keyNote, setKeyNote] = useState<Note>(null);
  const [keyBusy, setKeyBusy] = useState(false);
  const [url, setUrl] = useState("");
  const [ollamaNote, setOllamaNote] = useState<Note>(null);
  const [ollamaBusy, setOllamaBusy] = useState(false);
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [saveNote, setSaveNote] = useState<Note>(null);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    getSettings()
      .then((v) => {
        setS(v);
        setUrl(v.ollamaUrl);
      })
      .catch((e) => setLoadError(errorText(e)));
  }, []);

  useEffect(() => {
    if (p.focus && ref.current && typeof ref.current.scrollIntoView === "function") {
      ref.current.scrollIntoView({ block: "start" });
    }
  }, [p.focus, s]);

  if (loadError) {
    return (
      <section className="as-section" aria-labelledby="as-title" ref={ref}>
        <h3 id="as-title" className="as-title">Assistant</h3>
        <p className="as-err">{loadError}</p>
      </section>
    );
  }
  if (!s) {
    return (
      <section className="as-section" aria-labelledby="as-title" ref={ref}>
        <h3 id="as-title" className="as-title">Assistant</h3>
        <p className="as-muted">Loading…</p>
      </section>
    );
  }

  const persist = async (patch: Partial<Settings>, okText?: string): Promise<boolean> => {
    const next = { ...s, ...patch };
    try {
      const out = await setSettings({
        ollamaEnabled: next.ollamaEnabled,
        ollamaUrl: next.ollamaUrl,
        ollamaAllowRemote: next.ollamaAllowRemote,
        defaultProvider: next.defaultProvider,
        defaultModel: next.defaultModel,
      });
      setS(out);
      setUrl(out.ollamaUrl);
      setSaveNote(okText ? { ok: true, text: okText } : null);
      p.onChanged?.();
      return true;
    } catch (e) {
      setSaveNote({ ok: false, text: errorText(e) });
      return false;
    }
  };

  const doSaveKey = async () => {
    setKeyBusy(true);
    try {
      const out = await saveKey(key);
      setS(out);
      setKey("");
      setKeyNote({ ok: true, text: "Saved in the keychain." });
      p.onChanged?.();
    } catch (e) {
      setKeyNote({ ok: false, text: errorText(e) });
    } finally {
      setKeyBusy(false);
    }
  };

  const doTestKey = async () => {
    setKeyBusy(true);
    setKeyNote(null);
    try {
      setKeyNote({ ok: true, text: await testAnthropic(key.trim() ? key : null) });
    } catch (e) {
      setKeyNote({ ok: false, text: errorText(e) });
    } finally {
      setKeyBusy(false);
    }
  };

  const doRemoveKey = async () => {
    setKeyBusy(true);
    try {
      const out = await removeKey();
      setS(out);
      setKeyNote({ ok: true, text: "Removed. The key was deleted from the keychain." });
      p.onChanged?.();
    } catch (e) {
      setKeyNote({ ok: false, text: errorText(e) });
    } finally {
      setKeyBusy(false);
    }
  };

  const doTestOllama = async () => {
    setOllamaBusy(true);
    setOllamaNote(null);
    try {
      const models = await testOllama(url, s.ollamaAllowRemote);
      setOllamaModels(models);
      setOllamaNote(
        models.length
          ? { ok: true, text: `Ollama is running: ${models.length} model${models.length === 1 ? "" : "s"} found.` }
          : { ok: false, text: "Ollama is running but has no models. Pull one with `ollama pull llama3.2`." },
      );
    } catch (e) {
      setOllamaNote({ ok: false, text: errorText(e) });
    } finally {
      setOllamaBusy(false);
    }
  };

  // The default-model picker: what is configured, plus the current default
  // even when Ollama has not been listed in this dialog.
  const defaults: { provider: Provider; model: string; label: string }[] = [];
  if (s.anthropicConfigured) {
    for (const m of ANTHROPIC_MODELS) defaults.push({ provider: "anthropic", model: m.model, label: `${m.label} · your key` });
  }
  if (s.ollamaEnabled) {
    const names = new Set(ollamaModels);
    if (s.defaultProvider === "ollama" && s.defaultModel) names.add(s.defaultModel);
    for (const m of names) defaults.push({ provider: "ollama", model: m, label: `${m} · Ollama` });
  }
  const defaultKey = s.defaultProvider && s.defaultModel ? `${s.defaultProvider}:${s.defaultModel}` : "";

  return (
    <section className="as-section" aria-labelledby="as-title" ref={ref}>
      <h3 id="as-title" className="as-title">Assistant</h3>
      <p className="as-muted">
        Use your own Anthropic key, a model on this computer, or both. Keys are kept in the OS keychain. The
        assistant is sent your question, the query and the names of tables and columns — never row data.
      </p>

      <div className="as-card">
        <div className="as-card-head">
          <span className="as-card-title">Claude, Anthropic API</span>
          <span className={s.anthropicConfigured ? "as-ok" : "as-muted"}>
            {s.anthropicConfigured ? "Key saved in the keychain" : "No key"}
          </span>
        </div>
        <div className="as-row">
          <input
            type="password"
            className="as-input mono"
            aria-label="Anthropic API key"
            placeholder={s.anthropicConfigured ? "Paste a new key to replace the saved one" : "sk-ant-…"}
            autoComplete="off"
            spellCheck={false}
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          <button className="btn primary xs" disabled={keyBusy || !key.trim()} onClick={doSaveKey}>
            Save key
          </button>
          <button className="btn xs" aria-label="Test the key" disabled={keyBusy || (!key.trim() && !s.anthropicConfigured)} onClick={doTestKey}>
            Test
          </button>
          {s.anthropicConfigured && (
            <button className="btn xs" disabled={keyBusy} onClick={doRemoveKey}>
              Remove
            </button>
          )}
        </div>
        {keyNote && (
          <div role="status" className={keyNote.ok ? "as-ok" : "as-err"}>
            {keyNote.text}
          </div>
        )}
        <div className="as-hint">Test sends one tiny request to api.anthropic.com. It does not include any of your data.</div>
      </div>

      <div className="as-card">
        <div className="as-card-head">
          <span className="as-card-title">Local, Ollama</span>
          <button
            className={`toggle ${s.ollamaEnabled ? "on" : ""}`}
            role="switch"
            aria-checked={s.ollamaEnabled}
            aria-label="Use Ollama"
            onClick={() => void persist({ ollamaEnabled: !s.ollamaEnabled, ollamaUrl: url })}
          >
            <span className="knob" aria-hidden />
          </button>
        </div>
        <div className="as-row">
          <input
            className="as-input mono"
            aria-label="Ollama URL"
            value={url}
            spellCheck={false}
            onChange={(e) => setUrl(e.target.value)}
          />
          <button className="btn xs" aria-label="Test Ollama" disabled={ollamaBusy} onClick={doTestOllama}>
            Test
          </button>
          <button
            className="btn xs"
            disabled={url === s.ollamaUrl}
            onClick={() => void persist({ ollamaUrl: url }, "Saved.")}
          >
            Save URL
          </button>
        </div>
        <label className="as-check">
          <input
            type="checkbox"
            checked={s.ollamaAllowRemote}
            onChange={async (e) => {
              if (e.target.checked) {
                await persist({ ollamaAllowRemote: true, ollamaUrl: url });
                return;
              }
              // Turning it off with a remote URL saved would be refused, and
              // the switch would be stuck on: fall back to this computer.
              const ok = await persist({ ollamaAllowRemote: false });
              if (!ok) await persist({ ollamaAllowRemote: false, ollamaUrl: OLLAMA_DEFAULT_URL }, "Set back to Ollama on this computer.");
            }}
          />
          Allow a server on another computer
        </label>
        <div className="as-hint">
          {s.ollamaAllowRemote
            ? "On: your questions, the query and table names go to the server at this URL."
            : "Off: only this computer (localhost, 127.0.0.1, ::1). Nothing leaves this computer."}
        </div>
        {ollamaNote && (
          <div role="status" className={ollamaNote.ok ? "as-ok" : "as-err"}>
            {ollamaNote.text}
          </div>
        )}
      </div>

      <div className="section-row">
        <div>
          <div className="st">Default model</div>
          <div className="sd">What the panel starts with. You can pick another per request.</div>
        </div>
        <select
          aria-label="Default model"
          value={defaultKey}
          disabled={defaults.length === 0}
          onChange={(e) => {
            const d = defaults.find((x) => `${x.provider}:${x.model}` === e.target.value);
            void persist({ defaultProvider: d?.provider ?? null, defaultModel: d?.model ?? null }, "Saved.");
          }}
        >
          <option value="">{defaults.length ? "Choose…" : "Set up a provider first"}</option>
          {defaults.map((d) => (
            <option key={`${d.provider}:${d.model}`} value={`${d.provider}:${d.model}`}>
              {d.label}
            </option>
          ))}
        </select>
      </div>
      {saveNote && (
        <div role="status" className={saveNote.ok ? "as-ok" : "as-err"}>
          {saveNote.text}
        </div>
      )}
    </section>
  );
}
