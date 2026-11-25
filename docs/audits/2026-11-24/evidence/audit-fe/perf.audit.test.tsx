import { it } from "vitest";
import { tokenizeLines } from "@app/lib/sql";
import { getCompletions, type Catalog } from "@app/lib/complete";
import { parseCsv } from "@app/lib/csv";

const time = (f: () => void, n = 5) => { f(); const t = performance.now(); for (let i = 0; i < n; i++) f(); return (performance.now() - t) / n; };
it("AUDIT per-keystroke cost", () => {
  const line = "select u.id, u.email, o.total from users u join orders o on o.user_id = u.id where u.created_at > '2024-01-01' and o.total > 100; -- note\n";
  for (const lines of [200, 2000, 10000]) {
    const sql = line.repeat(lines);
    const cat: Catalog = {
      schemas: ["public"],
      tables: Array.from({ length: 10000 }, (_, i) => ({ schema: "public", name: `table_${i}`, kind: "table" })),
      columns: {},
      searchPath: ["public"],
    };
    const tk = time(() => tokenizeLines(sql));
    const cp = time(() => getCompletions(sql + "select * from tab", sql.length + 17, cat));
    console.log(`PERF lines=${lines} bytes=${sql.length} tokenizeLines=${tk.toFixed(1)}ms getCompletions(10k tables)=${cp.toFixed(1)}ms`);
  }
});
