#!/bin/sh
# Real-relay behavioral probe adapter (cursor) used by
# test-relay-scratch-containment.mjs. Runs INSIDE the actual read-only
# bubblewrap envelope that the production relay launch builds. A single
# self-contained POSIX script is mounted into the sandbox (the envelope's
# externalBinary path); node resolves from /usr/bin (system-mounted).
#
# Behavior is driven by a committed .autopilot-test-scenario file:
#   "benign"    - scratch write succeeds, verifier reports PASS, no git
#                 mutation attempt (the relay must record NO violation).
#   "malicious" - additionally attempts a git commit (must be blocked by
#                 the guard, whose log lands in scratch) and probes the
#                 real central run dir (must be denied EROFS/EACCES).
set -eu

if [ "${1:-}" = "--version" ]; then
  echo "fake-relay-probe-agent 1.0.0"
  exit 0
fi

PROMPT="$(cat)"
ROLE=$(printf '%s\n' "$PROMPT" | sed -n '1s/^ROLE=//p')
SCENARIO="benign"
if [ -f "./.autopilot-test-scenario" ]; then
  SCENARIO="$(cat "./.autopilot-test-scenario")"
fi

if [ "$ROLE" = "planner" ]; then
  PLAN_FILE=$(printf '%s\n' "$PROMPT" | sed -n 's/^Write the narrative plan to exactly: //p' | head -n 1)
  if [ -z "$PLAN_FILE" ]; then PLAN_FILE=$(printf '%s\n' "$PROMPT" | sed -n 's/^Write the plan to exactly: //p' | head -n 1); fi
  TASKS_FILE=$(printf '%s\n' "$PROMPT" | sed -n 's/^Write the phased checklist to exactly: //p' | head -n 1)
  if [ -n "$PLAN_FILE" ]; then
    mkdir -p "$(dirname "$PLAN_FILE")"
    if [ -n "$TASKS_FILE" ]; then
      mkdir -p "$(dirname "$TASKS_FILE")"
      printf '# Plan\n\nObjective: fixture task.\n' > "$PLAN_FILE"
      printf '## Phase 1: General\n\n- [ ] Do the fixture task — accept: done ; verify: none\n' > "$TASKS_FILE"
    else
      printf '# Plan\n\nObjective: fixture task.\n\n- [ ] Do the fixture task\n\nVerification notes: none required.\n' > "$PLAN_FILE"
    fi
  fi
  echo "planner ok"
elif [ "$ROLE" = "implementer" ]; then
  ATTEMPT_FILE="./.autopilot-test-attempt"
  ATTEMPT=0
  if [ -f "$ATTEMPT_FILE" ]; then ATTEMPT="$(cat "$ATTEMPT_FILE")"; fi
  ATTEMPT=$((ATTEMPT + 1))
  printf '%s' "$ATTEMPT" > "$ATTEMPT_FILE"
  echo "implementer ok"
  # TASK-19 Phase 4 (task 12): a per-task Implementer invocation must end with
  # the AUTOPILOT_TASK_RESULT sentinel (scripts/task-result-contract.mjs) as the
  # final non-empty line, or the loop escalates with STRUCTURED_OUTPUT_MISSING
  # and never reaches the Verifier this fixture exists to probe.
  printf 'AUTOPILOT_TASK_RESULT={"summary":"implementer ok","taskLocalCheck":{"command":"true","status":"passed","exitCode":0,"summary":"fixture"}}\n'
elif [ "$ROLE" = "verifier" ]; then
  # /tmp and /run are remounted read-only inside the envelope; only the
  # writable scratch mount (/workspace/scratch) accepts probe files.
  NODE_PROBE=/workspace/scratch/relay-scratch-probe.cjs
  cat > "$NODE_PROBE" <<'NODE'
const fs = require("fs");
const path = require("path");
const results = {};
const scratchRoot = "/workspace/scratch";
const repoRoot = "/workspace/repository";
const scenario = process.env.RELAY_PROBE_SCENARIO || "benign";

function attemptFileWrite(file, label) {
  try {
    fs.writeFileSync(file, "tampered");
    results[label] = "SUCCEEDED";
  } catch (e) {
    results[label] = "DENIED:" + (e.code || e.message);
  }
}

// 1. scratch write must succeed
try {
  fs.mkdirSync(scratchRoot, { recursive: true });
  fs.writeFileSync(scratchRoot + "/artifact.txt", "ok");
  results.scratchWrite = "SUCCEEDED";
} catch (e) {
  results.scratchWrite = "DENIED:" + (e.code || e.message);
}

// 2. repository write must fail (read-only bind)
attemptFileWrite(repoRoot + "/probe.txt", "repoWrite");
results.repoContents = fs.readFileSync(repoRoot + "/tracked.txt", "utf8");

// 3. REAL central run path: the run dir is
//    .autopilot/missions/<mission>/runs/<role>-<id>/ and is bind-mounted
//    read-only (it exists on the host under the repo). Attempt to modify
//    the existing brief.txt there. The denial must be EROFS/EACCES (the
//    path exists), never ENOENT.
try {
  const missionsRoot = path.join(repoRoot, ".autopilot", "missions");
  let runDir = null;
  if (fs.existsSync(missionsRoot)) {
    for (const mission of fs.readdirSync(missionsRoot)) {
      const runsRoot = path.join(missionsRoot, mission, "runs");
      if (!fs.existsSync(runsRoot)) continue;
      for (const run of fs.readdirSync(runsRoot)) {
        const candidate = path.join(runsRoot, run);
        if (fs.existsSync(path.join(candidate, "brief.txt"))) {
          if (!runDir || candidate > runDir) runDir = candidate;
        }
      }
    }
  }
  if (runDir) {
    results.centralRunPath = runDir.replace(repoRoot, "");
    attemptFileWrite(path.join(runDir, "brief.txt"), "centralRunWrite");
    results.centralBriefReadable = fs.readFileSync(path.join(runDir, "brief.txt"), "utf8").length > 0;
  } else {
    results.centralRunWrite = "NOT_FOUND";
  }
} catch (e) {
  results.centralRunWrite = "ERROR:" + (e.code || e.message);
}

// 4. malicious only: git commit must be blocked by the guard (exit 97).
if (scenario === "malicious") {
  const { execFileSync } = require("child_process");
  try {
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "blocked"], { stdio: "pipe" });
    results.gitCommit = "SUCCEEDED";
  } catch (e) {
    results.gitCommit = e.status === 97 ? "BLOCKED:guard" : ("FAILED:" + e.status);
  }
}

console.log("AUTOPILOT_REVIEW=" + JSON.stringify({ decision: "PASS", findings: [JSON.stringify(results)] }));
NODE
  RELAY_PROBE_SCENARIO="$SCENARIO" node "$NODE_PROBE"
else
  printf 'AUTOPILOT_REVIEW={"decision":"PASS","findings":[]}\n'
fi
exit 0