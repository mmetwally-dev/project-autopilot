#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

let ok = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); ok += 1; return; }
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${detail}` : ""}`);
  failed += 1;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const autopilotSource = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");

// Extract the rawRelayTaskText array construction from runRelay in autopilot.mjs
const rawRelayMatch = autopilotSource.match(/const rawRelayTaskText\s*=\s*(\[[\s\S]*?\])\.filter\(Boolean\)\.join\("\\n"\);/);
if (!rawRelayMatch) {
  console.error("FAIL: could not locate rawRelayTaskText array in scripts/autopilot.mjs");
  process.exit(1);
}

const FEW_TURNS_LINE = "Work in few turns: issue independent reads and searches as parallel tool calls in one response, or combine them in one command (e.g. sed -n 'a,bp;c,dp' file, grep -n -e A -e B file1 file2). When revising after a review, open the cited file:line locations first and make those edits before any wider exploration.";

// Build brief evaluator from autopilot.mjs source
const evaluateBrief = new Function(
  "roleName", "promptRepository", "mission", "role", "readOnly", "promptScratch", "disposableWorkspace", "relayTask", "review",
  `return (${rawRelayMatch[1]}).filter(Boolean).join("\\n");`
);

function buildBrief({
  roleName = "planner",
  role = {adapter: "antigravity"},
  readOnly = false,
  mission = "test-mission",
  promptRepository = "/workspace/repository",
  promptScratch = "/workspace/scratch",
  disposableWorkspace = false,
  relayTask = "task details",
  review = false
} = {}) {
  return evaluateBrief(roleName, promptRepository, mission, role, readOnly, promptScratch, disposableWorkspace, relayTask, review);
}

// Common brief assertions: verify baseline delegated worker & foreground instructions
const baseBrief = buildBrief({roleName: "planner", role: {adapter: "antigravity"}, readOnly: false});
check("brief contains 'You are a delegated worker'", baseBrief.includes("You are a delegated worker"));
check("brief contains 'Run every command in the foreground'", baseBrief.includes("Run every command in the foreground"));

// ── 1. Antigravity write roles: planner and implementer carry the few-turns line ──
const agyPlannerBrief = buildBrief({roleName: "planner", role: {adapter: "antigravity"}, readOnly: false});
check("antigravity planner brief contains few-turns instruction",
  agyPlannerBrief.includes(FEW_TURNS_LINE),
  agyPlannerBrief
);

const agyImplementerBrief = buildBrief({roleName: "implementer", role: {adapter: "antigravity"}, readOnly: false});
check("antigravity implementer brief contains few-turns instruction",
  agyImplementerBrief.includes(FEW_TURNS_LINE),
  agyImplementerBrief
);

// ── 2. Other adapters write roles do NOT carry the few-turns line ──
for (const adapter of ["claude", "opencode", "codex"]) {
  const plannerBrief = buildBrief({roleName: "planner", role: {adapter}, readOnly: false});
  check(`${adapter} planner brief does NOT contain few-turns instruction`,
    !plannerBrief.includes(FEW_TURNS_LINE),
    plannerBrief
  );

  const implementerBrief = buildBrief({roleName: "implementer", role: {adapter}, readOnly: false});
  check(`${adapter} implementer brief does NOT contain few-turns instruction`,
    !implementerBrief.includes(FEW_TURNS_LINE),
    implementerBrief
  );
}

// ── 3. Antigravity read-only roles do NOT carry the few-turns line ──
for (const roleName of ["plan_reviewer", "code_reviewer", "verifier"]) {
  const readOnlyBrief = buildBrief({roleName, role: {adapter: "antigravity"}, readOnly: true, review: true});
  check(`antigravity read-only ${roleName} brief does NOT contain few-turns instruction`,
    !readOnlyBrief.includes(FEW_TURNS_LINE),
    readOnlyBrief
  );
}

if (failed > 0) {
  console.error(`FAILED: ${failed} check(s) failed`);
  process.exit(1);
}
console.log(`ALL CHECKS PASSED (${ok}/${ok})`);
