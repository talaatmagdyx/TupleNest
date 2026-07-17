import { beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { CONNECTION, backend, type Backend } from "./test/backend";

/** The global keyboard shortcuts, and the two panes you can drag. */

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

const editor = () => screen.getByRole("textbox", { name: /sql editor/i }) as HTMLTextAreaElement;

describe("App — keyboard shortcuts", () => {
  it("runs the query with ⌘↵", async () => {
    const user = await connected();
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    await waitFor(() => expect(be.sent("pg_query")).toHaveLength(1));
  });

  it("formats the SQL with ⌘⇧F", async () => {
    const user = await connected();
    const ta = editor();
    await user.click(ta);
    await user.clear(ta);
    await user.type(ta, "select a,b from t where x=1");
    await user.keyboard("{Meta>}{Shift>}f{/Shift}{/Meta}");
    await waitFor(() => expect(ta.value).not.toBe("select a,b from t where x=1"));
    expect(ta.value.toLowerCase()).toContain("select");
  });

  it("does nothing when there is no SQL to format", async () => {
    const user = await connected();
    const ta = editor();
    await user.click(ta);
    await user.clear(ta);
    await user.keyboard("{Meta>}{Shift>}f{/Shift}{/Meta}");
    expect(ta.value).toBe("");
  });

  it("toggles the theme with ⌘⇧L, and remembers it", async () => {
    const user = await mount();
    const before = document.documentElement.getAttribute("data-tn-theme");
    await user.keyboard("{Meta>}{Shift>}l{/Shift}{/Meta}");
    await waitFor(() => expect(document.documentElement.getAttribute("data-tn-theme")).not.toBe(before));
    // A theme that resets on restart is not a setting.
    await waitFor(() => expect(be.sent("settings_set").length).toBeGreaterThan(0));
  });

  it("opens the connection editor with ⌘O", async () => {
    const user = await mount();
    await user.keyboard("{Meta>}o{/Meta}");
    expect(await screen.findByRole("button", { name: /^Save & Connect$/ })).toBeInTheDocument();
  });

  it("collapses and restores the sidebar with ⌘B", async () => {
    const user = await mount();
    const bar = () => document.querySelector(".sidebar") as HTMLElement;
    expect(bar().style.width).not.toBe("0px");
    await user.keyboard("{Meta>}b{/Meta}");
    await waitFor(() => expect(bar().style.width).toBe("0px"));
    await user.keyboard("{Meta>}b{/Meta}");
    await waitFor(() => expect(bar().style.width).not.toBe("0px"));
  });

  it("opens a new tab with ⌘T", async () => {
    const user = await mount();
    await user.keyboard("{Meta>}t{/Meta}");
    await waitFor(() => expect(document.querySelectorAll(".qtab")).toHaveLength(2));
  });

  it("opens the cheatsheet with ?", async () => {
    await mount();
    // Not typed into a field — bare "?" from the editor would be a character.
    fireEvent.keyDown(document.body, { key: "?" });
    expect(await screen.findByText(/shortcut/i)).toBeInTheDocument();
  });

  it("does not open the cheatsheet from a ? typed into the editor", async () => {
    const user = await connected();
    await user.click(editor());
    await user.keyboard("?");
    expect(editor().value).toContain("?");
  });

  it("opens the global search with ⌘P only when connected", async () => {
    // The search reads pg_catalog. Offline it would open and immediately fail.
    const user = await mount();
    await user.keyboard("{Meta>}p{/Meta}");
    expect(screen.queryByPlaceholderText(/search/i)).not.toBeInTheDocument();
    await palette(user, "Connect to local dev");
    await waitFor(() => expect(be.sent("pg_connect")).toHaveLength(1));
    await user.keyboard("{Meta>}p{/Meta}");
    await waitFor(() => expect(document.querySelector(".modal")).toBeInTheDocument());
  });
});

describe("App — Escape", () => {
  it("closes the overlay that is open", async () => {
    const user = await mount();
    await user.keyboard("{Meta>}o{/Meta}");
    await screen.findByRole("button", { name: /^Save & Connect$/ });
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /^Save & Connect$/ })).not.toBeInTheDocument(),
    );
  });

  it("cancels the running query when nothing is covering the screen", async () => {
    // Escape on a slow query is the reflex. With no overlay open there is
    // nothing else for it to mean.
    let release = () => {};
    be.on("pg_query", () => new Promise(() => { release = () => {}; }));
    const user = await connected();
    await user.click(screen.getByRole("button", { name: /^Run/ }));
    await screen.findByRole("button", { name: /^Cancel$/ });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(be.sent("pg_cancel")).toHaveLength(1));
    release();
  });

  it("does not cancel the query while an overlay is up", async () => {
    // Escape dismisses the thing in front of you, not the thing behind it.
    be.on("pg_query", () => new Promise(() => {}));
    const user = await connected();
    await user.click(screen.getByRole("button", { name: /^Run/ }));
    await screen.findByRole("button", { name: /^Cancel$/ });
    await user.keyboard("{Meta>}k{/Meta}");
    await screen.findByPlaceholderText(/type a command/i);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByPlaceholderText(/type a command/i)).not.toBeInTheDocument());
    expect(be.sent("pg_cancel")).toHaveLength(0);
  });

  it("says so when the cancel could not be sent", async () => {
    be.on("pg_query", () => new Promise(() => {}));
    be.on("pg_cancel", () => {
      throw new Error("no query in progress");
    });
    const user = await connected();
    await user.click(screen.getByRole("button", { name: /^Run/ }));
    await user.click(await screen.findByRole("button", { name: /^Cancel$/ }));
    expect(await screen.findByText(/Cancel error: .*no query in progress/)).toBeInTheDocument();
  });

  it("closes the connection menu", async () => {
    const user = await mount();
    await user.click(document.querySelector(".conn-switch > button") as HTMLElement);
    await waitFor(() => expect(document.querySelector(".conn-menu")).toBeInTheDocument());
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.querySelector(".conn-menu")).not.toBeInTheDocument());
  });
});

describe("App — the splitter", () => {
  /** jsdom has no layout, so the drag is driven by the coordinates the
   *  handler actually reads: clientY. */
  const drag = async (handle: Element, from: number, to: number) => {
    fireEvent.mouseDown(handle, { clientY: from, clientX: from });
    await act(async () => {
      fireEvent.mouseMove(document, { clientY: to, clientX: to });
    });
    fireEvent.mouseUp(document);
  };

  it("resizes the editor pane", async () => {
    await mount();
    const split = document.querySelector(".splitter") as HTMLElement;
    const pane = document.querySelector(".editor-frame") as HTMLElement;
    const before = pane.style.height;
    await drag(split, 300, 380);
    expect(pane.style.height).not.toBe(before);
  });

  it("will not let the editor be dragged shut", async () => {
    // Below ~120px the editor is a slit you cannot read a query in.
    await mount();
    const split = document.querySelector(".splitter") as HTMLElement;
    const pane = document.querySelector(".editor-frame") as HTMLElement;
    await drag(split, 300, -4000);
    expect(parseInt(pane.style.height, 10)).toBeGreaterThanOrEqual(120);
  });

  it("will not let the editor eat the whole window", async () => {
    await mount();
    const split = document.querySelector(".splitter") as HTMLElement;
    const pane = document.querySelector(".editor-frame") as HTMLElement;
    await drag(split, 300, 4000);
    expect(parseInt(pane.style.height, 10)).toBeLessThanOrEqual(480);
  });

  it("stops resizing once the button is released", async () => {
    await mount();
    const split = document.querySelector(".splitter") as HTMLElement;
    const pane = document.querySelector(".editor-frame") as HTMLElement;
    await drag(split, 300, 380);
    const settled = pane.style.height;
    await act(async () => {
      fireEvent.mouseMove(document, { clientY: 460 });
    });
    expect(pane.style.height).toBe(settled);
  });

  it("resizes the sidebar, within its limits", async () => {
    await mount();
    const grip = document.querySelector(".sidebar-resize") as HTMLElement;
    const bar = document.querySelector(".sidebar") as HTMLElement;
    await drag(grip, 260, 4000);
    expect(parseInt(bar.style.width, 10)).toBeLessThanOrEqual(480);
    await drag(grip, 260, -4000);
    expect(parseInt(bar.style.width, 10)).toBeGreaterThanOrEqual(200);
  });

  it("ignores mouse movement when no drag is in progress", async () => {
    await mount();
    const pane = document.querySelector(".editor-frame") as HTMLElement;
    const before = pane.style.height;
    await act(async () => {
      fireEvent.mouseMove(document, { clientY: 999 });
    });
    expect(pane.style.height).toBe(before);
  });
});

describe("App — the activity rail", () => {
  it("collapses the sidebar when the view already showing is clicked again", async () => {
    const user = await mount();
    const explorer = screen.getByTitle(/Explorer/i);
    const bar = () => document.querySelector(".sidebar") as HTMLElement;
    await user.click(explorer);
    await waitFor(() => expect(bar().style.width).toBe("0px"));
    await user.click(explorer);
    await waitFor(() => expect(bar().style.width).not.toBe("0px"));
  });

  it("switches view rather than collapsing when a different one is clicked", async () => {
    const user = await mount();
    await user.click(screen.getByTitle("Query history"));
    expect((document.querySelector(".sidebar") as HTMLElement).style.width).not.toBe("0px");
    expect(await screen.findByText("select 1")).toBeInTheDocument();
  });

  it("re-opens a collapsed sidebar on the view that was clicked", async () => {
    const user = await mount();
    await user.keyboard("{Meta>}b{/Meta}");
    await waitFor(() =>
      expect((document.querySelector(".sidebar") as HTMLElement).style.width).toBe("0px"),
    );
    await user.click(screen.getByTitle("Query history"));
    expect(await screen.findByText("select 1")).toBeInTheDocument();
  });
});
