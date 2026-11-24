/** EXPLAIN options and their defaults. Kept out of `explain.ts`, which is
 *  loaded on demand, because the app needs the defaults at startup. */

export type ExplainFormat = "json" | "text" | "yaml" | "xml";

export type ExplainOptions = {
  analyze: boolean;
  verbose: boolean;
  costs: boolean;
  buffers: boolean;
  settings: boolean;
  wal: boolean;
  timing: boolean;
  summary: boolean;
  memory: boolean;
  serialize: boolean;
  genericPlan: boolean;
  format: ExplainFormat;
};

export const DEFAULT_EXPLAIN: ExplainOptions = {
  analyze: false,
  verbose: false,
  costs: true, // Postgres defaults COSTS on; the plan tree is useless without it
  buffers: true,
  settings: false,
  wal: false,
  timing: false,
  summary: false,
  memory: false,
  serialize: false,
  genericPlan: false,
  format: "json", // the UI parses JSON to draw the tree
};
