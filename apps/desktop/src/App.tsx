import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type AppInfo = { name: string; version: string; os: string };

export default function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    invoke<AppInfo>("app_get_info").then(setInfo).catch(console.error);
    invoke<"dark" | "light" | null>("settings_get", { key: "theme" })
      .then((t) => {
        if (t) setTheme(t);
        setRestored(true);
      })
      .catch(() => setRestored(true));
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const toggleTheme = useCallback(async () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    await invoke("settings_set", { key: "theme", value: next });
  }, [theme]);

  return (
    <div className="shell">
      <header className="titlebar">
        <span className="brand">TupleNest</span>
        <button onClick={toggleTheme}>
          {theme === "dark" ? "Light theme" : "Dark theme"}
        </button>
      </header>
      <main className="content">
        <h1>Phase 0 shell</h1>
        {info ? (
          <p>
            {info.name} v{info.version} on {info.os} — settings store{" "}
            {restored ? "restored" : "loading"} (theme: {theme})
          </p>
        ) : (
          <p>Loading application info…</p>
        )}
        <p className="hint">
          Credentials never enter this WebView. All database work happens in the
          Rust core behind narrow, capability-gated commands.
        </p>
      </main>
    </div>
  );
}
