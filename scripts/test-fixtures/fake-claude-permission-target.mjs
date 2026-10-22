#!/usr/bin/env node
// Disposable fake Claude CLI used by test-claude-permission-mode-relay.mjs
// (via fake-claude-launcher.sh, copied/renamed to "claude.com" at test
// setup time) to prove through the REAL public relay path
// (`node scripts/autopilot.mjs run`) that:
//   - write roles (planner, implementer) are launched with exactly
//     `--permission-mode acceptEdits`;
//   - read-only roles (plan_reviewer, code_reviewer, verifier) are launched
//     with exactly `--permission-mode plan`.
//
// NOTE: this file is executed as `claude.com` (unknown extension ->
// CommonJS), so it must stay dependency-free CommonJS: no import syntax.
//
// The fake REFUSES (non-zero exit, like a real permission denial) any
// invocation where the observed --permission-mode does not match the role
// derived from the plain-text stdin prompt (first line `ROLE=<role>`).
// A passing mission is therefore a live behavioral proof that the production
// manifest (`adapters/agents.json` claude.write / claude.read_only) plus the
// relay delivers the correct least-privilege mode per role — the exact
// failure this guards against is the real Native Windows incident where the
// Planner arrived with NO permission mode at all, exited 0, and produced no
// SpecKit artifacts because Write was never granted.
//
// Observations are exfiltrated two ways (both best-effort, neither affects
// the exit code on success):
//   - reviewers embed an argv report inside their AUTOPILOT_REVIEW findings
//     (read-only roles cannot write to the repository);
//   - every role appends a JSON line to a permission-mode observations file,
//     trying the repository scratch area first and the envelope scratch mount
//     (/workspace/scratch) second.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);

function fail(reason) {
  process.stderr.write("fake-claude-permission: REFUSED: " + reason + "\n");
  process.exit(1);
}

if (args.includes("--version")) {
  process.stdout.write("fake-claude-permission 1.0.0\n");
  process.exit(0);
}

// Any other probe without a relay invocation (e.g. `auth status`) is not a
// mission call: exit non-zero without diagnostics.
if (!args.includes("-p")) {
  process.exit(1);
}

const WRITE_ROLES = new Set(["planner", "implementer"]);
const READ_ROLES = new Set(["plan_reviewer", "code_reviewer", "verifier"]);

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { stdin += chunk; });
process.stdin.on("end", () => {
  const trimmed = stdin.trimStart();
  if (trimmed === "") fail("stdin was empty; expected the plain-text mission prompt");
  if (trimmed[0] === "{" || trimmed[0] === "[") fail("stdin looked JSON-encoded; expected plain text");
  const firstLine = trimmed.split(/\r?\n/, 1)[0];
  const roleMatch = /^ROLE=(\S+)/.exec(firstLine);
  if (!roleMatch) fail("stdin did not start with ROLE=; expected the plain-text mission prompt");
  const role = roleMatch[1];

  let expectedMode = null;
  if (WRITE_ROLES.has(role)) expectedMode = "acceptEdits";
  else if (READ_ROLES.has(role)) expectedMode = "plan";
  else fail("unknown role '" + role + "' (fail closed)");

  const observedModes = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--permission-mode") observedModes.push(args[i + 1]);
  }
  if (observedModes.length === 0) {
    fail("role '" + role + "' arrived with NO --permission-mode (expected exactly '" + expectedMode + "'); " +
      "this is the real 15.6A failure mode — argv: " + JSON.stringify(args));
  }
  if (observedModes.length !== 1) {
    fail("role '" + role + "' arrived with " + observedModes.length + " --permission-mode flags (duplicate/conflicting, fail closed)");
  }
  if (observedModes[0] !== expectedMode) {
    fail("role '" + role + "' arrived with --permission-mode '" + observedModes[0] + "' (expected exactly '" + expectedMode + "')");
  }
  for (const arg of args) {
    const lowered = String(arg).toLowerCase();
    if (lowered.includes("dangerously-skip-permissions") || lowered.includes("bypasspermissions") || lowered.includes("bypass-permissions")) {
      fail("role '" + role + "' arrived with a dangerous permission bypass flag: " + arg);
    }
  }

  const observation = {
    role,
    argv: args,
    permissionMode: observedModes[0],
    stdinFirstLine: firstLine,
    stdinLength: stdin.length
  };
  const line = JSON.stringify(observation) + "\n";
  // Repository scratch area (works for write roles running in the repo).
  try {
    fs.mkdirSync(path.join(process.cwd(), ".autopilot"), {recursive: true});
    fs.appendFileSync(path.join(process.cwd(), ".autopilot", "permission-mode-observations.jsonl"), line);
  } catch (e) { /* read-only cwd: fall through to scratch mount */ }
  // Envelope scratch mount (works for read-only roles inside bubblewrap).
  try {
    fs.appendFileSync("/workspace/scratch/permission-mode-observations.jsonl", line);
  } catch (e) { /* outside an envelope: nothing to do */ }

  if (role === "planner") {
    const planMatch = /^Write the (?:narrative )?plan to exactly: (.+)$/m.exec(stdin);
    const tasksMatch = /^Write the phased checklist to exactly: (.+)$/m.exec(stdin);
    const legacyMatch = !planMatch ? /^Write the plan to exactly: (.+)$/m.exec(stdin) : null;
    const planFile = planMatch ? planMatch[1].trim() : legacyMatch ? legacyMatch[1].trim() : null;
    if (planFile) {
      const tasksFile = tasksMatch ? tasksMatch[1].trim() : null;
      try { fs.mkdirSync(path.dirname(planFile), {recursive: true}); } catch (e) {}
      if (tasksFile) {
        try { fs.mkdirSync(path.dirname(tasksFile), {recursive: true}); } catch (e) {}
        try {
          fs.writeFileSync(planFile, "# Plan\n\nObjective: fixture task.\n");
          fs.writeFileSync(tasksFile, "## Phase 1: General\n\n- [ ] Do the fixture task — accept: done ; verify: none\n");
        } catch (error) { fail("planner could not write split files: " + (error && error.message ? error.message : error)); }
      } else if (planMatch) {
        try {
          fs.writeFileSync(planFile, "# Plan\n\nObjective: fixture task.\n");
          fs.writeFileSync(planFile.replace(/PLAN\.md$/, "TASKS.md"), "## Phase 1: General\n\n- [ ] Do the fixture task — accept: done ; verify: none\n");
        } catch (error) { fail("planner could not write split files: " + (error && error.message ? error.message : error)); }
      } else {
        try { fs.writeFileSync(planFile, "# Plan\n\nObjective: fixture task.\n\n- [ ] Do the fixture task\n\nVerification notes: none required.\n"); } catch (error) { fail("planner could not write the plan file '" + planFile + "': " + (error && error.message ? error.message : error)); }
      }
    }
    process.stdout.write("planner ok\n");
    process.exit(0);
  }

  if (role === "implementer") {
    // Per-task invocation requires exactly one task-result sentinel from the
    // implementer (backlog 003#43 / TASK-25); a bare "implementer ok" is
    // STRUCTURED_OUTPUT_MISSING and the adapter retry budget runs out before
    // any reviewer launches (this test failed that way since TASK-25).
    const taskResult = "AUTOPILOT_TASK_RESULT=" + JSON.stringify({
      summary: "fixture implementer: permission mode verified, no file changes needed",
      taskLocalCheck: {command: "true", status: "passed", exitCode: 0, summary: "fixture task done"}
    });
    process.stdout.write(JSON.stringify({type: "agent_message", text: taskResult}) + "\n");
    process.exit(0);
  }

  const reviewLine = "AUTOPILOT_REVIEW=" + JSON.stringify({decision: "PASS", findings: [JSON.stringify(observation)]});
  process.stdout.write(JSON.stringify({type: "agent_message", text: reviewLine}) + "\n");
  process.exit(0);
});
