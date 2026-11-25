import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { Crashed, ErrorBoundary } from "./ErrorBoundary";

// Audit TN-025: with no boundary, one component that throws empties the window.
let logged: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  logged = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => logged.mockRestore());

function Bomb({ armed }: { armed: boolean }) {
  if (armed) throw new Error("kaboom");
  return <div>fine</div>;
}

describe("ErrorBoundary", () => {
  it("shows its children when nothing is wrong", () => {
    render(
      <ErrorBoundary fallback={() => <div>fallback</div>}>
        <Bomb armed={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText("fine")).toBeInTheDocument();
  });

  it("contains a render error: what is outside it stays, and the fallback gets the error", () => {
    render(
      <div>
        <span>outside</span>
        <ErrorBoundary fallback={(e) => <div>caught: {e.message}</div>}>
          <Bomb armed />
        </ErrorBoundary>
      </div>,
    );
    expect(screen.getByText("outside")).toBeInTheDocument();
    expect(screen.getByText("caught: kaboom")).toBeInTheDocument();
    expect(logged).toHaveBeenCalled();
  });

  it("wraps a thrown non-Error so the fallback always has a message", () => {
    function Throws(): never {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw "just a string";
    }
    render(
      <ErrorBoundary fallback={(e) => <div>caught: {e.message}</div>}>
        <Throws />
      </ErrorBoundary>,
    );
    expect(screen.getByText("caught: just a string")).toBeInTheDocument();
  });

  it("can be reset once the cause is gone", async () => {
    function Host() {
      const [armed, setArmed] = useState(true);
      return (
        <ErrorBoundary
          fallback={(_, reset) => (
            <button
              onClick={() => {
                setArmed(false);
                reset();
              }}
            >
              try again
            </button>
          )}
        >
          <Bomb armed={armed} />
        </ErrorBoundary>
      );
    }
    render(<Host />);
    await userEvent.click(screen.getByRole("button", { name: "try again" }));
    expect(screen.getByText("fine")).toBeInTheDocument();
  });
});

describe("Crashed — the whole-app fallback", () => {
  it("says what happened, shows the error, and offers a reload", async () => {
    const onReload = vi.fn();
    render(<Crashed error={new Error("cannot read x of undefined")} onReload={onReload} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/could not recover/);
    expect(screen.getByText("cannot read x of undefined")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Reload the window" }));
    expect(onReload).toHaveBeenCalled();
  });
});
