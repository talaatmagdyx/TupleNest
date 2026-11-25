import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType } from "react";
import { describe, expect, it, vi } from "vitest";
import { lazyModal } from "./lazy";

describe("lazyModal", () => {
  it("renders nothing until its chunk has loaded, then directly", async () => {
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

  // Audit TN-025. `React.lazy` threw a failed load into a tree with no
  // boundary, which unmounted the app: an empty window.
  it("shows a dialog when its chunk cannot be loaded, and leaves the rest of the page alone", async () => {
    const onClose = vi.fn();
    const Modal = lazyModal<{ onClose: () => void }>(() => Promise.reject(new Error("Failed to fetch chunk")));
    render(
      <div>
        <span>the app</span>
        <Modal onClose={onClose} />
      </div>,
    );
    expect(await screen.findByText("This panel could not be opened")).toBeInTheDocument();
    expect(screen.getByText("Its code could not be loaded (Failed to fetch chunk).")).toBeInTheDocument();
    expect(screen.getByText("the app")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("tries the load again the next time it is opened", async () => {
    let calls = 0;
    const Modal = lazyModal<{ onClose: () => void }>(() => {
      calls++;
      return calls === 1
        ? Promise.reject(new Error("first try failed"))
        : Promise.resolve({ default: () => <div>opened</div> });
    });
    const first = render(<Modal onClose={() => {}} />);
    expect(await screen.findByText("Its code could not be loaded (first try failed).")).toBeInTheDocument();
    first.unmount();
    render(<Modal onClose={() => {}} />);
    expect(await screen.findByText("opened")).toBeInTheDocument();
  });

  it("reports a rejection that is not an Error", async () => {
    const Modal = lazyModal<{ onClose: () => void }>(() => Promise.reject("offline"));
    render(<Modal onClose={() => {}} />);
    expect(await screen.findByText("Its code could not be loaded (offline).")).toBeInTheDocument();
  });

  it("catches a modal that throws while rendering", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const Broken = (): never => {
      throw new Error("bad render");
    };
    const Modal = lazyModal<{ onClose?: () => void }>(() => Promise.resolve({ default: Broken }));
    render(
      <div>
        <span>the app</span>
        <Modal />
      </div>,
    );
    expect(await screen.findByText("bad render")).toBeInTheDocument();
    expect(screen.getByText("the app")).toBeInTheDocument();
    // No `onClose` was given: the close button is still there and harmless.
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    logged.mockRestore();
  });

  it("does not set state after it has gone", async () => {
    let resolve!: (m: { default: ComponentType<object> }) => void;
    const Modal = lazyModal<object>(() => new Promise((r) => (resolve = r)));
    const { unmount } = render(<Modal />);
    unmount();
    resolve({ default: () => <div>late</div> });
    await Promise.resolve();
    expect(screen.queryByText("late")).not.toBeInTheDocument();
  });
});
