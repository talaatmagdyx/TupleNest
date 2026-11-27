import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import ChartView from "./ChartView";

const cols = [
  { name: "day", dbType: "text" },
  { name: "orders", dbType: "int4" },
];
const rows = [
  ["mon", 3],
  ["tue", 7],
];

describe("ChartView", () => {
  it("draws bars with their values", () => {
    render(<ChartView kind="bar" columns={cols} rows={rows} />);
    expect(screen.getByText("sum(orders) by day")).toBeInTheDocument();
    expect(screen.getByText("tue")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
  });

  it("names a line chart for a screen reader", () => {
    render(<ChartView kind="line" columns={cols} rows={rows} />);
    expect(screen.getByRole("img")).toHaveAccessibleName(
      "Line chart of orders by day, 2 points, from 3 at mon to 7 at tue",
    );
  });

  it("shows a single number", () => {
    render(<ChartView kind="number" columns={cols} rows={rows} />);
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("orders")).toBeInTheDocument();
  });

  it("says what it needs when it cannot draw", () => {
    const { rerender } = render(<ChartView kind="bar" columns={[cols[0]]} rows={[["x"]]} />);
    expect(screen.getByText(/one text column and one numeric column/)).toBeInTheDocument();
    rerender(<ChartView kind="number" columns={cols} rows={[]} />);
    expect(screen.getByText(/numeric value in the first row/)).toBeInTheDocument();
    rerender(<ChartView kind="bar" columns={cols} rows={[["x", null]]} />);
    expect(screen.getByText("No rows to chart.")).toBeInTheDocument();
  });
});
