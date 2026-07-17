import { beforeEach, describe, expect, it, vi } from "vitest";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { baseName, FILTERS, saveText } from "./save";

const saveMock = vi.mocked(save);
const writeMock = vi.mocked(writeTextFile);

beforeEach(() => {
  saveMock.mockReset();
  writeMock.mockReset();
});

describe("baseName", () => {
  it("takes the last segment of a posix path", () => {
    expect(baseName("/Users/t/Documents/plan.json")).toBe("plan.json");
  });

  it("takes the last segment of a windows path", () => {
    expect(baseName("C:\\Users\\t\\plan.json")).toBe("plan.json");
  });

  it("returns a bare filename unchanged", () => {
    expect(baseName("plan.json")).toBe("plan.json");
  });

  it("ignores a trailing separator rather than returning an empty name", () => {
    expect(baseName("/a/b/")).toBe("b");
  });

  it("falls back to the input when there is no segment at all", () => {
    expect(baseName("")).toBe("");
    expect(baseName("/")).toBe("/");
  });
});

describe("FILTERS", () => {
  it("maps each key to its own extension", () => {
    expect(FILTERS.json).toEqual({ name: "JSON", extensions: ["json"] });
    expect(FILTERS.csv).toEqual({ name: "CSV", extensions: ["csv"] });
    expect(FILTERS.md).toEqual({ name: "Markdown", extensions: ["md"] });
    expect(FILTERS.txt).toEqual({ name: "Text", extensions: ["txt"] });
  });
});

describe("saveText", () => {
  it("writes to the path the user picked and returns it", async () => {
    saveMock.mockResolvedValue("/tmp/out.json");
    const out = await saveText("out.json", "{}", FILTERS.json);
    expect(out).toBe("/tmp/out.json");
    expect(writeMock).toHaveBeenCalledWith("/tmp/out.json", "{}");
  });

  it("passes the filter through to the native panel", async () => {
    saveMock.mockResolvedValue("/tmp/a.csv");
    await saveText("a.csv", "x", FILTERS.csv);
    expect(saveMock).toHaveBeenCalledWith({
      defaultPath: "a.csv",
      filters: [FILTERS.csv],
    });
  });

  it("omits filters entirely when none is given", async () => {
    saveMock.mockResolvedValue("/tmp/a");
    await saveText("a", "x");
    expect(saveMock).toHaveBeenCalledWith({ defaultPath: "a", filters: undefined });
  });

  // Cancelling is the normal way to decline a save. Treating it as an error
  // would put a red toast in front of someone who simply changed their mind.
  it("returns null and writes nothing when the user cancels", async () => {
    saveMock.mockResolvedValue(null);
    expect(await saveText("out.json", "{}")).toBeNull();
    expect(writeMock).not.toHaveBeenCalled();
  });

  it("does not swallow a real write failure", async () => {
    saveMock.mockResolvedValue("/root/denied.json");
    writeMock.mockRejectedValue(new Error("permission denied"));
    await expect(saveText("denied.json", "{}")).rejects.toThrow("permission denied");
  });
});
