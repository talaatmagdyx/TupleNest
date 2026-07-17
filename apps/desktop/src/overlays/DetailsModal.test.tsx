import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import DetailsModal, { type ObjectDetails } from "./DetailsModal";

const details: ObjectDetails = {
  title: "eng_interactions",
  kind: "table",
  sections: [
    {
      label: "Storage",
      rows: [
        { k: "Total size", v: "3522 MB — all 300 partitions" },
        { k: "Rows (estimate)", v: "3000242" },
      ],
    },
    { label: "About", rows: [{ k: "Owner", v: "omniserve" }] },
  ],
};

const base = { schema: "company_1_schema", details, error: null, onClose: vi.fn() };

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
    expect(screen.getByText(/company_1_schema\.eng_interactions/)).toBeInTheDocument();
  });

  it("falls back to a neutral title before the payload arrives", () => {
    render(<DetailsModal {...base} details={null} />);
    expect(screen.getByText("OBJECT")).toBeInTheDocument();
  });

  it("renders every section and row", () => {
    render(<DetailsModal {...base} />);
    expect(screen.getByText("Storage")).toBeInTheDocument();
    expect(screen.getByText("Owner")).toBeInTheDocument();
    expect(screen.getByText("omniserve")).toBeInTheDocument();
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
    expect(screen.getByText("omniserve")).not.toHaveStyle({ color: "var(--tn-danger)" });
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
});
