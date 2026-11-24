import type * as Explain from "./explain";

/**
 * The EXPLAIN parser, index advisor and plan exporters, loaded on first use.
 *
 * They are a sizeable share of the code and most sessions never ask for a
 * plan, so they stay out of the startup bundle. The module is kept once
 * loaded so code that runs after a plan exists can reach it synchronously —
 * copying a plan must call the clipboard inside the click, not after an
 * await, or WebKit may refuse it as no longer user-initiated.
 */
let mod: typeof Explain | undefined;

export async function loadExplain(): Promise<typeof Explain> {
  return (mod ??= await import("./explain"));
}

/** The module if a plan has been requested this session, else undefined. */
export function loadedExplain(): typeof Explain | undefined {
  return mod;
}
