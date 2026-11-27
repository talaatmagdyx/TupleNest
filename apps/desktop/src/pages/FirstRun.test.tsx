import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import FirstRun, { WhatsNew } from "./FirstRun";
import { ABOUT_LINKS } from "../overlays/Overlays";
import pkg from "../../package.json";

const invokeMock = vi.mocked(invoke);
let settings: Record<string, unknown>;

beforeEach(() => {
  settings = {};
  invokeMock.mockReset();
  invokeMock.mockImplementation((async (cmd: string, a?: Record<string, unknown>) => {
    if (cmd === "settings_get") return settings[a!.key as string] ?? null;
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
    settings.whats_new_seen = "0.0.1";
    const user = userEvent.setup();
    const { unmount } = render(<FirstRun version={V} request={null} />);
    expect(await screen.findByRole("dialog", { name: "What's new" })).toBeInTheDocument();
    expect(screen.getByText(`Updated to ${V}`)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Got it" }));
    expect(settings.whats_new_seen).toBe(V);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    unmount();
    render(<FirstRun version={V} request={null} />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(3));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("says nothing on a first launch, and counts the version as seen", async () => {
    render(<FirstRun version={V} request={null} />);
    await waitFor(() => expect(settings.whats_new_seen).toBe(V));
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
    settings.whats_new_seen = V;
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
