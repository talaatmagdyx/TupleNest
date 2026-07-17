import { describe, expect, it } from "vitest";
import { defaultSearchPath, nodeRequest, parseNode } from "./nodes";

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

  it("splits on the LAST dot, because table names contain them", () => {
    // `engine__location__eng__interactions` is a real table here. Splitting on
    // the first dot would address a table that does not exist.
    expect(parseNode("i:company_1_schema.engine__location__eng__interactions")).toMatchObject({
      schema: "company_1_schema",
      table: "engine__location__eng__interactions",
    });
  });

  it("reads a partition node under a dotted name", () => {
    expect(parseNode("p:company_1_schema.eng_interactions")).toMatchObject({
      tag: "p",
      schema: "company_1_schema",
      table: "eng_interactions",
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
    expect(defaultSearchPath(["company_1_schema", "inbox_e2e_schema"])).toEqual(["company_1_schema"]);
  });

  it("assumes public before the schema list has loaded", () => {
    expect(defaultSearchPath(null)).toEqual(["public"]);
    expect(defaultSearchPath([])).toEqual(["public"]);
  });
});
