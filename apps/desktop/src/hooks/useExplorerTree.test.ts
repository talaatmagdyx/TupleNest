import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useExplorerTree, type MetaFetch, type MetaResult } from "./useExplorerTree";

/** A metaFetch that answers each `kind` from a table. */
const server = (by: Record<string, MetaResult>): MetaFetch =>
  vi.fn(async (req: Record<string, unknown>) => by[req.kind as string] ?? { payload: [] });

const DEFAULTS: Record<string, MetaResult> = {
  list_objects: { payload: [{ name: "users", kind: "table" }] },
  list_types: { payload: [{ name: "mood" }] },
  list_routines: { payload: [{ name: "f" }] },
  describe_object: { payload: { columns: [{ name: "id" }] } },
  list_indexes: { payload: [{ name: "users_pkey" }] },
  list_constraints: { payload: [{ name: "users_fk" }] },
  list_partitions: { payload: [{ name: "users_p1" }] },
};

const kinds = (f: MetaFetch) => (f as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].kind);

let fetchMock: MetaFetch;
beforeEach(() => {
  fetchMock = server(DEFAULTS);
});

const mount = (f: MetaFetch = fetchMock, onError?: (m: string) => void) =>
  renderHook(() => useExplorerTree(f, onError));

const toggle = async (result: { current: ReturnType<typeof useExplorerTree> }, key: string) => {
  await act(async () => void (await result.current.toggle(key)));
};

describe("useExplorerTree — opening and closing", () => {
  it("starts closed with nothing loaded", () => {
    const { result } = mount();
    expect(result.current.openNodes).toEqual({});
    expect(result.current.objects).toEqual({});
  });

  it("opens a node", async () => {
    const { result } = mount();
    await toggle(result, "s:public");
    expect(result.current.openNodes["s:public"]).toBe(true);
  });

  it("closes an open node", async () => {
    const { result } = mount();
    await toggle(result, "s:public");
    await toggle(result, "s:public");
    expect(result.current.openNodes["s:public"]).toBe(false);
  });

  it("fetches nothing when closing", async () => {
    const { result } = mount();
    await toggle(result, "s:public");
    const before = kinds(fetchMock).length;
    await toggle(result, "s:public");
    expect(kinds(fetchMock)).toHaveLength(before);
  });

  it("keeps what it loaded when the node is closed again", async () => {
    // Collapsing a group is not a reason to throw away 13,000 relations.
    const { result } = mount();
    await toggle(result, "s:public");
    await toggle(result, "s:public");
    expect(result.current.objects.public).toHaveLength(1);
  });
});

describe("useExplorerTree — what each node loads", () => {
  it("loads a schema's objects, types and routines together", async () => {
    // Types and routines are small. Fetching them alongside makes the groups
    // appear with the tables rather than a beat later.
    const { result } = mount();
    await toggle(result, "s:public");
    await waitFor(() => expect(result.current.routines.public).toHaveLength(1));
    // All three go out; the order between them is not something to pin, and
    // asserting it made an unrelated fix look like a failure.
    expect(kinds(fetchMock).sort()).toEqual(["list_objects", "list_routines", "list_types"]);
    expect(result.current.objects.public).toEqual([{ name: "users", kind: "table" }]);
    expect(result.current.types.public).toEqual([{ name: "mood" }]);
  });

  it("unwraps the columns out of a describe_object payload", async () => {
    const { result } = mount();
    await toggle(result, "c:public.users");
    expect(result.current.columns["public.users"]).toEqual([{ name: "id" }]);
  });

  it("loads indexes", async () => {
    const { result } = mount();
    await toggle(result, "i:public.users");
    expect(result.current.indexes["public.users"]).toEqual([{ name: "users_pkey" }]);
  });

  it("loads constraints", async () => {
    const { result } = mount();
    await toggle(result, "k:public.users");
    expect(result.current.constraints["public.users"]).toEqual([{ name: "users_fk" }]);
  });

  it("loads partitions", async () => {
    const { result } = mount();
    await toggle(result, "p:public.users");
    expect(result.current.partitions["public.users"]).toEqual([{ name: "users_p1" }]);
  });

  it("fetches nothing for a group or a table row — they only draw", async () => {
    const { result } = mount();
    await toggle(result, "g:public:table");
    await toggle(result, "t:public.users");
    expect(kinds(fetchMock)).toEqual([]);
    expect(result.current.openNodes["g:public:table"]).toBe(true);
  });

  it("fetches nothing for an id it cannot read", async () => {
    const { result } = mount();
    await toggle(result, "nonsense");
    expect(kinds(fetchMock)).toEqual([]);
  });
});

describe("useExplorerTree — fetching once", () => {
  it("does not re-fetch a schema already in hand", async () => {
    // Re-listing on every expand is a spinner, not a tree.
    const { result } = mount();
    await toggle(result, "s:public");
    await toggle(result, "s:public"); // close
    await toggle(result, "s:public"); // open again
    expect(kinds(fetchMock).filter((k) => k === "list_objects")).toHaveLength(1);
  });

  it("does not re-fetch columns already in hand", async () => {
    const { result } = mount();
    await toggle(result, "c:public.users");
    await toggle(result, "c:public.users");
    await toggle(result, "c:public.users");
    expect(kinds(fetchMock).filter((k) => k === "describe_object")).toHaveLength(1);
  });

  it("does not re-fetch a node whose result was empty", async () => {
    // Empty means "asked, got nothing". Only *absent* means "not asked" — if
    // an empty answer re-fetched, a genuinely empty schema would hit the
    // server on every single click.
    const { result } = mount(server({ ...DEFAULTS, list_indexes: { payload: [] } }));
    await toggle(result, "i:public.users");
    await toggle(result, "i:public.users");
    await toggle(result, "i:public.users");
    expect(result.current.indexes["public.users"]).toEqual([]);
  });

  it("does not re-fetch partitions already in hand", async () => {
    const { result } = mount();
    await toggle(result, "p:public.users");
    await toggle(result, "p:public.users"); // close
    await toggle(result, "p:public.users"); // open again
    expect(kinds(fetchMock).filter((k) => k === "list_partitions")).toHaveLength(1);
  });

  it("does not re-fetch constraints already in hand", async () => {
    const { result } = mount();
    await toggle(result, "k:public.users");
    await toggle(result, "k:public.users");
    await toggle(result, "k:public.users");
    expect(kinds(fetchMock).filter((k) => k === "list_constraints")).toHaveLength(1);
  });

  it("tracks each kind of child separately", async () => {
    const { result } = mount();
    await toggle(result, "c:public.users");
    await toggle(result, "i:public.users");
    expect(kinds(fetchMock)).toEqual(["describe_object", "list_indexes"]);
  });

  it("keys on the qualified name — two schemas can hold the same table", async () => {
    const { result } = mount();
    await toggle(result, "c:public.users");
    await toggle(result, "c:app.users");
    expect(kinds(fetchMock).filter((k) => k === "describe_object")).toHaveLength(2);
    expect(Object.keys(result.current.columns).sort()).toEqual(["app.users", "public.users"]);
  });
});

describe("useExplorerTree — failure", () => {
  it("records nothing, so the node can be tried again", async () => {
    // A failure is not an answer. Recording an empty list here would brand the
    // node as empty forever on the strength of a dropped connection — the key
    // must stay absent so the next click re-fetches.
    let fail = true;
    const flaky: MetaFetch = vi.fn(async () => {
      if (fail) throw new Error("connection reset");
      return { payload: [{ name: "users_pkey" }] };
    });
    const { result } = mount(flaky, vi.fn());
    await toggle(result, "i:public.users");
    expect(result.current.indexes).not.toHaveProperty("public.users");

    fail = false;
    await toggle(result, "i:public.users"); // close
    await toggle(result, "i:public.users"); // open — retries
    expect(result.current.indexes["public.users"]).toEqual([{ name: "users_pkey" }]);
  });

  it("reports the error rather than failing silently", async () => {
    const boom: MetaFetch = vi.fn(async () => {
      throw new Error("permission denied for schema secret");
    });
    const onError = vi.fn();
    const { result } = mount(boom, onError);
    await toggle(result, "s:secret");
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("permission denied"));
  });

  it("survives having no error handler", async () => {
    const boom: MetaFetch = vi.fn(async () => {
      throw new Error("x");
    });
    const { result } = mount(boom);
    await expect(toggle(result, "s:public")).resolves.toBeUndefined();
  });

  it("records empty when the fetch comes back null", async () => {
    const { result } = mount(server({ list_objects: null }));
    await toggle(result, "s:public");
    expect(result.current.objects.public).toEqual([]);
  });

  it("records empty columns when describe_object comes back without any", async () => {
    const { result } = mount(server({ ...DEFAULTS, describe_object: { payload: {} } }));
    await toggle(result, "c:public.users");
    expect(result.current.columns["public.users"]).toEqual([]);
  });

  it("keeps the tables when only types and routines fail", async () => {
    // The schema listing is the point of the node; a failed side-fetch of
    // types must not take the tables down with it.
    const f: MetaFetch = vi.fn(async (req) => {
      if (req.kind === "list_types" || req.kind === "list_routines") throw new Error("nope");
      return DEFAULTS.list_objects;
    });
    const { result } = mount(f);
    await toggle(result, "s:public");
    await waitFor(() => expect(result.current.types.public).toEqual([]));
    expect(result.current.objects.public).toHaveLength(1);
    expect(result.current.routines.public).toEqual([]);
  });
});

describe("useExplorerTree — the cache flag", () => {
  it("stays down for a live answer", async () => {
    const { result } = mount();
    await toggle(result, "s:public");
    expect(result.current.metaCached).toBe(false);
  });

  it("goes up when a schema listing came from the cache", async () => {
    const { result } = mount(server({ ...DEFAULTS, list_objects: { payload: [], cached: true } }));
    await toggle(result, "s:public");
    expect(result.current.metaCached).toBe(true);
  });

  it("goes up when columns came from the cache", async () => {
    const { result } = mount(server({ ...DEFAULTS, describe_object: { payload: { columns: [] }, cached: true } }));
    await toggle(result, "c:public.users");
    expect(result.current.metaCached).toBe(true);
  });
});

describe("useExplorerTree — prefetching for autocomplete", () => {
  it("loads a schema's objects without opening the node", async () => {
    const { result } = mount();
    await act(async () => void (await result.current.prefetchSchemaObjects("public")));
    expect(result.current.objects.public).toHaveLength(1);
    expect(result.current.openNodes).toEqual({});
  });

  it("does not re-fetch a schema the tree already has", async () => {
    const { result } = mount();
    await toggle(result, "s:public");
    await act(async () => void (await result.current.prefetchSchemaObjects("public")));
    expect(kinds(fetchMock).filter((k) => k === "list_objects")).toHaveLength(1);
  });

  it("stays silent when it fails — nobody asked for it", async () => {
    // Completion is a convenience. Raising an error banner for a fetch the
    // user never requested, about a table they are halfway through typing,
    // is noise they can do nothing with.
    const boom: MetaFetch = vi.fn(async () => {
      throw new Error("nope");
    });
    const onError = vi.fn();
    const { result } = mount(boom, onError);
    await act(async () => void (await result.current.prefetchSchemaObjects("public")));
    expect(onError).not.toHaveBeenCalled();
  });

  it("loads columns for the tables named", async () => {
    const { result } = mount();
    await act(async () => {
      result.current.prefetchTables([{ schema: "public", name: "users" }]);
    });
    await waitFor(() => expect(result.current.columns["public.users"]).toEqual([{ name: "id" }]));
  });

  it("fires one request for a table asked for twice in a burst", async () => {
    // Every keystroke re-asks. Without the in-flight guard, typing `users`
    // fires five identical describes.
    const { result } = mount();
    await act(async () => {
      result.current.prefetchTables([{ schema: "public", name: "users" }]);
      result.current.prefetchTables([{ schema: "public", name: "users" }]);
      result.current.prefetchTables([{ schema: "public", name: "users" }]);
    });
    await waitFor(() => expect(result.current.columns["public.users"]).toBeDefined());
    expect(kinds(fetchMock).filter((k) => k === "describe_object")).toHaveLength(1);
  });

  it("skips a table the tree already has columns for", async () => {
    const { result } = mount();
    await toggle(result, "c:public.users");
    await act(async () => {
      result.current.prefetchTables([{ schema: "public", name: "users" }]);
    });
    expect(kinds(fetchMock).filter((k) => k === "describe_object")).toHaveLength(1);
  });

  it("stays silent for a table that does not exist", async () => {
    const boom: MetaFetch = vi.fn(async () => {
      throw new Error("relation does not exist");
    });
    const onError = vi.fn();
    const { result } = mount(boom, onError);
    await act(async () => {
      result.current.prefetchTables([{ schema: "public", name: "use" }]);
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("lets a failed prefetch be retried", async () => {
    // The in-flight key must be released on failure too, or the table is
    // never fetched again for the life of the session.
    let fail = true;
    const flaky: MetaFetch = vi.fn(async () => {
      if (fail) throw new Error("reset");
      return { payload: { columns: [{ name: "id" }] } };
    });
    const { result } = mount(flaky);
    await act(async () => {
      result.current.prefetchTables([{ schema: "public", name: "users" }]);
    });
    fail = false;
    await act(async () => {
      result.current.prefetchTables([{ schema: "public", name: "users" }]);
    });
    await waitFor(() => expect(result.current.columns["public.users"]).toEqual([{ name: "id" }]));
  });

  it("asks for several tables at once", async () => {
    const { result } = mount();
    await act(async () => {
      result.current.prefetchTables([
        { schema: "public", name: "users" },
        { schema: "public", name: "orders" },
      ]);
    });
    await waitFor(() => expect(Object.keys(result.current.columns)).toHaveLength(2));
  });
});

describe("useExplorerTree — reset", () => {
  it("drops everything, because a new connection is a new catalog", async () => {
    const { result } = mount(server({ ...DEFAULTS, list_objects: { payload: [], cached: true } }));
    await toggle(result, "s:public");
    await toggle(result, "c:public.users");
    act(() => result.current.reset());
    expect(result.current.openNodes).toEqual({});
    expect(result.current.objects).toEqual({});
    expect(result.current.columns).toEqual({});
    expect(result.current.metaCached).toBe(false);
  });

  it("lets a node be fetched again afterwards", async () => {
    const { result } = mount();
    await toggle(result, "s:public");
    act(() => result.current.reset());
    await toggle(result, "s:public");
    expect(kinds(fetchMock).filter((k) => k === "list_objects")).toHaveLength(2);
  });
});

describe("useExplorerTree — types and routines are not tied to the tables", () => {
  it("fetches a schema's types even when its tables are already loaded", async () => {
    // The autocomplete prefetches a schema's objects on connect. That used to
    // make expanding the schema a no-op, because the request was skipped — and
    // the types and routines fetches were sitting inside the skipped branch.
    // Every schema you had prefetched showed no enums and no functions.
    const fetch = server(DEFAULTS);
    const { result } = renderHook(() => useExplorerTree(fetch));

    await act(async () => await result.current.toggle("s:public"));
    await waitFor(() => expect(result.current.types.public).toBeDefined());
    // Collapse, and re-open with the objects now cached.
    await act(async () => await result.current.toggle("s:public"));
    vi.mocked(fetch).mockClear();
    await act(async () => await result.current.toggle("s:public"));

    // Already known — asking again would be waste, not correctness.
    const kinds = vi.mocked(fetch).mock.calls.map((c) => (c[0] as { kind: string }).kind);
    expect(kinds).not.toContain("list_types");
    expect(result.current.types.public).toEqual([{ name: "mood" }]);
    expect(result.current.routines.public).toEqual([{ name: "f" }]);
  });

  it("still fetches the types when only the objects were prefetched", async () => {
    const fetch = server(DEFAULTS);
    const { result } = renderHook(() => useExplorerTree(fetch));

    // Stand in for the prefetch: objects present, types never asked for.
    await act(async () => await result.current.toggle("s:public"));
    await waitFor(() => expect(result.current.objects.public).toBeDefined());
    await waitFor(() => expect(result.current.types.public).toEqual([{ name: "mood" }]));
    expect(result.current.routines.public).toEqual([{ name: "f" }]);
  });
});
