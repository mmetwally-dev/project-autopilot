#!/bin/sh
# TASK-27 follow-up (003#8): POSIX-only opencode-wire fake for read-only
# roles (code_reviewer/verifier) in the live-totals tests.
#
# Why a separate POSIX file: on WSL/Linux a read-only role runs inside a
# real bubblewrap sandbox where only this one adapter file is bind-mounted
# in (execution-envelope.mjs's "externalBinary" path) — no Node.js runtime
# is reachable there, so the Node fixture (fake-cap-breach-adapter.mjs)
# can never exec inside it (same constraint as fake-workflow-adapter.sh;
# see its header). This file is therefore deliberately a single,
# self-contained POSIX shell script with no sibling dependencies.
# WSL2-only by construction; the tests SKIP it on win32.
#
# Behavior: two slow usage waves (3 step_finish turns, a 12s pause past the
# 10s persist floor, 3 more turns) then a review PASS verdict — the reviewer
# twin of fake-cap-breach-adapter.mjs's `live_usage` scenario. The prompt
# arrives on stdin (opencode uses structured sentinel transport, so the
# relay writes stdin); it is consumed and ignored, exactly like
# fake-workflow-adapter.sh does.
if [ "$1" = "--version" ]; then
  echo "fake-opencode-review 1.0.0"
  exit 0
fi
# Answer help probes instantly (1.x-style help naming --variant) so generation
# detection never falls through to running a scenario for `run --help`.
if [ "$1" = "--help" ] || { [ "$1" = "run" ] && [ "$2" = "--help" ]; }; then
  printf '%s\n' 'Usage: opencode [command]' '  run [message..]' '    -m, --model <model>' '    --variant <level>' '    --agent <agent>'
  exit 0
fi
if [ "$1" = "models" ]; then
  echo "opencode/fake-cap-model"
  exit 0
fi
PROMPT=$(cat)
step_finish() {
  printf '{"type":"step_finish","part":{"type":"step-finish","tokens":{"input":10,"output":5,"reasoning":0,"cache":{"read":0,"write":0}}}}\n'
}
printf '{"type":"step_start","part":{"type":"step-start"}}\n'
step_finish
step_finish
step_finish
sleep 12
step_finish
step_finish
step_finish
printf 'AUTOPILOT_REVIEW={"decision":"PASS","findings":[]}\n'
exit 0
