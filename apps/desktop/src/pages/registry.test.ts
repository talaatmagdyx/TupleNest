import { describe, expect, it, vi } from "vitest";
import { isRegistryPage, pageCommands } from "./registry";
import { unsupported } from "../lib/engine";

describe("page registry", () => {
  it("knows its own pages from the rail's", () => {
    expect(isRegistryPage("dashboards")).toBe(true);
    expect(isRegistryPage("roles")).toBe(true);
    expect(isRegistryPage("history")).toBe(false);
    expect(isRegistryPage("explorer")).toBe(false);
  });

  it("hides backup and roles on an engine that lacks them, and keeps dashboards and notebooks", () => {
    const open = vi.fn();
    const labels = (lacks: Parameters<typeof pageCommands>[1]) => pageCommands(open, lacks).map((i) => i.label);
    expect(labels(() => false)).toEqual([
      "Open dashboards",
      "Open notebooks",
      "Backup and restore (pg_dump)…",
      "Users and roles…",
    ]);
    expect(labels((f) => unsupported("sqlite", f) !== null)).toEqual(["Open dashboards", "Open notebooks"]);
    void pageCommands(open, () => false)[3].exec();
    expect(open).toHaveBeenCalledWith("roles");
  });
});
