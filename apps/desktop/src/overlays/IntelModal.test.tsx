import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import IntelModal from "./IntelModal";
import type { Catalog } from "../lib/complete";

const invokeMock = vi.mocked(invoke);
beforeEach(() => invokeMock.mockReset());

const catalog: Catalog = {
  schemas: ["public", "analytics"],
  tables: [{ schema: "public", name: "users", kind: "table" }],
  columns: {},
  searchPath: ["public"],
};

const plan = (label: string, over: Record<string, unknown> = {}) => ({
  label,
  summary: { totalMs: 100, totalCost: 500, rows: 10, nodes: { "Seq Scan": 1 }, ...over },
});

const base = {
  tabs: [
    { name: "a.sql", sql: "select id from users where id = 1" },
    { name: "b.sql", sql: "select 1" },
  ],
  catalog,
  plans: [] as ReturnType<typeof plan>[],
  onJump: vi.fn(),
  onRename: vi.fn(),
  onClose: vi.fn(),
};

describe("IntelModal — shell", () => {
  it("offers all three panes and marks the active one", () => {
    render(<IntelModal {...base} />);
    expect(screen.getByRole("button", { name: /Find usages & rename/ })).toHaveClass("on");
    expect(screen.getByRole("button", { name: /Schema diff/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Plan compare/ })).toBeInTheDocument();
  });

  it("switches pane", async () => {
    render(<IntelModal {...base} />);
    await userEvent.click(screen.getByRole("button", { name: /Schema diff/ }));
    expect(screen.getByRole("button", { name: /Schema diff/ })).toHaveClass("on");
  });

  it("closes from the labelled button", async () => {
    const onClose = vi.fn();
    render(<IntelModal {...base} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on the backdrop but not on the dialog", async () => {
    const onClose = vi.fn();
    const { container } = render(<IntelModal {...base} onClose={onClose} />);
    await userEvent.click(screen.getByText("SQL intelligence"));
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.click(container.querySelector(".overlay")!);
    expect(onClose).toHaveBeenCalled();
  });
});

describe("IntelModal — find usages", () => {
  it("finds nothing until something is typed", () => {
    render(<IntelModal {...base} />);
    expect(screen.queryByText("No usages found")).not.toBeInTheDocument();
  });

  it("says so when an identifier appears nowhere", async () => {
    render(<IntelModal {...base} />);
    await userEvent.type(screen.getByPlaceholderText(/Identifier/), "zzz");
    expect(screen.getByText("No usages found")).toBeInTheDocument();
  });

  it("lists hits across every tab, named by tab", async () => {
    render(<IntelModal {...base} />);
    await userEvent.type(screen.getByPlaceholderText(/Identifier/), "users");
    expect(screen.getAllByText(/a\.sql/).length).toBeGreaterThan(0);
  });

  it("jumps to a hit", async () => {
    const onJump = vi.fn();
    render(<IntelModal {...base} onJump={onJump} />);
    await userEvent.type(screen.getByPlaceholderText(/Identifier/), "users");
    await userEvent.click(screen.getAllByText(/a\.sql/)[0]);
    expect(onJump).toHaveBeenCalledWith(0, expect.any(Number));
  });

  it("will not rename without both a source and a target", async () => {
    render(<IntelModal {...base} />);
    const renameBtn = screen.getByRole("button", { name: /^Rename/ });
    expect(renameBtn).toBeDisabled();
    await userEvent.type(screen.getByPlaceholderText(/Identifier/), "users");
    expect(renameBtn).toBeDisabled();
    await userEvent.type(screen.getByPlaceholderText(/Rename to/), "people");
    expect(renameBtn).toBeEnabled();
  });

  it("renames only the tabs that actually contain the identifier", async () => {
    // b.sql has no `users`; rewriting it would dirty a tab for nothing.
    const onRename = vi.fn();
    render(<IntelModal {...base} onRename={onRename} />);
    await userEvent.type(screen.getByPlaceholderText(/Identifier/), "users");
    await userEvent.type(screen.getByPlaceholderText(/Rename to/), "people");
    await userEvent.click(screen.getByRole("button", { name: /^Rename/ }));
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRename).toHaveBeenCalledWith(0, expect.stringContaining("people"));
  });
});

describe("IntelModal — schema diff", () => {
  const openDiff = async () => {
    render(<IntelModal {...base} />);
    await userEvent.click(screen.getByRole("button", { name: /Schema diff/ }));
  };

  it("defaults to two different schemas so compare is usable at once", async () => {
    await openDiff();
    expect(screen.queryByText("Pick two different schemas.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Compare/ })).toBeEnabled();
  });

  it("refuses to diff a schema against itself", async () => {
    await openDiff();
    await userEvent.selectOptions(screen.getAllByRole("combobox")[1], "public");
    expect(screen.getByText("Pick two different schemas.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Compare/ })).toBeDisabled();
  });

  it("reports identical schemas rather than an empty list", async () => {
    invokeMock.mockResolvedValue({ payload: [], fetchedAt: null, source: "live" });
    await openDiff();
    await userEvent.click(screen.getByRole("button", { name: /Compare/ }));
    expect(await screen.findByText("Schemas are identical")).toBeInTheDocument();
  });
});

describe("IntelModal — plan compare", () => {
  const openPlans = async (plans: ReturnType<typeof plan>[]) => {
    render(<IntelModal {...base} plans={plans} />);
    await userEvent.click(screen.getByRole("button", { name: /Plan compare/ }));
  };

  it("needs two plans before it can compare anything", async () => {
    await openPlans([plan("first")]);
    expect(screen.queryByText(/Execution time/)).not.toBeInTheDocument();
  });

  it("compares execution time and cost across two runs", async () => {
    await openPlans([plan("before"), plan("after", { totalMs: 250, totalCost: 900 })]);
    expect(screen.getByText("Execution time")).toBeInTheDocument();
    expect(screen.getByText("Estimated cost")).toBeInTheDocument();
  });

  it("calls out a sequential scan the newer plan introduced", async () => {
    // The regression worth shouting about: an index stopped being used.
    await openPlans([
      plan("before", { nodes: { "Index Scan": 1 } }),
      plan("after", { nodes: { "Seq Scan": 1 } }),
    ]);
    expect(screen.getByText(/New sequential scan/)).toBeInTheDocument();
  });

  it("stays quiet when the shape did not change", async () => {
    await openPlans([plan("before"), plan("after")]);
    expect(screen.getByText(/only the numbers moved/)).toBeInTheDocument();
  });
});

describe("IntelModal — schema diff", () => {
  /** Answer list_objects / describe_object per schema. */
  const catalogOf = (by: Record<string, Record<string, { name: string; dbType: string }[]>>) => {
    invokeMock.mockImplementation(async (_cmd: string, a?: unknown) => {
      const req = (a as { request?: { kind: string; schema: string; name?: string } } | undefined)?.request;
      if (!req) return { payload: [] } as never;
      if (req.kind === "list_objects") {
        return { payload: Object.keys(by[req.schema] ?? {}).map((name) => ({ name, kind: "table" })) } as never;
      }
      return { payload: { columns: by[req.schema][req.name!] } } as never;
    });
  };

  const openDiff = async () => {
    render(<IntelModal {...base} />);
    await userEvent.click(screen.getByRole("button", { name: "Schema diff" }));
  };

  /** The two selects already default to different schemas, so this just runs. */
  const compare = async () => {
    await userEvent.click(screen.getByRole("button", { name: "Compare" }));
  };

  it("will not compare a schema against itself", async () => {
    // Diffing a schema with itself is always empty — say why rather than
    // showing "identical" and looking like it worked.
    await openDiff();
    await userEvent.selectOptions(screen.getAllByRole("combobox")[1], "public");
    expect(screen.getByRole("button", { name: "Compare" })).toBeDisabled();
    expect(screen.getByText(/pick two different schemas/i)).toBeInTheDocument();
  });

  it("names a table that only one side has", async () => {
    catalogOf({
      public: { users: [{ name: "id", dbType: "int8" }] },
      analytics: {},
    });
    await openDiff();
    await compare();
    expect(await screen.findByText("users")).toBeInTheDocument();
    expect(screen.getByText("removed")).toBeInTheDocument();
  });

  it("names a column whose type changed, old and new", async () => {
    // A type change is the one that silently breaks a deploy — it has to say
    // what it was and what it became, not just "changed".
    catalogOf({
      public: { users: [{ name: "id", dbType: "int4" }] },
      analytics: { users: [{ name: "id", dbType: "int8" }] },
    });
    await openDiff();
    await compare();
    expect(await screen.findByText("changed")).toBeInTheDocument();
    expect(screen.getByText("id")).toBeInTheDocument();
    expect(screen.getByText(/int4 → int8/)).toBeInTheDocument();
  });

  it("names a column one side has and the other does not", async () => {
    // An added column is the safe kind of change and a removed one is not —
    // both have to be visible, with the type, to tell them apart.
    catalogOf({
      public: { users: [{ name: "id", dbType: "int8" }] },
      analytics: { users: [{ name: "id", dbType: "int8" }, { name: "email", dbType: "text" }] },
    });
    await openDiff();
    await compare();
    expect(await screen.findByText("changed")).toBeInTheDocument();
    expect(screen.getByText("email")).toBeInTheDocument();
    expect(screen.getByText("text")).toBeInTheDocument();
  });

  it("says so when the two schemas match", async () => {
    const same = { users: [{ name: "id", dbType: "int8" }] };
    catalogOf({ public: same, analytics: same });
    await openDiff();
    await compare();
    expect(await screen.findByText(/schemas are identical/i)).toBeInTheDocument();
  });

  it("says when it only compared the first slice of a huge schema", async () => {
    // Silently diffing 150 of 4,000 tables reads as "the rest are identical".
    const many: Record<string, { name: string; dbType: string }[]> = {};
    for (let i = 0; i < 151; i++) many[`t${i}`] = [{ name: "id", dbType: "int8" }];
    catalogOf({ public: many, analytics: many });
    await openDiff();
    await compare();
    expect(await screen.findByText(/first 150 tables/i)).toBeInTheDocument();
  });

  it("reports a failed comparison rather than an empty diff", async () => {
    // Reading one schema and being refused the other is the common case: the
    // diff cannot be trusted, so it says why instead of showing half of one.
    invokeMock.mockImplementation(async (_cmd: string, a?: unknown) => {
      const req = (a as { request?: { kind: string; schema: string } } | undefined)?.request;
      if (req?.schema === "analytics") throw new Error("permission denied for schema analytics");
      return { payload: [] } as never;
    });
    await openDiff();
    await compare();
    expect(await screen.findByText(/permission denied/)).toBeInTheDocument();
  });
});

describe("IntelModal — generated migration", () => {
  const column = (name: string, dbType: string, nullable = true) => ({
    name,
    dbType,
    nullable,
    primaryKey: false,
    comment: null,
  });

  /** `public` has an extra column; `analytics` has one `public` lacks. */
  const mockTwoSchemas = () => {
    // `InvokeArgs` also allows an array form, so read the request defensively
    // rather than typing the parameter as a record.
    invokeMock.mockImplementation(async (_cmd, args) => {
      const req = (args as { request?: { kind: string; schema: string } } | undefined)?.request;
      if (!req) return { payload: [], fetchedAt: null, source: "live" };
      if (req.kind === "list_objects") {
        return { payload: [{ name: "t", kind: "table" }], fetchedAt: null, source: "live" };
      }
      return {
        payload: {
          columns:
            req.schema === "public"
              ? [column("id", "int8", false), column("gone", "text")]
              : [column("id", "int8", false), column("added", "text")],
        },
        fetchedAt: null,
        source: "live",
      };
    });
  };

  const openDiff = async () => {
    mockTwoSchemas();
    render(<IntelModal {...base} />);
    await userEvent.click(screen.getByRole("button", { name: /Schema diff/ }));
    await userEvent.click(screen.getByRole("button", { name: "Compare" }));
    await userEvent.click(await screen.findByRole("button", { name: "Generate migration" }));
  };

  it("promises up front that nothing will be run", async () => {
    mockTwoSchemas();
    render(<IntelModal {...base} />);
    await userEvent.click(screen.getByRole("button", { name: /Schema diff/ }));
    await userEvent.click(screen.getByRole("button", { name: "Compare" }));
    expect(await screen.findByText(/TupleNest never runs it/)).toBeInTheDocument();
  });

  it("shows an additive statement as safe and runnable", async () => {
    await openDiff();
    const add = await screen.findByText(/ADD COLUMN/);
    expect(add.textContent).not.toMatch(/^-- /);
    expect(add.closest(".mig-row")!.querySelector(".mig-badge")).toHaveTextContent("safe");
  });

  it("returns a dropped column commented out, so pasting cannot run it", async () => {
    await openDiff();
    const drop = await screen.findByText(/DROP COLUMN/);
    // The whole statement is a comment — that is the safety property.
    expect(drop.textContent!.trim().startsWith("-- ")).toBe(true);
    expect(drop.closest(".mig-row")!.querySelector(".mig-badge")).toHaveTextContent("destructive");
  });

  it("hides the migration again on request", async () => {
    await openDiff();
    await userEvent.click(screen.getByRole("button", { name: "Hide migration" }));
    expect(screen.queryByText(/ADD COLUMN/)).not.toBeInTheDocument();
  });

  it("copies a script that states nothing has been executed", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await openDiff();
    await userEvent.click(screen.getByRole("button", { name: "Copy script" }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Nothing here has been executed"));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("-- ALTER TABLE"));
  });
});

describe("IntelModal — node-by-node plan diff", () => {
  /** A plan entry carrying a real tree, which is what the node diff needs. */
  const withRoot = (label: string, root: Record<string, unknown>) => ({
    ...plan(label),
    root: { Plan: root, "Execution Time": 100 },
  });
  const node = (type: string, ms: number, extra: Record<string, unknown> = {}, ...children: unknown[]) => ({
    "Node Type": type,
    "Actual Total Time": ms,
    ...extra,
    ...(children.length ? { Plans: children } : {}),
  });

  const openWith = async (plans: unknown[]) => {
    render(<IntelModal {...base} plans={plans as ReturnType<typeof plan>[]} />);
    await userEvent.click(screen.getByRole("button", { name: /Plan compare/ }));
  };

  it("names the node that slowed down and the one that sped up", async () => {
    const before = node("Hash Join", 20, {}, node("Seq Scan", 2, { "Relation Name": "orders" }), node("Sort", 15));
    const after = node("Hash Join", 40, {}, node("Seq Scan", 30, { "Relation Name": "orders" }), node("Sort", 3));
    await openWith([withRoot("before", before), withRoot("after", after)]);

    expect(await screen.findByText("Node by node")).toBeInTheDocument();
    const scan = screen.getByText("Seq Scan on orders").closest(".pdiff-row")!;
    expect(scan.querySelector(".pdiff-badge")).toHaveTextContent("slower");
    expect(scan).toHaveTextContent("2.0 → 30.0 ms");
    const sort = screen.getByText("Sort").closest(".pdiff-row")!;
    expect(sort.querySelector(".pdiff-badge")).toHaveTextContent("faster");
  });

  it("marks a node that appeared and one that vanished", async () => {
    const before = node("Gather", 10, {}, node("Index Scan", 1, { "Relation Name": "t" }));
    const after = node("Gather", 10, {}, node("Seq Scan", 9, { "Relation Name": "t" }));
    await openWith([withRoot("before", before), withRoot("after", after)]);

    expect(screen.getByText("Index Scan on t").closest(".pdiff-row")!.querySelector(".pdiff-badge")).toHaveTextContent(
      "gone",
    );
    expect(screen.getByText("Seq Scan on t").closest(".pdiff-row")!.querySelector(".pdiff-badge")).toHaveTextContent("new");
  });

  it("labels a pairing it had to guess rather than showing it as fact", async () => {
    const before = node("Append", 9, {}, node("Seq Scan", 2, { "Relation Name": "p" }), node("Seq Scan", 3, { "Relation Name": "p" }));
    const after = node("Append", 9, {}, node("Seq Scan", 40, { "Relation Name": "p" }), node("Seq Scan", 3, { "Relation Name": "p" }));
    await openWith([withRoot("before", before), withRoot("after", after)]);
    expect(screen.getAllByText("ambiguous").length).toBeGreaterThan(0);
  });

  it("shows an unchanged node without a delta", async () => {
    const same = node("Sort", 10);
    await openWith([withRoot("before", same), withRoot("after", same)]);
    const row = screen.getByText("Sort").closest(".pdiff-row")!;
    expect(row.querySelector(".pdiff-badge")).toHaveTextContent("—");
    expect(row).not.toHaveTextContent("%");
  });

  it("says nothing node-by-node when the trees were not kept", async () => {
    // Older entries in the ring have no root; the summary comparison still
    // works and the node section simply does not appear.
    await openWith([plan("before"), plan("after")]);
    expect(screen.queryByText("Node by node")).not.toBeInTheDocument();
  });

  it("renders a plan with no timings without inventing any", async () => {
    const bare = { "Node Type": "Seq Scan", "Plan Rows": 10, "Total Cost": 5 };
    await openWith([withRoot("before", bare), withRoot("after", bare)]);
    const row = screen.getByText("Seq Scan").closest(".pdiff-row")!;
    expect(row).toHaveTextContent("—");
  });
});
