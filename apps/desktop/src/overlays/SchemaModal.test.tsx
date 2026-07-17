import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SchemaModal, { type SchemaExtra } from "./SchemaModal";
import type { DbColumn } from "../ipc/types";

const col = (name: string, over: Partial<DbColumn> = {}): DbColumn =>
  ({ name, dbType: "text", nullable: true, primaryKey: false, comment: null, ...over }) as DbColumn;

const extra: SchemaExtra = {
  indexes: [{ name: "users_pkey", def: "CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)" }],
  rowsEstimate: 3_000_242,
  totalSize: "3522 MB",
  comment: "the big one",
};

const base = {
  schema: "public",
  name: "users",
  kind: "table",
  columns: [col("id", { primaryKey: true, nullable: false, dbType: "int8" }), col("email")],
  extra,
  onClose: vi.fn(),
};

describe("SchemaModal", () => {
  it("titles with the qualified name and kind", () => {
    render(<SchemaModal {...base} />);
    expect(screen.getByText("public.users")).toBeInTheDocument();
    expect(screen.getByText("table")).toBeInTheDocument();
  });

  it("says loading before the columns arrive", () => {
    render(<SchemaModal {...base} columns={null} />);
    expect(screen.getByText("loading…")).toBeInTheDocument();
  });

  it("shows the size, row estimate and index count", () => {
    render(<SchemaModal {...base} />);
    expect(screen.getByText("3,000,242")).toBeInTheDocument();
    expect(screen.getByText("3522 MB")).toBeInTheDocument();
    expect(screen.getByText("the big one")).toBeInTheDocument();
  });

  it("shows a dash rather than a zero it does not know", () => {
    render(<SchemaModal {...base} extra={null} />);
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(3);
  });

  it("shows a dash for a negative row estimate — reltuples means unknown, not empty", () => {
    render(<SchemaModal {...base} extra={{ ...extra, rowsEstimate: -1 }} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("shows zero rows when that is genuinely the estimate", () => {
    render(<SchemaModal {...base} extra={{ ...extra, rowsEstimate: 0 }} />);
    expect(screen.getByText("0")).toBeInTheDocument();
  });

  it("marks the index count as pending rather than zero while loading", () => {
    render(<SchemaModal {...base} extra={null} />);
    expect(screen.getByText("…")).toBeInTheDocument();
  });

  it("lists columns with their types", () => {
    render(<SchemaModal {...base} />);
    expect(screen.getByText("id")).toBeInTheDocument();
    expect(screen.getByText("int8")).toBeInTheDocument();
    expect(screen.getByText("email")).toBeInTheDocument();
  });

  it("marks the primary key and the not-null columns", () => {
    render(<SchemaModal {...base} />);
    expect(screen.getByText("🔑")).toBeInTheDocument();
    expect(screen.getByText("not null")).toBeInTheDocument();
  });

  it("lists indexes, stripping the boilerplate prefix", () => {
    render(<SchemaModal {...base} />);
    expect(screen.getByText("users_pkey")).toBeInTheDocument();
    expect(screen.getByText(/btree \(id\)/)).toBeInTheDocument();
  });

  it("says so when a table has no indexes", () => {
    render(<SchemaModal {...base} extra={{ ...extra, indexes: [] }} />);
    expect(screen.getByText("no indexes")).toBeInTheDocument();
  });

  it("reconstructs DDL from the columns", () => {
    render(<SchemaModal {...base} />);
    const ddl = screen.getByText(/create table public\.users/);
    expect(ddl).toHaveTextContent("id int8 primary key");
    expect(ddl).toHaveTextContent("email text");
  });

  it("does not say not null on a primary key — it is implied", () => {
    render(<SchemaModal {...base} />);
    expect(screen.getByText(/create table/)).not.toHaveTextContent("primary key not null");
  });

  it("marks a not-null non-key column in the DDL", () => {
    render(<SchemaModal {...base} columns={[col("email", { nullable: false })]} />);
    expect(screen.getByText(/create table/)).toHaveTextContent("email text not null");
  });

  it("shows a placeholder rather than half-built DDL while loading", () => {
    render(<SchemaModal {...base} columns={null} />);
    expect(screen.queryByText(/create table/)).not.toBeInTheDocument();
  });

  it("closes", async () => {
    const onClose = vi.fn();
    render(<SchemaModal {...base} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });
});
