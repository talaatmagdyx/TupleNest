import { firstKeyword, guardReason, hasWriteVerb, looksLikeSelect } from "../lib/sql";

/** A piece of an answer: prose, or a fenced code block. */
export type Segment = { kind: "text"; text: string } | { kind: "code"; lang: string; code: string };

/**
 * Split a model's answer into prose and fenced code blocks.
 *
 * Works on a partial answer too, while it streams: an unclosed fence is shown
 * as code so far, which is what the user is watching arrive.
 */
export function splitAnswer(answer: string): Segment[] {
  const out: Segment[] = [];
  const re = /```([A-Za-z0-9_+-]*)[^\n]*\n([\s\S]*?)(?:```|$)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(answer))) {
    const before = answer.slice(last, m.index).trim();
    if (before) out.push({ kind: "text", text: before });
    out.push({ kind: "code", lang: m[1].toLowerCase(), code: m[2].replace(/\s+$/, "") });
    last = re.lastIndex;
  }
  const rest = answer.slice(last).trim();
  if (rest) out.push({ kind: "text", text: rest });
  return out;
}

/** Whether a fenced block is SQL worth offering to the editor. */
export function isSqlBlock(s: { lang: string; code: string }): boolean {
  if (s.lang === "sql" || s.lang === "postgresql" || s.lang === "pgsql") return true;
  // An untagged block counts when it starts like a statement, so a shell
  // command such as `ollama pull` is not offered to the editor.
  return s.lang === "" && SQL_START.test(firstKeyword(s.code) ?? "");
}

const SQL_START =
  /^(select|with|insert|update|delete|merge|create|alter|drop|truncate|explain|values|table|show|grant|revoke|copy|vacuum|analyze|reindex|comment|call|do)$/;

export type Classification = {
  /** "read" when it only reads, "write" for rows, "schema" for DDL. */
  kind: "read" | "write" | "schema";
  label: string;
  /** What will happen on Run on this connection, in words. */
  note: string;
};

const DDL = /^(create|drop|alter|truncate|grant|revoke|reindex|vacuum|cluster|comment)$/;

/**
 * Read-only or a write, by the same checks the Run path uses (`lib/sql`).
 *
 * It errs towards "write", as `hasWriteVerb` does. It is a label, not a
 * permission: whatever the card says, the statement runs only when the user
 * presses Run, and then through the guard like any other.
 */
export function classify(sql: string, env: string | null): Classification {
  const verb = firstKeyword(sql) ?? "";
  const explainOnly = verb === "explain" && !/\banaly[sz]e\b/i.test(sql);
  const reads = (looksLikeSelect(sql) || explainOnly || verb === "show") && !hasWriteVerb(sql);
  const guard = guardReason(sql, env);
  const where = env === "prod" || env === "staging" ? env.toUpperCase() : null;
  if (reads) {
    return {
      kind: "read",
      label: "Read-only",
      note: "Changes only the editor. Nothing runs until you press Run.",
    };
  }
  const kind = DDL.test(verb) ? "schema" : "write";
  const label = kind === "schema" ? "Changes the schema" : "Writes data";
  const note = guard
    ? `This is a write. On ${where ?? "this connection"} it still asks before it runs: ${guard.why}`
    : "This is a write. Nothing runs until you press Run.";
  return { kind, label, note };
}

/** One line of a line diff. */
export type DiffLine = { op: "same" | "add" | "del"; text: string };

/**
 * Line diff of `before` → `after`, by longest common subsequence.
 *
 * Statements are a few dozen lines; the quadratic table is fine, and past a
 * size where it would not be, the diff is replaced by delete-all/add-all.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.replace(/\s+$/, "").split("\n");
  const b = after.replace(/\s+$/, "").split("\n");
  if (a.length * b.length > 250_000) {
    return [...a.map((text) => ({ op: "del" as const, text })), ...b.map((text) => ({ op: "add" as const, text }))];
  }
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: "same", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ op: "del", text: a[i++] });
    } else {
      out.push({ op: "add", text: b[j++] });
    }
  }
  while (i < n) out.push({ op: "del", text: a[i++] });
  while (j < m) out.push({ op: "add", text: b[j++] });
  return out;
}
