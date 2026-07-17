import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import * as icons from "./icons";

/** Every export is a presentational SVG. There is no logic to assert beyond
 *  "renders, sizes, and stays out of the accessibility tree" — so the suite
 *  asserts exactly that, across all of them, rather than pretending each
 *  needs its own bespoke test. */
const all = Object.entries(icons) as [string, (p: { size?: number }) => JSX.Element][];

describe("icons", () => {
  it("exports the icons the UI imports", () => {
    expect(all.length).toBeGreaterThan(0);
  });

  it.each(all)("%s renders an svg", (_name, Icon) => {
    const { container } = render(<Icon />);
    expect(container.querySelector("svg")).toBeInTheDocument();
  });

  it.each(all)("%s is hidden from screen readers", (_name, Icon) => {
    // Decorative: the adjacent label carries the meaning. An icon announced
    // as "image" next to its own text label is noise.
    const { container } = render(<Icon />);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden");
  });

  it.each(all)("%s honours an explicit size", (_name, Icon) => {
    const { container } = render(<Icon size={41} />);
    expect(container.querySelector("svg")).toHaveAttribute("width", "41");
    expect(container.querySelector("svg")).toHaveAttribute("height", "41");
  });

  it("BrandMark defaults to 18px when no size is given", () => {
    const { container } = render(<icons.BrandMark />);
    expect(container.querySelector("svg")).toHaveAttribute("width", "18");
  });

  it("BrandMark paints its layers from the amber→coral gradient", () => {
    const { container } = render(<icons.BrandMark />);
    expect(container.querySelector("linearGradient")).toBeInTheDocument();
    expect(container.querySelectorAll("rect[fill^='url(']").length).toBeGreaterThan(0);
  });
});
