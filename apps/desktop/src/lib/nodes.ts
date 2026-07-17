/**
 * Explorer node keys.
 *
 * A node id carries its own meaning so the tree can stay a flat map rather
 * than a nested structure: `s:public` is a schema, `c:public.users` is that
 * table's columns. Everything below is the parsing of those ids — kept apart
 * from the fetching so it can be stated and tested without a database.
 */

/** What a node id addresses. */
export type NodeTag =
  | "s" // schema        → its object list
  | "g" // group         → presentation only, nothing to fetch
  | "t" // table         → presentation only, its children fetch their own
  | "c" // columns
  | "i" // indexes
  | "k" // constraints
  | "p"; // partitions

export type ParsedNode =
  | { tag: "s"; schema: string }
  | { tag: "g"; schema: string; kind: string }
  | { tag: Exclude<NodeTag, "s" | "g">; schema: string; table: string; key: string };

/**
 * Split a node id into what it addresses.
 *
 * Table ids are `tag:schema.table`, built by joining with a dot
 * (`ExplorerTree.tsx`) and split here on the LAST dot.
 *
 * **This is ambiguous and the split is a guess.** PostgreSQL allows any
 * character in a quoted identifier, so both parts may contain dots, and
 * joining them with one throws away the boundary:
 *
 *   schema `public`,    table `"q3.totals"` → `t:public.q3.totals`
 *   schema `"my.sch"`,  table `users`      → `t:my.sch.users`
 *
 * Those two are indistinguishable. Splitting on the last dot resolves the
 * second correctly and the first wrongly (schema `public.q3`, table
 * `totals`); splitting on the first would do the reverse. Last-dot is the
 * better bet only because a dotted *schema* is rarer than a dotted *table*
 * — this is a heuristic, not a parse.
 *
 * The consequence is bounded: a mis-split addresses an object that does not
 * exist, so the metadata request fails and the node stays empty. It cannot
 * misdirect a write — nothing here reaches `buildUpdate`. Fixing it properly
 * means making the id unambiguous (encode each part, or carry schema and
 * table separately) rather than choosing a cleverer dot.
 *
 * Returns null for anything unrecognised rather than guessing.
 */
export function parseNode(id: string): ParsedNode | null {
  const colon = id.indexOf(":");
  if (colon <= 0) return null;
  const tag = id.slice(0, colon);
  const rest = id.slice(colon + 1);
  if (!rest) return null;

  if (tag === "s") return { tag: "s", schema: rest };
  if (tag === "g") {
    // `g:schema:kind` — a colon, because a kind is never qualified.
    const sep = rest.lastIndexOf(":");
    if (sep <= 0) return null;
    return { tag: "g", schema: rest.slice(0, sep), kind: rest.slice(sep + 1) };
  }
  if (tag === "t" || tag === "c" || tag === "i" || tag === "k" || tag === "p") {
    const dot = rest.lastIndexOf(".");
    if (dot <= 0 || dot === rest.length - 1) return null;
    return {
      tag: tag,
      schema: rest.slice(0, dot),
      table: rest.slice(dot + 1),
      key: rest,
    };
  }
  return null;
}

/** The metadata request a node needs, or null when it needs none. */
export type NodeRequest = Record<string, unknown> | null;

/**
 * What to fetch when a node is opened.
 *
 * `loaded` is the set of keys already in hand. Returning null for those is
 * what keeps opening a node the user has opened before free — on a schema
 * with 13,000 relations, re-fetching on every expand is the difference
 * between a tree and a spinner.
 */
export function nodeRequest(id: string, loaded: (key: string) => boolean): NodeRequest {
  const n = parseNode(id);
  if (!n) return null;
  if (n.tag === "g" || n.tag === "t") return null; // pure presentation
  if (n.tag === "s") {
    return loaded(n.schema) ? null : { kind: "list_objects", schema: n.schema };
  }
  if (loaded(n.key)) return null;
  switch (n.tag) {
    case "c":
      return { kind: "describe_object", schema: n.schema, name: n.table };
    case "i":
      return { kind: "list_indexes", schema: n.schema, table: n.table };
    case "k":
      return { kind: "list_constraints", schema: n.schema, table: n.table };
    case "p":
      return { kind: "list_partitions", schema: n.schema, table: n.table };
  }
}

/**
 * The schemas the editor resolves unqualified names against.
 *
 * Not the server's real `search_path` — this is the app's approximation, and
 * it prefers `public` when it exists because that is what an unqualified name
 * almost always means.
 */
export function defaultSearchPath(schemas: string[] | null): string[] {
  if (schemas?.includes("public")) return ["public"];
  if (schemas?.length) return [schemas[0]];
  return ["public"];
}
