import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Titlebar from "./Titlebar";
import type { ConnectionRecord } from "../ipc/types";
// Tracks the keyboard; Overlays.test.tsx pins the labels per platform.
import { kbd } from "../lib/platform";

const conn = (over: Partial<ConnectionRecord> = {}): ConnectionRecord =>
  ({
    id: "c1",
    name: "customer_analytics",
    host: "localhost",
    port: 5432,
    database: "appdb",
    username: "appuser",
    environment: "dev",
    ...over,
  }) as ConnectionRecord;

const base = {
  theme: "dark" as const,
  connected: true,
  activeName: "customer_analytics",
  activeUserHost: "appuser@localhost:5432",
  activeEnv: "dev",
  saved: [conn()],
  activeId: "c1",
  connMenu: false,
  onToggleConnMenu: vi.fn(),
  onSelectProfile: vi.fn(),
  onNewConnection: vi.fn(),
  onToggleSidebar: vi.fn(),
  onOpenPalette: vi.fn(),
  onToggleTheme: vi.fn(),
  onOpenSettings: vi.fn(),
};

describe("Titlebar", () => {
  it("shows the brand", () => {
    render(<Titlebar {...base} />);
    expect(screen.getByText("TupleNest")).toBeInTheDocument();
  });

  it("names the live connection and its target", () => {
    render(<Titlebar {...base} />);
    expect(screen.getByText("customer_analytics")).toBeInTheDocument();
    expect(screen.getByText("appuser@localhost:5432")).toBeInTheDocument();
  });

  it("says Not connected rather than showing a stale name", () => {
    render(<Titlebar {...base} connected={false} />);
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.queryByText("appuser@localhost:5432")).not.toBeInTheDocument();
  });

  it("hides the env pill when there is no session to describe", () => {
    const { container } = render(<Titlebar {...base} connected={false} />);
    expect(container.querySelector(".conn-switch .env-pill")).toBeNull();
  });

  it("greys the dot when disconnected", () => {
    const { container } = render(<Titlebar {...base} connected={false} />);
    expect(container.querySelector(".conn-switch .dot")).toHaveStyle({ background: "#4a4f57" });
  });

  it("reddens the dot on prod — the warning that has to be visible at a glance", () => {
    const { container } = render(<Titlebar {...base} activeEnv="prod" />);
    expect(container.querySelector(".conn-switch .dot")).toHaveStyle({ background: "#ef4d4d" });
  });

  it("greens the dot off prod", () => {
    const { container } = render(<Titlebar {...base} />);
    expect(container.querySelector(".conn-switch .dot")).toHaveStyle({ background: "#3fb950" });
  });

  it("keeps the connection menu shut until asked", () => {
    render(<Titlebar {...base} />);
    expect(screen.queryByText("Switch connection")).not.toBeInTheDocument();
  });

  it("opens the menu", async () => {
    const onToggleConnMenu = vi.fn();
    render(<Titlebar {...base} onToggleConnMenu={onToggleConnMenu} />);
    await userEvent.click(screen.getByText("customer_analytics"));
    expect(onToggleConnMenu).toHaveBeenCalled();
  });

  it("lists profiles in the open menu", () => {
    render(<Titlebar {...base} connMenu />);
    expect(screen.getByText("Switch connection")).toBeInTheDocument();
    expect(screen.getByText("appuser@localhost:5432/appdb")).toBeInTheDocument();
  });

  it("marks the active profile in the menu", () => {
    const { container } = render(<Titlebar {...base} connMenu />);
    expect(container.querySelector(".conn-menu .row")).toHaveClass("active");
  });

  it("does not mark a profile active when its session is closed", () => {
    const { container } = render(<Titlebar {...base} connMenu connected={false} />);
    expect(container.querySelector(".conn-menu .row .dot")).toHaveStyle({ background: "#4a4f57" });
  });

  it("defaults a profile with no environment to dev", () => {
    render(<Titlebar {...base} connMenu saved={[conn({ environment: null })]} />);
    expect(screen.getAllByText("dev").length).toBeGreaterThan(0);
  });

  it("switches profile from the menu", async () => {
    const onSelectProfile = vi.fn();
    render(<Titlebar {...base} connMenu onSelectProfile={onSelectProfile} />);
    await userEvent.click(screen.getByText("appuser@localhost:5432/appdb"));
    expect(onSelectProfile).toHaveBeenCalledWith(base.saved[0]);
  });

  it("creates a connection from the menu", async () => {
    const onNewConnection = vi.fn();
    render(<Titlebar {...base} connMenu onNewConnection={onNewConnection} />);
    await userEvent.click(screen.getByRole("button", { name: /New connection…/ }));
    expect(onNewConnection).toHaveBeenCalled();
  });

  it("shows the palette shortcut", () => {
    render(<Titlebar {...base} />);
    expect(screen.getByText(kbd("mod", "K"))).toBeInTheDocument();
  });

  it("opens the palette, settings and the sidebar toggle", async () => {
    const onOpenPalette = vi.fn();
    const onOpenSettings = vi.fn();
    const onToggleSidebar = vi.fn();
    render(
      <Titlebar
        {...base}
        onOpenPalette={onOpenPalette}
        onOpenSettings={onOpenSettings}
        onToggleSidebar={onToggleSidebar}
      />,
    );
    await userEvent.click(screen.getByText("Search & commands"));
    await userEvent.click(screen.getByTitle("Settings"));
    await userEvent.click(screen.getByTitle("Toggle sidebar"));
    expect(onOpenPalette).toHaveBeenCalled();
    expect(onOpenSettings).toHaveBeenCalled();
    expect(onToggleSidebar).toHaveBeenCalled();
  });

  it("offers the moon in dark and the sun in light", async () => {
    const onToggleTheme = vi.fn();
    const { rerender } = render(<Titlebar {...base} onToggleTheme={onToggleTheme} />);
    expect(screen.getByTitle("Toggle theme")).toHaveTextContent("☾");
    rerender(<Titlebar {...base} theme="light" onToggleTheme={onToggleTheme} />);
    expect(screen.getByTitle("Toggle theme")).toHaveTextContent("☀");
    await userEvent.click(screen.getByTitle("Toggle theme"));
    expect(onToggleTheme).toHaveBeenCalled();
  });
});
