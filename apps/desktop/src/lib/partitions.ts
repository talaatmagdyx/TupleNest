import type { PartitionRow } from "../ipc/types";

/** One RANGE partition's parsed bounds. `raw` is kept so the UI can always
 *  fall back to showing exactly what Postgres said. */
export type Range = { name: string; from: string; to: string; raw: string };

const RANGE_RE = /FOR VALUES FROM \((.+?)\) TO \((.+?)\)$/;

/**
 * Parse `FOR VALUES FROM ('x') TO ('y')`.
 *
 * Returns null for anything else — DEFAULT partitions, LIST, HASH, and
 * multi-column range keys whose bounds contain commas we would misread.
 * Guessing at a bound we do not understand is how you propose a partition
 * that silently overlaps an existing one.
 */
export function parseRange(p: PartitionRow): Range | null {
  const m = RANGE_RE.exec(p.bounds.trim());
  if (!m) return null;
  const [from, to] = [m[1].trim(), m[2].trim()];
  // A composite key like ('a', 1) — we can't order these reliably.
  if (from.includes(",") || to.includes(",")) return null;
  return { name: p.name, from, to, raw: p.bounds };
}

export type Gap = { after: string; before: string; from: string; to: string };

/**
 * Holes in a RANGE series: places where one partition ends and the next does
 * not begin.
 *
 * The comparison is textual, which is exactly right for the quoted literals
 * Postgres emits for dates and integers ('2024-04-01' sorts correctly as a
 * string) and exactly wrong for anything else. Callers must treat the result
 * as a prompt to look, not as proof.
 */
export function findGaps(rows: PartitionRow[]): Gap[] {
  const rs = rows
    .map(parseRange)
    .filter((r): r is Range => r !== null)
    // MINVALUE/MAXVALUE are unbounded ends; they can't leave a hole.
    .filter((r) => !/MINVALUE|MAXVALUE/i.test(r.from + r.to))
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));

  const gaps: Gap[] = [];
  for (let i = 0; i + 1 < rs.length; i++) {
    // Upper bounds are exclusive, so contiguous means prev.to === next.from.
    if (rs[i].to !== rs[i + 1].from) {
      gaps.push({ after: rs[i].name, before: rs[i + 1].name, from: rs[i].to, to: rs[i + 1].from });
    }
  }
  return gaps;
}

/** SQL to fill a gap. Named after the bound so two gaps can't collide. */
export function createPartitionSql(
  schema: string,
  parent: string,
  g: Gap,
  suffix: string,
): string {
  return (
    `CREATE TABLE "${schema}"."${parent}_${suffix}"\n` +
    `  PARTITION OF "${schema}"."${parent}"\n` +
    `  FOR VALUES FROM (${g.from}) TO (${g.to});`
  );
}

/** Detach is reversible and takes no long lock in CONCURRENTLY form; drop is
 *  neither. They are never offered as the same button. */
export function detachSql(schema: string, part: string, parent: string): string {
  return (
    `-- Detach keeps the data as a standalone table. Reversible with ATTACH.\n` +
    `-- CONCURRENTLY avoids a long ACCESS EXCLUSIVE lock, and cannot run\n` +
    `-- inside a transaction block.\n` +
    `ALTER TABLE "${schema}"."${parent}" DETACH PARTITION "${schema}"."${part}" CONCURRENTLY;`
  );
}

export function dropPartitionSql(schema: string, part: string, rows: number): string {
  return (
    `-- DESTRUCTIVE: this deletes the partition and every row in it` +
    (rows > 0 ? ` (~${rows.toLocaleString()} rows).` : ".") +
    `\n-- Detach it first if you may want the data back.\n` +
    `DROP TABLE "${schema}"."${part}";`
  );
}
