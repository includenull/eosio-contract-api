#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SIDECAR="${REAL_SIDECAR:-$ROOT/native/ship-sidecar/build/ship-sidecar}"
PROFILER="${PROFILER_LIB:-/usr/lib/x86_64-linux-gnu/libprofiler.so}"

if [[ ! -x "$SIDECAR" ]]; then
  echo "ship-sidecar-profile: binary not found at $SIDECAR" >&2
  exit 1
fi

if [[ ! -f "$PROFILER" ]]; then
  echo "ship-sidecar-profile: install google-perftools (libprofiler.so)" >&2
  exit 1
fi

export CPUPROFILE="${SHIP_SIDECAR_PROFILE:-/tmp/ship-sidecar-latest.prof}"
echo "ship-sidecar-profile: writing CPU profile to $CPUPROFILE" >&2
exec env LD_PRELOAD="$PROFILER" "$SIDECAR" "$@"
