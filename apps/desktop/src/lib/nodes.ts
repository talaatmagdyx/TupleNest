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

/*
 * ---------------------------------------------------------------------------
 * Why identifiers are escaped before they go into an id
 *
 * An id used to be built by joining with a dot and taken apart by splitting on
 * one, which is not reversible. PostgreSQL allows any character inside a
 * quoted identifier — `CREATE TABLE "q3.totals"` is legal — so both halves can
 * contain the separator, and these two are the *same string*:
 *
 *   schema `public`,   table `"q3.totals"` → t:public.q3.totals
 *   schema `"my.sch"`, table `users`       → t:my.sch.users
 *
 * No choice of dot recovers both. Last-dot resolved the second and mangled the
 * first; first-dot did the reverse. The old comment argued for first-dot while
 * the code did last-dot, and the test that claimed to settle it used a fixture
 * whose table name had no dots at all — so it passed either way and pinned
 * nothing. The bug was invisible for exactly that reason.
 *
 * The fix is to stop throwing the boundary away. Each half is escaped so that
 * it cannot contain a separator, which makes the join reversible and the split
 * a parse instead of a guess. `:` is escaped for the same reason — `g:schema:kind`
 * had the identical flaw one separator over.
 *
 * Names without `%`, `.` or `:` — which is very nearly all of them — encode to
 * themselves, so ids and keys are byte-identical to what they were.
 * ---------------------------------------------------------------------------
 */

/**
 * Escape the three characters the id format reserves.
 *
 * `%` goes first, so that the escapes introduced for `.` and `:` are not
 * themselves re-escaped on the way out.
 */
export function encodePart(s: string): string {
  return s.replace(/%/g, "%25").replace(/\./g, "%2E").replace(/:/g, "%3A");
}

/**
 * Inverse of {@link encodePart}.
 *
 * One pass, not three sequential replaces: unescaping `%2E` before `%25` would
 * corrupt a name that legitimately contains the text `%2E` (encoded `%252E`,
 * which must come back as `%2E` and not as `.`). Matching each escape once,
 * left to right, cannot make that mistake.
 */
export function decodePart(s: string): string {
  return s.replace(/%(25|2E|3A)/g, (_m, h: string) =>
    h === "25" ? "%" : h === "2E" ? "." : ":",
  );
}

/**
 * The canonical `schema.table` key.
 *
 * This is one keyspace with several writers — `parseNode` derives it from an
 * id, `prefetchTables` builds it before any node exists, and `dml`/`complete`
 * read it out of the catalog. They must agree exactly or columns get stored
 * under one key and looked up under another, so they all come through here.
 */
export function tableKey(schema: string, table: string): string {
  return `${encodePart(schema)}.${encodePart(table)}`;
}

/** The id of a node addressing a table (or one of its child lists). */
export function nodeId(tag: Exclude<NodeTag, "s" | "g">, schema: string, table: string): string {
  return `${tag}:${tableKey(schema, table)}`;
}

/** The id of a schema node. */
export function schemaId(schema: string): string {
  return `s:${encodePart(schema)}`;
}

/** The id of a group node (`table`, `view`, ...) under a schema. */
export function groupId(schema: string, kind: string): string {
  return `g:${encodePart(schema)}:${kind}`;
}

/**
 * Split a node id into what it addresses.
 *
 * Both halves are escaped (see above), so each separator below occurs exactly
 * once and this is a parse rather than a heuristic. Returns null for anything
 * unrecognised — including an id with a stray separator, which can only be
 * hand-written or from an older format — rather than guessing at it.
 */
export function parseNode(id: string): ParsedNode | null {
  const colon = id.indexOf(":");
  if (colon <= 0) return null;
  const tag = id.slice(0, colon);
  const rest = id.slice(colon + 1);
  if (!rest) return null;

  if (tag === "s") return { tag: "s", schema: decodePart(rest) };
  if (tag === "g") {
    // `g:schema:kind`. The schema is escaped, so the first colon is the one.
    const sep = rest.indexOf(":");
    if (sep <= 0 || sep === rest.length - 1) return null;
    return {
      tag: "g",
      schema: decodePart(rest.slice(0, sep)),
      kind: rest.slice(sep + 1),
    };
  }
  if (tag === "t" || tag === "c" || tag === "i" || tag === "k" || tag === "p") {
    const dot = rest.indexOf(".");
    if (dot <= 0 || dot === rest.length - 1) return null;
    // Exactly one dot, or this id was not built by `tableKey` and its shape is
    // not something to interpret.
    if (rest.indexOf(".", dot + 1) !== -1) return null;
    return {
      tag: tag,
      schema: decodePart(rest.slice(0, dot)),
      table: decodePart(rest.slice(dot + 1)),
      // Already canonical: `rest` is exactly what `tableKey` produces.
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
