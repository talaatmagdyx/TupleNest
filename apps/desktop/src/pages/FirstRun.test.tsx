import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import FirstRun, { TOUR_STEPS, Tour, WhatsNew } from "./FirstRun";
import { ABOUT_LINKS } from "../overlays/Overlays";
import pkg from "../../package.json";

const invokeMock = vi.mocked(invoke);
let settings: Record<string, unknown>;
let profiles: unknown[];

beforeEach(() => {
  settings = {};
  profiles = [];
  invokeMock.mockReset();
  invokeMock.mockImplementation((async (cmd: string, a?: Record<string, unknown>) => {
    if (cmd === "settings_get") return settings[a!.key as string] ?? null;
    if (cmd === "connection_list") return profiles;
    if (cmd === "settings_set") {
      settings[a!.key as string] = a!.value;
      return undefined;
    }
    throw new Error(cmd);
  }) as never);
});

const V = pkg.version;

describe("FirstRun — what's new", () => {
  it("shows once after an update, then remembers the version", async () => {
    settings = { whats_new_seen: "0.0.1", tour_done: true };
    const user = userEvent.setup();
    const { unmount } = render(<FirstRun version={V} request={null} />);
    expect(await screen.findByRole("dialog", { name: "What's new" })).toBeInTheDocument();
    expect(screen.getByText(`Updated to ${V}`)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Got it" }));
    expect(settings.whats_new_seen).toBe(V);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    unmount();
    const before = invokeMock.mock.calls.length;
    render(<FirstRun version={V} request={null} />);
    await waitFor(() => expect(invokeMock.mock.calls.length).toBe(before + 3));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("waits for the version, and survives a store that will not answer", async () => {
    const { rerender } = render(<FirstRun version="" request={null} />);
    expect(invokeMock).not.toHaveBeenCalled();
    invokeMock.mockRejectedValue("store lock poisoned");
    rerender(<FirstRun version={V} request={null} />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens again on request, each time it is asked", async () => {
    settings = { whats_new_seen: V, tour_done: true };
    const user = userEvent.setup();
    const { rerender } = render(<FirstRun version={V} request={{ kind: "news", n: 1 }} />);
    await user.click(await screen.findByRole("button", { name: "Got it" }));
    rerender(<FirstRun version={V} request={{ kind: "news", n: 1 }} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    rerender(<FirstRun version={V} request={{ kind: "news", n: 2 }} />);
    expect(screen.getByRole("dialog", { name: "What's new" })).toBeInTheDocument();
  });

  it("links the full changelog, and copes with a version that has no notes", async () => {
    const user = userEvent.setup();
    render(<WhatsNew version="9.9.9" onClose={vi.fn()} />);
    expect(screen.getByText(/Fixes and small improvements/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Full changelog" }));
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith(ABOUT_LINKS.changelog));
  });
});

describe("FirstRun — the tour", () => {
  it("shows on the first launch, and never again after it is skipped", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<FirstRun version={V} request={null} />);
    expect(await screen.findByRole("dialog", { name: TOUR_STEPS[0].heading })).toBeInTheDocument();
    // A new user gets no what's new as well.
    expect(settings.whats_new_seen).toBe(V);
    await user.click(screen.getByRole("button", { name: "Skip the tour" }));
    expect(settings.tour_done).toBe(true);
    unmount();
    render(<FirstRun version={V} request={null} />);
    await waitFor(() => expect(invokeMock.mock.calls.filter((c) => c[0] === "connection_list")).toHaveLength(2));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("is not shown to someone upgrading with connections, and is marked done for them", async () => {
    profiles = [{ id: "p1" }];
    settings = { whats_new_seen: V };
    render(<FirstRun version={V} request={null} />);
    await waitFor(() => expect(settings.tour_done).toBe(true));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("can be opened again from Help, and finishing it counts as done", async () => {
    settings = { whats_new_seen: V, tour_done: true };
    const user = userEvent.setup();
    render(<FirstRun version={V} request={{ kind: "tour", n: 1 }} />);
    for (let i = 0; i < TOUR_STEPS.length - 1; i++) await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Finish" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(settings.tour_done).toBe(true);
  });
});

describe("Tour", () => {
  it("has three steps, moved through by the keyboard", async () => {
    const onDone = vi.fn();
    const user = userEvent.setup();
    render(<Tour onDone={onDone} />);
    expect(TOUR_STEPS.map((s) => s.title)).toEqual(["Connect", "Safe by default", "Assistant and MCP"]);
    // Next has focus, so the keyboard starts in the dialog.
    expect(screen.getByRole("button", { name: "Next" })).toHaveFocus();
    expect(screen.getByText("STEP 1 OF 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByText("STEP 1 OF 3")).toBeInTheDocument();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByText("STEP 2 OF 3")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveAccessibleName("TupleNest asks before it can hurt");
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(screen.getByText("STEP 3 OF 3")).toBeInTheDocument();
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByText("STEP 2 OF 3")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("STEP 1 OF 3")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
