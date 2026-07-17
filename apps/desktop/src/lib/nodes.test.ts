import { describe, expect, it } from "vitest";
import { defaultSearchPath, groupId, nodeId, nodeRequest, parseNode, schemaId, tableKey } from "./nodes";

const none = () => false;
const all = () => true;

describe("parseNode", () => {
  it("reads a schema", () => {
    expect(parseNode("s:public")).toEqual({ tag: "s", schema: "public" });
  });

  it("reads a group", () => {
    expect(parseNode("g:public:table")).toEqual({ tag: "g", schema: "public", kind: "table" });
  });

  it("reads a table's columns", () => {
    expect(parseNode("c:public.users")).toEqual({
      tag: "c",
      schema: "public",
      table: "users",
      key: "public.users",
    });
  });

  it("keeps underscores and other non-dot punctuation in the table name", () => {
    expect(parseNode("i:analytics.engine__location__line__items")).toMatchObject({
      schema: "analytics",
      table: "engine__location__line__items",
    });
  });

  // The two cases that used to be the same string. An earlier test claimed to
  // prove the split rule using a fixture whose table name contained no dots —
  // with one dot in the id, first and last agree, so it passed against either
  // rule and pinned nothing. These two disagree, which is the whole point of
  // them: if the escaping is ever dropped, exactly one of them must fail.
  it("round-trips a dotted TABLE name", () => {
    // `CREATE TABLE "q3.totals"` is legal PostgreSQL.
    const id = nodeId("t", "public", "q3.totals");
    expect(parseNode(id)).toMatchObject({ schema: "public", table: "q3.totals" });
  });

  it("round-trips a dotted SCHEMA name", () => {
    const id = nodeId("t", "my.sch", "users");
    expect(parseNode(id)).toMatchObject({ schema: "my.sch", table: "users" });
  });

  it("tells those two apart — they used to be the same string", () => {
    expect(nodeId("t", "public", "q3.totals")).not.toBe(nodeId("t", "public.q3", "totals"));
  });

  it("round-trips a colon in a schema, which g:schema:kind also relied on", () => {
    expect(parseNode(groupId("we:rd", "table"))).toEqual({
      tag: "g",
      schema: "we:rd",
      kind: "table",
    });
    expect(parseNode(schemaId("we:rd"))).toEqual({ tag: "s", schema: "we:rd" });
  });

  it("round-trips a percent, including one that looks like an escape", () => {
    // `%2E` as a literal name must come back as `%2E`, not as `.` — which is
    // why decoding is one pass rather than three sequential replaces.
    for (const name of ["100%", "%2E", "%25", "a%2Eb.c"]) {
      expect(parseNode(nodeId("c", "public", name))).toMatchObject({
        schema: "public",
        table: name,
      });
    }
  });

  it("refuses an id with a stray separator rather than guessing", () => {
    // Only reachable by hand or from an older format. Returning null leaves
    // the node empty; interpreting it is how the original bug behaved.
    expect(parseNode("t:public.q3.totals")).toBeNull();
  });

  it("leaves ordinary names byte-identical, so ids did not change", () => {
    expect(nodeId("c", "public", "users")).toBe("c:public.users");
    expect(schemaId("public")).toBe("s:public");
    expect(groupId("public", "table")).toBe("g:public:table");
    expect(tableKey("public", "users")).toBe("public.users");
  });

  it("parseNode's key is exactly what tableKey builds, for both writers", () => {
    // These index the same `columns` map from opposite ends: parseNode derives
    // the key from an id, prefetchTables builds it from raw names. If they ever
    // disagree, columns are stored under one key and read under another and the
    // fetch silently repeats forever.
    const n = parseNode(nodeId("c", "my.sch", "q3.totals"));
    expect(n).not.toBeNull();
    expect(n && "key" in n && n.key).toBe(tableKey("my.sch", "q3.totals"));
  });

  it("reads a partition node under a dotted name", () => {
    expect(parseNode("p:analytics.messages")).toMatchObject({
      tag: "p",
      schema: "analytics",
      table: "messages",
    });
  });

  it.each(["", "nocolon", ":public", "s:", "z:public.users"])(
    "returns null for %s rather than guessing",
    (id) => expect(parseNode(id)).toBeNull(),
  );

  it("returns null for a table id with no schema", () => {
    expect(parseNode("c:users")).toBeNull();
  });

  it("returns null for a table id ending in a dot", () => {
    expect(parseNode("c:public.")).toBeNull();
  });
});

describe("nodeRequest — what to fetch", () => {
  it("asks for a schema's objects", () => {
    expect(nodeRequest("s:public", none)).toEqual({ kind: "list_objects", schema: "public" });
  });

  it("asks for columns", () => {
    expect(nodeRequest("c:public.users", none)).toEqual({
      kind: "describe_object",
      schema: "public",
      name: "users",
    });
  });

  it("asks for indexes", () => {
    expect(nodeRequest("i:public.users", none)).toEqual({
      kind: "list_indexes",
      schema: "public",
      table: "users",
    });
  });

  it("asks for constraints", () => {
    expect(nodeRequest("k:public.users", none)).toEqual({
      kind: "list_constraints",
      schema: "public",
      table: "users",
    });
  });

  it("asks for partitions", () => {
    expect(nodeRequest("p:public.users", none)).toEqual({
      kind: "list_partitions",
      schema: "public",
      table: "users",
    });
  });

  it("fetches nothing for a group or a table row — they only draw", () => {
    expect(nodeRequest("g:public:table", none)).toBeNull();
    expect(nodeRequest("t:public.users", none)).toBeNull();
  });

  it("fetches nothing for an unrecognised id", () => {
    expect(nodeRequest("zzz", none)).toBeNull();
  });
});

describe("nodeRequest — fetch once", () => {
  it("does not re-fetch a schema already in hand", () => {
    // 13,000 relations: re-listing on every expand is a spinner, not a tree.
    expect(nodeRequest("s:public", all)).toBeNull();
  });

  it("does not re-fetch columns already in hand", () => {
    expect(nodeRequest("c:public.users", all)).toBeNull();
  });

  it("keys the check on the qualified name, not the bare table", () => {
    // public.users and app.users are different tables with the same name.
    const loaded = (k: string) => k === "public.users";
    expect(nodeRequest("c:public.users", loaded)).toBeNull();
    expect(nodeRequest("c:app.users", loaded)).not.toBeNull();
  });

  it("keys a schema on its own name", () => {
    const loaded = (k: string) => k === "public";
    expect(nodeRequest("s:public", loaded)).toBeNull();
    expect(nodeRequest("s:analytics", loaded)).not.toBeNull();
  });

  it("tracks each kind of child separately", () => {
    // Having a table's columns says nothing about having its indexes.
    const loaded = (k: string) => k === "public.users";
    expect(nodeRequest("c:public.users", loaded)).toBeNull();
    expect(nodeRequest("i:public.users", loaded)).toBeNull();
    // Different tables are independent.
    expect(nodeRequest("i:public.orders", loaded)).not.toBeNull();
  });
});

describe("defaultSearchPath", () => {
  it("prefers public, which is what an unqualified name usually means", () => {
    expect(defaultSearchPath(["analytics", "public"])).toEqual(["public"]);
  });

  it("falls back to the first schema when there is no public", () => {
    expect(defaultSearchPath(["analytics", "reporting"])).toEqual(["analytics"]);
  });

  it("assumes public before the schema list has loaded", () => {
    expect(defaultSearchPath(null)).toEqual(["public"]);
    expect(defaultSearchPath([])).toEqual(["public"]);
  });
});
