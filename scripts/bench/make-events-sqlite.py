"""Writes a SQLite file shaped like the benchmark's analytics.sqlite.

    python scripts/bench/make-events-sqlite.py <out.sqlite> [rows]

One table, events(id integer primary key, ts text, kind text, page text,
ms integer), 50,000 rows by default: the same schema, row count and value
shapes as the file in docs/benchmarks/README.md, generated deterministically
so a machine without that file (a CI runner) can run tests/bench_sqlite.rs.
The values are not byte-for-byte the same as the original's.
"""

import datetime
import os
import sqlite3
import sys

out = sys.argv[1]
rows = int(sys.argv[2]) if len(sys.argv) > 2 else 50_000
if os.path.exists(out):
    os.remove(out)

start = datetime.datetime(2026, 11, 1)
kinds = ["click", "view", "signup", "view"]
pages = ["/docs", "/home", "/blog", "/pricing", "/about"]

conn = sqlite3.connect(out)
conn.execute("CREATE TABLE events(id integer primary key, ts text, kind text, page text, ms integer)")
conn.executemany(
    "INSERT INTO events VALUES (?, ?, ?, ?, ?)",
    (
        (
            i,
            (start + datetime.timedelta(seconds=53 * i)).strftime("%Y-%m-%d %H:%M:%S"),
            kinds[(i - 1) % 4],
            pages[(i - 1) % 5],
            40 + (7 * i) % 900,
        )
        for i in range(1, rows + 1)
    ),
)
conn.commit()
conn.close()
print(f"wrote {rows} rows to {out}")
