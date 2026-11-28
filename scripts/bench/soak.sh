#!/usr/bin/env bash
# Idle soak: launches the app once with an isolated HOME and samples its memory
# and open file handles until the duration is up. See docs/benchmarks/README.md.
#
#   scripts/bench/soak.sh <path/to/tuplenest-desktop> [duration-s] [interval-s] [out.csv]
#
# Defaults: 1800 s (30 minutes), a sample every 30 s, soak-<timestamp>.csv in
# the current directory. For the long run, on a quiet machine:
#
#   scripts/bench/soak.sh <binary> 28800 60 soak-8h.csv
#
# HOME points at a new temporary directory, so the app starts with an empty
# data folder and never reads or writes the real one. It is removed at the end.
set -euo pipefail

repo="$(cd "$(dirname "$0")/../.." && pwd)"
binary="${1:?usage: soak.sh <binary> [duration-s] [interval-s] [out.csv]}"
duration="${2:-1800}"
interval="${3:-30}"
out="${4:-soak-$(date +%Y%m%d-%H%M%S).csv}"

work="$(mktemp -d -t tuplenest-soak)"
trap 'rm -rf "$work"' EXIT

echo "load before: $(uptime | sed 's/.*load averages*: //')" >&2
swiftc -O "$repo/scripts/bench/soak.swift" -o "$work/soak-probe"
"$work/soak-probe" "$binary" "$work/home" "$duration" "$interval" "$out"
echo "load after:  $(uptime | sed 's/.*load averages*: //')" >&2
echo "wrote $out" >&2
