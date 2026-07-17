import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import DiagramModal from "./DiagramModal";

const invokeMock = vi.mocked(invoke);
beforeEach(() => invokeMock.mockReset());

const fk = (name: string, from: string, to: string) => ({ name, from, to });
const base = { schema: "public", onClose: vi.fn() };

describe("DiagramModal", () => {
  it("asks for the schema's relationships", async () => {
    invokeMock.mockResolvedValue([]);
    render(<DiagramModal {...base} />);
    expect(invokeMock).toHaveBeenCalledWith("pg_relationships", { schema: "public" });
  });

  it("says loading before they arrive", () => {
    invokeMock.mockResolvedValue([]);
    render(<DiagramModal {...base} />);
    expect(screen.getByText("loading relationships…")).toBeInTheDocument();
  });

  it("names the schema in the title", async () => {
    invokeMock.mockResolvedValue([]);
    render(<DiagramModal {...base} />);
    expect(screen.getAllByText("public").length).toBeGreaterThan(0);
  });

  it("says so when a schema has no foreign keys", async () => {
    invokeMock.mockResolvedValue([]);
    render(<DiagramModal {...base} />);
    expect(await screen.findByText(/No foreign keys in/)).toBeInTheDocument();
  });

  /** Node labels only — table names also appear in the key list below. */
  const nodeLabels = (c: HTMLElement) =>
    Array.from(c.querySelectorAll("svg text")).map((t) => t.textContent);

  it("draws a node per table and an edge per key", async () => {
    invokeMock.mockResolvedValue([fk("fk_a", "orders", "users"), fk("fk_b", "items", "orders")]);
    const { container } = render(<DiagramModal {...base} />);
    await screen.findAllByText("orders");
    expect(nodeLabels(container)).toEqual(expect.arrayContaining(["orders", "users", "items"]));
    expect(container.querySelectorAll("svg line, svg path").length).toBeGreaterThan(0);
  });

  it("places every table on the circle exactly once, however many keys touch it", async () => {
    invokeMock.mockResolvedValue([fk("a", "t1", "t2"), fk("b", "t2", "t1")]);
    const { container } = render(<DiagramModal {...base} />);
    await screen.findAllByText("t1");
    expect(nodeLabels(container).filter((l) => l === "t1")).toHaveLength(1);
    expect(nodeLabels(container).filter((l) => l === "t2")).toHaveLength(1);
  });

  it("copes with a self-referencing key without collapsing the layout", async () => {
    // from === to: the dedupe must yield one node, not two stacked on a point.
    invokeMock.mockResolvedValue([fk("parent", "tree", "tree")]);
    const { container } = render(<DiagramModal {...base} />);
    await screen.findAllByText("tree");
    expect(nodeLabels(container).filter((l) => l === "tree")).toHaveLength(1);
  });

  it("shows a failure rather than an empty canvas", async () => {
    // mockReturnValueOnce — see the note in AuditModal.test.tsx.
    const rejected = Promise.reject(new Error("permission denied"));
    rejected.catch(() => {});
    invokeMock.mockReturnValueOnce(rejected);
    render(<DiagramModal {...base} />);
    expect(await screen.findByText(/permission denied/)).toBeInTheDocument();
    expect(screen.queryByText("loading relationships…")).not.toBeInTheDocument();
  });

  it("closes", async () => {
    invokeMock.mockResolvedValue([]);
    const onClose = vi.fn();
    render(<DiagramModal {...base} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });
});
