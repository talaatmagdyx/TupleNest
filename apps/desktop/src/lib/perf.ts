/**
 * User Timing marks for one query run, for measuring time to first rows
 * (docs/benchmarks/README.md, "Time to first rows in the UI").
 *
 * Nothing reads these in the app and nothing is shown or sent anywhere. In a
 * WebView with an inspector, after a run:
 *
 *   performance.getEntriesByType("measure").filter((m) => m.name.startsWith("tuplenest:"))
 *
 * Marks, all from the same run:
 * - `tuplenest:run-start`: just before `pg_query` is invoked.
 * - `tuplenest:result`: `pg_query` has answered (the summary, no rows yet).
 * - `tuplenest:first-rows`: the first frame after rows of this result were
 *   committed to the grid's DOM (a timeout queued from a requestAnimationFrame
 *   callback, so it runs once that frame has been handed to the compositor).
 * - `tuplenest:settled`: the same, once every page the grid's viewport
 *   (with its overscan) covers is loaded. At the top of a result the viewport fits
 *   in the first 200-row page, so this is usually the same frame.
 *
 * Measures `tuplenest:run-to-result`, `tuplenest:run-to-first-rows` and
 * `tuplenest:run-to-settled` span from `run-start` to each. Only the latest
 * run's entries are kept, so a long session does not grow the buffer.
 *
 * Every call is wrapped: a WebView without User Timing loses the numbers,
 * never the query.
 */

const P = "tuplenest:";
const MARKS = ["run-start", "result", "first-rows", "settled"];
const MEASURES = ["run-to-result", "run-to-first-rows", "run-to-settled"];

/** The run whose grid marks are still to come; null when none is. */
let pending: { first: boolean } | null = null;

function safe(f: () => void) {
  try {
    f();
  } catch {
    // User Timing missing or a mark absent: the measurement is lost, nothing else.
  }
}

function afterFrame(f: () => void) {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => setTimeout(f, 0));
  else setTimeout(f, 0);
}

export function markRunStart() {
  safe(() => {
    for (const m of MARKS) performance.clearMarks(P + m);
    for (const m of MEASURES) performance.clearMeasures(P + m);
    performance.mark(P + "run-start");
  });
  pending = null;
}

/** `pg_query` answered. `hasRows` false (an error, a statement with no result
 *  set, an empty result) means the grid will not mark this run. */
export function markResult(hasRows: boolean) {
  safe(() => {
    performance.mark(P + "result");
    performance.measure(P + "run-to-result", P + "run-start", P + "result");
  });
  pending = hasRows ? { first: false } : null;
}

/** The run ended without a result for the grid (error, cancel, superseded). */
export function markRunAbandoned() {
  pending = null;
}

/** Called by the grid after each commit with what its viewport holds. */
export function markGridRows(anyLoaded: boolean, allLoaded: boolean) {
  const run = pending;
  if (!run || !anyLoaded) return;
  if (!run.first) {
    run.first = true;
    afterFrame(() =>
      safe(() => {
        performance.mark(P + "first-rows");
        performance.measure(P + "run-to-first-rows", P + "run-start", P + "first-rows");
      }),
    );
  }
  if (allLoaded) {
    pending = null;
    afterFrame(() =>
      safe(() => {
        performance.mark(P + "settled");
        performance.measure(P + "run-to-settled", P + "run-start", P + "settled");
      }),
    );
  }
}

/** The latest run's measures, in ms, keyed without the prefix. */
export function runTimings(): Record<string, number> {
  const out: Record<string, number> = {};
  safe(() => {
    for (const m of performance.getEntriesByType("measure")) {
      if (m.name.startsWith(P)) out[m.name.slice(P.length)] = m.duration;
    }
  });
  return out;
}
