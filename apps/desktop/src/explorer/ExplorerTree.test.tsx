import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ExplorerTree from "./ExplorerTree";
import type { DbColumn, DbIndex, DbObject, DbPartition } from "../ipc/types";

const obj = (name: string, over: Partial<DbObject> = {}): DbObject =>
  ({ name, kind: "table", comment: null, isPartitioned: false, partitionCount: 0, ...over }) as DbObject;

const col = (name: string, over: Partial<DbColumn> = {}): DbColumn =>
  ({ name, dbType: "int4", nullable: true, primaryKey: false, comment: null, ...over }) as DbColumn;

const idx = (name: string, over: Partial<DbIndex> = {}): DbIndex =>
  ({
    name,
    definition: `CREATE INDEX ${name} ON t (a)`,
    isPrimary: false,
    isUnique: false,
    isValid: true,
    scans: 10,
    bytes: 16384,
    ...over,
  }) as DbIndex;

const part = (name: string, over: Partial<DbPartition> = {}): DbPartition =>
  ({
    name,
    bounds: "FOR VALUES IN ('a')",
    isPartitioned: false,
    partitionCount: 0,
    ...over,
  }) as DbPartition;

const base = {
  schemas: ["public"],
  metaCached: false,
  connected: true,
  open: {} as Record<string, boolean>,
  onToggle: vi.fn(),
  objects: {} as Record<string, DbObject[]>,
  columns: {} as Record<string, DbColumn[]>,
  indexes: {} as Record<string, DbIndex[]>,
  constraints: {},
  partitions: {} as Record<string, DbPartition[]>,
  types: {},
  routines: {},
  onInsertSelect: vi.fn(),
  onDescribe: vi.fn(),
  onDetails: vi.fn(),
  onPartitions: vi.fn(),
  onConnect: vi.fn(),
};

/** Fully-expanded public schema with one table.
 *  `open` is merged last so a caller's extra keys add to the defaults rather
 *  than replacing them. */
const withTable = (o: DbObject, extra: Partial<typeof base> = {}) => ({
  ...base,
  objects: { public: [o] },
  ...extra,
  open: { "s:public": true, "g:public:table": true, [`t:public.${o.name}`]: true, ...(extra.open ?? {}) },
});

describe("ExplorerTree — shell", () => {
  it("invites connecting when there is nothing yet", async () => {
    const onConnect = vi.fn();
    render(<ExplorerTree {...base} schemas={null} connected={false} onConnect={onConnect} />);
    await userEvent.click(screen.getByText("New connection"));
    expect(onConnect).toHaveBeenCalled();
  });

  it("lists schemas", () => {
    render(<ExplorerTree {...base} schemas={["public", "app"]} />);
    expect(screen.getByText("public")).toBeInTheDocument();
    expect(screen.getByText("app")).toBeInTheDocument();
  });

  it("flags that the tree is being served from cache", () => {
    render(<ExplorerTree {...base} metaCached />);
    expect(screen.getByText("CACHED")).toBeInTheDocument();
  });

  it("says it is live when connected", () => {
    render(<ExplorerTree {...base} />);
    expect(screen.getByText("live")).toBeInTheDocument();
  });

  it("toggles a schema", async () => {
    const onToggle = vi.fn();
    render(<ExplorerTree {...base} onToggle={onToggle} />);
    await userEvent.click(screen.getByText("public"));
    expect(onToggle).toHaveBeenCalledWith("s:public");
  });

  it("filters objects within a schema, and shows the ratio it kept", async () => {
    // Schemas stay put: hiding them would make an empty tree look like a lost
    // connection. The group badge reports matched/total instead.
    render(
      <ExplorerTree
        {...base}
        objects={{ public: [obj("users"), obj("orders")] }}
        open={{ "s:public": true, "g:public:table": true }}
      />,
    );
    await userEvent.type(screen.getByPlaceholderText("Filter objects…"), "ord");
    expect(screen.getByText("orders")).toBeInTheDocument();
    expect(screen.queryByText("users")).not.toBeInTheDocument();
    expect(screen.getByText("1/2")).toBeInTheDocument();
  });

  it("says so when a filter matches nothing in a group", async () => {
    render(
      <ExplorerTree
        {...base}
        objects={{ public: [obj("users")] }}
        open={{ "s:public": true, "g:public:table": true }}
      />,
    );
    await userEvent.type(screen.getByPlaceholderText("Filter objects…"), "zzz");
    expect(screen.getByText("no match")).toBeInTheDocument();
  });
});

describe("ExplorerTree — objects", () => {
  it("groups objects by kind rather than listing them flat", () => {
    render(<ExplorerTree {...base} objects={{ public: [obj("users")] }} open={{ "s:public": true }} />);
    expect(screen.getByText("Tables")).toBeInTheDocument();
  });

  it("shows a table once its group is open", () => {
    render(<ExplorerTree {...withTable(obj("users"))} />);
    expect(screen.getByText("users")).toBeInTheDocument();
  });

  it("inserts a select on double click", async () => {
    const onInsertSelect = vi.fn();
    render(<ExplorerTree {...withTable(obj("users"))} onInsertSelect={onInsertSelect} />);
    await userEvent.dblClick(screen.getByText("users"));
    expect(onInsertSelect).toHaveBeenCalledWith("public", "users");
  });

  it("opens details from the ⓘ without toggling the row", async () => {
    const onDetails = vi.fn();
    const onToggle = vi.fn();
    render(<ExplorerTree {...withTable(obj("users"))} onDetails={onDetails} onToggle={onToggle} />);
    await userEvent.click(screen.getByTitle(/Details —/));
    expect(onDetails).toHaveBeenCalledWith("public", "users", "table");
    expect(onToggle).not.toHaveBeenCalled();
  });
});

describe("ExplorerTree — sequences are leaves", () => {
  // A sequence has no columns, indexes or constraints; giving it the
  // expandable table shape promised three empty groups.
  const seqTree = {
    ...base,
    objects: { public: [obj("users_id_seq", { kind: "sequence" })] },
    open: { "s:public": true, "g:public:sequence": true },
  };

  it("opens details on click rather than expanding", async () => {
    const onDetails = vi.fn();
    const onToggle = vi.fn();
    render(<ExplorerTree {...seqTree} onDetails={onDetails} onToggle={onToggle} />);
    await userEvent.click(screen.getByText("users_id_seq"));
    expect(onDetails).toHaveBeenCalledWith("public", "users_id_seq", "sequence");
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("offers no expand arrow", () => {
    const { container } = render(<ExplorerTree {...seqTree} />);
    const row = screen.getByText("users_id_seq").closest(".tree-row")!;
    expect(row.querySelector(".caret")).toHaveStyle({ visibility: "hidden" });
    expect(container).toBeTruthy();
  });
});

describe("ExplorerTree — partitions", () => {
  const t = obj("messages", { isPartitioned: true, partitionCount: 10 });

  it("badges a partitioned table with its direct count", () => {
    render(<ExplorerTree {...withTable(t)} />);
    expect(screen.getByTitle(/10 direct partitions/)).toHaveTextContent("10");
  });

  it("opens the partition view from the badge, without toggling the row", async () => {
    const onPartitions = vi.fn();
    const onToggle = vi.fn();
    render(<ExplorerTree {...withTable(t)} onPartitions={onPartitions} onToggle={onToggle} />);
    await userEvent.click(screen.getByTitle(/10 direct partitions/));
    expect(onPartitions).toHaveBeenCalledWith("public", "messages");
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("does not badge an ordinary table", () => {
    render(<ExplorerTree {...withTable(obj("users"))} />);
    expect(screen.queryByTitle(/direct partitions/)).not.toBeInTheDocument();
  });

  it("nests partitions under the parent", () => {
    render(
      <ExplorerTree
        {...withTable(t, {
          open: { "p:public.messages": true },
          partitions: { "public.messages": [part("messages_email")] },
        })}
      />,
    );
    expect(screen.getByText("messages_email")).toBeInTheDocument();
  });
});

describe("ExplorerTree — partitions", () => {
  it("says loading before the partition list arrives", () => {
    // A partitioned table with no list yet is not a table with no partitions.
    render(
      <ExplorerTree
        {...base}
        objects={{ public: [obj("events", { isPartitioned: true, partitionCount: 3 })] }}
        open={{ "s:public": true, "g:public:table": true, "t:public.events": true, "p:public.events": true }}
      />,
    );
    expect(screen.getAllByText("loading…").length).toBeGreaterThan(0);
  });
});

describe("ExplorerTree — columns and indexes", () => {
  const open = {
    "s:public": true,
    "g:public:table": true,
    "t:public.users": true,
    "c:public.users": true,
    "i:public.users": true,
  };

  it("says loading before columns arrive", () => {
    render(<ExplorerTree {...base} objects={{ public: [obj("users")] }} open={open} />);
    expect(screen.getAllByText("loading…").length).toBeGreaterThan(0);
  });

  it("marks a primary key column", () => {
    render(
      <ExplorerTree
        {...base}
        objects={{ public: [obj("users")] }}
        open={open}
        columns={{ "public.users": [col("id", { primaryKey: true })] }}
      />,
    );
    expect(screen.getByText("PK")).toBeInTheDocument();
  });

  it.each([
    [512, "512 B"],
    // A decimal below ten, none above it — "16.0 KB" is false precision.
    [16384, "16 KB"],
    [5 * 1024 * 1024, "5.0 MB"],
    [3_692_000_000, "3.4 GB"],
  ])("shows %i bytes as %s", (bytes, shown) => {
    // An index size in raw bytes is unreadable at a glance, and reading it
    // wrong is how a 3 GB index gets mistaken for 3 MB.
    render(
      <ExplorerTree
        {...base}
        objects={{ public: [obj("users")] }}
        open={open}
        indexes={{ "public.users": [idx("ix_size", { bytes })] }}
      />,
    );
    expect(screen.getByText(shown)).toBeInTheDocument();
  });

  it("flags an index nobody has scanned — the number that matters here", () => {
    render(
      <ExplorerTree
        {...base}
        objects={{ public: [obj("users")] }}
        open={open}
        indexes={{ "public.users": [idx("ix_dead", { scans: 0 })] }}
      />,
    );
    expect(screen.getByText("UNUSED")).toBeInTheDocument();
  });

  it("does not call a primary key unused, however few scans it has", () => {
    render(
      <ExplorerTree
        {...base}
        objects={{ public: [obj("users")] }}
        open={open}
        indexes={{ "public.users": [idx("users_pkey", { scans: 0, isPrimary: true, isUnique: true })] }}
      />,
    );
    expect(screen.queryByText("UNUSED")).not.toBeInTheDocument();
    expect(screen.getByText("PK")).toBeInTheDocument();
  });

  it("flags an invalid index", () => {
    render(
      <ExplorerTree
        {...base}
        objects={{ public: [obj("users")] }}
        open={open}
        indexes={{ "public.users": [idx("ix_bad", { isValid: false })] }}
      />,
    );
    expect(screen.getByText("INVALID")).toBeInTheDocument();
  });

  it("opens index details on click", async () => {
    const onDetails = vi.fn();
    render(
      <ExplorerTree
        {...base}
        objects={{ public: [obj("users")] }}
        open={open}
        indexes={{ "public.users": [idx("ix_a")] }}
        onDetails={onDetails}
      />,
    );
    await userEvent.click(screen.getByText("ix_a"));
    expect(onDetails).toHaveBeenCalledWith("public", "ix_a", "index");
  });

  it("explains an empty index list on a partitioned parent rather than looking broken", () => {
    // This database indexes the leaves, so the parent genuinely has none.
    render(
      <ExplorerTree
        {...base}
        objects={{ public: [obj("users", { isPartitioned: true, partitionCount: 3 })] }}
        open={open}
        indexes={{ "public.users": [] }}
      />,
    );
    expect(screen.getByText(/defined on the partitions/)).toBeInTheDocument();
  });

  it("just says none on an ordinary table", () => {
    render(
      <ExplorerTree {...base} objects={{ public: [obj("users")] }} open={open} indexes={{ "public.users": [] }} />,
    );
    expect(screen.getByText("none")).toBeInTheDocument();
  });
});

describe("ExplorerTree — types and functions", () => {
  const withTypes = {
    ...base,
    types: {
      public: [
        { name: "mood", kind: "enum", comment: null, labels: "happy, sad" },
        { name: "addr", kind: "composite", comment: null, labels: null },
      ],
    },
    routines: {
      public: [
        { name: "calc", kind: "function", args: "a int", returns: "int4", comment: null, language: "sql" },
        { name: "do_it", kind: "procedure", args: null, returns: null, comment: null, language: "plpgsql" },
      ],
    },
    open: { "s:public": true, "g:public:types": true, "g:public:routines": true },
    objects: { public: [] as DbObject[] },
  };

  it("surfaces enums, which used to be invisible", () => {
    render(<ExplorerTree {...withTypes} />);
    expect(screen.getByText("Types & enums")).toBeInTheDocument();
    expect(screen.getByText("mood")).toBeInTheDocument();
  });

  it("shows an enum's labels rather than just its kind", () => {
    render(<ExplorerTree {...withTypes} />);
    expect(screen.getByText("happy, sad")).toBeInTheDocument();
  });

  it("falls back to the kind for a type with no labels", () => {
    render(<ExplorerTree {...withTypes} />);
    expect(screen.getByText("composite")).toBeInTheDocument();
  });

  it("lists functions with their return type", () => {
    render(<ExplorerTree {...withTypes} />);
    expect(screen.getByText("Functions")).toBeInTheDocument();
    expect(screen.getByText("calc")).toBeInTheDocument();
    expect(screen.getByText("int4")).toBeInTheDocument();
  });

  it("falls back to the kind for a routine that returns nothing", () => {
    render(<ExplorerTree {...withTypes} />);
    expect(screen.getByText("procedure")).toBeInTheDocument();
  });

  it("hides both groups when the schema has neither", () => {
    render(<ExplorerTree {...base} objects={{ public: [] }} open={{ "s:public": true }} />);
    expect(screen.queryByText("Types & enums")).not.toBeInTheDocument();
    expect(screen.queryByText("Functions")).not.toBeInTheDocument();
  });

  it("filters types and functions too", async () => {
    render(<ExplorerTree {...withTypes} />);
    await userEvent.type(screen.getByPlaceholderText("Filter objects…"), "mood");
    expect(screen.getByText("mood")).toBeInTheDocument();
    expect(screen.queryByText("calc")).not.toBeInTheDocument();
  });
});

describe("ExplorerTree — constraints", () => {
  const open = {
    "s:public": true,
    "g:public:table": true,
    "t:public.users": true,
    "k:public.users": true,
  };
  const tree = (constraints: Record<string, unknown[]>) => (
    <ExplorerTree
      {...base}
      objects={{ public: [obj("users")] }}
      open={open}
      constraints={constraints as never}
    />
  );

  it("lists a constraint with its kind", () => {
    render(
      tree({
        "public.users": [
          { name: "users_pkey", kind: "PRIMARY KEY", definition: "PRIMARY KEY (id)", isValid: true },
        ],
      }),
    );
    expect(screen.getByText("users_pkey")).toBeInTheDocument();
    expect(screen.getByText("PRIMARY KEY")).toBeInTheDocument();
  });

  it("flags a NOT VALID constraint — it is not enforcing what it claims", () => {
    render(
      tree({
        "public.users": [
          { name: "fk_x", kind: "FOREIGN KEY", definition: "FOREIGN KEY (a)", isValid: false },
        ],
      }),
    );
    expect(screen.getByText("NOT VALID")).toBeInTheDocument();
  });

  it("says none rather than showing an empty group", () => {
    render(tree({ "public.users": [] }));
    expect(screen.getByText("none")).toBeInTheDocument();
  });

  it("says loading before they arrive", () => {
    render(tree({}));
    expect(screen.getAllByText("loading…").length).toBeGreaterThan(0);
  });
});
