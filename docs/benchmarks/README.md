# Benchmarks

Measurements of TupleNest 0.1.1 on one Mac, taken on 2026-11-27. They show
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
| SQLite | 3.54.1, the copy bundled into the app by `rusqlite` (the `sqlite3` CLI on the machine is 3.51.0; it was only used to inspect the file) |
| App version | 0.1.1 (`apps/desktop/src-tauri/tauri.conf.json`) |
| Source commit | `2029aab8ee66` (driver benchmarks were built from this commit) |
| App binary | a local release build (`target/release/bundle/macos/TupleNest.app`), bundle identifier `app.tuplenest.verify`, 22 MB executable. It was built from the main checkout before these measurements; the binary does not record its commit, so it is assumed, not verified, to match `2029aab`. |
| Rust profile | `release` from the workspace `Cargo.toml` (thin LTO, one codegen unit), the same profile the app is built with |

The machine was not idle. Other work (builds, a VM, test suites) was running
during the session; the 1-minute load average was 5.6 to 13.6 during the
recorded runs, on 12 cores. Earlier attempts at a load average of 45 to 70
gave driver timings 3 to 12 times slower with much wider ranges, and were
discarded. The recorded runs were started only once the load average dropped
below 6, and the load is printed before and after each section of the run.
Treat the maxima below as partly noise from that background load.

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

| What | Result | Notes |
| --- | --- | --- |
| Startup: launch to window on screen | median 305 ms (252 to 430), n=7 | second run: 317 ms (306 to 432) |
| Startup: launch to start-up work finished | median 1.34 s (1.08 to 1.79), n=7 | second run: 1.14 s (1.08 to 1.55); proxy, see below |
| Idle memory after 30 s, resident (sum of 4 processes) | 140 to 163 MB | includes shared system pages |
| Idle memory after 30 s, physical footprint (sum) | 119 to 129 MB | the figure Activity Monitor shows as "Memory" |
| PostgreSQL: 20,000 rows (`LIMIT 20000`), all read | median 12.5 ms (11.9 to 13.4), n=20 | first batch after 1.0 ms |
| PostgreSQL: `SELECT * FROM orders` until the 20,000-row cap | median 21.8 ms (20.3 to 40.8), n=20 | rows written to the app's result store |
| PostgreSQL: all 250,000 rows, no cap | median 151 ms (147 to 194), n=20 | reference only; the app caps at 20,000 |
| SQLite: 20,000 rows (`LIMIT 20000`), all read | median 4.1 ms (3.8 to 4.3), n=20 | first batch after 0.19 ms |
| SQLite: `SELECT * FROM events` until the 20,000-row cap | median 8.8 ms (7.9 to 19.9), n=20 | rows written to the app's result store |
| SQLite: all 50,000 rows, no cap | median 12.2 ms (10.5 to 17.4), n=20 | reference only |
| Schema discovery, `shop` (1 schema, 8 objects) | median 9.8 ms (6.2 to 10.8), n=20 | full walk, see below |
| Schema discovery, `analytics.sqlite` (1 table) | median 0.24 ms (0.16 to 0.42), n=20 | |
| PostgreSQL cancel of `pg_sleep(30)` | median 2.6 ms (1.6 to 114), n=20 | from `cancel()` call to the query returning |
| SQLite cancel of an endless query | median 0.03 ms (0.02 to 0.13), n=20 | |
| Large-result rendering in the UI | Not measured yet | see below |
| Long-running stability | Not measured yet | see below |

Numbers are from the second of two complete runs, taken a few minutes apart.
Where the first run differs in a way worth knowing, both are given.

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
before the next launch. 7 launches per run.

Second run (the one in the summary):

| Run | Window on screen (ms) | Start-up work finished (ms) | Resident at that point (MB) |
| --- | --- | --- | --- |
| 1 | 383 | 1785 | 211 |
| 2 | 270 | 1106 | 221 |
| 3 | 252 | 1343 | 205 |
| 4 | 288 | 1576 | 204 |
| 5 | 311 | 1083 | 213 |
| 6 | 430 | 1609 | 207 |
| 7 | 305 | 1121 | 210 |

The first launch of the whole session, with nothing in the file cache, took
1028 ms to the window. That single cold number is not repeatable without a
reboot and is not part of the medians.

On first launch the frontend calls the updater; the release endpoint did not
answer successfully from this build (its log has `update endpoint did not
respond with a successful status code`). That request is part of the
"start-up work" window when it completes inside it.

### 2. Idle memory

Measured on the last launch of each run, 30 s after start-up work finished,
with the first-run screen showing and no connection open. Per process, via
`proc_pid_rusage` (`ri_resident_size`, `ri_phys_footprint`):

| Process | Resident (MB) run 1 / run 2 | Footprint (MB) run 1 / run 2 |
| --- | --- | --- |
| `tuplenest-desktop` (Rust + Tauri) | 82.2 / 84.1 | 28.9 / 29.0 |
| `com.apple.WebKit.WebContent` | 31.8 / 45.8 | 73.2 / 71.8 |
| `com.apple.WebKit.GPU` | 18.7 / 25.3 | 20.4 / 11.7 |
| `com.apple.WebKit.Networking` | 7.5 / 8.0 | 6.5 / 6.4 |
| **Total** | **140.2 / 163.2** | **129.1 / 118.9** |

Resident size counts shared framework pages in every process, so the sum
overstates what the app costs the system. Physical footprint is the private
memory macOS charges to each process (including compressed and GPU memory,
which is why it can exceed resident size for the WebKit processes). The
WebKit processes are identified as WebKit XPC processes that appeared after
the app launched; another app starting a WebView in the same window would be
counted wrongly. In both recorded runs the idle report lists exactly one
GPU, one Networking and one WebContent process.

Memory is higher during start-up (about 205 to 221 MB resident in total at
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

Three cases per engine, each repeated 20 times after one warm-up:

1. `SELECT * FROM <table> LIMIT 20000`, no row limit, rows decoded and
   counted but not kept. "First batch" is the time until the first batch of
   rows reached the sink.
2. `SELECT * FROM <table>` with `row_limit` 20,000, the app's path. Each row
   is written as a JSON array and pushed into a
   `tuplenest_result_stream::RowStore` built with the app's caps. Measured
   until `execute` returns with `more_rows = true`. The row writer is a copy
   of the app's for the column types in these tables, not the app's own
   function (that lives in the app crate). The store held 1.2 MB of row text
   (0.4 MB compressed) for `orders` and 0.9 MB (0.2 MB compressed) for
   `events`.
3. The whole table with no row limit, decoded and counted. Not something the
   app does with a plain read; it is here to show the per-row cost at scale.

| Case | PostgreSQL `orders` | SQLite `events` |
| --- | --- | --- |
| Connect / open | 2.4 ms (2.2 to 3.8) | 0.10 ms (0.10 to 0.13) |
| 1. 20,000 rows, decode only: total | 12.5 ms (11.9 to 13.4) | 4.1 ms (3.8 to 4.3) |
| 1. 20,000 rows, decode only: first batch | 1.0 ms (0.8 to 1.5) | 0.19 ms (0.18 to 0.22) |
| 2. Until the 20,000-row cap, stored | 21.8 ms (20.3 to 40.8) | 8.8 ms (7.9 to 19.9) |
| 3. Whole table, no cap, decode only | 151 ms (147 to 194), 250,000 rows | 12.2 ms (10.5 to 17.4), 50,000 rows |

Median (min to max), n=20. What these numbers leave out, all of which a user
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

| | Median | Range | n |
| --- | --- | --- | --- |
| `shop`: full walk (1 schema, 8 objects, 12 requests) | 9.8 ms | 6.2 to 10.8 | 20 |
| `shop`: `ListObjects` on `public` | 0.27 ms | 0.23 to 0.36 | 20 |
| `shop`: `DescribeObject` on `public.orders` | 0.92 ms | 0.75 to 3.28 | 20 |
| `analytics.sqlite`: full walk (1 schema, 1 table) | 0.24 ms | 0.16 to 0.42 | 20 |

`shop` is a small schema. These numbers say nothing about a database with
thousands of tables or partitions; that has not been measured.

### 5. Query cancellation

Time from calling the session's cancel handle to `execute` returning a
`Cancelled` error. The statement is started, the cancel is sent 500 ms
later, so the statement is running on the server when it arrives.

| | Median | Range | n |
| --- | --- | --- | --- |
| PostgreSQL, `SELECT pg_sleep(30)` | 2.6 ms | 1.6 to 114 | 20 |
| SQLite, endless recursive CTE (`WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c`) | 0.03 ms | 0.02 to 0.13 | 20 |

For PostgreSQL, the cancel opens a separate connection and sends a cancel
request; the server then interrupts the backend. Over TCP to localhost this
is a few milliseconds. One run in each of the two complete runs took more
than 10 ms (114 ms and 11.7 ms); this was not investigated further, and the
background load is a likely cause. Over a real network, add at least one
connection setup to the server.

For SQLite, cancel calls `sqlite3_interrupt`, which the running statement
checks between steps of the virtual machine.

### Not measured yet

- **Large-result rendering in the UI.** Time from pressing Run to the first
  rows painted in the grid, and scrolling through 20,000 rows. This needs a
  way to drive the UI and observe paints (WebDriver for the Tauri WebView, or
  timing marks added to the frontend). Neither is set up, and the
  measurement process could not capture the screen, so any number would be a
  guess.
- **Long-running stability.** Memory and responsiveness over hours of use
  with repeated queries. This needs a scripted workload that drives the app
  for a long time, which needs the same UI automation. A one-hour idle run
  could be done with the startup probe, but idle is not where problems would
  show, so it was not reported.
- **Startup with existing data.** Every launch here started with an empty
  data folder. A data folder with many profiles, a long history and a large
  metadata cache was not measured.
- **Remote servers, TLS, SSH tunnels.** All PostgreSQL numbers are over
  plain TCP on the same machine.

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
TUPLENEST_BENCH_RUNS=20 \
  scripts/bench/run-all.sh <repo>/target/release/bundle/macos/TupleNest.app/Contents/MacOS/tuplenest-desktop
```

Or each part on its own:

```sh
# Startup and idle memory: <runs> launches, idle <seconds> on the last one.
swiftc -O scripts/bench/startup.swift -o /tmp/startup-probe
mkdir -p /tmp/tn-bench-home
/tmp/startup-probe <path to tuplenest-desktop> /tmp/tn-bench-home 7 30

# PostgreSQL driver: connect, streaming, schema discovery, cancel.
TUPLENEST_TEST_PG_USER=<pg user> TUPLENEST_TEST_PG_DB=shop TUPLENEST_BENCH_RUNS=20 \
  cargo test --release -p tuplenest-driver-postgres --test bench_pg \
  -- --ignored --nocapture --test-threads=1

# SQLite driver: open, streaming, schema discovery, cancel.
TUPLENEST_BENCH_SQLITE=<path>/analytics.sqlite TUPLENEST_BENCH_RUNS=20 \
  cargo test --release -p tuplenest-driver-sqlite --test bench_sqlite \
  -- --ignored --nocapture --test-threads=1
```

The PostgreSQL connection uses the same `TUPLENEST_TEST_PG_HOST`, `_PORT`,
`_USER` and `_DB` variables as the live tests in
`crates/driver-postgres/tests/live_pg.rs`, with no password (local trust
authentication) and TLS off. The benchmarks connect read-only and do not
write to either database. They are `#[ignore]`d, so a plain `cargo test`
does not run them.

Check the load average (`uptime`) before running; on a busy machine the
driver numbers in particular move a lot.

The files:

- `scripts/bench/run-all.sh`: runs everything and prints the environment
  and load average with the results.
- `scripts/bench/startup.swift`: the startup and idle-memory probe.
- `crates/driver-postgres/tests/bench_pg.rs`: PostgreSQL driver timings.
- `crates/driver-sqlite/tests/bench_sqlite.rs`: SQLite driver timings.
