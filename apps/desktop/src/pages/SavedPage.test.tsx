import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SavedPage, { tagsOf } from "./SavedPage";
import type { SnippetRecord } from "../ipc/types";

const sn = (id: string, name: string, tags: string | null = null): SnippetRecord => ({
  id,
  name,
  body: `select '${name}'`,
  tags,
});

const base = { items: [sn("1", "weekly"), sn("2", "monthly")], onOpen: vi.fn(), onNew: vi.fn(), onClose: vi.fn() };

describe("tagsOf", () => {
  it("splits the stored column on commas and drops blanks", () => {
    expect(tagsOf(sn("1", "x", " finance, ,ops "))).toEqual(["finance", "ops"]);
    expect(tagsOf(sn("1", "x"))).toEqual([]);
  });
});

describe("SavedPage", () => {
  it("shows a card per snippet with its name and text", () => {
    render(<SavedPage {...base} />);
    expect(screen.getByRole("region", { name: "Saved queries" })).toBeInTheDocument();
    expect(screen.getByText("weekly")).toBeInTheDocument();
    expect(screen.getByText("select 'monthly'")).toBeInTheDocument();
  });

  it("shows no tag chips when nothing is tagged", () => {
    render(<SavedPage {...base} />);
    expect(screen.queryByRole("group", { name: "Filter by tag" })).not.toBeInTheDocument();
  });

  it("filters by tag when snippets have them", async () => {
    render(<SavedPage {...base} items={[sn("1", "weekly", "finance"), sn("2", "monthly", "ops")]} />);
    await userEvent.click(screen.getByRole("button", { name: "ops" }));
    expect(screen.getByRole("button", { name: "ops" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText("weekly")).not.toBeInTheDocument();
    expect(screen.getByText("monthly")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByText("weekly")).toBeInTheDocument();
  });

  it("opens a snippet, and starts a new query", async () => {
    const onOpen = vi.fn();
    const onNew = vi.fn();
    render(<SavedPage {...base} onOpen={onOpen} onNew={onNew} />);
    await userEvent.click(screen.getByTitle("Open “weekly” in the editor"));
    expect(onOpen).toHaveBeenCalledWith(base.items[0]);
    await userEvent.click(screen.getByRole("button", { name: "New query" }));
    expect(onNew).toHaveBeenCalled();
  });

  it("says how to save one when there are none", () => {
    render(<SavedPage {...base} items={[]} />);
    expect(screen.getByText(/Nothing saved yet/)).toBeInTheDocument();
  });

  it("goes back on Escape", () => {
    const onClose = vi.fn();
    render(<SavedPage {...base} onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "New query" }), { key: "Escape" });
    fireEvent.keyDown(screen.getByRole("button", { name: "New query" }), { key: "Enter" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
