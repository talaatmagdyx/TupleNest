import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { McpSection, claudeCodeCommand, type McpAccessRow, type McpInfo } from "./McpSection";

const invokeMock = vi.mocked(invoke);

// Vitest runs from apps/desktop; under jsdom import.meta.url is not a file URL.
const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

const INFO: McpInfo = {
  command: "/Applications/TupleNest.app/Contents/MacOS/tuplenest-desktop",
  args: ["mcp"],
  config: '{\n  "mcpServers": {\n    "tuplenest": {\n      "command": "/Applications/TupleNest.app/Contents/MacOS/tuplenest-desktop",\n      "args": ["mcp"]\n    }\n  }\n}',
};

const DEV: McpAccessRow = { id: "c1", name: "local dev", environment: "dev", access: "off", readWriteAllowed: true };
const PROD: McpAccessRow = { id: "c2", name: "prod db", environment: "prod", access: "read_only", readWriteAllowed: false };
const BARE: McpAccessRow = { id: "c3", name: "untagged", environment: null, access: "off", readWriteAllowed: true };

function backend(rows: McpAccessRow[] = [DEV, PROD], info: McpInfo | undefined = INFO) {
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "mcp_info") return info;
    if (cmd === "mcp_access_list") return rows;
    return undefined;
  });
}

beforeEach(() => invokeMock.mockReset());

describe("McpSection", () => {
  it("shows the configuration with this app's real binary path", async () => {
    backend();
    render(<McpSection />);
    const pre = await screen.findByLabelText("MCP configuration");
    expect(pre).toHaveTextContent(INFO.command);
    expect(pre).toHaveTextContent('"mcp"');
    expect(invokeMock).toHaveBeenCalledWith("mcp_info");
    expect(invokeMock).toHaveBeenCalledWith("mcp_access_list");
  });

  it("lists every saved connection with its current access", async () => {
    backend([DEV, PROD, BARE]);
    render(<McpSection />);
    expect(await screen.findByLabelText("MCP access for local dev")).toHaveValue("off");
    expect(screen.getByLabelText("MCP access for prod db")).toHaveValue("read_only");
    expect(screen.getByText("· prod")).toBeInTheDocument();
    expect(screen.getByLabelText("MCP access for untagged")).toHaveValue("off");
  });

  it("does not offer read and write for prod, staging or read-only connections", async () => {
    backend();
    render(<McpSection />);
    const prod = await screen.findByLabelText("MCP access for prod db");
    const rw = Array.from((prod as HTMLSelectElement).options).find((o) => o.value === "read_write")!;
    expect(rw.disabled).toBe(true);
    expect(rw.textContent).toMatch(/not for prod, staging or read-only/);
    const dev = screen.getByLabelText("MCP access for local dev") as HTMLSelectElement;
    expect(Array.from(dev.options).find((o) => o.value === "read_write")!.disabled).toBe(false);
  });

  it("saves a change through the backend and shows it", async () => {
    backend();
    const user = userEvent.setup();
    render(<McpSection />);
    const dev = await screen.findByLabelText("MCP access for local dev");
    await user.selectOptions(dev, "read_write");
    expect(invokeMock).toHaveBeenCalledWith("mcp_access_set", { id: "c1", access: "read_write" });
    expect(dev).toHaveValue("read_write");
  });

  it("keeps the old access and says why when the backend refuses", async () => {
    // One answer per call, the refusal last and pre-handled, as in
    // AuditModal.test.tsx: a rejected promise left armed in a persistent
    // mock is reported as unhandled once the test ends.
    const refused = Promise.reject(new Error("read and write is not available"));
    refused.catch(() => {});
    invokeMock.mockResolvedValueOnce(INFO).mockResolvedValueOnce([DEV]).mockReturnValueOnce(refused);
    const user = userEvent.setup();
    render(<McpSection />);
    const dev = await screen.findByLabelText("MCP access for local dev");
    await user.selectOptions(dev, "read_only");
    expect(await screen.findByRole("alert")).toHaveTextContent("read and write is not available");
    expect(dev).toHaveValue("off");
  });

  it("surfaces a load failure instead of an empty list", async () => {
    const rejected = Promise.reject(new Error("store locked"));
    rejected.catch(() => {});
    invokeMock.mockReturnValue(rejected);
    render(<McpSection />);
    expect(await screen.findByRole("alert")).toHaveTextContent("store locked");
    expect(screen.queryByText(/No saved connections yet/)).not.toBeInTheDocument();
    invokeMock.mockReset();
  });

  it("explains an empty list, and copes with a backend that answers nothing", async () => {
    invokeMock.mockResolvedValue(undefined);
    render(<McpSection />);
    expect(await screen.findByText(/No saved connections yet/)).toBeInTheDocument();
    expect(screen.queryByLabelText("MCP configuration")).not.toBeInTheDocument();
  });

  it("copies the configuration and the Claude Code command", async () => {
    backend();
    const user = userEvent.setup();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<McpSection />);
    await user.click(await screen.findByRole("button", { name: "Copy configuration" }));
    expect(writeText).toHaveBeenCalledWith(INFO.config);
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Copy Claude Code command" }));
    expect(writeText).toHaveBeenLastCalledWith(claudeCodeCommand(INFO));
  });

  it("says so when the clipboard refuses", async () => {
    backend();
    const user = userEvent.setup();
    const writeText = vi.fn(async () => {
      throw new Error("denied");
    });
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<McpSection />);
    await user.click(await screen.findByRole("button", { name: "Copy configuration" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Could not copy/);
  });
});

/** The rule bodies for `selector` in the stylesheet, joined. */
function cssRule(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...css.matchAll(new RegExp(`(?:^|\\n|\\})\\s*${esc}\\s*\\{([^}]*)\\}`, "g"))].map((m) => m[1]).join(";");
}

describe("McpSection styling", () => {
  it("themes each access select with tokens, so its value shows in the dark theme", async () => {
    backend();
    render(<McpSection />);
    const dev = await screen.findByLabelText("MCP access for local dev");
    expect(dev).toHaveClass("mcp-select");
    // The current value is the selected option's label, not a blank box.
    expect((dev as HTMLSelectElement).selectedOptions[0].textContent).toBe("Off");
    const rule = cssRule(".mcp-select");
    expect(rule).toMatch(/background:\s*var\(--tn-s2\)/);
    expect(rule).toMatch(/color:\s*var\(--tn-tp\)/);
    expect(rule).toMatch(/color-scheme:\s*dark/);
    expect(cssRule('[data-tn-theme="light"] .mcp-select')).toMatch(/color-scheme:\s*light/);
    expect(cssRule(".mcp-select option")).toMatch(/background:\s*var\(--tn-s2\)/);
  });

  it("keeps the configuration inside its own scrolling box", async () => {
    backend();
    render(<McpSection />);
    const pre = await screen.findByLabelText("MCP configuration");
    expect(pre).toHaveClass("mcp-config");
    // Reachable by keyboard so the scrolled-off part can be read.
    expect(pre).toHaveAttribute("tabindex", "0");
    const rule = cssRule(".mcp-config");
    expect(rule).toMatch(/max-width:\s*100%/);
    expect(rule).toMatch(/overflow-x:\s*auto/);
    // The pane it sits in may shrink below its content, or the box never scrolls.
    expect(cssRule(".set-body")).toMatch(/min-width:\s*0/);
  });
});

describe("claudeCodeCommand", () => {
  it("quotes the path and passes the subcommand after --", () => {
    expect(claudeCodeCommand({ ...INFO, command: "/Apps/Tuple Nest/tuplenest-desktop" })).toBe(
      'claude mcp add tuplenest -- "/Apps/Tuple Nest/tuplenest-desktop" mcp',
    );
  });
});
