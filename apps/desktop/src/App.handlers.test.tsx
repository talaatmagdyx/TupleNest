import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { CONNECTION, LOST, PLAN, RESULT, backend, type Backend } from "./test/backend";

/** The handlers that are only reachable by clicking the thing itself. */

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

const connected = async () => {
  const user = await mount();
  await palette(user, "Connect to local dev");
  await waitFor(() => expect(be.sent("pg_connect")).toHaveLength(1));
  return user;
};

const modal = () => document.querySelector(".modal") as HTMLElement;

describe("App — the explorer's other groups", () => {
  /** A catalog with something under every group. */
  const rich = () =>
    be.on("pg_metadata", (a) => {
      const req = a.request as Record<string, unknown>;
      switch (req.kind) {
        case "list_schemas":
          return { payload: ["public"], cached: false };
        case "server_info":
          return { payload: { version: "PostgreSQL 18.0" }, cached: false };
        case "list_objects":
          return {
            payload: [{ name: "users", kind: "table", isPartitioned: true, partitionCount: 1 }],
            cached: false,
          };
        case "describe_object":
          return {
            payload: { columns: [{ name: "id", dbType: "int8", nullable: false, primaryKey: true }] },
            cached: false,
          };
        case "list_indexes":
          return {
            payload: [
              {
                name: "users_pkey",
                definition: "CREATE UNIQUE INDEX users_pkey ON users (id)",
                isUnique: true,
                isPrimary: true,
                bytes: 8192,
                scans: 12,
                isValid: true,
              },
            ],
            cached: false,
          };
        case "list_constraints":
          return {
            payload: [
              { name: "users_email_check", kind: "check", definition: "CHECK (email <> '')", isValid: true },
            ],
            cached: false,
          };
        case "list_partitions":
          return {
            payload: [
              {
                name: "users_p0",
                bounds: "FOR VALUES FROM (0) TO (10)",
                bytes: 8192,
                rowsEstimate: 1,
                isPartitioned: false,
                partitionCount: 0,
              },
            ],
            cached: false,
          };
        case "list_types":
          return { payload: [{ name: "mood", kind: "enum", comment: null, labels: "happy, sad" }], cached: false };
        case "list_routines":
          return {
            payload: [
              { name: "now_utc", kind: "function", args: "", returns: "timestamptz", comment: null, language: "sql" },
            ],
            cached: false,
          };
        default:
          return { payload: [], cached: false };
      }
    });

  const table = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(await screen.findByText("public"));
    await user.click(await screen.findByText("Tables"));
    await user.click(await screen.findByText("users"));
  };

  it("expands the indexes of a table", async () => {
    const user = await mount();
    rich();
    await palette(user, "Connect to local dev");
    await table(user);
    await user.click(await screen.findByText("Indexes"));
    expect(await screen.findByText("users_pkey")).toBeInTheDocument();
  });

  it("expands the constraints of a table", async () => {
    const user = await mount();
    rich();
    await palette(user, "Connect to local dev");
    await table(user);
    await user.click(await screen.findByText("Constraints"));
    expect(await screen.findByText("users_email_check")).toBeInTheDocument();
  });

  it("expands the partitions of a table", async () => {
    const user = await mount();
    rich();
    await palette(user, "Connect to local dev");
    await table(user);
    await user.click(await screen.findByText("Partitions"));
    expect(await screen.findByText("users_p0")).toBeInTheDocument();
  });

  it("expands a schema's types", async () => {
    const user = await mount();
    rich();
    await palette(user, "Connect to local dev");
    await user.click(await screen.findByText("public"));
    await user.click(await screen.findByText("Types & enums"));
    expect(await screen.findByText("mood")).toBeInTheDocument();
  });

  it("expands a schema's routines", async () => {
    const user = await mount();
    rich();
    await palette(user, "Connect to local dev");
    await user.click(await screen.findByText("public"));
    await user.click(await screen.findByText("Functions"));
    expect(await screen.findByText("now_utc")).toBeInTheDocument();
  });
});

describe("App — the Plan tab", () => {
  it("runs EXPLAIN from the result tabs", async () => {
    be.on("pg_query", () => ({
      columns: [{ name: "QUERY PLAN", dbType: "json" }],
      totalRows: 1,
      storedRows: 1,
      truncated: false,
      rowsAffected: null,
    }));
    be.on("pg_rows", () => [[JSON.stringify(PLAN)]]);
    const user = await connected();
    await user.click(screen.getByRole("button", { name: /^Plan$/ }));
    await waitFor(() => expect(document.querySelector(".modal")).toBeInTheDocument());
    expect((await within(modal()).findAllByText(/Seq Scan/)).length).toBeGreaterThan(0);
  });

  it("copies the plan as text", async () => {
    be.on("pg_query", () => ({
      columns: [{ name: "QUERY PLAN", dbType: "json" }],
      totalRows: 1,
      storedRows: 1,
      truncated: false,
      rowsAffected: null,
    }));
    be.on("pg_rows", () => [[JSON.stringify(PLAN)]]);
    const user = await connected();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await palette(user, "Show EXPLAIN plan");
    await within(modal()).findAllByText(/Seq Scan/);
    await user.click(within(modal()).getByRole("button", { name: /Export/i }));
    const menu = await waitFor(() => document.querySelector(".drop-menu") as HTMLElement);
    // Under "Copy to clipboard", the text-tree option.
    const copies = within(menu).getAllByRole("button", { name: /text/i });
    await user.click(copies[copies.length - 1]);
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(String(writeText.mock.calls[0][0])).toContain("Seq Scan");
  });
});

describe("App — the settings", () => {
  it("switches to the light theme and back", async () => {
    const user = await mount();
    await palette(user, "Open settings");
    const seg = await screen.findByText("Theme");
    const group = seg.closest(".srow") ?? modal();
    await user.click(within(group as HTMLElement).getByRole("button", { name: "Light" }));
    await waitFor(() => expect(document.documentElement.getAttribute("data-tn-theme")).toBe("light"));
    await user.click(within(group as HTMLElement).getByRole("button", { name: "Dark" }));
    await waitFor(() => expect(document.documentElement.getAttribute("data-tn-theme")).toBe("dark"));
  });
});

describe("App — the lost-session notice", () => {
  it("reconnects on request", async () => {
    // The session is gone and nothing was re-run. Reconnecting is the only
    // thing this notice offers, and it must open a fresh one.
    be.on("pg_query", () => {
      throw new Error(LOST);
    });
    const user = await connected();
    await user.click(screen.getByRole("button", { name: /^Run/ }));
    await waitFor(() => expect(document.querySelector(".modal")).toBeInTheDocument());
    await user.click(within(modal()).getByRole("button", { name: /reconnect/i }));
    await waitFor(() => expect(be.sent("pg_connect")).toHaveLength(2));
  });

  it("can be dismissed without reconnecting", async () => {
    be.on("pg_query", () => {
      throw new Error(LOST);
    });
    const user = await connected();
    await user.click(screen.getByRole("button", { name: /^Run/ }));
    await waitFor(() => expect(document.querySelector(".modal")).toBeInTheDocument());
    await user.click(within(modal()).getByRole("button", { name: /Close|Dismiss/ }));
    await waitFor(() => expect(document.querySelector(".modal")).not.toBeInTheDocument());
    expect(be.sent("pg_connect")).toHaveLength(1);
  });
});

describe("App — query parameters", () => {
  const prompted = async () => {
    const user = await connected();
    const ta = screen.getByRole("textbox", { name: /sql editor/i });
    await user.click(ta);
    await user.clear(ta);
    await user.type(ta, "select * from users where id = $1");
    await user.click(screen.getByRole("button", { name: /^Run/ }));
    await waitFor(() => expect(document.querySelector(".modal")).toBeInTheDocument());
    return user;
  };

  it("runs with the values it was given", async () => {
    const user = await prompted();
    const box = within(modal()).getAllByRole("textbox")[0];
    await user.type(box, "42");
    await user.click(within(modal()).getByRole("button", { name: /^Run/ }));
    await waitFor(() => expect(be.sent("pg_query")).toHaveLength(1));
    expect(be.sent("pg_query")[0].params).toEqual([42]);
  });

  it("backs out without running", async () => {
    const user = await prompted();
    await user.click(within(modal()).getByRole("button", { name: /^Cancel$/ }));
    await waitFor(() => expect(document.querySelector(".modal")).not.toBeInTheDocument());
    expect(be.sent("pg_query")).toHaveLength(0);
  });
});

describe("App — the grid", () => {
  it("fetches the next window as you scroll", async () => {
    be.on("pg_query", () => ({ ...RESULT, totalRows: 5000, storedRows: 5000 }));
    be.on("pg_rows", (a) => {
      const offset = a.offset as number;
      return Array.from({ length: 200 }, (_, i) => [`r${offset + i}`, offset + i]);
    });
    const user = await connected();
    await user.click(screen.getByRole("button", { name: /^Run/ }));
    await waitFor(() => expect(be.sent("pg_rows").length).toBeGreaterThan(0));
    const before = be.sent("pg_rows").length;
    const view = document.querySelector(".vgrid") as HTMLElement;
    fireEvent.scroll(view, { target: { scrollTop: 8000 } });
    await waitFor(() => expect(be.sent("pg_rows").length).toBeGreaterThan(before));
  });
});

describe("App — the rest of the import wizard", () => {
  const wizard = async () => {
    const user = await connected();
    await palette(user, "Import CSV");
    await waitFor(() => expect(document.querySelector(".modal")).toBeInTheDocument());
    return user;
  };

  it("opens the file picker from the button", async () => {
    // The <input type=file> is hidden; the visible button stands in for it.
    const user = await wizard();
    const input = modal().querySelector('input[type="file"]') as HTMLInputElement;
    const click = vi.spyOn(input, "click");
    await user.click(within(modal()).getByRole("button", { name: /Choose file/i }));
    expect(click).toHaveBeenCalled();
  });

  it("parses with the delimiter it was told to use", async () => {
    // A semicolon file read as comma-separated is one wide column, and the
    // wizard would offer to create a table with one column in it.
    const user = await wizard();
    const [delimiter] = within(modal()).getAllByRole("combobox");
    await user.selectOptions(delimiter, ";");
    const input = modal().querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File(["id;name\n1;ada\n"], "p.csv", { type: "text/csv" }));
    expect(await within(modal()).findByText("ada")).toBeInTheDocument();
  });

  it("imports into the schema it was pointed at", async () => {
    const user = await wizard();
    const input = modal().querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File(["id,name\n1,ada\n"], "p.csv", { type: "text/csv" }));
    await within(modal()).findByText("ada");
    const schema = within(modal()).getAllByRole("combobox")[0];
    await user.selectOptions(schema, "public");
    await user.click(within(modal()).getByRole("button", { name: /^Import/i }));
    await waitFor(() => expect(be.sent("pg_query").length).toBeGreaterThan(0));
    // Identifiers are quoted, so this is `"public"."p"`.
    expect(String(be.sent("pg_query")[0].sql)).toContain('"public"."p"');
  });
});

describe("App — comparing two schemas", () => {
  it("diffs the pair it was given", async () => {
    be.on("pg_metadata", (a) => {
      const req = a.request as Record<string, unknown>;
      if (req.kind === "list_schemas") return { payload: ["public", "audit"], cached: false };
      if (req.kind === "server_info") return { payload: { version: "PostgreSQL 18.0" }, cached: false };
      return { payload: [], cached: false };
    });
    const user = await connected();
    await palette(user, "Compare schemas");
    await waitFor(() => expect(document.querySelector(".modal")).toBeInTheDocument());
    const tabs = modal().querySelectorAll(".rtab");
    await user.click([...tabs].find((t) => /diff|compare/i.test(t.textContent ?? ""))!);
    const [left, right] = within(modal()).getAllByRole("combobox");
    await user.selectOptions(left, "public");
    await user.selectOptions(right, "audit");
    expect((left as HTMLSelectElement).value).toBe("public");
    expect((right as HTMLSelectElement).value).toBe("audit");
  });
});

describe("App — the macOS menu bar's About", () => {
  it("opens the real About box, not the system's version panel", async () => {
    // The menu item lives in Rust and only emits; without this listener the
    // menu bar fell through to macOS's bare panel while the palette opened
    // the designed one — two different About boxes.
    const { listen } = await import("@tauri-apps/api/event");
    await mount();

    const call = vi.mocked(listen).mock.calls.find(([name]) => name === "menu:about");
    expect(call, "App never subscribed to menu:about").toBeDefined();

    const handler = call![1] as (e: unknown) => void;
    handler({ event: "menu:about", id: 1, payload: undefined });

    await waitFor(() => expect(screen.getByText("About TupleNest")).toBeInTheDocument());
    expect(screen.getByText("github.com/talaatmagdyx")).toBeInTheDocument();
  });

  it("opens the pasted-plan analyser from the File menu", async () => {
    // The Rust side only emits; if nothing listens, the menu item does nothing
    // at all and the failure is silent.
    const { listen } = await import("@tauri-apps/api/event");
    await mount();

    const call = vi.mocked(listen).mock.calls.find(([name]) => name === "menu:paste-plan");
    expect(call, "App never subscribed to menu:paste-plan").toBeDefined();

    const handler = call![1] as (e: unknown) => void;
    handler({ event: "menu:paste-plan", id: 1, payload: undefined });

    await waitFor(() => expect(screen.getByLabelText(/paste a query plan/i)).toBeInTheDocument());
  });
});

describe("App — one session, many tabs: the transaction has an owner", () => {
  /*
   * Tabs are editors over a single PostgreSQL session, so a transaction opened
   * in one tab is joined by every other tab's statements. Pressing Commit in a
   * different tab used to commit the first tab's uncommitted work — a DELETE
   * you could not see from where you clicked.
   */
  const openTxInFirstTab = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(await screen.findByRole("button", { name: /Begin transaction/ }));
    await waitFor(() => expect(be.sent("pg_begin")).toHaveLength(1));
  };

  it("refuses to commit from a tab that did not open the transaction, and says which did", async () => {
    const user = await connected();
    await openTxInFirstTab(user);

    // A second tab, which knows nothing about the transaction.
    await user.keyboard("{Meta>}t{/Meta}");
    await user.click(screen.getByRole("button", { name: "Commit" }));

    expect(be.sent("pg_commit")).toHaveLength(0);
    expect(await screen.findByText(/belongs to untitled-1\.sql/)).toBeInTheDocument();
  });

  it("commits from the owning tab", async () => {
    const user = await connected();
    await openTxInFirstTab(user);
    await user.click(screen.getByRole("button", { name: "Commit" }));
    await waitFor(() => expect(be.sent("pg_commit")).toHaveLength(1));
  });

  it("lets the owning tab be returned to after a detour", async () => {
    const user = await connected();
    await openTxInFirstTab(user);
    await user.keyboard("{Meta>}t{/Meta}");
    // Back to tab 1 — the owner is the tab, not the index.
    await user.click(screen.getByText("untitled-1.sql"));
    await user.click(screen.getByRole("button", { name: "Commit" }));
    await waitFor(() => expect(be.sent("pg_commit")).toHaveLength(1));
  });
});
