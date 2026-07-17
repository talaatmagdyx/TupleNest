import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import EditReviewModal from "./EditReviewModal";
import type { CellEdit, EditTarget } from "../lib/dml";

const target: EditTarget = {
  schema: "public",
  table: "users",
  pk: [{ name: "id", index: 0 }],
  writable: [true, true],
};

const edit = (rowKey: string, column: string, value: unknown): CellEdit => ({
  rowKey,
  pkValues: [Number(rowKey.replace(/\D/g, "")) || 1],
  column,
  value,
});

const base = {
  target,
  edits: [edit("[1]", "email", "a@b.c")],
  env: "dev" as string | null,
  applying: false,
  error: null as string | null,
  onApply: vi.fn(),
  onDiscard: vi.fn(),
  onClose: vi.fn(),
};

describe("EditReviewModal", () => {
  it("counts the cells and the rows they span", () => {
    render(<EditReviewModal {...base} />);
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText(/cell across 1 row in/)).toBeInTheDocument();
  });

  it("pluralises cells and rows", () => {
    render(
      <EditReviewModal {...base} edits={[edit("[1]", "email", "x"), edit("[2]", "email", "y")]} />,
    );
    expect(screen.getByText(/cells across 2 rows in/)).toBeInTheDocument();
  });

  it("names the table being written to", () => {
    render(<EditReviewModal {...base} />);
    expect(screen.getByText("public.users")).toBeInTheDocument();
  });

  it("shows the statement that will run", () => {
    render(<EditReviewModal {...base} />);
    expect(screen.getByText(/UPDATE/)).toBeInTheDocument();
  });

  it("promises the whole batch is one transaction", () => {
    render(<EditReviewModal {...base} />);
    expect(screen.getByText(/any failure rolls back all of it/)).toBeInTheDocument();
  });

  it("stays quiet about production outside production", () => {
    render(<EditReviewModal {...base} />);
    expect(screen.queryByText(/Production\./)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Apply 1/ })).toHaveClass("primary");
  });

  it("warns loudly on production, and says there is no undo", () => {
    render(<EditReviewModal {...base} env="prod" />);
    expect(screen.getByText(/Production\./)).toBeInTheDocument();
    expect(screen.getByText(/there is no undo/)).toBeInTheDocument();
  });

  it("makes the production apply button the dangerous-looking one", () => {
    render(<EditReviewModal {...base} env="prod" />);
    const apply = screen.getByRole("button", { name: "Apply to production" });
    expect(apply).toHaveClass("danger");
    expect(apply).not.toHaveClass("primary");
  });

  it("applies and discards", async () => {
    const onApply = vi.fn();
    const onDiscard = vi.fn();
    render(<EditReviewModal {...base} onApply={onApply} onDiscard={onDiscard} />);
    await userEvent.click(screen.getByRole("button", { name: /Apply 1/ }));
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(onApply).toHaveBeenCalled();
    expect(onDiscard).toHaveBeenCalled();
  });

  it("locks both buttons while applying, so a write cannot be double-sent", () => {
    render(<EditReviewModal {...base} applying />);
    expect(screen.getByRole("button", { name: "Applying…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Discard" })).toBeDisabled();
  });

  it("shows a failure without discarding the pending edits", () => {
    render(<EditReviewModal {...base} error="deadlock detected" />);
    expect(screen.getByText("deadlock detected")).toBeInTheDocument();
    expect(screen.getByText(/UPDATE/)).toBeInTheDocument();
  });

  it("closes on the backdrop but not on the dialog itself", async () => {
    const onClose = vi.fn();
    const { container } = render(<EditReviewModal {...base} onClose={onClose} />);
    await userEvent.click(screen.getByText("Review changes"));
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.click(container.querySelector(".overlay")!);
    expect(onClose).toHaveBeenCalled();
  });

  it("closes from the x", async () => {
    const onClose = vi.fn();
    render(<EditReviewModal {...base} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });
});
