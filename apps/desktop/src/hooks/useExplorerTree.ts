import { useCallback, useRef, useState } from "react";
import { errText } from "../lib/text";
import type { DbColumn, DbConstraint, DbIndex, DbObject, DbPartition, DbRoutine, DbType } from "../ipc/types";
import { nodeRequest, parseNode } from "../lib/nodes";

/** What a metadata fetch comes back as. `cached` means it was served from the
 *  local metadata cache rather than the server. */
export type MetaResult = { payload: unknown; cached?: boolean } | null;
export type MetaFetch = (req: Record<string, unknown>) => Promise<MetaResult>;

export type ExplorerTree = {
  openNodes: Record<string, boolean>;
  objects: Record<string, DbObject[]>;
  columns: Record<string, DbColumn[]>;
  indexes: Record<string, DbIndex[]>;
  constraints: Record<string, DbConstraint[]>;
  partitions: Record<string, DbPartition[]>;
  types: Record<string, DbType[]>;
  routines: Record<string, DbRoutine[]>;
  /** True once anything on screen came from the cache rather than the server. */
  metaCached: boolean;
  /** For the schema listing, which App fetches itself — it is not a tree node. */
  setMetaCached: (v: boolean) => void;
  toggle: (key: string) => Promise<void>;
  /** Load a schema's objects for autocomplete, without opening the node. */
  prefetchSchemaObjects: (schema: string) => Promise<void>;
  /** Load columns for tables the user is typing about. */
  prefetchTables: (want: { schema: string; name: string }[]) => void;
  /** Drop everything. A new connection is a new catalog. */
  reset: () => void;
};

/**
 * The lazy schema tree.
 *
 * Which request a node needs — including "none, it is already loaded" — is
 * decided in lib/nodes, where it is tested without a database. This holds what
 * came back and when to ask.
 *
 * The distinction between an empty answer and a failed one is carried by
 * whether the key exists at all:
 *
 * - Answered, with nothing in it → an empty list is recorded. The key exists,
 *   so the node is never fetched again; the tree draws an empty group. On a
 *   schema with 13,000 relations, re-listing an empty node on every expand is
 *   the difference between a tree and a spinner.
 * - Failed → nothing is recorded and the key stays absent, so the next click
 *   tries again. A dropped connection should not permanently brand a node as
 *   empty when nobody ever found out what was in it.
 */
export function useExplorerTree(metaFetch: MetaFetch, onError?: (message: string) => void): ExplorerTree {
  const [openNodes, setOpenNodes] = useState<Record<string, boolean>>({});
  const [objects, setObjects] = useState<Record<string, DbObject[]>>({});
  const [columns, setColumns] = useState<Record<string, DbColumn[]>>({});
  const [indexes, setIndexes] = useState<Record<string, DbIndex[]>>({});
  const [constraints, setConstraints] = useState<Record<string, DbConstraint[]>>({});
  const [partitions, setPartitions] = useState<Record<string, DbPartition[]>>({});
  const [types, setTypes] = useState<Record<string, DbType[]>>({});
  const [routines, setRoutines] = useState<Record<string, DbRoutine[]>>({});
  const [metaCached, setMetaCached] = useState(false);
  /** Keys currently being prefetched, so a burst of keystrokes asking for the
   *  same table fires one request rather than one per stroke. */
  const inFlight = useRef<Set<string>>(new Set());

  const reset = useCallback(() => {
    setOpenNodes({});
    setObjects({});
    setColumns({});
    setIndexes({});
    setConstraints({});
    setPartitions({});
    setTypes({});
    setRoutines({});
    setMetaCached(false);
  }, []);

  const toggle = useCallback(
    async (key: string) => {
      const opening = !openNodes[key];
      setOpenNodes((m) => ({ ...m, [key]: opening }));
      if (!opening) return;

      const node = parseNode(key);
      if (!node) return;
      // Groups and table rows are presentation: they fetch nothing and have no
      // key to look up. Leaving them to fall through meant `loadedFor` needed a
      // `default` arm that nothing could ever reach.
      if (node.tag === "g" || node.tag === "t") return;

      // Read the tag out here: narrowed to the five fetching kinds, the switch
      // below is exhaustive and needs no unreachable default.
      const tag: "s" | "c" | "i" | "k" | "p" = node.tag;
      const loadedFor = (k: string) => {
        switch (tag) {
          case "s":
            return k in objects;
          case "c":
            return k in columns;
          case "i":
            return k in indexes;
          case "k":
            return k in constraints;
          case "p":
            return k in partitions;
        }
      };
      // Types and routines are small, and are fetched whenever a schema is
      // opened without their own list yet.
      //
      // They used to be fetched inside the objects branch below, which is only
      // reached when the objects still need loading. Anything that had already
      // pulled a schema's tables — the autocomplete prefetch does, on connect —
      // therefore made expanding that schema a no-op, and its enums and
      // functions never appeared at all. Whether the tables are loaded is a
      // different question from whether the types are.
      if (node.tag === "s") {
        if (!(node.schema in types)) {
          metaFetch({ kind: "list_types", schema: node.schema })
            .then((t) => setTypes((m) => ({ ...m, [node.schema]: t ? (t.payload as DbType[]) : [] })))
            .catch(() => setTypes((m) => ({ ...m, [node.schema]: [] })));
        }
        if (!(node.schema in routines)) {
          metaFetch({ kind: "list_routines", schema: node.schema })
            .then((t) => setRoutines((m) => ({ ...m, [node.schema]: t ? (t.payload as DbRoutine[]) : [] })))
            .catch(() => setRoutines((m) => ({ ...m, [node.schema]: [] })));
        }
      }

      const req = nodeRequest(key, loadedFor);
      if (!req) return;

      try {
        const r = await metaFetch(req);
        if (node.tag === "s") {
          setObjects((m) => ({ ...m, [node.schema]: r ? (r.payload as DbObject[]) : [] }));
          if (r?.cached) setMetaCached(true);
          return;
        }
        const k = node.key;
        if (node.tag === "c") {
          const desc = r?.payload as { columns: DbColumn[] } | undefined;
          setColumns((m) => ({ ...m, [k]: desc?.columns ?? [] }));
          if (r?.cached) setMetaCached(true);
        } else if (node.tag === "i") {
          setIndexes((m) => ({ ...m, [k]: r ? (r.payload as DbIndex[]) : [] }));
        } else if (node.tag === "k") {
          setConstraints((m) => ({ ...m, [k]: r ? (r.payload as DbConstraint[]) : [] }));
        } else if (node.tag === "p") {
          setPartitions((m) => ({ ...m, [k]: r ? (r.payload as DbPartition[]) : [] }));
        }
      } catch (e) {
        onError?.(`Explorer error: ${errText(e)}`);
      }
    },
    [openNodes, objects, columns, indexes, constraints, partitions, types, routines, metaFetch, onError],
  );

  /**
   * Load a schema's objects for autocomplete without opening the node.
   *
   * Best-effort throughout: completion is a convenience, so a failure here is
   * swallowed rather than shown. The user did not ask for this fetch and has
   * nothing to do about it failing.
   */
  const prefetchSchemaObjects = useCallback(
    async (schema: string) => {
      const key = `objs:${schema}`;
      if (schema in objects || inFlight.current.has(key)) return;
      inFlight.current.add(key);
      try {
        const r = await metaFetch({ kind: "list_objects", schema });
        setObjects((m) => ({ ...m, [schema]: r ? (r.payload as DbObject[]) : [] }));
      } catch {
        // Swallowed on purpose — see above.
      } finally {
        inFlight.current.delete(key);
      }
    },
    [objects, metaFetch],
  );

  const prefetchTables = useCallback(
    (want: { schema: string; name: string }[]) => {
      for (const { schema, name } of want) {
        const key = `${schema}.${name}`;
        if (key in columns || inFlight.current.has(key)) continue;
        inFlight.current.add(key);
        metaFetch({ kind: "describe_object", schema, name })
          .then((r) => {
            if (r) setColumns((m) => ({ ...m, [key]: (r.payload as { columns: DbColumn[] }).columns }));
          })
          .catch(() => {
            // The table may not exist yet — the user is mid-word.
          })
          .finally(() => inFlight.current.delete(key));
      }
    },
    [columns, metaFetch],
  );

  return {
    openNodes,
    objects,
    columns,
    indexes,
    constraints,
    partitions,
    types,
    routines,
    metaCached,
    setMetaCached,
    toggle,
    prefetchSchemaObjects,
    prefetchTables,
    reset,
  };
}
