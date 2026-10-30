#!/usr/bin/env node
// TASK-36 pin: a NEW standalone request must never adopt a finished
// mission's folder just because the derived names match. The same-name reuse
// in existingMissionSeqForName is valid only for an empty provisional folder
// created moments earlier (WATCH-REPORT refresh). See
// .autopilot/tasks/TASK-36-new-mission-reuses-old-folder.md.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {existingMissionSeqForName, resolveStandaloneMission, missionFor, nextMissionSeq} from "./mission-naming.mjs";
import {makeFixtureRepo, makeFixtureBin, setScenario, writeConfig, runAutopilot, cleanup} from "./test-fixtures/workflow-order-harness.mjs";

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); return; }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

if (process.platform === "win32") {
  console.log("test-mission-folder-reuse: SKIP — standalone read-only roles this file drives need Linux/WSL2 bubblewrap (same prerequisite as test-workflow-order-standalone.mjs).");
  process.exit(0);
}

const MISSION_TIMEOUT_MS = 90000;
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

function seedMission(repo, dirName, {tasks = true, plan = true, runs = 1} = {}) {
  const dir = path.join(repo, ".autopilot", "missions", dirName);
  fs.mkdirSync(dir, {recursive: true});
  if (tasks) fs.writeFileSync(path.join(dir, "TASKS.md"), "## Phase 1: General\n\n- [x] 1. Do the thing — accept: done ; verify: check the thing\n");
  if (plan) fs.writeFileSync(path.join(dir, "PLAN.md"), "# plan\n");
  for (let i = 0; i < runs; i++) fs.mkdirSync(path.join(dir, "runs", `0${i + 1}-x`), {recursive: true});
  return dir;
}

// ---- 1. Unit: finished folder is not reusable; default (no opts) is unchanged.
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ap-reuse-unit-"));
  try {
    seedMission(repo, "021-fix-backlog-item");
    check("unit: finished folder with TASKS/PLAN/runs is not reusable", existingMissionSeqForName(repo, "fix-backlog-item", {reusableOnly: true}) === null);
    check("unit: no opts still returns the match (default behavior unchanged)", existingMissionSeqForName(repo, "fix-backlog-item") === "021");
  } finally { fs.rmSync(repo, {recursive: true, force: true}); }
}

// ---- 2. Unit: empty provisional folder (WATCH-REPORT only) is reused.
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ap-reuse-unit-"));
  try {
    const dir = path.join(repo, ".autopilot", "missions", "023-fix-backlog-item");
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, "WATCH-REPORT.md"), "# watch\n");
    check("unit: empty provisional folder (only WATCH-REPORT.md) is reused", existingMissionSeqForName(repo, "fix-backlog-item", {reusableOnly: true}) === "023");
  } finally { fs.rmSync(repo, {recursive: true, force: true}); }
}

// ---- 3. Unit: a folder with only runs/ entries is NOT reused.
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ap-reuse-unit-"));
  try {
    seedMission(repo, "024-fix-backlog-item", {tasks: false, plan: false, runs: 1});
    check("unit: folder with only runs/01-… (no TASKS.md) is not reused", existingMissionSeqForName(repo, "fix-backlog-item", {reusableOnly: true}) === null);
  } finally { fs.rmSync(repo, {recursive: true, force: true}); }
}

// ---- 3b. Unit: allowlist — anything outside WATCH-REPORT.md / its tmp
//          leftovers blocks reuse; empty and watch-only folders reuse.
{
  const caseRepo = (setup) => {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), "ap-reuse-unit-"));
    try {
      const d = path.join(r, ".autopilot", "missions", "025-fix-backlog-item");
      fs.mkdirSync(d, {recursive: true});
      setup(d);
      return existingMissionSeqForName(r, "fix-backlog-item", {reusableOnly: true});
    } finally { fs.rmSync(r, {recursive: true, force: true}); }
  };
  check("unit: folder with only NOTES.md is not reused", caseRepo((d) => fs.writeFileSync(path.join(d, "NOTES.md"), "# notes\n")) === null);
  check("unit: folder with only phase-briefs/ is not reused", caseRepo((d) => fs.mkdirSync(path.join(d, "phase-briefs"))) === null);
  check("unit: folder with WATCH-REPORT.md + WATCH-REPORT.md.tmp.123 is reused", caseRepo((d) => {
    fs.writeFileSync(path.join(d, "WATCH-REPORT.md"), "# watch\n");
    fs.writeFileSync(path.join(d, "WATCH-REPORT.md.tmp.123"), "# partial\n");
  }) === "025");
  check("unit: empty folder is reused", caseRepo(() => {}) === "025");
}

// ---- 4. Unit (resume regression guard): open mission in state + no usable
//         live request keeps the persisted mission/folder.
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ap-reuse-unit-"));
  try {
    seedMission(repo, "021-fix-backlog-item");
    const s = {phase: "implementing", step: "implementation", mission: "021-fix-backlog-item", missionSeq: "021", planningRequest: "Fix backlog item #25: do the thing"};
    const resumed = resolveStandaloneMission(repo, s, "Use the current project request/context.");
    check("unit: resume with bare ap run keeps persisted mission", resumed === "021-fix-backlog-item", resumed);
    const sameRequest = resolveStandaloneMission(repo, s, "Fix backlog item #25: do the thing");
    check("unit: resume with the same request keeps persisted mission", sameRequest === "021-fix-backlog-item", sameRequest);
    check("unit: missionFor with no message keeps persisted mission", missionFor(repo, {...s, planningRequest: undefined}) === "021-fix-backlog-item", missionFor(repo, {...s, planningRequest: undefined}));
  } finally { fs.rmSync(repo, {recursive: true, force: true}); }
}

// ---- 5. E2E standalone: finished 021-fix-backlog-item must NOT be reused;
//         the new request gets nextMissionSeq and 021 is byte-identical after.
{
  const repo = makeFixtureRepo("reuse-finished");
  const binDir = makeFixtureBin("reuse-finished");
  try {
    writeConfig(repo, {planningFramework: "standalone"});
    const oldDir = seedMission(repo, "021-fix-backlog-item");
    const tasksHash = sha(path.join(oldDir, "TASKS.md"));
    const planHash = sha(path.join(oldDir, "PLAN.md"));
    setScenario(repo, "success");
    const run = runAutopilot(repo, binDir, {request: "Fix backlog item #25: resurface the old mission record", timeoutMs: MISSION_TIMEOUT_MS});

    check("e2e standalone: mission completed", run.status === 0, run.status);
    const state = JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
    check("e2e standalone: finished folder NOT reused (new sequence allocated)", state.missionSeq === "022", state.missionSeq);
    check("e2e standalone: new mission folder differs from the seeded one", !String(state.mission || "").startsWith("021-"), state.mission);
    check("e2e standalone: old TASKS.md byte-identical", sha(path.join(oldDir, "TASKS.md")) === tasksHash);
    check("e2e standalone: old PLAN.md byte-identical", sha(path.join(oldDir, "PLAN.md")) === planHash);
  } finally { cleanup(repo, binDir); }
}

// ---- 6. E2E standalone: empty provisional 023 folder IS reused.
{
  const repo = makeFixtureRepo("reuse-provisional");
  const binDir = makeFixtureBin("reuse-provisional");
  try {
    writeConfig(repo, {planningFramework: "standalone"});
    const dir = path.join(repo, ".autopilot", "missions", "023-fix-backlog-item");
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, "WATCH-REPORT.md"), "# watch\n");
    setScenario(repo, "success");
    const run = runAutopilot(repo, binDir, {request: "Fix backlog item #25: resurface the old mission record", timeoutMs: MISSION_TIMEOUT_MS});

    check("e2e standalone: mission completed", run.status === 0, run.status);
    const state = JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
    check("e2e standalone: provisional empty folder reused", state.missionSeq === "023", state.missionSeq);
    check("e2e standalone: mission folder is the provisional one", state.mission === "023-fix-backlog-item", state.mission);
  } finally { cleanup(repo, binDir); }
}

// ---- 7. E2E SpecKit: an empty provisional folder IS reused (no orphan 002).
{
  const repo = makeFixtureRepo("reuse-speckit-provisional");
  const binDir = makeFixtureBin("reuse-speckit-provisional");
  try {
    writeConfig(repo, {planningFramework: "speckit"});
    const dir = path.join(repo, ".autopilot", "missions", "001-smoke-test-health-endpoint");
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, "WATCH-REPORT.md"), "# watch\n");
    setScenario(repo, "speckit_boundary_violation");
    const run = runAutopilot(repo, binDir, {request: "smoke test the health endpoint", timeoutMs: MISSION_TIMEOUT_MS});

    check("e2e speckit: boundary-violation mission did not complete", run.status !== 0, run.status);
    const state = JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
    check("e2e speckit: provisional empty folder reused", state.missionSeq === "001", state.missionSeq);
    check("e2e speckit: no orphan 002 folder created", !fs.existsSync(path.join(repo, ".autopilot", "missions", "002-smoke-test-health-endpoint")), state.mission);
  } finally { cleanup(repo, binDir); }
}

// ---- 7b. E2E SpecKit guarantee: a folder with real work is NEVER adopted.
{
  const repo = makeFixtureRepo("reuse-speckit-finished");
  const binDir = makeFixtureBin("reuse-speckit-finished");
  try {
    writeConfig(repo, {planningFramework: "speckit"});
    const oldDir = seedMission(repo, "001-smoke-test-health-endpoint");
    const tasksHash = sha(path.join(oldDir, "TASKS.md"));
    const planHash = sha(path.join(oldDir, "PLAN.md"));
    setScenario(repo, "speckit_boundary_violation");
    const run = runAutopilot(repo, binDir, {request: "smoke test the health endpoint", timeoutMs: MISSION_TIMEOUT_MS});

    check("e2e speckit: boundary-violation mission did not complete", run.status !== 0, run.status);
    const state = JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
    check("e2e speckit: finished folder not reused (new sequence allocated)", state.missionSeq === "002", state.missionSeq);
    check("e2e speckit: seeded mission folder untouched", sha(path.join(oldDir, "TASKS.md")) === tasksHash && sha(path.join(oldDir, "PLAN.md")) === planHash);
  } finally { cleanup(repo, binDir); }
}

console.log(failures ? `${failures} check(s) failed.` : "mission-folder-reuse tests passed");
process.exit(failures ? 1 : 0);
