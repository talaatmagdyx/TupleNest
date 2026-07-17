import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import StatusBar from "./StatusBar";

const base = {
  connected: true,
  isProd: false,
  connName: "engagement_database",
  tlsMode: "verify-full",
  explorerSource: "live" as const,
  rowsInfo: "200 rows · 12 ms",
  txOpenSince: null,
  // No transaction open in the base case, so the clock is never consulted.
  now: 0,
  serverVersion: "18.0",
  osLabel: "macos",
};

describe("StatusBar", () => {
  it("names the connection when connected", () => {
    render(<StatusBar {...base} />);
    expect(screen.getByText("engagement_database")).toBeInTheDocument();
  });

  it("says disconnected rather than showing a stale name", () => {
    render(<StatusBar {...base} connected={false} />);
    expect(screen.getByText("disconnected")).toBeInTheDocument();
    expect(screen.queryByText("engagement_database")).not.toBeInTheDocument();
  });

  it("greys the dot when disconnected", () => {
    const { container } = render(<StatusBar {...base} connected={false} />);
    expect(container.querySelector(".dot")).toHaveStyle({ background: "#4a4f57" });
  });

  it("greens the dot for a non-prod connection", () => {
    const { container } = render(<StatusBar {...base} />);
    expect(container.querySelector(".dot")).toHaveStyle({ background: "#3fb950" });
  });

  it("reddens the dot on prod — the one place colour carries a warning", () => {
    const { container } = render(<StatusBar {...base} isProd />);
    expect(container.querySelector(".dot")).toHaveStyle({ background: "#ef4d4d" });
  });

  it("shows the TLS mode with a lock", () => {
    render(<StatusBar {...base} />);
    expect(screen.getByText("🔒 verify-full")).toBeInTheDocument();
  });

  it("says plaintext rather than showing a lock for an unencrypted link", () => {
    render(<StatusBar {...base} tlsMode="disabled" />);
    expect(screen.getByText("plaintext")).toBeInTheDocument();
    expect(screen.queryByText(/🔒/)).not.toBeInTheDocument();
  });

  it("reports where the explorer's data came from", () => {
    render(<StatusBar {...base} explorerSource="cached" />);
    expect(screen.getByText("explorer: cached")).toBeInTheDocument();
  });

  it("shows row info when there is any", () => {
    render(<StatusBar {...base} />);
    expect(screen.getByText("200 rows · 12 ms")).toBeInTheDocument();
  });

  it("omits the row segment entirely when empty", () => {
    const { container } = render(<StatusBar {...base} rowsInfo="" />);
    expect(container.querySelectorAll(".bar-sep")).toHaveLength(2);
  });

  it("shows the server version and OS", () => {
    render(<StatusBar {...base} />);
    expect(screen.getByText(/PostgreSQL 18\.0 · macos/)).toBeInTheDocument();
  });

  it("omits the OS suffix when unknown", () => {
    render(<StatusBar {...base} osLabel="" />);
    expect(screen.getByText("PostgreSQL 18.0")).toBeInTheDocument();
  });

  it("omits the version entirely when unknown", () => {
    render(<StatusBar {...base} serverVersion={null} />);
    expect(screen.queryByText(/PostgreSQL/)).not.toBeInTheDocument();
  });
});

describe("StatusBar — open transaction warning", () => {
  beforeEach(() => vi.useFakeTimers().setSystemTime(new Date("2026-07-16T00:00:00Z")));
  afterEach(() => vi.useRealTimers());

  const at = (secondsAgo: number) => Date.now() - secondsAgo * 1000;

  it("stays quiet with no open transaction", () => {
    render(<StatusBar {...base} />);
    expect(screen.queryByText(/tx open/)).not.toBeInTheDocument();
  });

  it("counts seconds under a minute", () => {
    render(<StatusBar {...base} txOpenSince={at(42)} now={Date.now()} />);
    expect(screen.getByText("⚠ tx open 42s")).toBeInTheDocument();
  });

  it("switches to minutes and pads the seconds", () => {
    // "1m 5s" not "1m 5s" — zero-padding keeps the bar from jittering as the
    // number of glyphs changes.
    render(<StatusBar {...base} txOpenSince={at(65)} now={Date.now()} />);
    expect(screen.getByText("⚠ tx open 1m 05s")).toBeInTheDocument();
  });

  it("shows a long-running transaction in minutes", () => {
    render(<StatusBar {...base} txOpenSince={at(3600)} now={Date.now()} />);
    expect(screen.getByText("⚠ tx open 60m 00s")).toBeInTheDocument();
  });

  it("handles the exact minute boundary", () => {
    render(<StatusBar {...base} txOpenSince={at(60)} now={Date.now()} />);
    expect(screen.getByText("⚠ tx open 1m 00s")).toBeInTheDocument();
  });
});
