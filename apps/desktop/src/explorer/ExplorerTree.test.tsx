import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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

  it("can be driven from the keyboard: rows are focusable treeitems", async () => {
    // Exploring the schema used to be mouse-only: plain divs with onClick.
    const onToggle = vi.fn();
    render(<ExplorerTree {...base} onToggle={onToggle} />);
    expect(screen.getByRole("tree", { name: "Database objects" })).toBeInTheDocument();
    const row = screen.getByText("public").closest('[role="treeitem"]') as HTMLElement;
    // One tab stop for the whole tree; rows are reached with the arrow keys.
    expect(screen.getByRole("tree")).toHaveAttribute("tabindex", "0");
    expect(row).toHaveAttribute("tabindex", "-1");
    expect(row).toHaveAttribute("aria-expanded");
    row.focus();
    await userEvent.keyboard(" ");
    expect(onToggle).toHaveBeenCalledWith("s:public");
  });

  it("moves between rows with the arrow keys and opens with ArrowRight", async () => {
    const onToggle = vi.fn();
    render(<ExplorerTree {...base} schemas={["public", "app"]} onToggle={onToggle} />);
    const tree = screen.getByRole("tree");
    tree.focus(); // Tab into the tree lands on the first row
    const first = screen.getByText("public").closest('[role="treeitem"]') as HTMLElement;
    expect(document.activeElement).toBe(first);
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByText("app").closest('[role="treeitem"]'));
    await userEvent.keyboard("{ArrowRight}");
    expect(onToggle).toHaveBeenCalledWith("s:app");
    await userEvent.keyboard("{Home}");
    expect(document.activeElement).toBe(first);
  });

  it("closes an open row with ArrowLeft, steps out to its parent, and ends with End", async () => {
    const onToggle = vi.fn();
    render(<ExplorerTree {...withTable(obj("users"))} onToggle={onToggle} />);
    const items = () => screen.getAllByRole("treeitem");
    const pub = screen.getByText("public").closest('[role="treeitem"]') as HTMLElement;
    pub.focus();
    // Open row + ArrowRight steps into its first child instead of toggling.
    await userEvent.keyboard("{ArrowRight}");
    const child = document.activeElement as HTMLElement;
    expect(child).not.toBe(pub);
    expect(Number(child.getAttribute("aria-level"))).toBeGreaterThan(1);
    // From the deepest row, ArrowLeft (on a closed row) steps out a level.
    await userEvent.keyboard("{End}");
    const deep = document.activeElement as HTMLElement;
    const deepLevel = Number(deep.getAttribute("aria-level"));
    if (deep.getAttribute("aria-expanded") !== "true") {
      await userEvent.keyboard("{ArrowLeft}");
      expect(Number((document.activeElement as HTMLElement).getAttribute("aria-level"))).toBeLessThan(deepLevel);
    }
    // ArrowLeft on the open parent closes it.
    pub.focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(onToggle).toHaveBeenCalledWith("s:public");
    await userEvent.keyboard("{End}");
    expect(document.activeElement).toBe(items()[items().length - 1]);
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(items()[items().length - 2]);
    // Other keys are left alone.
    await userEvent.keyboard("x");
    expect(document.activeElement).toBe(items()[items().length - 2]);
  });

  it("returns to the row last used when focus comes back to the tree", async () => {
    render(<ExplorerTree {...base} schemas={["public", "app"]} />);
    const tree = screen.getByRole("tree");
    tree.focus();
    await userEvent.keyboard("{ArrowDown}");
    const app = screen.getByText("app").closest('[role="treeitem"]');
    expect(document.activeElement).toBe(app);
    (document.activeElement as HTMLElement).blur();
    tree.focus();
    expect(document.activeElement).toBe(app);
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

describe("ExplorerTree — windowing", () => {
  // Rows are a fixed 24px; jsdom has no layout, so the viewport falls back to
  // 600px: 25 rows on screen plus 10 of overscan each side.
  const ROW = 24;
  const name = (n: number) => `t_${String(n).padStart(4, "0")}`;
  const many = (n: number) => Array.from({ length: n }, (_, i) => obj(name(i)));
  const big = (n = 2000) => ({
    ...base,
    objects: { public: many(n) },
    open: { "s:public": true, "g:public:table": true },
  });
  const tree = () => screen.getByRole("tree");
  const scrollTo = (top: number) => {
    tree().scrollTop = top;
    fireEvent.scroll(tree());
  };
  const focusedText = () => (document.activeElement as HTMLElement).textContent;

  it("renders a bounded number of rows for a schema with 2,000 tables", () => {
    const { container } = render(<ExplorerTree {...big()} />);
    // 2,002 rows exist; a screenful and its overscan are in the DOM.
    expect(screen.getAllByRole("treeitem").length).toBeLessThanOrEqual(45);
    expect(container.querySelectorAll(".tree *").length).toBeLessThan(400);
    expect(screen.getByText(name(0))).toBeInTheDocument();
    expect(screen.queryByText(name(1999))).not.toBeInTheDocument();
    // The rest is one spacer, sized as if the rows were there.
    const spacers = container.querySelectorAll('.tree > [role="presentation"]');
    expect(spacers).toHaveLength(1);
    expect(spacers[0]).toHaveStyle({ height: `${(2002 - 45) * ROW}px` });
  });

  it("adds no spacers to a tree that fits", () => {
    const { container } = render(<ExplorerTree {...big(5)} />);
    expect(container.querySelectorAll('.tree > [role="presentation"]')).toHaveLength(0);
    expect(screen.getAllByRole("treeitem")).toHaveLength(7);
  });

  it("shows later rows once scrolled to them", () => {
    const { container } = render(<ExplorerTree {...big()} />);
    scrollTo(1000 * ROW);
    // Row 1000 is the 999th table: the schema and group rows come first.
    expect(screen.getByText(name(998))).toBeInTheDocument();
    expect(screen.queryByText(name(0))).not.toBeInTheDocument();
    expect(screen.getAllByRole("treeitem").length).toBeLessThanOrEqual(45);
    expect(container.querySelectorAll('.tree > [role="presentation"]')).toHaveLength(2);
    expect(screen.getByText(name(998)).closest('[role="treeitem"]')).toHaveAttribute("aria-level", "3");
  });

  it("does not re-window for a scroll within the same row", () => {
    render(<ExplorerTree {...big()} />);
    scrollTo(ROW * 20 + 5);
    const before = screen.getAllByRole("treeitem")[0];
    scrollTo(ROW * 20 + 9);
    expect(screen.getAllByRole("treeitem")[0]).toBe(before);
  });

  it("walks past the edge of the window with the arrow keys", async () => {
    render(<ExplorerTree {...big()} />);
    tree().focus();
    // 80 rows down: far beyond the 45 that were rendered to begin with.
    await userEvent.keyboard("{ArrowDown>80/}");
    expect(focusedText()).toContain(name(78));
    expect(screen.queryByText(name(0))).not.toBeInTheDocument();
    expect(tree().scrollTop).toBeGreaterThan(0);
    await userEvent.keyboard("{ArrowUp>70/}");
    expect(focusedText()).toContain(name(8));
    expect(tree().scrollTop).toBeLessThanOrEqual(10 * ROW);
  });

  it("jumps to rows that are not rendered with End and Home", async () => {
    render(<ExplorerTree {...big()} />);
    tree().focus();
    await userEvent.keyboard("{End}");
    expect(focusedText()).toContain(name(1999));
    await userEvent.keyboard("{Home}");
    expect(focusedText()).toContain("public");
    expect(tree().scrollTop).toBe(0);
  });

  it("keeps the keyboard working after the focused row is scrolled out of the window", async () => {
    const onToggle = vi.fn();
    render(<ExplorerTree {...big()} onToggle={onToggle} />);
    const row = screen.getByText(name(3)).closest('[role="treeitem"]') as HTMLElement;
    row.focus();
    // Still inside the window: focus stays where it is.
    scrollTo(5 * ROW);
    expect(document.activeElement).toBe(row);
    // Its node is dropped; focus is parked on the tree rather than lost.
    scrollTo(1000 * ROW);
    expect(document.activeElement).toBe(tree());
    // ArrowRight on the closed table it was on opens it…
    await userEvent.keyboard("{ArrowRight}");
    expect(onToggle).toHaveBeenCalledWith(`t:public.${name(3)}`);
    // …and the arrows carry on from it, scrolling it back in.
    await userEvent.keyboard("{ArrowDown}");
    expect(focusedText()).toContain(name(4));
    // Steps out to the group from a parked row too.
    scrollTo(1000 * ROW);
    expect(document.activeElement).toBe(tree());
    await userEvent.keyboard("{ArrowLeft}");
    expect(focusedText()).toContain("Tables");
  });

  it("ignores the keys when the row focus was parked on is gone", async () => {
    const props = big();
    const { rerender } = render(<ExplorerTree {...props} />);
    (screen.getByText(name(3)).closest('[role="treeitem"]') as HTMLElement).focus();
    scrollTo(1000 * ROW);
    rerender(<ExplorerTree {...props} open={{ "s:public": true }} />);
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(tree());
  });

  it("shows the tail when the tree shrinks under a deep scroll", () => {
    const props = big();
    const { rerender } = render(<ExplorerTree {...props} />);
    scrollTo(1900 * ROW);
    rerender(<ExplorerTree {...props} objects={{ public: many(100) }} />);
    expect(screen.getByText(name(99))).toBeInTheDocument();
  });

  it("skips rows that are not treeitems, and stays put at the ends", async () => {
    render(
      <ExplorerTree
        {...base}
        schemas={["public", "app"]}
        objects={{ public: [obj("users")] }}
        columns={{ "public.users": [col("id"), col("email")] }}
        open={{ "s:public": true, "g:public:table": true, "t:public.users": true, "c:public.users": true }}
      />,
    );
    const cols = screen.getByText("Columns").closest('[role="treeitem"]') as HTMLElement;
    cols.focus();
    // Over the two column leaves to the next header.
    await userEvent.keyboard("{ArrowDown}");
    expect(focusedText()).toContain("Indexes");
    await userEvent.keyboard("{End}");
    expect(focusedText()).toContain("app");
    await userEvent.keyboard("{ArrowDown}");
    expect(focusedText()).toContain("app");
    // A row with nothing to open leaves ArrowRight alone; a top-level row has
    // no parent to step out to.
    await userEvent.keyboard("{ArrowLeft}");
    expect(focusedText()).toContain("app");
  });

  it("leaves ArrowRight alone on a row that does not expand", async () => {
    const onDetails = vi.fn();
    render(
      <ExplorerTree
        {...base}
        objects={{ public: [obj("users_id_seq", { kind: "sequence" })] }}
        open={{ "s:public": true, "g:public:sequence": true }}
        onDetails={onDetails}
      />,
    );
    const seq = screen.getByText("users_id_seq").closest('[role="treeitem"]') as HTMLElement;
    seq.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(seq);
    await userEvent.keyboard("{Enter}");
    expect(onDetails).toHaveBeenCalledWith("public", "users_id_seq", "sequence");
  });

  it("does not hijack keys pressed on a button inside a row", async () => {
    render(<ExplorerTree {...withTable(obj("users"))} />);
    const btn = screen.getByTitle(/Details —/);
    btn.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(btn);
  });

  it("does nothing when an empty tree takes focus", () => {
    render(<ExplorerTree {...base} schemas={[]} />);
    tree().focus();
    expect(document.activeElement).toBe(tree());
  });

  it("uses the measured height when there is one", () => {
    const spy = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(240);
    try {
      render(<ExplorerTree {...big()} />);
      // 10 rows on screen + 10 of overscan each side.
      expect(screen.getAllByRole("treeitem")).toHaveLength(30);
    } finally {
      spy.mockRestore();
    }
  });

  it("toggles a group from its header", async () => {
    const onToggle = vi.fn();
    render(<ExplorerTree {...big(3)} onToggle={onToggle} />);
    await userEvent.click(screen.getByText("Tables"));
    expect(onToggle).toHaveBeenCalledWith("g:public:table");
  });

  it("says loading under an open schema whose objects have not arrived, and before any schema has", () => {
    const { rerender } = render(<ExplorerTree {...base} open={{ "s:public": true }} />);
    expect(screen.getByText("loading…")).toBeInTheDocument();
    rerender(<ExplorerTree {...base} schemas={null} />);
    expect(screen.getByText("Loading schemas…")).toBeInTheDocument();
  });

  it("marks a unique index, and titles a constraint with its kind when it has no definition", () => {
    render(
      <ExplorerTree
        {...base}
        objects={{ public: [obj("users")] }}
        indexes={{ "public.users": [idx("ux_email", { isUnique: true })] }}
        constraints={{ "public.users": [{ name: "ck_a", kind: "CHECK", definition: null, isValid: true }] } as never}
        open={{
          "s:public": true,
          "g:public:table": true,
          "t:public.users": true,
          "i:public.users": true,
          "k:public.users": true,
        }}
      />,
    );
    expect(screen.getByText("UNIQUE")).toBeInTheDocument();
    expect(screen.getByText("ck_a").closest(".tree-row")).toHaveAttribute("title", "CHECK");
  });
});
