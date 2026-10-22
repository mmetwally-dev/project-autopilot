#!/usr/bin/env node
// TASK-backlog-#28 test fixture: disposable fake Claude CLI that, for the
// REFUSE_ROLE baked in at copy time, emits a failing linked
// command_execution event before its PASS verdict, so the orchestrator's
// PASS-refusal path runs. Once-mode refuses only while the implementer's
// attempt-counter file (.autopilot-test-attempt, written by the cursor
// fixture adapter) still shows "1" — after the implementer-retry relaunch
// it increments to "2" and later roles see a clean PASS. Forever-mode
// always refuses. All other roles emit a plain PASS verdict.
// NOTE: copied to "claude.com" (resolution may treat it as CommonJS), so
// it must not use ESM import syntax.
"use strict";
const fs = require("node:fs");
const args = process.argv.slice(2);

const REFUSE_ROLE = %REFUSE_ROLE%;
const REFUSE_FOREVER = %REFUSE_FOREVER%;
const LINKED_COMMAND = %LINKED_COMMAND%;

function fail(reason) {
  process.stderr.write("fake-claude-refusal: " + reason + "\n");
  process.exit(1);
}

if (args.includes("--version")) {
  process.stdout.write("fake-claude-refusal 1.0.0\n");
  process.exit(0);
}

function attemptCount() {
  try {
    return fs.readFileSync(path_module.join(cwd, ".autopilot-test-attempt"), "utf8").trim();
  } catch { return ""; }
}

const path_module = require("node:path");
const cwd = process.cwd();

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { stdin += chunk; });
process.stdin.on("end", () => {
  const trimmed = stdin.trimStart();
  if (!trimmed.startsWith("ROLE=")) fail("stdin did not start with ROLE=");
  const role = trimmed.split(/\r?\n/, 1)[0].slice("ROLE=".length).trim();
  let shouldRefuse = role === REFUSE_ROLE;
  if (shouldRefuse && !REFUSE_FOREVER) shouldRefuse = attemptCount() === "1";
  if (shouldRefuse) {
    process.stdout.write(JSON.stringify({type: "item.completed", item: {type: "command_execution", command: LINKED_COMMAND, status: "completed", exit_code: 1}}) + "\n");
  }
  process.stdout.write(JSON.stringify({type: "agent_message", text: "AUTOPILOT_REVIEW=" + JSON.stringify({decision: "PASS", findings: []})}) + "\n");
  process.exit(0);
});
