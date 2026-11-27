import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Welcome from "./Welcome";
import type { ConnectionRecord } from "../ipc/types";

const profile = (i: number, env: string | null = "dev"): ConnectionRecord =>
  ({
    id: `c${i}`,
    name: `db-${i}`,
    environment: env,
    host: `h${i}.internal`,
    port: 5432,
    database: "app",
  }) as unknown as ConnectionRecord;

describe("Welcome", () => {
  const base = { saved: [] as ConnectionRecord[], onNew: vi.fn(), onOpen: vi.fn() };

  it("is a named region with a heading", () => {
    render(<Welcome {...base} />);
    expect(screen.getByRole("region", { name: "Connect to a database" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Connect to a database" })).toBeInTheDocument();
  });

  it("starts a new connection", async () => {
    const onNew = vi.fn();
    render(<Welcome {...base} onNew={onNew} />);
    await userEvent.click(screen.getByRole("button", { name: /New connection/ }));
    expect(onNew).toHaveBeenCalled();
  });

  it("offers no action the app does not have", () => {
    render(<Welcome {...base} />);
    expect(screen.queryByText(/Paste a connection URL|Open a \.sql file/)).not.toBeInTheDocument();
  });

  it("lists nothing when there is nothing saved", () => {
    render(<Welcome {...base} />);
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("lists the saved profiles, up to five, with where they point", async () => {
    const onOpen = vi.fn();
    const saved = [1, 2, 3, 4, 5, 6].map((i) => profile(i));
    saved[0] = profile(1, "prod");
    render(<Welcome {...base} saved={saved} onOpen={onOpen} />);
    const list = screen.getByRole("list", { name: "Saved connections" });
    const rows = within(list).getAllByRole("button");
    expect(rows).toHaveLength(5);
    expect(rows[0]).toHaveTextContent("db-1");
    expect(rows[0]).toHaveTextContent("h1.internal:5432/app");
    expect(rows[0]).toHaveTextContent("prod");
    await userEvent.click(rows[1]);
    expect(onOpen).toHaveBeenCalledWith(saved[1]);
  });

  it("calls a profile with no environment dev", () => {
    render(<Welcome {...base} saved={[profile(1, null)]} />);
    expect(screen.getByText("dev")).toBeInTheDocument();
  });
});
