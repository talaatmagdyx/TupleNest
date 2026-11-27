import type { ReactNode } from "react";

/**
 * A small Markdown renderer for notebook text cells.
 *
 * Safe by construction: it builds React elements, never an HTML string, so a
 * `<script>` or `<img onerror>` in a cell is shown as the text it is. Links
 * are not followed — this webview is the app, and a click would replace it —
 * so `[text](url)` shows the text with the address beside it.
 *
 * Covered: `#`–`###` headings, paragraphs, `-`/`*` lists, fenced code,
 * `inline code`, **bold** and *italic*. Anything else is plain text.
 */
export function renderMarkdown(src: string): ReactNode[] {
  const out: ReactNode[] = [];
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) body.push(lines[i++]);
      i++; // the closing fence, if there is one
      out.push(<pre key={key++} className="md-code">{body.join("\n")}</pre>);
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const Tag = (["h3", "h4", "h5"] as const)[h[1].length - 1];
      out.push(<Tag key={key++}>{inline(h[2])}</Tag>);
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ""));
      out.push(
        <ul key={key++}>
          {items.map((t, j) => (
            <li key={j}>{inline(t)}</li>
          ))}
        </ul>,
      );
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    const para: string[] = [lines[i++]];
    while (i < lines.length && lines[i].trim() !== "" && !/^(```|#{1,3}\s|\s*[-*]\s)/.test(lines[i])) para.push(lines[i++]);
    out.push(<p key={key++}>{inline(para.join(" "))}</p>);
  }
  return out;
}

/** Inline spans: code first (nothing inside it is markup), then links, bold, italic. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*/g;
  let at = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text))) {
    if (m.index > at) out.push(text.slice(at, m.index));
    if (m[1] !== undefined) out.push(<code key={key++}>{m[1]}</code>);
    else if (m[2] !== undefined)
      out.push(
        <span key={key++} className="md-link" title={m[3]}>
          {m[2]} <span className="md-url">({m[3]})</span>
        </span>,
      );
    else if (m[4] !== undefined) out.push(<strong key={key++}>{m[4]}</strong>);
    else out.push(<em key={key++}>{m[5]}</em>);
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}
