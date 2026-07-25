import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import PlanView from "./PlanView";
import type { IndexSuggestion } from "../lib/index-advisor";

const one: IndexSuggestion[] = [
  {
    table: "orders",
    columns: ["status", "created_at"],
    ddl: "CREATE INDEX ON orders (status, created_at);",
    reason: "Seq Scan on orders reads the whole table to apply this filter.",
  },
];

beforeEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PlanView — candidate indexes", () => {
  it("renders each suggested statement and its reason", () => {
    render(<PlanView nodes={[]} stats={[]} suggestion={null} indexSuggestions={one} error={null} />);
    expect(screen.getByText("CREATE INDEX ON orders (status, created_at);")).toBeTruthy();
    expect(screen.getByText(/reads the whole table/)).toBeTruthy();
    expect(screen.getByText("Candidate indexes")).toBeTruthy();
  });

  it("shows nothing when there are no suggestions", () => {
    render(<PlanView nodes={[]} stats={[]} suggestion={null} indexSuggestions={[]} error={null} />);
    expect(screen.queryByText("Candidate indexes")).toBeNull();
  });

  it("copies the statement and flips the button to Copied, then back", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    render(<PlanView nodes={[]} stats={[]} suggestion={null} indexSuggestions={one} error={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    expect(writeText).toHaveBeenCalledWith("CREATE INDEX ON orders (status, created_at);");
    expect(await screen.findByText("Copied")).toBeTruthy();

    // The label resets itself after the timeout.
    await waitFor(() => expect(screen.getByText("Copy")).toBeTruthy(), { timeout: 2500 });
  });

  it("stays on Copy when the clipboard write is rejected", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("denied");
    });
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    render(<PlanView nodes={[]} stats={[]} suggestion={null} indexSuggestions={one} error={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    // Give the rejected promise a tick to settle; the label must not change.
    await Promise.resolve();
    expect(screen.getByText("Copy")).toBeTruthy();
    expect(screen.queryByText("Copied")).toBeNull();
  });
});
