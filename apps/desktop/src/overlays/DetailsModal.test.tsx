import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import DetailsModal, { type ObjectDetails } from "./DetailsModal";
import type { TableStructure } from "../lib/structure";

const details: ObjectDetails = {
  title: "messages",
  kind: "table",
  sections: [
    {
      label: "Storage",
      rows: [
        { k: "Total size", v: "3522 MB — all 300 partitions" },
        { k: "Rows (estimate)", v: "3000242" },
      ],
    },
    { label: "About", rows: [{ k: "Owner", v: "appuser" }] },
  ],
};

const base = { schema: "analytics", details, error: null, onClose: vi.fn() };

describe("DetailsModal", () => {
  it("says loading before the data lands", () => {
    render(<DetailsModal {...base} details={null} />);
    expect(screen.getByText("loading…")).toBeInTheDocument();
  });

  it("shows an error instead of sections", () => {
    render(<DetailsModal {...base} details={null} error="nope" />);
    expect(screen.getByText("nope")).toBeInTheDocument();
    expect(screen.queryByText("Storage")).not.toBeInTheDocument();
  });

  it("titles with the kind and the qualified name", () => {
    render(<DetailsModal {...base} />);
    expect(screen.getByText("TABLE")).toBeInTheDocument();
    expect(screen.getByText(/analytics\.messages/)).toBeInTheDocument();
  });

  it("falls back to a neutral title before the payload arrives", () => {
    render(<DetailsModal {...base} details={null} />);
    expect(screen.getByText("OBJECT")).toBeInTheDocument();
  });

  it("renders every section and row", () => {
    render(<DetailsModal {...base} />);
    expect(screen.getByText("Storage")).toBeInTheDocument();
    expect(screen.getByText("Owner")).toBeInTheDocument();
    expect(screen.getByText("appuser")).toBeInTheDocument();
  });

  it("says so when the server had nothing to report", () => {
    render(<DetailsModal {...base} details={{ ...details, sections: [] }} />);
    expect(screen.getByText("Nothing to report.")).toBeInTheDocument();
  });

  it("renders a definition as code rather than prose", () => {
    render(
      <DetailsModal
        {...base}
        details={{ ...details, sections: [{ label: "Definition", rows: [{ k: "SQL", v: "CREATE INDEX x" }] }] }}
      />,
    );
    expect(screen.getByText("CREATE INDEX x")).toHaveClass("det-code");
  });

  it("colours a value that is its own warning", () => {
    render(
      <DetailsModal
        {...base}
        details={{ ...details, sections: [{ label: "Usage", rows: [{ k: "Scans", v: "0 — never used" }] }] }}
      />,
    );
    expect(screen.getByText("0 — never used")).toHaveStyle({ color: "var(--tn-danger)" });
  });

  it("leaves an ordinary value unstyled", () => {
    render(<DetailsModal {...base} />);
    expect(screen.getByText("appuser")).not.toHaveStyle({ color: "var(--tn-danger)" });
  });

  it.each(["sequence", "index", "view", "matview", "wat"])("titles a %s", (kind) => {
    render(<DetailsModal {...base} details={{ ...details, kind }} />);
    expect(screen.getByText(kind.toUpperCase())).toBeInTheDocument();
  });

  it("closes", async () => {
    const onClose = vi.fn();
    render(<DetailsModal {...base} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("has no tabs for an object without columns", () => {
    render(<DetailsModal {...base} />);
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Query this table" })).not.toBeInTheDocument();
  });
});

describe("DetailsModal — structure", () => {
  const structure: TableStructure = {
    columns: [
      { name: "id", dbType: "int8", nullable: false, primaryKey: true, comment: null },
      { name: "customer_id", dbType: "int8", nullable: true, primaryKey: false, comment: "who ordered" },
      { name: "total", dbType: "numeric", nullable: true, primaryKey: false, comment: null, generated: true },
    ],
    indexes: [
      { name: "orders_pkey", definition: "USING btree (id)", isUnique: true, isPrimary: true, bytes: 1, scans: 12, isValid: true },
      { name: "orders_ref", definition: "USING btree (ref)", isUnique: true, isPrimary: false, bytes: 1, scans: 0, isValid: false },
      { name: "orders_cust", definition: "USING btree (customer_id)", isUnique: false, isPrimary: false, bytes: 1, scans: 3, isValid: true },
    ],
    constraints: [
      { name: "orders_customer_fk", kind: "foreign key", definition: "FOREIGN KEY (customer_id) REFERENCES customers(id)", isValid: true },
      { name: "orders_odd_fk", kind: "foreign key", definition: null, isValid: true },
      { name: "orders_total_check", kind: "check", definition: "CHECK (total > 0)", isValid: true },
    ],
  };
  const tabbed = { ...base, structure };
  const openStructure = () => userEvent.click(screen.getByRole("tab", { name: "Structure" }));

  it("opens on the details, with a tab for the structure", () => {
    render(<DetailsModal {...tabbed} />);
    expect(screen.getByRole("tab", { name: "Details" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Storage");
  });

  it("tabulates the columns with their key tags", async () => {
    render(<DetailsModal {...tabbed} />);
    await openStructure();
    expect(screen.getByRole("tab", { name: "Structure" })).toHaveAttribute("aria-selected", "true");
    const row = (name: string) => screen.getByRole("cell", { name }).closest("tr") as HTMLElement;
    expect(within(row("id")).getByText("primary key")).toBeInTheDocument();
    expect(within(row("customer_id")).getByText("foreign key")).toBeInTheDocument();
    expect(within(row("customer_id")).getByText("who ordered")).toBeInTheDocument();
    expect(within(row("total")).getByText("generated")).toBeInTheDocument();
    expect(within(row("id")).getByText("no")).toBeInTheDocument();
  });

  it("lists the indexes and the relations beside the columns", async () => {
    render(<DetailsModal {...tabbed} />);
    await openStructure();
    const side = screen.getByRole("complementary", { name: "Indexes and relations" });
    expect(within(side).getByText("primary · 12 scans")).toBeInTheDocument();
    expect(within(side).getByText("unique · 0 scans · invalid")).toBeInTheDocument();
    expect(within(side).getByText("3 scans")).toBeInTheDocument();
    expect(within(side).getByText("customers.id")).toBeInTheDocument();
    // A foreign key whose definition could not be read is still named.
    expect(within(side).getByText("orders_odd_fk")).toBeInTheDocument();
  });

  it("leaves out scan counts an engine does not keep (SQLite)", async () => {
    const sqlite: TableStructure = {
      ...structure,
      indexes: [{ ...structure.indexes[1], isValid: true, scans: null }],
    };
    render(<DetailsModal {...base} structure={sqlite} />);
    await openStructure();
    const side = screen.getByRole("complementary", { name: "Indexes and relations" });
    expect(within(side).getByText("unique")).toBeInTheDocument();
    expect(within(side).queryByText(/scans/)).not.toBeInTheDocument();
  });

  it("switches tabs with the arrow keys", async () => {
    render(<DetailsModal {...tabbed} />);
    screen.getByRole("tab", { name: "Details" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Structure" })).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{ArrowLeft}");
    expect(screen.getByRole("tab", { name: "Details" })).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{Home}");
    expect(screen.getByRole("tab", { name: "Details" })).toHaveAttribute("aria-selected", "true");
  });

  it("says loading while the structure is on its way", async () => {
    render(<DetailsModal {...base} structure={null} />);
    await openStructure();
    expect(screen.getByText("loading…")).toBeInTheDocument();
  });

  it("says so when nothing could be read", async () => {
    render(<DetailsModal {...base} structure={{ columns: [], indexes: [], constraints: [] }} />);
    await openStructure();
    expect(screen.getByText("No columns could be read.")).toBeInTheDocument();
    expect(screen.getByText("None.")).toBeInTheDocument();
    expect(screen.getByText("No foreign keys.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show in ER diagram" })).not.toBeInTheDocument();
  });

  it("queries the table and opens the diagram", async () => {
    const onQuery = vi.fn();
    const onDiagram = vi.fn();
    render(<DetailsModal {...tabbed} onQuery={onQuery} onDiagram={onDiagram} />);
    await userEvent.click(screen.getByRole("button", { name: "Query this table" }));
    expect(onQuery).toHaveBeenCalled();
    await openStructure();
    await userEvent.click(screen.getByRole("button", { name: "Show in ER diagram" }));
    expect(onDiagram).toHaveBeenCalled();
  });
});
