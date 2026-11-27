import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PageHeader, { onPageKeyDown } from "./PageHeader";

describe("PageHeader", () => {
  it("draws back, title, description and actions, in that order", () => {
    render(
      <PageHeader
        title="History"
        sub="Every statement you ran."
        meta={<select aria-label="Pick" />}
        actions={<button>Clear</button>}
        onBack={vi.fn()}
      />,
    );
    expect(screen.getByRole("heading", { level: 1, name: "History" })).toBeInTheDocument();
    expect(screen.getByText("Every statement you ran.")).toHaveClass("page-sub");
    const order = [...document.querySelectorAll(".page-head > *")].map(
      (n) => n.getAttribute("aria-label") ?? n.textContent,
    );
    expect(order).toEqual(["Back to the editor", "History", "Pick", "Every statement you ran.", "", "Clear"]);
  });

  it("leaves the description out when there is none", () => {
    render(<PageHeader title="Backup" onBack={vi.fn()} />);
    expect(document.querySelector(".page-sub")).toBeNull();
  });

  it("goes back from the button", async () => {
    const onBack = vi.fn();
    render(<PageHeader title="Roles" onBack={onBack} />);
    await userEvent.click(screen.getByRole("button", { name: "Back to the editor" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("goes back on Escape only, and keeps Escape from the window", () => {
    const onBack = vi.fn();
    const onWindow = vi.fn();
    render(
      <div onKeyDown={onWindow}>
        <div onKeyDown={onPageKeyDown(onBack)}>
          <input aria-label="field" />
        </div>
      </div>,
    );
    fireEvent.keyDown(screen.getByLabelText("field"), { key: "a" });
    fireEvent.keyDown(screen.getByLabelText("field"), { key: "Escape" });
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onWindow).toHaveBeenCalledTimes(1);
  });
});
