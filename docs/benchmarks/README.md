# Benchmarks

Measurements of TupleNest 0.1.1 on one Mac, taken on 2026-11-28. They show
what this build does on this hardware with this data. They are not a
guarantee for other machines, and they are not compared with any other
product.

Each section gives what was measured, how, and the numbers. Everything here
can be reproduced with the commands under [Reproducing](#reproducing).

## Environment

| | |
| --- | --- |
| Machine | Apple M4 Pro, 12 cores, 24 GB RAM (`sysctl -n machdep.cpu.brand_string`, `hw.ncpu`, `hw.memsize` = 25769803776) |
| OS | macOS 26.6.2 (build 25G83) |
| PostgreSQL | 18.0 (Homebrew build, aarch64), same machine, TCP to `localhost:5432`, no TLS, `shared_buffers` = 128MB |
| SQLite | 3.54.1, the copy bundled into the app by `rusqlite` |
| App version | 0.1.1 (`apps/desktop/src-tauri/tauri.conf.json`) |
| Commit | `40fc8e1`, for both the app and the driver benchmarks. Both were built from a fresh worktree of that commit with no local changes (`git status --porcelain` empty). The app embeds its commit at build time and shows it in the status bar; the built bundle records `40fc8e1` with no `+`, so it is verified, not assumed. |
| App binary | a local release build, bundle identifier `app.tuplenest.verify`, 22 MB executable |
| Rust profile | `release` from the workspace `Cargo.toml` (thin LTO, one codegen unit), the same profile the app is built with |

**The machine was not idle.** Other work was running throughout: a virtual
machine, Spotlight indexing and an unrelated Go build. The 1-minute load
average, printed before and after each section, was 11.9 at the start, 13.3
after start-up, 14.5 after PostgreSQL and 46.5 at the end of SQLite, on 12
cores. A wait of almost three hours for the load to drop below 6 did not
succeed, so these runs were taken under that load. Medians are fairly stable
under load; the p95, p99 and maximum figures are inflated by it and should be
read as an upper bound, not as what the app does on a quiet machine.

Percentiles are nearest-rank. Every driver measurement ran 100 times after
one warm-up; start-up ran 20 launches.

## Datasets

**PostgreSQL database `shop`** (61 MB on disk), schema `public`:

| Object | Kind | Rows |
| --- | --- | --- |
| `orders` | table | 250,000 |
| `line_items` | table | 60,000 |
| `customers` | table | 400 |
| `products` | table | 120 |
| `monthly_revenue` | view | |
| `customers_id_seq`, `orders_id_seq`, `products_id_seq` | sequences | |

`orders` is `id bigint` (identity, primary key), `customer_id bigint` (FK,
indexed), `status text` (4 distinct values), `total numeric(12,2)`,
`created_at timestamptz`. 33 MB heap, 47 MB with indexes. It fits in
`shared_buffers`, and every measurement does a warm-up run first, so the
timings are for a warm cache.

**SQLite file `analytics.sqlite`** (2.2 MB, page size 4096, rollback journal):
one table, `events(id integer primary key, ts text, kind text, page text, ms integer)`,
50,000 rows. Opened read-only.

## Results

### Summary

| What | Median | p95 | p99 | n |
| --- | --- | --- | --- | --- |
| Startup: launch to window on screen | 309 ms | 416 ms | | 20 |
| Startup: launch to start-up work finished | 1.13 s | 3.38 s | | 20 |
| Idle memory after 30 s, physical footprint (sum of 4 processes) | 127 MB | | | 1 |
| Idle memory after 30 s, resident (sum) | 136 MB | | | 1 |
| PostgreSQL: 20,000 rows (`LIMIT 20000`), all read | 12.6 ms | 26.9 ms | 31.9 ms | 100 |
| PostgreSQL: `SELECT * FROM orders` until the 20,000-row cap, stored | 25.3 ms | 81.1 ms | 150 ms | 100 |
| PostgreSQL: all 250,000 rows, no cap | 152 ms | 334 ms | 625 ms | 100 |
| SQLite: 20,000 rows (`LIMIT 20000`), all read | 4.0 ms | 4.2 ms | 5.1 ms | 100 |
| SQLite: `SELECT * FROM events` until the 20,000-row cap, stored | 11.2 ms | 19.9 ms | 24.0 ms | 100 |
| SQLite: all 50,000 rows, no cap | 11.4 ms | 22.7 ms | 30.5 ms | 100 |
| Schema discovery, `shop` (1 schema, 8 objects) | 6.5 ms | 16.8 ms | 53.9 ms | 100 |
| Schema discovery, `analytics.sqlite` (1 table) | 0.10 ms | 0.15 ms | 0.19 ms | 100 |
| PostgreSQL cancel of `pg_sleep(30)` | 2.7 ms | 5.5 ms | 20.4 ms | 100 |
| SQLite cancel of an endless query | 0.04 ms | 0.70 ms | 2.4 ms | 100 |
| Large-result rendering in a real WebView | Not measured yet (timing marks in place, section 7) | | | |
| PostgreSQL, 10,000 tables: `ListObjects` (section 6) | 48.8 ms | 171 ms | 408 ms | 100 |
| PostgreSQL, 10,000 tables: full walk, 10,004 requests | 10.3 s | | | 5 |
| SQLite, 10,000 tables: full walk, 10,004 requests | 70.9 s | | | 5 |
| PostgreSQL at +80 ms RTT: `SELECT 1` on a read-only session (section 8) | 343 ms | 368 ms | 379 ms | 20 |
| PostgreSQL at +80 ms RTT: 20,000-row read, stored | 883 ms | 894 ms | 900 ms | 20 |
| PostgreSQL at +80 ms RTT, TLS: connect | 522 ms | 545 ms | 548 ms | 20 |
| Idle app, 30 min: footprint from minute 5 to the end (section 9) | 118.0 to 119.2 MB, no growth | | | 60 samples |
| Driver soak, 20 min: resident size from 30 s to the end | 9.8 to 10.5 MB, no growth | | | 41 samples |

Rows from section 6 on were measured later, under heavier load; see
[Results, phase 3](#results-phase-3-2026-11-28-later-the-same-day).

With 20 launches, p99 would be the maximum, so it is not given for start-up.

### 1. Application startup

**What "ready" means here.** The app has no "window is ready" event that can
be seen from outside the process: it logs `TupleNest starting` from Tauri's
`setup` hook, which runs before the WebView has loaded anything, and the
first IPC calls the UI makes on mount (`app_get_info`, `settings_get`,
`connection_list`) are reads that leave no trace on disk. Screen capture was
not available to the measuring process, so painted pixels could not be
checked either. Two proxies are reported instead:

- **Window on screen**: time from process launch until the process owns an
  on-screen, layer-0 window in `CGWindowListCopyWindowInfo`. This is a lower
  bound: the window exists, but its web content may not be painted yet.
- **Start-up work finished**: time from launch until the app process and the
  WebKit processes it started together use less than 5% of one core for
  500 ms (10 samples, 50 ms apart). The reported time is the start of that
  quiet period. It covers Rust setup, the WebView processes starting, the
  frontend bundle being parsed and run, the first render and the first IPC
  calls. It is an upper bound on "the UI is usable": it may include
  background work the user would not wait for, such as the update check.

Method (`scripts/bench/startup.swift`): each launch gets a new, empty `HOME`
(a temporary directory), so the app starts with no data folder, no profiles,
no history, as on first run. The probe snapshots the WebKit processes
already running (other apps own some), launches the binary, polls every
50 ms, then sends SIGTERM and waits for the app's WebKit processes to exit
before the next launch. 20 launches.

| | Median | p95 | Min | Max |
| --- | --- | --- | --- | --- |
| Window on screen | 309 ms | 416 ms | 291 ms | 1988 ms |
| Start-up work finished | 1.13 s | 3.38 s | 1.03 s | 4.43 s |
| Resident at that point | 209 MB | | 188 MB | 224 MB |

The 1988 ms maximum is the first launch, with the new binary not yet in the
file cache; launches 2 to 20 took 291 to 416 ms to the window. Three launches
(1, 17 and 18) took 2.7 to 4.4 s to finish start-up work; the load average
was above 11 for the whole run, and these were not investigated further.

On first launch the frontend calls the updater; the release endpoint did not
answer successfully from this build (its log has `update endpoint did not
respond with a successful status code`). That request is part of the
"start-up work" window when it completes inside it.

### 2. Idle memory

Measured on the last launch, 30 s after start-up work finished, with the
first-run screen showing and no connection open. Per process, via
`proc_pid_rusage` (`ri_resident_size`, `ri_phys_footprint`):

| Process | Resident (MB) | Footprint (MB) |
| --- | --- | --- |
| `tuplenest-desktop` (Rust + Tauri) | 78.6 | 28.2 |
| `com.apple.WebKit.WebContent` | 31.4 | 72.5 |
| `com.apple.WebKit.GPU` | 18.7 | 20.1 |
| `com.apple.WebKit.Networking` | 7.4 | 6.6 |
| **Total** | **136.1** | **127.4** |

Resident size counts shared framework pages in every process, so the sum
overstates what the app costs the system. Physical footprint is the private
memory macOS charges to each process (including compressed and GPU memory,
which is why it can exceed resident size for the WebKit processes). The
WebKit processes are identified as WebKit XPC processes that appeared after
the app launched; another app starting a WebView in the same window would be
counted wrongly. The idle report lists exactly one GPU, one Networking and
one WebContent process.

Memory is higher during start-up (about 188 to 224 MB resident in total at
the end of start-up work) and drops over the next seconds.

### 3. Query result streaming

These drive the driver crates directly, not the app: no IPC, no WebView, no
rendering. They measure the part of a query that happens in Rust: sending
the statement, receiving rows, decoding cells, and (where stated) storing
them the way the app does.

The app keeps at most 20,000 rows (and at most 128 MB of row text) of a
result (`RESULT_STORE_CAP` and `RESULT_STORE_BYTES` in
`apps/desktop/src-tauri/src/pg.rs`). For a plain read it passes 20,000 as
`QueryRequest::row_limit`, and the driver stops at that many rows on the
server side.

Three cases per engine, each repeated 100 times after one warm-up:

1. `SELECT * FROM <table> LIMIT 20000`, no row limit, rows decoded and
   counted but not kept. "First batch" is the time until the first batch of
   rows reached the sink.
2. `SELECT * FROM <table>` with `row_limit` 20,000, the app's path. Each row
   is written as a JSON array and pushed into a
   `tuplenest_result_stream::RowStore` built with the app's caps. Measured
   until `execute` returns with `more_rows = true`. The row writer is a copy
   of the app's for the column types in these tables, not the app's own
   function (that lives in the app crate). The store held 1.1 MB of row text
   (0.4 MB compressed) for `orders` and 0.9 MB (0.2 MB compressed) for
   `events`.
3. The whole table with no row limit, decoded and counted. Not something the
   app does with a plain read; it is here to show the per-row cost at scale.

| Case | PostgreSQL `orders`: median / p95 / p99 | SQLite `events`: median / p95 / p99 |
| --- | --- | --- |
| Connect / open | 2.5 / 4.5 / 5.6 ms | 0.09 / 0.13 / 0.19 ms |
| 1. 20,000 rows, decode only: total | 12.6 / 26.9 / 31.9 ms | 4.0 / 4.2 / 5.1 ms |
| 1. 20,000 rows, decode only: first batch | 1.0 / 2.1 / 7.2 ms | 0.18 / 0.21 / 0.27 ms |
| 2. Until the 20,000-row cap, stored | 25.3 / 81.1 / 150 ms | 11.2 / 19.9 / 24.0 ms |
| 3. Whole table, no cap, decode only | 152 / 334 / 625 ms, 250,000 rows | 11.4 / 22.7 / 30.5 ms, 50,000 rows |

n=100 each. What these numbers leave out, all of which a user
waits for in the app: the IPC hop to the WebView, the first page of rows
being serialized and sent to it, and the grid rendering. See "Large-result
rendering" below.

### 4. Schema discovery

The full walk of everything the explorer can load for a database, on one
open session:
`ServerInfo`, `ListSchemas`, then for each schema `ListObjects` and
`Relationships`, and `DescribeObject` for every object listed. This is the
cost of loading the whole tree; how much of it the explorer requests before
showing its first screen was not checked.

| | Median | p95 | p99 | n |
| --- | --- | --- | --- | --- |
| `shop`: full walk (1 schema, 8 objects, 12 requests) | 6.5 ms | 16.8 ms | 53.9 ms | 100 |
| `shop`: `ListObjects` on `public` | 0.24 ms | 0.30 ms | 0.35 ms | 100 |
| `shop`: `DescribeObject` on `public.orders` | 0.67 ms | 0.83 ms | 0.99 ms | 100 |
| `analytics.sqlite`: full walk (1 schema, 1 table) | 0.10 ms | 0.15 ms | 0.19 ms | 100 |

`shop` is a small schema. These numbers say nothing about a database with
thousands of tables or partitions; that has not been measured.

### 5. Query cancellation

Time from calling the session's cancel handle to `execute` returning a
`Cancelled` error. The statement is started, the cancel is sent 500 ms
later, so the statement is running on the server when it arrives.

| | Median | p95 | p99 | Max | n |
| --- | --- | --- | --- | --- | --- |
| PostgreSQL, `SELECT pg_sleep(30)` | 2.7 ms | 5.5 ms | 20.4 ms | 35.8 ms | 100 |
| SQLite, endless recursive CTE (`WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c`) | 0.04 ms | 0.70 ms | 2.4 ms | 2.5 ms | 100 |

For PostgreSQL, the cancel opens a separate connection and sends a cancel
request; the server then interrupts the backend. Over TCP to localhost this
is a few milliseconds. The slowest 1% took 20 to 36 ms; this was not
investigated further, and the background load is a likely cause. Over a real network, add at least one
connection setup to the server.

For SQLite, cancel calls `sqlite3_interrupt`, which the running statement
checks between steps of the virtual machine.

## Results, phase 3 (2026-11-28, later the same day)

Sections 6 to 10 were added afterwards, on the same machine, from branch
`phase3/perf-stability`. The driver code measured is unchanged from
`40fc8e1`; only benchmark code, a probe script and UI timing marks were
added. **The load was worse than for sections 1 to 5**: the 1-minute load
average, given with each section, ranged from 12 to 115 on 12 cores, from
other work on the machine (not from these runs). Medians are usable; every
p95, p99 and maximum below is inflated by that load and is an upper bound.
Driver measurements are n=100 after one warm-up unless stated otherwise.

### 6. Large schemas

The same calls as section 4, on databases built for the purpose with 1,000
and 10,000 tables in one schema. Each table is `id bigint primary key`
(`integer` in SQLite), `parent_id`, `name text not null`,
`amount numeric(12,2)`, `created_at timestamptz` (`text` in SQLite). Every
even-numbered table has a foreign key from `parent_id` to the table before it
and an index on `parent_id`: 10,000 tables means 5,000 foreign keys and
5,000 extra indexes, besides the primary keys.

- PostgreSQL: a new database per size (`tuplenest_bench_<n>_tables`, created
  through the `postgres` database), filled with `DO` blocks of 200 tables,
  `ANALYZE`d, measured over a read-only session, then dropped
  (`DROP DATABASE … WITH (FORCE)`, also if the measurement panics). Building
  took 1.4 s for 1,000 tables and 19.7 s for 10,000. `shop` was not touched.
- SQLite: a new file in a temporary directory, created in one transaction
  (0.1 s and 6.1 MB for 1,000 tables, 6.6 s and 60.8 MB for 10,000), opened
  read-only through the driver, deleted afterwards.

The full walk is ServerInfo, ListSchemas, ListObjects, one DescribeObject per
table and Relationships, one request after another on one session: 1,004 and
10,004 requests. It takes seconds, so it was repeated 5 times, not 100
(n=5: p95 and p99 are the maximum).

PostgreSQL (load 67 at the start, 93 at the end):

| | 1,000 tables: median / p95 / p99 | 10,000 tables: median / p95 / p99 |
| --- | --- | --- |
| `ListSchemas` | 0.18 / 0.24 / 0.26 ms | 0.16 / 0.22 / 0.45 ms |
| `ListObjects public` | 4.96 / 7.80 / 10.7 ms (0.08 MB JSON) | 48.8 / 171 / 408 ms (0.85 MB JSON) |
| `DescribeObject` on the middle table | 0.97 / 1.83 / 2.62 ms | 0.89 / 1.29 / 1.91 ms |
| `Relationships public` | 1.29 / 1.47 / 2.93 ms (0.03 MB) | 12.0 / 17.4 / 28.5 ms (0.30 MB) |
| Full walk, n=5 | 1.38 s (min 0.75, max 2.41) | 10.3 s (min 8.5, max 19.4) |

SQLite (load 98 at the start of the run):

| | 1,000 tables: median / p95 / p99 | 10,000 tables: median / p95 / p99 |
| --- | --- | --- |
| `ListSchemas` | 0.34 / 5.22 / 6.65 ms | 0.06 / 0.39 / 0.80 ms |
| `ListObjects main` | 1.61 / 3.59 / 5.18 ms (0.08 MB JSON) | 9.96 / 14.7 / 18.4 ms (0.85 MB JSON) |
| `DescribeObject` on the middle table | 0.72 / 1.57 / 1.97 ms | 4.71 / 8.59 / 13.3 ms |
| `Relationships main` | 10.4 / 21.7 / 30.0 ms (0.03 MB) | 105 / 197 / 262 ms (0.25 MB) |
| Full walk, n=5 | 0.36 s (min 0.31, max 0.54) | 70.9 s (min 45.8, max 97.6) |

What this shows:

- PostgreSQL's per-object calls do not grow with the table count
  (`DescribeObject` is under 1 ms at both sizes); `ListObjects` and
  `Relationships` grow about linearly, 10 times the tables for about 10
  times the time. The full walk is dominated by the 10,000 sequential
  `DescribeObject` round trips, about 1 ms each.
- SQLite's `DescribeObject` and `Relationships` grow with the number of
  tables in the file: `DescribeObject` went from 0.72 to 4.71 ms, and
  `Relationships` from 10 to 105 ms. The full walk is therefore worse than
  linear, 0.36 s at 1,000 tables and 71 s at 10,000. Why `DescribeObject`
  depends on the table count was not investigated; it is the one result in
  this section that looks like a scaling problem rather than a cost.
- The 10,000-table PostgreSQL `ListObjects` tail (p99 408 ms, max 1.75 s)
  came with load averages near 100 and is not reproducible as a property of
  the driver from this run.
- As in section 4, these are driver calls. How much of the walk the
  explorer requests before its first screen, and what the WebView does with
  0.85 MB of object list, were not measured.

### 7. Time to first rows in the UI

**Not measured in a real WebView.** The frontend now records User Timing
marks for each query run (`apps/desktop/src/lib/perf.ts`); no behaviour
changes, nothing is shown and nothing is sent:

| Mark | When |
| --- | --- |
| `tuplenest:run-start` | just before `pg_query` is invoked |
| `tuplenest:result` | `pg_query` has answered: the summary, no rows yet |
| `tuplenest:first-rows` | the first frame after rows of this result were committed to the grid's DOM |
| `tuplenest:settled` | the first frame after every 200-row page the grid's viewport covers is loaded |

and measures `tuplenest:run-to-result`, `tuplenest:run-to-first-rows` and
`tuplenest:run-to-settled` from `run-start`. "First frame after" means a
timeout queued from a `requestAnimationFrame` callback, so it runs once that
frame has been handed off for painting: close to when the rows can be seen,
not a confirmed paint. At the top of a result the viewport fits in the first
page, so `first-rows` and `settled` are usually the same frame. Only the
latest run's entries are kept.

**Reading them in the app.** Release builds have no Web Inspector. In a
development build, with an isolated `HOME`:

```sh
cd apps/desktop
HOME="$(mktemp -d)" npx tauri dev
```

Connect, run a query, then in the WebView's inspector (right-click, Inspect
Element) console:

```js
performance.getEntriesByType("measure").filter((m) => m.name.startsWith("tuplenest:"))
```

A development build is not optimised, so these numbers would be an upper
bound for a release build. This was not done here: driving the app's UI
from outside is not set up, and the measuring process cannot see the
screen.

**What was measured instead: the marks in jsdom.** An opt-in vitest reads
the same marks with `pg_query` already answered and `pg_rows` answered from
memory, for an `orders`-shaped result of 20,000 stored rows in a 600 px
viewport (50 rows in the DOM), 100 runs after one warm-up:

```sh
cd apps/desktop
TUPLENEST_BENCH_UI=1 npx vitest run src/lib/perf.test.tsx
```

| | Median | p95 | p99 | n |
| --- | --- | --- | --- | --- |
| jsdom: run-to-first-rows | 75.2 ms | 174 ms | 281 ms | 100 |
| jsdom: run-to-settled | 75.3 ms | 175 ms | 281 ms | 100 |

Load 32 before, 35 after. This measures React rendering and committing the
grid's first rows into jsdom's DOM plus the wait for jsdom's
`requestAnimationFrame`, which is a timer at about 60 Hz. It does not
include IPC, serialising the page of rows, style, layout, paint or the
compositor, none of which jsdom does, and jsdom's DOM is far slower than a
browser engine's. **It is not a figure for what a user sees** and should not
be quoted as one; it is here to show the marks work end to end and to give a
number to compare against after a change to the grid.

### 8. Remote PostgreSQL: added latency and TLS

The driver connects to `127.0.0.1:<port>` of a TCP proxy written for the
benchmark (`latency_proxy` in `tests/bench_pg.rs`, tokio, no new
dependencies), which forwards to the local server and holds every chunk of
bytes for half the round-trip time in each direction. Chunks are delayed,
not queued behind each other, so bandwidth is not limited: this models
distance, not a slow link. The proxy uses tokio's timer (1 ms resolution);
at +0 ms it does not wait at all, so that row is the proxy hop alone. The
cancel request opens its own connection, also through the proxy.

TLS: the local server already has `ssl = on` with its own certificate; no
server setting was changed. The benchmark connects with `TlsMode::Prefer`,
which negotiates TLS without verifying the certificate, and checks
`pg_stat_ssl.ssl` for its own backend rather than assuming (`true` for every
TLS row, `false` for every plain one). Certificate verification
(`verify-full`) was not measured; it adds CPU work at connect, not round
trips.

The session is read-only, as for a read-only profile. n=20 per cell after
one warm-up (p95 is the second-largest value, p99 the largest). Load 24 at
the start, 12 at the end.

| Median (p95) | +0 ms | +20 ms | +80 ms | +80 ms, TLS |
| --- | --- | --- | --- | --- |
| Connect | 18.1 (158) ms; TLS 6.1 (11.1) | 105 (108) ms; TLS 157 (178) | 350 (395) ms | 522 (545) ms |
| `SELECT 1` | 1.30 (6.33) ms; TLS 0.42 (0.93) | 102 (105) ms; TLS 101 (106) | 343 (368) ms | 341 (394) ms |
| `SELECT * FROM orders`, row limit 20,000, stored | 44.0 (72.6) ms; TLS 21.9 (28.4) | 288 (300) ms; TLS 272 (293) | 883 (894) ms | 879 (911) ms |
| Schema walk of `shop` (12 requests) | 28.5 (113) ms; TLS 6.65 (10.9) | 1.45 (1.46) s; TLS 2.72 (3.53) | 4.82 (4.95) s | 4.82 (4.84) s |
| Cancel, call to `execute` returning | 4.85 (88.9) ms; TLS 10.1 (31.8) | 27.0 (29.1) ms; TLS 91.1 (134) | 86.9 (101) ms | 262 (272) ms |

The +0 ms plain-TCP cells ran first, at the highest load of the run, and are
noisier than the +0 ms TLS cells measured right after them; TLS is not
faster than plain TCP, the order of the runs is. The +20 ms TLS schema walk
was bimodal (min 1.45 s, like plain TCP, median 2.72 s) and was not
investigated.

What the round-trip counts say (time at +80 ms divided by 80 ms):

- **Every statement on a read-only session costs about 4 round trips**,
  even `SELECT 1`: 343 ms at +80 ms. Before each statement the driver runs
  `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY` and reads back
  `transaction_read_only` (`ensure_read_only` in
  `crates/driver-postgres/src/lib.rs`, two round trips by design, see its
  comment), then prepares and executes. On a local server this is invisible;
  at 80 ms it is a third of a second per statement. A read-write session
  skips the check (it is inside `if self.read_only` in `execute`), so it
  should be 2 round trips cheaper per statement; read-write sessions were not
  measured.
- The app's 20,000-row read is about 10 round trips (883 ms at +80 ms,
  44 ms of it work), because a capped read goes through a cursor. Reading
  `run_cursor` in `crates/driver-postgres/src/lib.rs`: the two-step read-only
  check, a prepare of the statement, `BEGIN`, a prepare and execute of the
  `DECLARE`, a prepare and execute of one `FETCH` for all the rows, and the
  `COMMIT`. That is 9 round trips; the measurement agrees to within one.
- Metadata requests are about 5 round trips each: the 12-request walk of
  `shop` took 4.8 s at +80 ms. At 10,000 tables (section 6) the walk would be
  roughly 10,000 × 5 × RTT, over an hour at 80 ms; that was not run.
- Connect is about 4.4 round trips without TLS and 6.5 with it.
- Cancel is about 1 round trip without TLS and about 3 with it (the cancel
  connection does its own TLS handshake).

These are counts, not recommendations: whether to pipeline the read-only
check or batch metadata is a design decision outside this measurement.

SSH tunnels: **not measured.** The app's SSH tunnel needs an SSH server and
credentials, and there was none to use without touching the user's
configuration. A tunnel adds its own handshake at connect and a hop per
round trip, so the round-trip counts above are the part that carries over.

### 9. Soak: an idle app for 30 minutes, the driver under load for 20

Two separate runs, because nothing can drive queries through the app's UI
from outside yet:

**Idle app, 30 minutes** (`scripts/bench/soak.sh`, the release build of
`40fc8e1` from sections 1 and 2). One launch with `HOME` set to a new
temporary directory, left on its first-run screen with no connection, and
sampled every 30 s: physical footprint and resident size of the app and of
the WebKit processes that appeared after it launched, and the number of
lines `lsof -p` prints for each (open files including mapped libraries, the
cwd and sockets, not only descriptors). 60 samples. Load 68 before, 38
after, between 11 and 116 during.

| | at 30 s | at 5 min | at 15 min | at 29.5 min |
| --- | --- | --- | --- | --- |
| Physical footprint, app + WebKit | 128.5 MB | 118.6 MB | 118.8 MB | 119.2 MB |
| of which `tuplenest-desktop` | 28.5 MB | 28.4 MB | 29.3 MB | 29.3 MB |
| `lsof` lines, app | 68 | 67 | 63 | 63 |
| `lsof` lines, WebKit processes | 100 | 98 | 98 | 98 |

No growth: total footprint was 118.0 to 119.2 MB from minute 5 to the end,
and handle counts only went down. The app's own footprint stepped once from
28.4 to 29.3 MB at about 6.5 minutes and stayed there. Resident size fell
over the run (app 75 to 30 MB) while footprint did not, which is macOS
compressing idle pages under the machine's memory pressure, not the app
freeing memory. One sample (at 17 minutes) counted 10 WebKit processes and
158.5 MB: another application started WebViews then, and the probe, which
counts every WebKit process that appeared after launch, included them; the
next sample was back to 3.

**Driver, 20 minutes** (`bench_pg_soak`). One process repeats: the app's
20,000-row read of `orders` stored in a `RowStore`, a full schema walk of
`shop`, `SELECT 1`; every 10th iteration also cancels a running `pg_sleep`
and replaces the connection with a new one. Every 30 s it records its own
resident size (`ps -o rss`) and open descriptors (`/dev/fd`). Load 27 at
the start, 21 at the end; the workspace's clippy and test gates ran on the
same machine during the first minutes.

| | Start | After 30 s | Range from 30 s to the end | At 20 min |
| --- | --- | --- | --- | --- |
| Iterations | 0 | 74 | | 9,330 (933 reconnects and cancels) |
| Resident size | 7.6 MB | 9.9 MB | 9.8 to 10.5 MB | 10.3 MB |
| Open descriptors | 11 | 11 | 11 | 11 |
| Cancels that missed | | | | 0 |

Flat: no growth in memory or descriptors over 9,330 iterations and 933
connections opened and closed. Iteration time (median per 30-s window,
32 to 461 ms) followed the machine's load, not the elapsed time.

A first attempt of this run, with a 100 ms head start before the cancel,
failed after a minute: one cancel arrived before its `pg_sleep` had started
and so cancelled nothing, and the 30-second sleep then completed normally.
That is how PostgreSQL's cancel works (it interrupts whatever is running at
the moment it arrives), made visible by a very loaded machine. The soak now
waits 500 ms, as section 5 does, and counts a missed cancel instead of
failing.

Not covered: the app with queries running, for hours. The 8-hour commands
are under [Reproducing](#phase-3-benchmarks); run them on a quiet machine.

### 10. Linux and Windows

`.github/workflows/bench.yml` runs the SQLite driver benchmarks (sections
3 to 6 for SQLite, including the 1,000 and 10,000-table schemas) on
`ubuntu-latest`, `windows-latest` and `macos-latest` runners. It runs only
when started by hand (`workflow_dispatch`), never on push or pull request.
The runners have no copy of `analytics.sqlite`, so the workflow generates one
with `scripts/bench/make-events-sqlite.py`: the same schema, row count (50,000)
and value shapes, not the same bytes. Results go to the job summary and an
artifact. **It has not been run yet**, so there are no Linux or Windows
numbers in this file; shared CI runners are also noisy, so read their
medians and compare runners with each other rather than with this machine.
PostgreSQL is not part of it.

### Not measured yet

- **Time to first rows in a real WebView, and scrolling through 20,000
  rows.** The timing marks are in place (section 7); reading them needs a
  development build driven by hand or by UI automation, which is not set up.
- **The app under a query workload for hours.** Section 9 has an idle app
  for 30 minutes and the driver under load for 20; driving queries through
  the app's UI is not set up.
- **Startup with existing data.** Every launch here started with an empty
  data folder. A data folder with many profiles, a long history and a large
  metadata cache was not measured.
- **SSH tunnels**, and PostgreSQL over a real network rather than an added
  delay (packet loss, bandwidth, a server under its own load).
- **Linux and Windows numbers**: the workflow exists (section 10) but has
  not been run.
- **The PostgreSQL walk of 10,000 tables over added latency** (estimated
  above, not run).

## Reproducing

From the repository root (`<repo>`), with a release build of the app and a
PostgreSQL server holding the `shop` database:

```sh
# Everything, in one go. The app is launched with HOME set to a new temporary
# directory each time, so it never touches your real data folder, and it is
# terminated at the end of each launch.
TUPLENEST_TEST_PG_USER=<pg user> \
TUPLENEST_TEST_PG_DB=shop \
TUPLENEST_BENCH_SQLITE=<path>/analytics.sqlite \
TUPLENEST_BENCH_RUNS=100 STARTUP_RUNS=20 \
  scripts/bench/run-all.sh <repo>/target/release/bundle/macos/TupleNest.app/Contents/MacOS/tuplenest-desktop
```

Or each part on its own:

```sh
# Startup and idle memory: <runs> launches, idle <seconds> on the last one.
swiftc -O scripts/bench/startup.swift -o /tmp/startup-probe
mkdir -p /tmp/tn-bench-home
/tmp/startup-probe <path to tuplenest-desktop> /tmp/tn-bench-home 20 30

# PostgreSQL driver: connect, streaming, schema discovery, cancel.
TUPLENEST_BENCH_PG=1 TUPLENEST_TEST_PG_USER=<pg user> TUPLENEST_TEST_PG_DB=shop TUPLENEST_BENCH_RUNS=100 \
  cargo test --release -p tuplenest-driver-postgres --test bench_pg \
  -- --ignored --nocapture --test-threads=1

# SQLite driver: open, streaming, schema discovery, cancel.
TUPLENEST_BENCH_SQLITE=<path>/analytics.sqlite TUPLENEST_BENCH_RUNS=100 \
  cargo test --release -p tuplenest-driver-sqlite --test bench_sqlite \
  -- --ignored --nocapture --test-threads=1
```

The PostgreSQL connection uses the same `TUPLENEST_TEST_PG_HOST`, `_PORT`,
`_USER` and `_DB` variables as the live tests in
`crates/driver-postgres/tests/live_pg.rs`, with no password (local trust
authentication) and TLS off. The benchmarks connect read-only and do not
write to either database (the large-schema benchmarks below write only to
databases and files they create and then remove). They are `#[ignore]`d, so a plain `cargo test`
does not run them, and they also need an opt-in variable: the PostgreSQL ones
run only with `TUPLENEST_BENCH_PG` set and the SQLite ones only with
`TUPLENEST_BENCH_SQLITE`, so CI's `--include-ignored` live-test job skips
them. `run-all.sh` sets `TUPLENEST_BENCH_PG` itself.

Check the load average (`uptime`) before running; on a busy machine the
p95 and p99 figures in particular move a lot. Build from a clean checkout so
the status bar shows the commit without a `+`.

The files:

- `scripts/bench/run-all.sh`: runs everything and prints the environment
  and load average with the results.
- `scripts/bench/startup.swift`: the startup and idle-memory probe.
- `crates/driver-postgres/tests/bench_pg.rs`: PostgreSQL driver timings,
  including the large-schema, latency and soak benchmarks.
- `crates/driver-sqlite/tests/bench_sqlite.rs`: SQLite driver timings,
  including the large-schema benchmark.
- `scripts/bench/soak.sh` and `soak.swift`: the idle app soak.
- `scripts/bench/make-events-sqlite.py`: generates an `events` file for
  machines without `analytics.sqlite`.
- `apps/desktop/src/lib/perf.ts`: the UI timing marks;
  `perf.test.tsx` reads them in jsdom.
- `.github/workflows/bench.yml`: the manual SQLite benchmark workflow.

### Phase 3 benchmarks

These are not run by `run-all.sh`. Each needs `TUPLENEST_BENCH_PG` (or
`TUPLENEST_BENCH_SQLITE`) and a second opt-in of its own, because they build
databases, take minutes, or both. All are `#[ignore]`d.

```sh
# Large schemas (section 6). Creates and drops databases named
# tuplenest_bench_<n>_tables through TUPLENEST_BENCH_PG_ADMIN_DB (default
# postgres), so the PostgreSQL user needs CREATEDB.
TUPLENEST_BENCH_PG=1 TUPLENEST_BENCH_PG_LARGE=1 TUPLENEST_TEST_PG_USER=<pg user> \
TUPLENEST_BENCH_RUNS=100 TUPLENEST_BENCH_WALK_RUNS=5 \
  cargo test --release -p tuplenest-driver-postgres --test bench_pg bench_pg_large_schema \
  -- --ignored --nocapture --test-threads=1
TUPLENEST_BENCH_SQLITE=<any path> TUPLENEST_BENCH_SQLITE_LARGE=1 TUPLENEST_BENCH_RUNS=100 \
  cargo test --release -p tuplenest-driver-sqlite --test bench_sqlite bench_sqlite_large_schema \
  -- --ignored --nocapture --test-threads=1
# Sizes: TUPLENEST_BENCH_PG_LARGE_SIZES / TUPLENEST_BENCH_SQLITE_LARGE_SIZES (default 1000,10000).

# Added latency and TLS (section 8). Needs the shop dataset; TLS rows need a
# server with ssl = on, and say so (pg_stat_ssl.ssl) when it is off.
TUPLENEST_BENCH_PG=1 TUPLENEST_BENCH_PG_LATENCY=1 TUPLENEST_TEST_PG_USER=<pg user> \
TUPLENEST_BENCH_PG_RTTS=0,20,80 TUPLENEST_BENCH_LATENCY_RUNS=20 \
  cargo test --release -p tuplenest-driver-postgres --test bench_pg bench_pg_latency \
  -- --ignored --nocapture --test-threads=1

# Driver soak (section 9): 20 minutes, a sample every 30 s.
TUPLENEST_BENCH_PG=1 TUPLENEST_TEST_PG_USER=<pg user> \
TUPLENEST_BENCH_SOAK_SECS=1200 TUPLENEST_BENCH_SOAK_INTERVAL=30 TUPLENEST_BENCH_SOAK_CSV=soak-driver.csv \
  cargo test --release -p tuplenest-driver-postgres --test bench_pg bench_pg_soak \
  -- --ignored --nocapture --test-threads=1

# Idle app soak (section 9): 30 minutes, a sample every 30 s. HOME is a new
# temporary directory.
scripts/bench/soak.sh <path to tuplenest-desktop> 1800 30 soak-idle.csv

# The 8-hour versions, on a quiet machine:
scripts/bench/soak.sh <path to tuplenest-desktop> 28800 60 soak-idle-8h.csv
TUPLENEST_BENCH_PG=1 TUPLENEST_TEST_PG_USER=<pg user> \
TUPLENEST_BENCH_SOAK_SECS=28800 TUPLENEST_BENCH_SOAK_INTERVAL=60 TUPLENEST_BENCH_SOAK_CSV=soak-driver-8h.csv \
  cargo test --release -p tuplenest-driver-postgres --test bench_pg bench_pg_soak \
  -- --ignored --nocapture --test-threads=1

# UI marks in jsdom (section 7).
(cd apps/desktop && TUPLENEST_BENCH_UI=1 npx vitest run src/lib/perf.test.tsx)
```
