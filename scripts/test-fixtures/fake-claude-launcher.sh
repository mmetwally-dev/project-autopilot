#!/bin/sh
# Disposable fake `claude` launcher used by test-claude-stdin-contract.mjs.
#
# scripts/adapter-drivers.mjs's resolveClaudeBinary() treats any shebang
# script named "claude" as a possible npm-generated launcher shim and
# chases it to its real target via a quoted claude-executable path regex,
# so it can correctly classify the ultimate binary (native vs Windows PE)
# instead of the shim itself. The quoted reference below is what that
# regex matches; the real fake-CLI behavior lives in claude.com, next to
# this file.
# real target: "claude.com"
set -eu
exec "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/claude.com" "$@"
