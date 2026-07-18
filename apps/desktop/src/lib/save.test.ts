import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { baseName, FILTERS, saveText } from "./save";

// The dialog + write both happen in the Rust `export_save` command now; the
// frontend only invokes it. So the unit test asserts the invoke shape (TAURI-01).
const invokeMock = vi.mocked(invoke);

beforeEach(() => {
  invokeMock.mockReset();
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
  it("returns the path the backend wrote", async () => {
    invokeMock.mockResolvedValue("/tmp/out.json");
    const out = await saveText("out.json", "{}", FILTERS.json);
    expect(out).toBe("/tmp/out.json");
  });

  it("hands the backend the contents, name and filter — never a path", async () => {
    invokeMock.mockResolvedValue("/tmp/a.csv");
    await saveText("a.csv", "x", FILTERS.csv);
    expect(invokeMock).toHaveBeenCalledWith("export_save", {
      defaultName: "a.csv",
      contents: "x",
      filterName: "CSV",
      extensions: ["csv"],
    });
  });

  it("sends null filter fields when none is given", async () => {
    invokeMock.mockResolvedValue("/tmp/a");
    await saveText("a", "x");
    expect(invokeMock).toHaveBeenCalledWith("export_save", {
      defaultName: "a",
      contents: "x",
      filterName: null,
      extensions: null,
    });
  });

  // Cancelling is the normal way to decline a save; the backend returns null.
  it("returns null when the user cancels", async () => {
    invokeMock.mockResolvedValue(null);
    expect(await saveText("out.json", "{}")).toBeNull();
  });

  it("does not swallow a real write failure", async () => {
    invokeMock.mockRejectedValue(new Error("permission denied"));
    await expect(saveText("denied.json", "{}")).rejects.toThrow("permission denied");
  });
});
