import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import type { JSX } from "react";
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

  // The brand mark sizes its tile, not the glyph inside it — tested below.
  it.each(all.filter(([n]) => n !== "BrandMark"))("%s honours an explicit size", (_name, Icon) => {
    const { container } = render(<Icon size={41} />);
    expect(container.querySelector("svg")).toHaveAttribute("width", "41");
    expect(container.querySelector("svg")).toHaveAttribute("height", "41");
  });

  it("BrandMark defaults to an 18px tile when no size is given", () => {
    const { container } = render(<icons.BrandMark />);
    const tile = container.querySelector(".brand-mark") as HTMLElement;
    expect(tile.style.width).toBe("18px");
    expect(tile).toHaveAttribute("aria-hidden");
  });

  it("BrandMark draws three lines in the on-accent colour, with no hard-coded fill", () => {
    const { container } = render(<icons.BrandMark size={24} />);
    const svg = container.querySelector("svg")!;
    expect(svg).toHaveAttribute("stroke", "currentColor");
    expect(container.querySelector("path")!.getAttribute("d")).toBe("M4 7h16M4 12h10M4 17h6");
    expect(container.querySelector("linearGradient")).toBeNull();
  });
});
