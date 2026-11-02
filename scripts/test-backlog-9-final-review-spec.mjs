#!/usr/bin/env node
// Backlog #9 — the mission-final code review checks the code against the spec's FRs (standalone SPEC.md and SpecKit spec.md)
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {buildStandaloneHandoff, specFrCheckLine} from "./standalone-handoff.mjs";
import {scopedDeltaBeginMarker} from "./implementation-baseline.mjs";
import {
  makeFixtureRepo,
  makeFixtureBin,
  setScenario,
  writeConfig,
  runAutopilot,
  readObservedEvents,
  cleanup
} from "./test-fixtures/workflow-order-harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`PASS ${name}`);
  else {
    failures += 1;
    console.error(`FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  }
}

function missionFinalBase(extra = {}) {
  return {
    kind: "MISSION_FINAL",
    deltaChunks: [],
    baselineKey: "mission-final-spec",
    declaredPaths: [],
    planPath: "/repo/PLAN.md",
    tasksPath: "/repo/TASKS.md",
    implementationSummary: "",
    ...extra,
  };
}

// ---- Unit: buildStandaloneHandoff MISSION_FINAL & specFrCheckLine ----
{
  const withSpec = buildStandaloneHandoff(missionFinalBase({specPath: "/x/SPEC.md"}));
  const withoutSpec = buildStandaloneHandoff(missionFinalBase());
  const emptySpec = buildStandaloneHandoff(missionFinalBase({specPath: ""}));

  const specMarkerIdx = withSpec.text.indexOf("Feature specification: /x/SPEC.md");
  const deltaBeginIdx = withSpec.text.indexOf(scopedDeltaBeginMarker("MISSION"));

  check("unit: MISSION_FINAL with specPath:'/x/SPEC.md' contains 'Feature specification: /x/SPEC.md'",
    specMarkerIdx !== -1,
    withSpec.text.slice(0, 400));

  check("unit: MISSION_FINAL with specPath:'/x/SPEC.md' contains \"'SPEC.md FR-###'\"",
    withSpec.text.includes("'SPEC.md FR-###'"),
    withSpec.text.slice(0, 400));

  check("unit: spec line comes before the scoped-delta begin marker",
    specMarkerIdx !== -1 && deltaBeginIdx !== -1 && specMarkerIdx < deltaBeginIdx,
    {specMarkerIdx, deltaBeginIdx});

  check("unit: MISSION_FINAL without specPath and with specPath:'' are byte-identical",
    withoutSpec.text === emptySpec.text,
    {withoutLen: withoutSpec.text.length, emptyLen: emptySpec.text.length});

  check("unit: MISSION_FINAL without specPath does not contain 'Feature specification:'",
    !withoutSpec.text.includes("Feature specification:"),
    withoutSpec.text.slice(0, 300));

  const speckitLine = specFrCheckLine("/a/specs/010-x/spec.md");
  check("unit: specFrCheckLine('/a/specs/010-x/spec.md') contains \"'spec.md FR-###'\"",
    speckitLine.includes("'spec.md FR-###'"),
    speckitLine);
}

// ---- Wiring: source check of scripts/autopilot.mjs ----
{
  const autopilotSrc = fs.readFileSync(path.join(HERE, "autopilot.mjs"), "utf8");
  const standaloneCallMatches = autopilotSrc.match(/specPath:standaloneFinalSpecPath\(c,mission\)/g) || [];
  check("wiring: scripts/autopilot.mjs has exactly 3 occurrences of specPath:standaloneFinalSpecPath(c,mission)",
    standaloneCallMatches.length === 3,
    standaloneCallMatches.length);

  const speckitSiteIdx = autopilotSrc.indexOf("Perform final repository review against the planning artifacts.");
  const speckitRegion = speckitSiteIdx !== -1
    ? autopilotSrc.slice(Math.max(0, speckitSiteIdx - 600), speckitSiteIdx + 600)
    : "";
  check("wiring: SpecKit final-review prompt site references specFrCheckLine(",
    speckitRegion.includes("specFrCheckLine("),
    speckitRegion);
}

// ---- Integration: standalone spec on ----
{
  const repo = makeFixtureRepo("backlog9-spec-on");
  const binDir = makeFixtureBin("backlog9-spec-on");
  try {
    writeConfig(repo, {planningFramework: "standalone", maxPlanRevisions: 1});
    const cfgPath = path.join(repo, ".autopilot", "config.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    delete cfg.workflow.standaloneSpec;
    delete cfg.workflow.standalone_spec;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

    setScenario(repo, "success");
    const run = runAutopilot(repo, binDir, {request: "implement the fixture task", timeoutMs: 120000});
    const events = readObservedEvents(repo);
    const state = JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
    const missionDir = path.join(repo, ".autopilot", "missions", state.mission);
    const specFile = path.join(missionDir, "SPEC.md");
    const specRel = path.posix.join(".autopilot", "missions", state.mission, "SPEC.md");

    const reviewerEvents = events.filter(e => e.role === "code_reviewer");
    const lastReviewerEvent = reviewerEvents[reviewerEvents.length - 1];
    const lastReviewerPrompt = lastReviewerEvent
      ? fs.readFileSync(path.join(path.dirname(lastReviewerEvent.file), "brief.txt"), "utf8")
      : "";

    check("integration (spec on): run exits 0", run.status === 0, {status: run.status, stderr: run.stderr});
    check("integration (spec on): last code_reviewer prompt contains 'Feature specification:' and mission SPEC.md path",
      lastReviewerPrompt.includes("Feature specification:")
      && (lastReviewerPrompt.includes(specFile) || lastReviewerPrompt.includes(specRel)),
      lastReviewerPrompt.slice(0, 800));
  } finally {
    cleanup(repo, binDir);
  }
}

// ---- Integration: standalone spec off (harness default) ----
{
  const repo = makeFixtureRepo("backlog9-spec-off");
  const binDir = makeFixtureBin("backlog9-spec-off");
  try {
    writeConfig(repo, {planningFramework: "standalone", maxPlanRevisions: 1});
    setScenario(repo, "success");
    const run = runAutopilot(repo, binDir, {request: "implement the fixture task", timeoutMs: 120000});
    const events = readObservedEvents(repo);
    const reviewerPrompts = events
      .filter(e => e.role === "code_reviewer")
      .map(e => fs.readFileSync(path.join(path.dirname(e.file), "brief.txt"), "utf8"));

    check("integration (spec off): run exits 0", run.status === 0, {status: run.status, stderr: run.stderr});
    check("integration (spec off): no code_reviewer prompt contains 'Feature specification:'",
      reviewerPrompts.length > 0 && reviewerPrompts.every(p => !p.includes("Feature specification:")),
      reviewerPrompts.map(p => p.slice(0, 120)));
  } finally {
    cleanup(repo, binDir);
  }
}

if (failures) {
  console.error(`${failures} final-review spec check(s) failed.`);
  process.exit(1);
}
console.log("final-review spec tests passed");

