#!/bin/sh
# Fake adapter CLI for testing stdin EPIPE/error handling in the relay.
# Behavior: immediately closes/destins stdin (no read), writes to stderr,
# and exits 0 — simulating an adapter that crashes before consuming input.
set -eu

if [ "${1:-}" = "--version" ]; then
  echo "fake-stdin-error-adapter 1.0.0"
  exit 0
fi

# Destroy stdin immediately — the orchestrator's write will hit EPIPE.
exec 0<&-

# Diagnostic stderr so the relay can capture it.
printf 'adapter-stderr: stdin closed before input\n' >&2

exit 0
