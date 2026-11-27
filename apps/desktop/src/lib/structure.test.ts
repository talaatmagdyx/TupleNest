import { describe, expect, it, vi } from "vitest";
import { HAS_STRUCTURE, loadStructure, parseForeignKey } from "./structure";

describe("loadStructure", () => {
  it("asks for columns, indexes and constraints, and keeps what came back", async () => {
    const fetch = vi.fn(async (req: Record<string, unknown>) => {
      if (req.kind === "describe_object") return { payload: { columns: [{ name: "id" }] } };
      if (req.kind === "list_indexes") return { payload: [{ name: "pk" }] };
      return { payload: [{ name: "fk" }] };
    });
    const s = await loadStructure(fetch, "public", "orders");
    expect(fetch).toHaveBeenCalledWith({ kind: "describe_object", schema: "public", name: "orders" });
    expect(fetch).toHaveBeenCalledWith({ kind: "list_indexes", schema: "public", table: "orders" });
    expect(fetch).toHaveBeenCalledWith({ kind: "list_constraints", schema: "public", table: "orders" });
    expect(s.columns).toEqual([{ name: "id" }]);
    expect(s.indexes).toEqual([{ name: "pk" }]);
    expect(s.constraints).toEqual([{ name: "fk" }]);
  });

  it("keeps the parts that worked when one fails, and never rejects", async () => {
    const fetch = vi.fn(async (req: Record<string, unknown>) => {
      if (req.kind === "list_indexes") throw new Error("permission denied");
      if (req.kind === "list_constraints") return null;
      return { payload: { columns: [{ name: "id" }] } };
    });
    const s = await loadStructure(fetch, "public", "orders");
    expect(s).toEqual({ columns: [{ name: "id" }], indexes: [], constraints: [] });
  });

  it("treats a payload of the wrong shape as empty", async () => {
    const s = await loadStructure(async () => ({ payload: {} }), "s", "t");
    expect(s).toEqual({ columns: [], indexes: [], constraints: [] });
  });
});

describe("parseForeignKey", () => {
  it("splits a foreign key into its columns and its target", () => {
    expect(parseForeignKey("FOREIGN KEY (customer_id) REFERENCES customers(id)")).toEqual({
      from: "customer_id",
      to: "customers.id",
    });
    expect(parseForeignKey("FOREIGN KEY (a, b) REFERENCES s.t (x, y) ON DELETE CASCADE")).toEqual({
      from: "a, b",
      to: "s.t(x, y)",
    });
  });

  it("gives up on anything else", () => {
    expect(parseForeignKey("CHECK (x > 0)")).toBeNull();
    expect(parseForeignKey(null)).toBeNull();
  });
});

it("knows which kinds have columns", () => {
  expect(HAS_STRUCTURE.has("table")).toBe(true);
  expect(HAS_STRUCTURE.has("sequence")).toBe(false);
});
