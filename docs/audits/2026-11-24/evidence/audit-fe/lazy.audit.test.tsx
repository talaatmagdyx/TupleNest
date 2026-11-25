import { expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { lazyModal } from "@app/overlays/lazy";

it("AUDIT lazy chunk failure unmounts everything (no error boundary)", async () => {
  const Broken = lazyModal<{ x?: number }>(() => Promise.reject(new Error("Failed to fetch dynamically imported module")));
  const host = document.createElement("div");
  document.body.appendChild(host);
  const errors: unknown[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  const root = createRoot(host, { onUncaughtError: (e) => errors.push(e) });
  function Shell({ open }: { open: boolean }) {
    return (
      <div>
        <p>editor with unsaved sql</p>
        {open && <Broken />}
      </div>
    );
  }
  await act(async () => root.render(<Shell open={false} />));
  expect(host.textContent).toContain("editor with unsaved sql");
  try { await act(async () => { root.render(<Shell open={true} />); await new Promise((r) => setTimeout(r, 20)); }); } catch (e) { errors.push('act rethrew: ' + String(e)); }
  spy.mockRestore();
  console.log("AFTER CHUNK FAILURE html:", JSON.stringify(host.innerHTML), "| errors:", errors.map(String));
  // Correct behaviour would keep the shell and show a message.
  expect(host.textContent).toContain("editor with unsaved sql");
});
