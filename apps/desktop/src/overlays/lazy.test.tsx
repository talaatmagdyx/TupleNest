import { render, screen } from "@testing-library/react";
import type { ComponentType } from "react";
import { describe, expect, it } from "vitest";
import { lazyModal } from "./lazy";

describe("lazyModal", () => {
  it("renders through Suspense until its chunk has loaded, then directly", async () => {
    let resolve!: (m: { default: ComponentType<{ label: string }> }) => void;
    const Modal = lazyModal<{ label: string }>(
      () => new Promise((r) => (resolve = r)),
    );

    const first = render(<Modal label="one" />);
    // Nothing yet: the chunk is still loading and the fallback is empty.
    expect(first.container).toBeEmptyDOMElement();
    resolve({ default: (p) => <div>{p.label}</div> });
    expect(await screen.findByText("one")).toBeInTheDocument();
    first.unmount();

    // A later mount, after the chunk has loaded, renders on the first pass.
    render(<Modal label="two" />);
    expect(screen.getByText("two")).toBeInTheDocument();
  });
});
