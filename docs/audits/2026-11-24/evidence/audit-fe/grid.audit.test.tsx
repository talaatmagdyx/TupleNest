import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import Grid, { type GridColumn } from "@app/results/Grid";
import App from "@app/App";
import { CONNECTION, backend } from "@app/test/backend";

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() { return this.className?.includes?.("vgrid") ? 360 : 0; },
  });
});
const base = { epoch: 1, onInspect: vi.fn(), onCopyable: vi.fn(), onToast: vi.fn() };

describe("AUDIT grid keyboard", () => {
  it("End on a wide result drops keyboard focus out of the grid", async () => {
    const wide: GridColumn[] = [...Array(60)].map((_, i) => ({ name: `c${i}`, dbType: "text" }));
    vi.mocked(invoke).mockResolvedValue([wide.map((_, i) => `v${i}`)] as never);
    const { container } = render(<Grid {...base} columns={wide} storedRows={1} />);
    const view = container.querySelector(".vgrid") as HTMLElement;
    Object.defineProperty(view, "clientWidth", { configurable: true, value: 56 + 300 });
    await userEvent.click(await screen.findByText("v0"));
    expect(view.contains(document.activeElement)).toBe(true);
    await userEvent.keyboard("{End}");
    fireEvent.scroll(view); // what the browser fires after scrollLeft was assigned
    await act(async () => {});
    const sel = container.querySelector('[aria-selected="true"]');
    console.log("GRID END: scrollLeft", view.scrollLeft, "| selected cell:", sel?.textContent,
      "| activeElement:", document.activeElement?.tagName, document.activeElement?.className,
      "| focus inside grid:", view.contains(document.activeElement));
    // And the keyboard is now dead: ArrowLeft goes to <body>.
    await userEvent.keyboard("{ArrowLeft}");
    console.log("GRID END then ArrowLeft: selected:", container.querySelector('[aria-selected="true"]')?.textContent);
    expect(view.contains(document.activeElement)).toBe(true);
  });

  it("the first ArrowDown from a header skips the first row", async () => {
    const cols: GridColumn[] = [{ name: "id", dbType: "int8" }];
    vi.mocked(invoke).mockResolvedValue([[10], [20], [30]] as never);
    const { container } = render(<Grid {...base} columns={cols} storedRows={3} />);
    await screen.findByText("10");
    (container.querySelector(".g-hcell") as HTMLElement).focus();
    await userEvent.keyboard("{ArrowDown}");
    const sel = container.querySelector('[aria-selected="true"]');
    console.log("GRID FIRST ARROW: selected cell:", sel?.textContent);
    expect(sel?.textContent).toBe("10");
  });
});

describe("AUDIT import can be dismissed mid-flight when focus is outside the dialog", () => {
  it("Escape with focus on <body> unmounts the running import", async () => {
    const be = backend();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText(CONNECTION.name);
    await user.keyboard("{Meta>}k{/Meta}");
    await user.type(await screen.findByPlaceholderText(/type a command/i), "Connect to local dev");
    await user.keyboard("{Enter}");
    await screen.findByText(/Connected — local dev/);
    await user.keyboard("{Meta>}k{/Meta}");
    await user.type(await screen.findByPlaceholderText(/type a command/i), "Import CSV");
    await user.keyboard("{Enter}");
    const modal = await waitFor(() => document.querySelector(".modal") as HTMLElement);
    const file = new File(["id,name\n1,ada\n"], "people.csv", { type: "text/csv" });
    await user.upload(modal.querySelector('input[type="file"]') as HTMLInputElement, file);
    await within(modal).findByText(/ada/);
    be.on("pg_query", (a) => (/^insert into/i.test(String(a.sql)) ? new Promise(() => {}) : { columns: [], storedRows: 0, totalRows: 0, rowsAffected: 0 }));
    await user.click(within(modal).getByRole("button", { name: /^Import/i }));
    await waitFor(() => expect(be.sent("pg_query").some((c) => /^insert into/i.test(String(c.sql)))).toBe(true));
    // Focus leaves the dialog the way a click on the dimmed backdrop does.
    await user.click(document.querySelector(".overlay") as HTMLElement);
    console.log("IMPORT: after backdrop click modal present:", !!document.querySelector(".modal.import"), "| active:", document.activeElement?.tagName);
    (document.activeElement as HTMLElement | null)?.blur?.();
    await user.keyboard("{Escape}");
    console.log("IMPORT: after Escape on body, modal present:", !!document.querySelector(".modal.import"),
      "| commit:", be.sent("pg_commit").length, "| rollback:", be.sent("pg_rollback").length);
    expect(document.querySelector(".modal.import")).not.toBeNull();
  });
});
