#!/usr/bin/env bash
# Runs every benchmark in docs/benchmarks/README.md and prints the results.
#
#   scripts/bench/run-all.sh [path/to/tuplenest-desktop]
#
# Environment:
#   TUPLENEST_TEST_PG_USER / _DB / _HOST / _PORT   PostgreSQL to use (db default: shop)
#   TUPLENEST_BENCH_SQLITE                          SQLite file (events table)
#   TUPLENEST_BENCH_RUNS                            repetitions per driver measurement (10)
#   STARTUP_RUNS / IDLE_SECONDS                     app launches (7) and idle wait (30)
#
# The app is always launched with HOME pointed at a fresh temporary
# directory, so it starts with an empty data folder and never reads or writes
# the real one. It is terminated at the end of each run.
set -euo pipefail

repo="$(cd "$(dirname "$0")/../.." && pwd)"
binary="${1:-$repo/target/release/bundle/macos/TupleNest.app/Contents/MacOS/tuplenest-desktop}"
export TUPLENEST_TEST_PG_DB="${TUPLENEST_TEST_PG_DB:-shop}"

work="$(mktemp -d -t tuplenest-bench)"
trap 'rm -rf "$work"' EXIT

echo "== environment"
echo "cpu:      $(sysctl -n machdep.cpu.brand_string), $(sysctl -n hw.ncpu) cores"
echo "memory:   $(($(sysctl -n hw.memsize) / 1024 / 1024 / 1024)) GB"
echo "macOS:    $(sw_vers -productVersion) ($(sw_vers -buildVersion))"
echo "commit:   $(git -C "$repo" rev-parse --short HEAD) (source); the app build shows its own in the status bar"
echo "load:     $(uptime | sed 's/.*load averages*: //')"
echo

if [[ -x "$binary" ]]; then
  echo "== startup and idle memory ($binary)"
  swiftc -O "$repo/scripts/bench/startup.swift" -o "$work/startup-probe"
  mkdir -p "$work/home"
  "$work/startup-probe" "$binary" "$work/home" "${STARTUP_RUNS:-7}" "${IDLE_SECONDS:-30}"
  echo "load:     $(uptime | sed 's/.*load averages*: //')"
  echo
else
  echo "== startup: skipped, no binary at $binary"
fi

echo "== PostgreSQL driver (database $TUPLENEST_TEST_PG_DB)"
(cd "$repo" && TUPLENEST_BENCH_PG=1 cargo test --release -q -p tuplenest-driver-postgres --test bench_pg \
  -- --ignored --nocapture --test-threads=1 2>&1 | grep -oE '(BENCH|INFO)[[:space:]].*|panicked.*|FAILED.*')
echo "load:     $(uptime | sed 's/.*load averages*: //')"
echo

if [[ -n "${TUPLENEST_BENCH_SQLITE:-}" ]]; then
  echo "== SQLite driver ($(basename "$TUPLENEST_BENCH_SQLITE"))"
  (cd "$repo" && cargo test --release -q -p tuplenest-driver-sqlite --test bench_sqlite \
    -- --ignored --nocapture --test-threads=1 2>&1 | grep -oE '(BENCH|INFO)[[:space:]].*|panicked.*|FAILED.*')
  echo "load:     $(uptime | sed 's/.*load averages*: //')"
else
  echo "== SQLite: skipped, TUPLENEST_BENCH_SQLITE is not set"
fi
