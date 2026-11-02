#!/usr/bin/env node
// Backlog #6 (Part A) — optional SPEC.md before the standalone plan, with FR->task coverage.
import fs from "node:fs";
import path from "node:path";
import {specCoverageFindings} from "./verify-denylist.mjs";
import {toRuntimeConfig, toNewLayoutConfig, DEFAULTS} from "./config-layout.mjs";
import {
  makeFixtureRepo,
  makeFixtureBin,
  setScenario,
  writeConfig,
  runAutopilot,
  readObservedEvents,
  cleanup
} from "./test-fixtures/workflow-order-harness.mjs";

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`PASS ${name}`);
  else {
    failures += 1;
    console.error(`FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  }
}

// ---- Unit: specCoverageFindings ----
{
  // 1. spec with FR-001..FR-003, tasks citing FR-001 and FR-003 -> exactly one finding, location SPEC.md FR-002
  const spec1 = `## Requirements\n- **FR-001**: System MUST do item 1\n- **FR-002**: System MUST do item 2\n- **FR-003**: System MUST do item 3\n`;
  const tasks1 = `## Phase 1: Setup\n- [ ] **1.1** Implement item 1 (FR-001) ; verify: test1.mjs\n- [ ] **1.2** Implement item 3 (FR-003) ; verify: test3.mjs\n`;
  const findings1 = specCoverageFindings(spec1, tasks1);
  check("unit: spec with FR-001..FR-003, tasks citing FR-001 and FR-003 -> exactly one finding, location SPEC.md FR-002",
    findings1.length === 1 && findings1[0].location === "SPEC.md FR-002",
    findings1);

  // 2. all cited -> []
  const tasksAll = `## Phase 1: Setup\n- [ ] **1.1** Implement item 1 (FR-001) ; verify: test1.mjs\n- [ ] **1.2** Implement item 2 (FR-002) ; verify: test2.mjs\n- [ ] **1.3** Implement item 3 (FR-003) ; verify: test3.mjs\n`;
  const findingsAll = specCoverageFindings(spec1, tasksAll);
  check("unit: all cited -> []",
    findingsAll.length === 0,
    findingsAll);

  // 3. empty spec text -> one finding with location SPEC.md and "missing" in problem
  const findingsEmpty = specCoverageFindings("", tasksAll);
  check("unit: empty spec text -> one finding with location SPEC.md and missing in problem",
    findingsEmpty.length === 1
    && findingsEmpty[0].location === "SPEC.md"
    && findingsEmpty[0].problem.includes("missing"),
    findingsEmpty);

  // 4. FR-010 defined, task cites only FR-01 -> FR-010 uncovered (whole-ID match)
  const specWhole = `## Requirements\n- **FR-010**: System MUST match whole IDs\n`;
  const tasksPartial = `## Phase 1: Setup\n- [ ] **1.1** Task (FR-01) ; verify: test.mjs\n`;
  const findingsWhole = specCoverageFindings(specWhole, tasksPartial);
  check("unit: FR-010 defined, task cites only FR-01 -> FR-010 uncovered (whole-ID match)",
    findingsWhole.length === 1 && findingsWhole[0].location === "SPEC.md FR-010",
    findingsWhole);

  // 5. FR defined only inside a ``` fence -> not counted; a citation only inside a fence in TASKS.md -> not counted
  const specFenced = `\`\`\`\n- **FR-001**: Fenced requirement\n\`\`\`\n- **FR-002**: Real requirement\n`;
  const tasksFenced = `## Phase 1: Setup\n\`\`\`\n- [ ] **1.1** Fenced citation (FR-002) ; verify: test.mjs\n\`\`\`\n- [ ] **1.2** Real task (FR-001) ; verify: test.mjs\n`;
  const findingsFenced = specCoverageFindings(specFenced, tasksFenced);
  check("unit: FR defined only inside fence not counted; citation only inside fence not counted",
    findingsFenced.length === 1 && findingsFenced[0].location === "SPEC.md FR-002",
    findingsFenced);

  // 6. spec containing [NEEDS CLARIFICATION: x] -> a finding about the markers
  const specClarify = `## Requirements\n- **FR-001**: Requirement with [NEEDS CLARIFICATION: exact behavior]\n`;
  const tasksClarify = `## Phase 1: Setup\n- [ ] **1.1** Task (FR-001) ; verify: test.mjs\n`;
  const findingsClarify = specCoverageFindings(specClarify, tasksClarify);
  check("unit: spec containing [NEEDS CLARIFICATION: x] -> finding about markers",
    findingsClarify.some(f => f.location === "SPEC.md" && f.problem.includes("[NEEDS CLARIFICATION]")),
    findingsClarify);
}

// ---- Config: layout <-> runtime mapping ----
{
  const layoutOn = {
    workflow: {
      standalone_spec: true
    }
  };
  const rtOn = toRuntimeConfig(layoutOn);
  check("config: toRuntimeConfig with workflow.standalone_spec: true gives workflow.standaloneSpec === true",
    rtOn.workflow.standaloneSpec === true,
    rtOn.workflow);

  const defaultsRt = toRuntimeConfig(DEFAULTS);
  check("config: DEFAULTS gives workflow.standaloneSpec === true",
    defaultsRt.workflow.standaloneSpec === true,
    defaultsRt.workflow);

  const roundTrip = toNewLayoutConfig(defaultsRt);
  check("config: toNewLayoutConfig round-trips it back to standalone_spec: true",
    roundTrip.workflow.standalone_spec === true,
    roundTrip.workflow);

  const layoutOff = {
    workflow: {
      standalone_spec: false
    }
  };
  const rtOff = toRuntimeConfig(layoutOff);
  check("config: toRuntimeConfig with workflow.standalone_spec: false gives workflow.standaloneSpec === false",
    rtOff.workflow.standaloneSpec === false,
    rtOff.workflow);

  const roundTripOff = toNewLayoutConfig(rtOff);
  check("config: toNewLayoutConfig round-trips it back to standalone_spec: false",
    roundTripOff.workflow.standalone_spec === false,
    roundTripOff.workflow);
}

// ---- Integration: real autopilot.mjs run ----
// Case 1: absent standaloneSpec (default = on). Fake planner writes SPEC.md (FR-001), CONTEXT.md and (FR-001) citations.
{
  const repo = makeFixtureRepo("backlog6-spec-on");
  const binDir = makeFixtureBin("backlog6-spec-on");
  try {
    writeConfig(repo, {planningFramework: "standalone", maxPlanRevisions: 1});
    const cfgPath = path.join(repo, ".autopilot", "config.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    delete cfg.workflow.standaloneSpec;
    delete cfg.workflow.standalone_spec;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

    setScenario(repo, "success");
    const run = runAutopilot(repo, binDir, {request: "implement the fixture task", timeoutMs: 120000});
    const state = JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
    const missionDir = path.join(repo, ".autopilot", "missions", state.mission);
    const specFile = path.join(missionDir, "SPEC.md");
    const tasksFile = path.join(missionDir, "TASKS.md");

    check("integration (on): run exits 0", run.status === 0, {status: run.status, timedOut: run.timedOut});
    check("integration (on): SPEC.md exists", fs.existsSync(specFile), specFile);
    check("integration (on): TASKS.md contains FR-001",
      fs.existsSync(tasksFile) && fs.readFileSync(tasksFile, "utf8").includes("FR-001"),
      tasksFile);
  } finally {
    cleanup(repo, binDir);
  }
}

// Case 2: harness default (standaloneSpec: false). Completes successfully like control case.
{
  const repo = makeFixtureRepo("backlog6-spec-off");
  const binDir = makeFixtureBin("backlog6-spec-off");
  try {
    writeConfig(repo, {planningFramework: "standalone", maxPlanRevisions: 1});
    setScenario(repo, "success");
    const run = runAutopilot(repo, binDir, {request: "implement the fixture task", timeoutMs: 120000});
    const state = JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));

    check("integration (off): completes like control case (exit 0)", run.status === 0, {status: run.status, timedOut: run.timedOut});
    check("integration (off): state.phase === complete", state.phase === "complete", {phase: state.phase});
  } finally {
    cleanup(repo, binDir);
  }
}

if (failures) {
  console.error(`${failures} standalone SPEC test check(s) failed.`);
  process.exit(1);
}
console.log("standalone SPEC tests passed");
