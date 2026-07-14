import React from "react";
import { invoke } from "@tauri-apps/api/core";

/** SQL syntax highlighting (from the HUD design's tokenizer). */
const SQL_RE =
  /(--[^\n]*)|('(?:[^']|'')*')|(\b\d+(?:\.\d+)?\b)|(\b(?:select|from|where|join|left|right|inner|outer|full|on|group|order|by|having|limit|offset|insert|into|values|update|set|delete|create|table|view|as|and|or|not|null|is|in|like|distinct|desc|asc|union|all|case|when|then|else|end|count|sum|avg|min|max|begin|commit|rollback|explain|analyze)\b)/gi;

export function tokenizeSQL(sql: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  const re = new RegExp(SQL_RE.source, "gi");
  while ((m = re.exec(sql))) {
    if (m.index > last) out.push(sql.slice(last, m.index));
    const cls = m[1] ? "tok-c" : m[2] ? "tok-s" : m[3] ? "tok-n" : "tok-k";
    out.push(
      <span key={k++} className={cls}>
        {m[0]}
      </span>
    );
    last = re.lastIndex;
  }
  if (last < sql.length) out.push(sql.slice(last));
  out.push("\n");
  return out;
}

/** Pages the backend row store until `stored` rows are collected. */
export async function fetchAllRows(stored: number, cap = 100_000): Promise<unknown[][]> {
  const n = Math.min(stored, cap);
  const out: unknown[][] = [];
  for (let off = 0; off < n; off += 1000) {
    const page = await invoke<unknown[][]>("pg_rows", { offset: off, limit: 1000 });
    out.push(...page);
    if (page.length === 0) break;
  }
  return out;
}

const cellText = (v: unknown): string =>
  v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);

export function toCSV(cols: { name: string }[], rows: unknown[][]): string {
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const head = cols.map((c) => esc(c.name)).join(",");
  return [head, ...rows.map((r) => r.map((v) => esc(cellText(v))).join(","))].join("\n");
}

export function toJSONExport(cols: { name: string }[], rows: unknown[][]): string {
  return JSON.stringify(
    rows.map((r) => Object.fromEntries(cols.map((c, i) => [c.name, r[i] ?? null]))),
    null,
    2
  );
}

export function toMarkdown(cols: { name: string }[], rows: unknown[][]): string {
  const head = `| ${cols.map((c) => c.name).join(" | ")} |`;
  const sep = `| ${cols.map(() => "---").join(" | ")} |`;
  const body = rows
    .slice(0, 1000)
    .map((r) => `| ${r.map((v) => cellText(v).replace(/\|/g, "\\|")).join(" | ")} |`);
  return [head, sep, ...body].join("\n");
}

/** Destructive-statement guard: UPDATE/DELETE without WHERE on prod. */
export function needsGuard(sql: string, env: string | null): boolean {
  return env === "prod" && /^\s*(update|delete)\b/i.test(sql) && !/\bwhere\b/i.test(sql);
}

/** Lightweight SQL formatter: uppercases keywords, breaks major clauses. */
export function formatSQL(sql: string): string {
  const KW =
    /\b(select|from|where|join|left join|right join|inner join|full join|cross join|on|group by|order by|having|limit|offset|insert into|values|update|set|delete from|union all|union|and|or|as|desc|asc|distinct|case|when|then|else|end|returning|with)\b/gi;
  let out = sql.replace(KW, (m) => m.toUpperCase());
  const BREAK_BEFORE =
    /\s+(FROM|WHERE|LEFT JOIN|RIGHT JOIN|INNER JOIN|FULL JOIN|CROSS JOIN|JOIN|GROUP BY|ORDER BY|HAVING|LIMIT|OFFSET|UNION ALL|UNION|VALUES|SET|RETURNING)\b/g;
  out = out.replace(BREAK_BEFORE, "\n$1");
  out = out.replace(/\s+(AND|OR)\b/g, "\n  $1");
  return out.replace(/[ \t]+$/gm, "").trim();
}

export function looksLikeSelect(sql: string): boolean {
  return /^\s*(select|with|values|table)\b/i.test(sql);
}

export const ENV_COLORS: Record<string, { color: string; bg: string }> = {
  dev: { color: "#3fb950", bg: "rgba(63,185,80,.14)" },
  test: { color: "#9aa0a9", bg: "rgba(154,160,169,.14)" },
  staging: { color: "#e0a13a", bg: "rgba(224,161,58,.14)" },
  prod: { color: "#ef4d4d", bg: "rgba(239,77,77,.16)" },
};

export function envMeta(env: string | null | undefined) {
  return ENV_COLORS[env ?? "dev"] ?? ENV_COLORS.dev;
}
