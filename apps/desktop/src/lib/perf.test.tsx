import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import Grid, { type GridColumn } from "../results/Grid";
import { markGridRows, markResult, markRunAbandoned, markRunStart, runTimings } from "./perf";

const invokeMock = vi.mocked(invoke);

const columns: GridColumn[] = [
  { name: "id", dbType: "int8" },
  { name: "customer_id", dbType: "int8" },
  { name: "status", dbType: "text" },
  { name: "total", dbType: "numeric" },
  { name: "created_at", dbType: "timestamptz" },
];

/** One 200-row page of an `orders`-shaped result, starting at `offset`. */
function page(offset: number, limit: number): unknown[][] {
  return Array.from({ length: limit }, (_, i) => [
    offset + i + 1,
    (offset + i) % 400,
    "shipped",
    "123.45",
    "2026-11-28 02:00:00+00",
  ]);
}

const props = (epoch: number) => ({
  columns,
  storedRows: 20_000,
  epoch,
  onInspect: vi.fn(),
  onCopyable: vi.fn(),
  onToast: vi.fn(),
});

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (_cmd, args) => {
    const a = args as { offset: number; limit: number };
    return page(a.offset, a.limit);
  });
  // jsdom has no layout; give the grid the viewport a real window would.
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return this.className?.includes?.("vgrid") ? 600 : 0;
    },
  });
});

describe("perf marks", () => {
  it("measures run to result, first rows and settled for a run the grid shows", async () => {
    markRunStart();
    markResult(true);
    render(<Grid {...props(1)} />);
    await waitFor(() => expect(runTimings()).toHaveProperty("run-to-settled"));
    const t = runTimings();
    expect(Object.keys(t).sort()).toEqual(["run-to-first-rows", "run-to-result", "run-to-settled"]);
    expect(t["run-to-first-rows"]).toBeGreaterThanOrEqual(t["run-to-result"]);
    expect(t["run-to-settled"]).toBeGreaterThanOrEqual(t["run-to-first-rows"]);
  });

  it("keeps only the latest run", () => {
    markRunStart();
    markResult(false);
    markRunStart();
    markResult(false);
    expect(performance.getEntriesByName("tuplenest:run-to-result")).toHaveLength(1);
  });

  it("does not mark the grid for a run without rows, or one that failed", async () => {
    markRunStart();
    markResult(false);
    markGridRows(true, true);
    markRunStart();
    markRunAbandoned();
    markGridRows(true, true);
    await new Promise((r) => setTimeout(r, 50));
    expect(runTimings()).not.toHaveProperty("run-to-first-rows");
  });

  it("loses the numbers, not the run, without User Timing", () => {
    const mark = vi.spyOn(performance, "mark").mockImplementation(() => {
      throw new Error("no user timing");
    });
    expect(() => {
      markRunStart();
      markResult(true);
    }).not.toThrow();
    mark.mockRestore();
  });
});

/*
 * Opt-in measurement: TUPLENEST_BENCH_UI=1 npx vitest run src/lib/perf.test.tsx
 *
 * Reads the same marks in jsdom, with `pg_query` already answered and
 * `pg_rows` answered from memory. What it measures: React rendering and
 * committing the grid's first rows into jsdom's DOM, plus the wait for jsdom's
 * requestAnimationFrame (a timer at about 60 Hz). What it does not: IPC,
 * serialisation, layout, style, paint or the compositor. jsdom does none of
 * those, so this is not a figure for what a user sees; see docs/benchmarks.
 */
describe.skipIf(!process.env.TUPLENEST_BENCH_UI)("perf marks: jsdom measurement", () => {
  it("reports run to first rows over 100 runs", async () => {
    const first: number[] = [];
    const settled: number[] = [];
    const runs = 100;
    const { rerender } = render(<Grid {...props(0)} />);
    for (let i = 1; i <= runs + 1; i++) {
      markRunStart();
      markResult(true);
      rerender(<Grid {...props(i)} />);
      await waitFor(() => expect(runTimings()).toHaveProperty("run-to-settled"), { interval: 1 });
      const t = runTimings();
      if (i > 1) {
        first.push(t["run-to-first-rows"]);
        settled.push(t["run-to-settled"]);
      }
    }
    const stats = (xs: number[]) => {
      const v = [...xs].sort((a, b) => a - b);
      const n = v.length;
      const pct = (p: number) => v[Math.min(n, Math.max(1, Math.ceil(p * n))) - 1];
      const med = n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
      return `median ${med.toFixed(2)} ms\tp95 ${pct(0.95).toFixed(2)}\tp99 ${pct(0.99).toFixed(2)}\tn=${n}`;
    };
    const rows = document.querySelectorAll(".vgrid [role=row]").length;
    process.stdout.write(`BENCH\tjsdom run-to-first-rows (${rows} rows in the DOM)\t${stats(first)}\n`);
    process.stdout.write(`BENCH\tjsdom run-to-settled\t${stats(settled)}\n`);
    expect(first).toHaveLength(runs);
  }, 120_000);
});
