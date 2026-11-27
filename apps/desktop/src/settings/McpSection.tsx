import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/** What `mcp_info` answers: how an AI tool starts `tuplenest-desktop mcp`. */
export type McpInfo = { command: string; args: string[]; config: string };

export type McpAccess = "off" | "read_only" | "read_write";

/** One saved connection's row, from `mcp_access_list`. */
export type McpAccessRow = {
  id: string;
  name: string;
  environment: string | null;
  access: McpAccess;
  /** False for prod, staging and read-only profiles: the backend refuses it. */
  readWriteAllowed: boolean;
};

const LABELS: Record<McpAccess, string> = {
  off: "Off",
  read_only: "Read only",
  read_write: "Read and write",
};

/** The command-line form, for `claude mcp add`. Quoted: the macOS path has a
 *  space-free bundle name, but a user's install location may not. */
export function claudeCodeCommand(info: McpInfo): string {
  return `claude mcp add tuplenest -- "${info.command}" ${info.args.join(" ")}`;
}

/**
 * Settings → MCP server.
 *
 * Lets an AI tool (Claude Desktop, Claude Code, Cursor) reach saved
 * connections through TupleNest. Every connection starts Off; the user turns
 * on the ones they want, read only or read and write. The rules are enforced
 * in the backend (`mcp/server.rs`) — the disabled option here only says so.
 */
export function McpSection() {
  const [info, setInfo] = useState<McpInfo | null>(null);
  const [rows, setRows] = useState<McpAccessRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [i, r] = await Promise.all([
          invoke<McpInfo>("mcp_info"),
          invoke<McpAccessRow[]>("mcp_access_list"),
        ]);
        setInfo(i ?? null);
        setRows(r ?? []);
      } catch (e) {
        setErr(String(e));
      }
    })();
  }, []);

  const change = async (row: McpAccessRow, access: McpAccess) => {
    setErr(null);
    try {
      await invoke("mcp_access_set", { id: row.id, access });
      setRows((rs) => (rs ?? []).map((r) => (r.id === row.id ? { ...r, access } : r)));
    } catch (e) {
      // The row keeps the access the backend still has.
      setErr(String(e));
    }
  };

  const copy = async (what: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
    } catch {
      setErr("Could not copy to the clipboard; select the text and copy it instead.");
    }
  };

  return (
    <div className="section-row" style={{ display: "block" }}>
      <div className="st">MCP server</div>
      <div className="sd" style={{ marginBottom: 8 }}>
        Lets AI tools such as Claude Desktop, Claude Code and Cursor query the connections you turn on below, through
        TupleNest and its safety rules. Read only uses a read-only session. Read and write still refuses destructive
        statements (no WHERE, DROP, TRUNCATE, ALTER…), and is not available on prod or staging. Statements on prod and
        staging are written to the audit log before they run.
      </div>
      {err && (
        <div className="error-box" role="alert">
          {err}
        </div>
      )}
      {info && (
        <>
          <div className="sd">Add this to the AI tool's MCP configuration (Claude Desktop, Cursor):</div>
          {/* Its own scrolling box: the binary path is one unbreakable run,
              and without this it pushed the whole settings pane wider. */}
          <pre className="mono mcp-config" aria-label="MCP configuration" tabIndex={0}>
            {info.config}
          </pre>
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <button className="btn" onClick={() => void copy("config", info.config)}>
              {copied === "config" ? "Copied" : "Copy configuration"}
            </button>
            <button className="btn" onClick={() => void copy("claude", claudeCodeCommand(info))}>
              {copied === "claude" ? "Copied" : "Copy Claude Code command"}
            </button>
          </div>
        </>
      )}
      {rows && rows.length === 0 && <div className="sd">No saved connections yet.</div>}
      {(rows ?? []).map((r) => (
        <div key={r.id} className="mcp-row">
          <span className="mcp-name">
            {r.name}
            {r.environment && <span className="hmeta"> · {r.environment}</span>}
          </span>
          <select
            className="mcp-select"
            aria-label={`MCP access for ${r.name}`}
            value={r.access}
            onChange={(e) => void change(r, e.target.value as McpAccess)}
          >
            <option value="off">{LABELS.off}</option>
            <option value="read_only">{LABELS.read_only}</option>
            <option value="read_write" disabled={!r.readWriteAllowed}>
              {r.readWriteAllowed ? LABELS.read_write : `${LABELS.read_write} (not for prod, staging or read-only)`}
            </option>
          </select>
        </div>
      ))}
    </div>
  );
}
