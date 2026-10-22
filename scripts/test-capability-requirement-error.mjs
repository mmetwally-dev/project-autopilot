#!/usr/bin/env node
// F6 — a planner-authored capability annotation must never kill a mission with
// an unclassified stack trace.
//
// The verified chain, all in production code:
//   1. adapters/standalone.mjs (and speckit.mjs) parse
//      `<!-- autopilot-requires: … -->` out of the planner's task line
//      VERBATIM into `task.requiredCapabilities` — no contract check;
//   2. autopilot.mjs hands those tokens to runRelay as `requirements`, and the
//      verifier's buildRoleRequirements() normalizes them;
//   3. before the fix, normalizeRequirement threw a BARE Error which left
//      runRelay uncaught: mission 004 died with
//      `ERROR: Error: Unknown capability requirement 'read'.` plus a stack
//      trace, with no die() message and no state.step
//      (evidence: .autopilot/mission-004-report/run-C.log).
//
// After the fix the same input fails CLOSED with a named class, a state.step,
// a classified INTERNAL_CONTRACT_ERROR/orchestrator failure and the offending
// task text. The e2e case is the mission shape that actually died: a task line
// carrying the bad annotation, resumed at the implementation stage, so the
// verifier relay is the first thing that normalizes the token.
import fs from "node:fs";
import path from "node:path";
import {CapabilityRequirementError} from "./capability-contract.mjs";
import {buildRoleRequirements, parseInlineRequirements, requirementFailure} from "./role-requirements.mjs";
import * as standalone from "../adapters/standalone.mjs";
import {
  makeFixtureRepo, makeFixtureBin, writeConfig, runAutopilot, cleanup
} from "./test-fixtures/workflow-order-harness.mjs";

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); return; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

// The annotation exactly as mission 004's planner wrote it — note the semicolons,
// which splitRequirements does NOT treat as separators, so the tokens include
// `scripts/doctor.mjs;`.
const BAD_ANNOTATION = "<!-- autopilot-requires: read scripts/doctor.mjs; read package.json -->";
const TASK_TEXT = `1. Read the version field and print a banner ${BAD_ANNOTATION}`;
const EXPECTED_TOKENS = ["read", "scripts/doctor.mjs;", "package.json"];

const created = [];
function track(x) { created.push(x); return x; }

try {
  // ---- 1. the parser takes the tokens verbatim, unvalidated ---------------
  const parsed = parseInlineRequirements(TASK_TEXT);
  check("parse: the planner's annotation yields the raw tokens",
    EXPECTED_TOKENS.every(token => parsed.includes(token)) && parsed.includes("read"), parsed);
  check("parse: an unknown token is NOT rejected at parse time (that is the gap)",
    parsed.includes("read") && !parsed.includes("commands.execute"), parsed);

  const repo = track(makeFixtureRepo("f6-parse"));
  const mission = "001-f6-annotation";
  const dir = path.join(repo, ".autopilot", "missions", mission);
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, "TASKS.md"), `## Phase 1: Implementation\n\n- [ ] ${TASK_TEXT}\n`);
  const tasks = standalone.tasks(repo, mission);
  check("parse: the real standalone adapter carries those tokens into the task",
    tasks.length === 1 && EXPECTED_TOKENS.every(token => (tasks[0].requiredCapabilities || []).includes(token)),
    tasks[0]?.requiredCapabilities);
  check("parse: the annotation is stripped from the task text",
    !!tasks[0] && !tasks[0].text.includes("autopilot-requires"), tasks[0]?.text);

  // ---- 2. normalization raises a NAMED error carrying the token -----------
  const config = {capabilities: {}};
  let thrown = null;
  try {
    buildRoleRequirements({config, roleName: "verifier", explicit: tasks[0].requiredCapabilities});
  } catch (err) { thrown = err; }
  check("contract: an unknown token throws the named CapabilityRequirementError",
    thrown instanceof CapabilityRequirementError, {name: thrown?.name, message: thrown?.message});
  check("contract: the error carries the offending token for the operator",
    thrown?.token === "read" && thrown?.message === "Unknown capability requirement 'read'.", thrown?.token);
  check("contract: it is no longer a bare Error (the old escape)",
    thrown?.name !== "Error" && typeof thrown?.token === "string", {name: thrown?.name});

  // valid tokens must still pass — no over-correction
  let validThrown = null;
  try {
    buildRoleRequirements({config, roleName: "verifier", explicit: ["commands.execute", "repository.read"]});
  } catch (err) { validThrown = err; }
  check("contract: valid tokens still normalize cleanly", validThrown === null, validThrown?.message);

  // a weakening token is the same named family (config-validation relies on it)
  let weaken = null;
  try {
    buildRoleRequirements({config, roleName: "verifier", explicit: ["isolation.repositoryReadOnly=false"]});
  } catch (err) { weaken = err; }
  check("contract: a weakening requirement is the same named class, message preserved",
    weaken instanceof CapabilityRequirementError && /cannot weaken/.test(weaken.message), weaken?.message);

  // ---- 3. the classification the orchestrator acts on ---------------------
  const classed = requirementFailure(thrown, {roleName: "verifier", taskText: TASK_TEXT});
  check("classify: a contract violation becomes a named step",
    classed?.step === "capability_requirement_invalid", classed?.step);
  check("classify: it is classified non-retryable INTERNAL_CONTRACT_ERROR/orchestrator",
    classed?.failure?.class === "INTERNAL_CONTRACT_ERROR" && classed?.failure?.domain === "orchestrator"
    && classed?.failure?.retryable === false, classed?.failure);
  check("classify: the message names the token, the role and the offending task text",
    classed?.message.includes("'read'") && classed?.message.includes("verifier")
    && classed?.message.includes(BAD_ANNOTATION), classed?.message);
  check("classify: an unrelated error is NOT masked (returns null, caller rethrows)",
    requirementFailure(new TypeError("boom"), {roleName: "verifier"}) === null);

  // ---- 4. end to end: a resumed mission at the verifier relay -------------
  {
    const e2eRepo = track(makeFixtureRepo("f6-e2e"));
    const binDir = track(makeFixtureBin("f6-e2e"));
    writeConfig(e2eRepo, {planningFramework: "standalone"});
    const e2eMission = "001-f6-annotation";
    const e2eDir = path.join(e2eRepo, ".autopilot", "missions", e2eMission);
    fs.mkdirSync(e2eDir, {recursive: true});
    fs.writeFileSync(path.join(e2eDir, "PLAN.md"), "# Plan\n\nFixture plan.\n");
    fs.writeFileSync(path.join(e2eDir, "TASKS.md"), `## Phase 1: Implementation\n\n- [ ] ${TASK_TEXT}\n`);
    // Seeded PRE-implementation (tasks_ready, review passed) exactly like the
    // other implementation-stage fixtures: the migration/baseline guard refuses
    // to invent a baseline for a state that already claims to be implementing,
    // and this way the mission transitions into the phase itself and reaches the
    // verifier relay — the first thing that normalizes the task's tokens.
    fs.writeFileSync(path.join(e2eRepo, ".autopilot", "state.json"), JSON.stringify({
      version: 1, mission: e2eMission, missionSeq: "001", phase: "tasks_ready", step: "tasks_ready",
      phaseIndex: 0, attempt: 1,
      planningStateReview: {status: "passed", framework: "standalone", phase: null, at: new Date().toISOString()}
    }, null, 2));

    const run = runAutopilot(e2eRepo, binDir, {request: "", timeoutMs: 180000});
    const out = `${run.stdout || ""}${run.stderr || ""}`;
    const state = JSON.parse(fs.readFileSync(path.join(e2eRepo, ".autopilot", "state.json"), "utf8"));

    check("e2e: the mission fails closed with the named step, not a raw throw",
      state.phase === "escalated" && state.step === "capability_requirement_invalid",
      {phase: state.phase, step: state.step, tail: out.slice(-400)});
    check("e2e: the operator gets a die() message naming the token, not a stack trace",
      out.includes("is not a capability Project Autopilot recognises")
      && out.includes("'read'") && !out.includes("at normalizeRequirement"),
      out.slice(-600));
    check("e2e: the classified failure and the offending token are recorded in state",
      state.lastFailure?.class === "INTERNAL_CONTRACT_ERROR" && state.unrecognisedRequirement?.token === "read",
      {lastFailure: state.lastFailure, unrecognisedRequirement: state.unrecognisedRequirement});
  }
} finally {
  cleanup(...created);
}

if (failures) {
  console.error(`${failures} F6 check(s) failed.`);
  process.exit(1);
}
console.log("test-capability-requirement-error: ALL CHECKS PASSED");
