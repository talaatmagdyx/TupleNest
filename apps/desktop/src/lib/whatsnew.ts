/**
 * What's new, bundled with the app: a few lines per version, shown once after
 * an update. The full story is CHANGELOG.md, one click away.
 *
 * A version with no entry here shows nothing — a patch release need not say
 * anything — and is still recorded as seen.
 */

export type NewsItem = { icon: string; title: string; text: string; tone: "accent" | "info" | "success" | "warn" };

export const RELEASE_NOTES: Record<string, NewsItem[]> = {
  "0.1.1": [
    {
      icon: "✦",
      title: "The assistant",
      text: "Ask in plain English, explain a slow query, fix an error. Your own Anthropic key, or a model on this computer.",
      tone: "accent",
    },
    {
      icon: "⇄",
      title: "MCP server",
      text: "Claude Desktop, Claude Code and Cursor can query the connections you allow, with read-only and guard rules applied.",
      tone: "info",
    },
    {
      icon: "▦",
      title: "Dashboards and notebooks",
      text: "Pin saved queries as charts that refresh, and keep notes, queries and charts together in a notebook.",
      tone: "success",
    },
    {
      icon: "⇩",
      title: "Backup, restore, users and roles",
      text: "Back up and restore with your own pg_dump and pg_restore, and see what each role may do to each table.",
      tone: "warn",
    },
  ],
};

/** Notes for `version`, or none. */
export function notesFor(version: string): NewsItem[] {
  return RELEASE_NOTES[version] ?? [];
}

/** Settings key: the version whose notes were last seen. */
export const SEEN_VERSION_KEY = "whats_new_seen";

/**
 * What to show at start-up, given the stored settings: what's new, for a
 * version not seen before that has notes. A first launch (nothing seen yet)
 * shows nothing — a new user has nothing to compare with.
 */
export function startupDialog(version: string, seenVersion: string | null): "news" | null {
  if (!version || seenVersion === null) return null;
  if (seenVersion !== version && notesFor(version).length > 0) return "news";
  return null;
}
