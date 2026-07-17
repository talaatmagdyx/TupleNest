import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { CONNECTION, PROD, backend, type Backend } from "./test/backend";

/** The database-health reports, the palette items that open them, and the
 *  empty state you land on with no tabs. */

let be: Backend;
beforeEach(() => {
  be = backend();
});

const mount = async () => {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByText(CONNECTION.name);
  return user;
};

const palette = async (user: ReturnType<typeof userEvent.setup>, term: string) => {
  await user.keyboard("{Meta>}k{/Meta}");
  await user.type(await screen.findByPlaceholderText(/type a command/i), term);
  await user.keyboard("{Enter}");
};

const connected = async (profile = CONNECTION.name) => {
  const user = await mount();
  await palette(user, `Connect to ${profile}`);
  await waitFor(() => expect(be.sent("pg_connect")).toHaveLength(1));
  return user;
};

/** One index that has never been scanned, and is therefore droppable. */
const INDEXES = {
  items: [
    {
      schema: "public",
      table: "users",
      columns: "email",
      method: "btree",
      scans: 0,
      bytes: 8192,
      size: "8192 bytes",
      members: 1,
      sampleIndex: "users_email_idx",
      indexIdents: ['public."users_email_idx"'],
      // "candidate" is what earns the DROP script; a primary key's index is
      // marked "keep" and is never proposed.
      verdict: "candidate",
      why: "never scanned since stats were reset",
    },
  ],
  droppableBytes: 8192,
  droppableIndexes: 1,
};

/** Answer one health request; leave the tree's own requests working. */
const health = (kind: string, payload: unknown) => {
  be.on("pg_metadata", (a) => {
    const req = a.request as Record<string, unknown>;
    if (req.kind === kind) return { payload, cached: false };
    if (req.kind === "list_schemas") return { payload: ["public"], cached: false };
    if (req.kind === "server_info") return { payload: { version: "PostgreSQL 18.0" }, cached: false };
    return { payload: [], cached: false };
  });
};

describe("App — index health", () => {
  it("reports the space that dropping unused indexes would return", async () => {
    const user = await connected();
    health("index_health", INDEXES);
    await palette(user, "Index health");
    expect(await screen.findByText("public.users")).toBeInTheDocument();
    expect(screen.getByText("8.0 KB")).toBeInTheDocument();
    expect(screen.getByText(/recoverable across 1 index$/)).toBeInTheDocument();
  });

  it("opens the DROP script as a tab instead of running it", async () => {
    // 580 indexes is not something to drop on one click. The script is written
    // into the editor, with its comments, for the user to read and decide.
    const user = await connected();
    health("index_health", INDEXES);
    await palette(user, "Index health");
    await user.click(await screen.findByRole("button", { name: /Generate DROP script/i }));
    const ta = (await screen.findByRole("textbox", { name: /sql editor/i })) as HTMLTextAreaElement;
    await waitFor(() => expect(ta.value).toContain("users_email_idx"));
    expect(be.sent("pg_query")).toHaveLength(0);
    expect(await screen.findByText(/nothing was executed/i)).toBeInTheDocument();
  });

  it("says why the report could not be read", async () => {
    const user = await connected();
    be.on("pg_metadata", (a) => {
      const req = a.request as Record<string, unknown>;
      if (req.kind === "index_health") throw new Error("permission denied for pg_stat_user_indexes");
      if (req.kind === "list_schemas") return { payload: ["public"], cached: false };
      return { payload: [], cached: false };
    });
    await palette(user, "Index health");
    expect(await screen.findByText(/permission denied/)).toBeInTheDocument();
  });
});

describe("App — vacuum & bloat", () => {
  it("shows dead tuples and when the table was last vacuumed", async () => {
    const user = await connected();
    health("table_health", {
      items: [
        {
          schema: "public",
          table: "events",
          liveTuples: 1000,
          deadTuples: 400,
          deadPct: 28.6,
          vacuumed: "never",
          analyzed: "never",
          neverAnalyzed: true,
          size: "12 MB",
        },
      ],
      neverAnalyzed: 1,
      neverVacuumed: 1,
      totalTables: 1,
      truncated: false,
    });
    await palette(user, "Vacuum & bloat");
    expect(await screen.findByText("public.events")).toBeInTheDocument();
  });
});

describe("App — top queries", () => {
  it("shows the slowest statements the server has recorded", async () => {
    const user = await connected();
    health("top_queries", {
      available: true,
      items: [
        { queryId: "42", query: "select * from users", calls: 10, totalMs: 500, meanMs: 50, rows: 100 },
      ],
    });
    await palette(user, "Top queries");
    expect(await screen.findByText(/select \* from users/)).toBeInTheDocument();
  });

  it("explains how to turn the extension on rather than showing an empty table", async () => {
    // pg_stat_statements is off by default. An empty table reads as "no slow
    // queries", which is the opposite of what is true.
    const user = await connected();
    health("top_queries", {
      available: false,
      reason: "pg_stat_statements is not loaded",
      remedy: "shared_preload_libraries = 'pg_stat_statements'",
      items: [],
    });
    await palette(user, "Top queries");
    expect(await screen.findByText(/not loaded/)).toBeInTheDocument();
    expect(screen.getByText(/shared_preload_libraries/)).toBeInTheDocument();
  });
});

describe("App — the prod audit log", () => {
  it("is offered only for a production session", async () => {
    // The log only records statements run against prod. On a dev session the
    // item would open an empty panel.
    const user = await connected();
    await user.keyboard("{Meta>}k{/Meta}");
    await user.type(await screen.findByPlaceholderText(/type a command/i), "audit");
    expect(screen.queryByText(/Prod audit log/)).not.toBeInTheDocument();
  });

  it("opens for a production session", async () => {
    be.on("audit_list", () => []);
    const user = await connected(PROD.name);
    await palette(user, "Prod audit log");
    await waitFor(() => expect(be.sent("audit_list").length).toBeGreaterThan(0));
  });
});

describe("App — the empty state", () => {
  it("offers a way out when the last tab is closed", async () => {
    // A blank main pane with no controls is a dead end.
    const user = await mount();
    await user.click(await screen.findByTitle("Close"));
    expect(await screen.findByText(/No query open/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /New query/i }));
    expect(await screen.findByRole("textbox", { name: /sql editor/i })).toBeInTheDocument();
  });

  it("opens the palette from the empty state", async () => {
    const user = await mount();
    await user.click(await screen.findByTitle("Close"));
    await screen.findByText(/No query open/i);
    await user.click(screen.getByRole("button", { name: /Command palette/i }));
    expect(await screen.findByPlaceholderText(/type a command/i)).toBeInTheDocument();
  });
});
