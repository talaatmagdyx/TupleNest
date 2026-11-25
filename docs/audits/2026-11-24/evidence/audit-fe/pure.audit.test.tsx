import { describe, expect, it, vi } from "vitest";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { formatSQL, looksLikeSelect } from "@app/lib/sql";
import { isMutating, optionIssues, DEFAULT_EXPLAIN } from "@app/lib/explain";
import { useExplain } from "@app/hooks/useExplain";
import { lazyModal } from "@app/overlays/lazy";

describe("AUDIT formatSQL", () => {
  it("rewrites the contents of string literals", () => {
    const src = "insert into notes(body) values ('made from scratch and love, order by mail')";
    const out = formatSQL(src);
    console.log("FORMAT OUT:", JSON.stringify(out));
    // Expected (correct) behaviour: literal untouched.
    expect(out).toContain("'made from scratch and love, order by mail'");
  });
  it("strips trailing whitespace inside a multi-line literal", () => {
    const src = "select 'line one   \nline two'";
    const out = formatSQL(src);
    console.log("FORMAT OUT2:", JSON.stringify(out));
    expect(out).toContain("'line one   \nline two'");
  });
  it("uppercases a quoted identifier", () => {
    const out = formatSQL('select "from" from t');
    console.log("FORMAT OUT3:", JSON.stringify(out));
    expect(out).toContain('"from"');
  });
});

describe("AUDIT explain auto-ANALYZE on a data-modifying CTE", () => {
  const sql = "with gone as (delete from users returning id) select count(*) from gone";
  it("is classified as a select and not as mutating", () => {
    console.log("looksLikeSelect:", looksLikeSelect(sql), "isMutating:", isMutating(sql),
      "issues:", JSON.stringify(optionIssues({ ...DEFAULT_EXPLAIN, analyze: true }, sql, 17)));
    expect(looksLikeSelect(sql)).toBe(false); // expected: must not auto-analyze
  });
  it("sends EXPLAIN (ANALYZE …) for it without being asked", async () => {
    const sent: string[] = [];
    vi.mocked(invoke).mockImplementation((async (cmd: string, a: { sql?: string }) => {
      if (cmd === "pg_query") { sent.push(a.sql ?? ""); return { columns: [], storedRows: 1, totalRows: 1 }; }
      if (cmd === "pg_rows") return [[JSON.stringify([{ Plan: { "Node Type": "Result" } }])]];
      return undefined;
    }) as never);
    const { result } = renderHook(() => useExplain(17));
    await act(async () => {
      await result.current.run({ sql, title: "t", connected: true });
    });
    console.log("EXPLAIN SENT:", sent[0]);
    expect(sent[0]).not.toMatch(/ANALYZE/);
  });
});

describe("AUDIT lazy modal chunk failure", () => {
  it("takes the whole tree down (no error boundary)", async () => {
    const Broken = lazyModal<{ x?: number }>(() => Promise.reject(new Error("Failed to fetch dynamically imported module")));
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onErr = (e: ErrorEvent) => { errors.push(e.error); e.preventDefault(); };
    window.addEventListener("error", onErr);
    const { container } = render(
      <div>
        <p>editor with unsaved sql</p>
        <Broken />
      </div>,
      { onUncaughtError: (e: unknown) => errors.push(e) } as never,
    );
    await waitFor(() => expect(errors.length).toBeGreaterThan(0));
    window.removeEventListener("error", onErr);
    spy.mockRestore();
    console.log("AFTER CHUNK FAILURE container html:", JSON.stringify(container.innerHTML), "errors:", String(errors[0]));
    expect(container.textContent).toContain("editor with unsaved sql");
  });
});
