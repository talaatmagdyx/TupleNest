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
| Large-result rendering in the UI | Not measured yet | | | |
| Long-running stability | Not measured yet | | | |

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
write to either database. They are `#[ignore]`d, so a plain `cargo test`
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
- `crates/driver-postgres/tests/bench_pg.rs`: PostgreSQL driver timings.
- `crates/driver-sqlite/tests/bench_sqlite.rs`: SQLite driver timings.
