import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SavedList from "./SavedList";
import type { ConnectionRecord } from "../ipc/types";

const conn = (over: Partial<ConnectionRecord> = {}): ConnectionRecord =>
  ({
    id: "c1",
    name: "engagement_database",
    host: "localhost",
    port: 5432,
    database: "omniserve",
    username: "omniserve",
    environment: "dev",
    secretRef: null,
    tlsMode: "prefer",
    tlsCaPath: null,
    sshJson: null,
    ...over,
  }) as ConnectionRecord;

const base = {
  saved: [conn()],
  activeId: null,
  connected: false,
  onLoad: vi.fn(),
  onNew: vi.fn(),
  onDelete: vi.fn(),
};

describe("SavedList", () => {
  it("invites you to create one when there are none", () => {
    render(<SavedList {...base} saved={[]} />);
    expect(screen.getByText("No connections yet.")).toBeInTheDocument();
  });

  it("creates from the empty state", async () => {
    const onNew = vi.fn();
    render(<SavedList {...base} saved={[]} onNew={onNew} />);
    await userEvent.click(screen.getByRole("button", { name: /New connection/ }));
    expect(onNew).toHaveBeenCalled();
  });

  it("creates from the header plus", async () => {
    const onNew = vi.fn();
    render(<SavedList {...base} onNew={onNew} />);
    await userEvent.click(screen.getByTitle("New connection"));
    expect(onNew).toHaveBeenCalled();
  });

  it("shows the name and the full target", () => {
    render(<SavedList {...base} />);
    expect(screen.getByText("engagement_database")).toBeInTheDocument();
    expect(screen.getByText("omniserve@localhost:5432/omniserve")).toBeInTheDocument();
  });

  it("shows the environment pill", () => {
    render(<SavedList {...base} />);
    expect(screen.getByText("dev")).toBeInTheDocument();
  });

  it("defaults an unset environment to dev rather than showing nothing", () => {
    render(<SavedList {...base} saved={[conn({ environment: null })]} />);
    expect(screen.getByText("dev")).toBeInTheDocument();
  });

  it("colours a prod pill differently — the point of the pill", () => {
    const { container } = render(<SavedList {...base} saved={[conn({ environment: "prod" })]} />);
    // jsdom serialises the hex to rgb().
    expect(container.querySelector(".env-pill")).toHaveStyle({ color: "rgb(239, 77, 77)" });
  });

  it("marks the active card", () => {
    const { container } = render(<SavedList {...base} activeId="c1" />);
    expect(container.querySelector(".conn-card")).toHaveClass("active");
  });

  it("shows a live dot only when the active profile is actually connected", () => {
    const { container: off } = render(<SavedList {...base} activeId="c1" connected={false} />);
    expect(off.querySelector(".nm .dot")).toBeNull();
    const { container: on } = render(<SavedList {...base} activeId="c1" connected />);
    expect(on.querySelector(".nm .dot")).not.toBeNull();
  });

  it("loads a profile when its card is clicked", async () => {
    const onLoad = vi.fn();
    render(<SavedList {...base} onLoad={onLoad} />);
    await userEvent.click(screen.getByText("engagement_database"));
    expect(onLoad).toHaveBeenCalledWith(base.saved[0]);
  });

  it("deletes without also loading the profile it just deleted", async () => {
    const onDelete = vi.fn();
    const onLoad = vi.fn();
    render(<SavedList {...base} onDelete={onDelete} onLoad={onLoad} />);
    await userEvent.click(screen.getByTitle("Delete"));
    expect(onDelete).toHaveBeenCalledWith(base.saved[0]);
    expect(onLoad).not.toHaveBeenCalled();
  });

  it("does not nest an interactive control inside another", () => {
    // A <button> inside a <button> is invalid HTML: the parser may hoist the
    // inner one out, and assistive tech has no sensible way to present it.
    const { container } = render(<SavedList {...base} />);
    for (const b of Array.from(container.querySelectorAll("button"))) {
      expect(b.querySelector("button")).toBeNull();
    }
  });

  it("lists every saved profile", () => {
    render(<SavedList {...base} saved={[conn(), { ...conn(), id: "c2", name: "second" }]} />);
    expect(screen.getByText("engagement_database")).toBeInTheDocument();
    expect(screen.getByText("second")).toBeInTheDocument();
  });
});
