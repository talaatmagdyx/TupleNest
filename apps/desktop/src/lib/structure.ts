import type { DbColumn, DbConstraint, DbIndex } from "../ipc/types";

/** A relation's columns, indexes and constraints — the same three reads the
 *  explorer makes when its nodes are opened. Kept out of DetailsModal, which is
 *  loaded on demand: App reads these, and importing a value from the modal
 *  would pull the whole modal into the first bundle. */
export type TableStructure = {
  columns: DbColumn[];
  indexes: DbIndex[];
  constraints: DbConstraint[];
};

/** Kinds that have columns worth tabulating. */
export const HAS_STRUCTURE = new Set(["table", "view", "matview", "foreign"]);

type Fetch = (req: Record<string, unknown>) => Promise<{ payload: unknown } | null>;

/**
 * Read the structure through the app's metadata path (live, or the cache when
 * offline). Each part stands on its own: a role that may not read the index
 * list still gets its columns. Never rejects; whatever failed is empty.
 */
export async function loadStructure(fetch: Fetch, schema: string, name: string): Promise<TableStructure> {
  const [cols, idx, cons] = await Promise.allSettled([
    fetch({ kind: "describe_object", schema, name }),
    fetch({ kind: "list_indexes", schema, table: name }),
    fetch({ kind: "list_constraints", schema, table: name }),
  ]);
  const payload = (r: PromiseSettledResult<{ payload: unknown } | null>): unknown =>
    r.status === "fulfilled" ? r.value?.payload : undefined;
  const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  return {
    columns: list<DbColumn>((payload(cols) as { columns?: unknown } | undefined)?.columns),
    indexes: list<DbIndex>(payload(idx)),
    constraints: list<DbConstraint>(payload(cons)),
  };
}

/** `FOREIGN KEY (a) REFERENCES t(x)` → `a` and `t.x`; with several columns
 *  the target keeps its parentheses, `s.t(x, y)`, so it still reads right. */
export function parseForeignKey(def: string | null): { from: string; to: string } | null {
  const m = /FOREIGN KEY \(([^)]+)\) REFERENCES ([^(\s]+)\s*\(([^)]+)\)/i.exec(def ?? "");
  if (!m) return null;
  return { from: m[1], to: m[3].includes(",") ? `${m[2]}(${m[3]})` : `${m[2]}.${m[3]}` };
}
