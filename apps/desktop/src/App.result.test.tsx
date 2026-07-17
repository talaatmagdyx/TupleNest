import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import App from "./App";
import { CONNECTION, backend, type Backend } from "./test/backend";

/** Copying results, export failures, and the layout drag handles. */

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

const run = async (user: ReturnType<typeof userEvent.setup>, sql = "select kind, n from t") => {
  const ta = screen.getByRole("textbox", { name: /sql editor/i });
  await user.click(ta);
  await user.clear(ta);
  await user.type(ta, sql);
  await user.click(screen.getByRole("button", { name: /^Run/ }));
  await waitFor(() => expect(be.sent("pg_query").length).toBeGreaterThan(0));
};

/** Open the results toolbar's Export menu. */
const exportMenu = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: /^Export/ }));
  return document.querySelector(".drop-menu") as HTMLElement;
};

describe("App — copying the result", () => {
  /**
   * These check the copy path runs and reports honestly — that it read every
   * row and said how many. They do not assert the clipboard's contents:
   * jsdom's `navigator.clipboard` could not be intercepted here (neither
   * spyOn nor defineProperty is what the app ends up calling), so an
   * assertion on it would be checking the stub rather than the app. The
   * formatting itself is covered against `toCSV`/`toMarkdown` in lib/csv.
   */
  it("reads every row before copying, not just the page on screen", async () => {
    // The grid holds a window. Copying what is on screen silently truncates,
    // and the count in the toast is what makes that visible.
    const user = await connected();
    await run(user);
    const menu = await exportMenu(user);
    // "CSV .csv" saves a file; the bare "CSV" under "Copy to clipboard" is
    // the one meant here.
    const csv = within(menu).getAllByRole("button", { name: /^CSV/ });
    await user.click(csv[csv.length - 1]);
    expect(await screen.findByText("CSV copied — 2 rows")).toBeInTheDocument();
    expect(be.sent("pg_rows")[0]).toMatchObject({ offset: 0 });
  });

  it("copies as markdown too", async () => {
    const user = await connected();
    await run(user);
    const menu = await exportMenu(user);
    const md = within(menu).getAllByRole("button", { name: /^Markdown/ });
    await user.click(md[md.length - 1]);
    expect(await screen.findByText(/MD copied/)).toBeInTheDocument();
  });
});

describe("App — exporting the result", () => {
  it("says what a truncated export is missing", async () => {
    // A .csv has no banner. If the count does not say the file holds 2 of
    // 4,213,662 rows, the file reads as the whole answer.
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    vi.mocked(writeTextFile).mockClear();
    vi.mocked(saveDialog).mockResolvedValue("/tmp/out.csv");
    be.on("pg_query", () => ({
      columns: [
        { name: "kind", dbType: "text" },
        { name: "n", dbType: "int4" },
      ],
      totalRows: 4_213_662,
      storedRows: 2,
      truncated: true,
      rowsAffected: null,
    }));
    const user = await connected();
    await run(user);
    const menu = await exportMenu(user);
    await user.click(within(menu).getByRole("button", { name: "CSV .csv" }));
    expect(await screen.findByText(/2 of 4,213,662 rows \(truncated\)/)).toBeInTheDocument();
  });

  it("does not cry truncation on a complete export", async () => {
    vi.mocked(saveDialog).mockResolvedValue("/tmp/out.csv");
    const user = await connected();
    await run(user);
    const menu = await exportMenu(user);
    await user.click(within(menu).getByRole("button", { name: "CSV .csv" }));
    expect(await screen.findByText(/— 2 rows/)).toBeInTheDocument();
  });

  it("says why a write failed rather than claiming it saved", async () => {
    vi.mocked(saveDialog).mockRejectedValue(new Error("disk full"));
    const user = await connected();
    await run(user);
    const menu = await exportMenu(user);
    await user.click(within(menu).getByRole("button", { name: "JSON .json" }));
    expect(await screen.findByText(/Export failed/)).toBeInTheDocument();
  });

  it("writes markdown when markdown was asked for", async () => {
    vi.mocked(saveDialog).mockResolvedValue("/tmp/out.md");
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    vi.mocked(writeTextFile).mockClear();
    const user = await connected();
    await run(user);
    const menu = await exportMenu(user);
    await user.click(within(menu).getByRole("button", { name: "Markdown .md" }));
    await waitFor(() => expect(vi.mocked(writeTextFile)).toHaveBeenCalled());
    expect(String(vi.mocked(writeTextFile).mock.calls[0][1])).toContain("|");
  });
});

describe("App — the layout drag handles", () => {
  it("widens the sidebar as the edge is dragged", async () => {
    await connected();
    const aside = document.querySelector(".sidebar") as HTMLElement;
    const before = parseInt(aside.style.width, 10);
    const grip = document.querySelector(".sidebar-resize") as HTMLElement;
    fireEvent.mouseDown(grip, { clientX: before });
    fireEvent.mouseMove(document, { clientX: before + 80 });
    expect(parseInt(aside.style.width, 10)).toBe(before + 80);
    fireEvent.mouseUp(document);
  });

  it("stops at a width the tree is still readable at", async () => {
    // Dragged to nothing, the sidebar is a slice with no content; dragged to
    // the moon, it eats the editor. Both ends are clamped.
    await connected();
    const aside = document.querySelector(".sidebar") as HTMLElement;
    const grip = document.querySelector(".sidebar-resize") as HTMLElement;
    fireEvent.mouseDown(grip, { clientX: 272 });
    fireEvent.mouseMove(document, { clientX: -5000 });
    expect(parseInt(aside.style.width, 10)).toBe(200);
    fireEvent.mouseMove(document, { clientX: 5000 });
    expect(parseInt(aside.style.width, 10)).toBe(480);
    fireEvent.mouseUp(document);
  });

  it("lets go of the cursor when the drag ends", async () => {
    // A body stuck on col-resize makes the whole app look frozen.
    await connected();
    const grip = document.querySelector(".sidebar-resize") as HTMLElement;
    fireEvent.mouseDown(grip, { clientX: 272 });
    expect(document.body.style.cursor).toBe("col-resize");
    fireEvent.mouseUp(document);
    expect(document.body.style.cursor).toBe("");
  });

  it("ignores a move that is not a drag", async () => {
    await connected();
    const aside = document.querySelector(".sidebar") as HTMLElement;
    const before = aside.style.width;
    fireEvent.mouseMove(document, { clientX: 999 });
    expect(aside.style.width).toBe(before);
  });
});
