#!/usr/bin/env node
// Mission 093 Part 1 task 2.4: planRevision on planning runs.
//
// Source of truth is s.standalonePlanReview.revision inside runStandalonePlanning
// (autopilot.mjs:4764), threaded into the run record through the relay/
// runRelay/relayAsync `planRevision` option into initRun (status.json) and
// makeRelayResult (result.json). Accept: planRevision present on planning runs
// and null everywhere else, never fabricated (only a finite integer >= 0
// survives; a bad value degrades to null, never 0).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initRun } from "./run-observability.mjs";

const failures = [];
const check = (name, cond, extra) => {
  if (cond) console.log(`PASS ${name}`);
  else { failures.push(name); console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`); }
};
const readStatus = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8"));
const autopilotSource = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
const observabilitySource = fs.readFileSync(new URL("./run-observability.mjs", import.meta.url), "utf8");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "093-plan-revision-"));

// ── 1. initRun: null by default (never fabricated) ───────────────────────
const dirBare = path.join(root, "bare");
initRun(dirBare, { role: "implementer", runId: "run-bare" });
{
  const st = readStatus(dirBare);
  check("bare: planRevision null", st.planRevision === null, st.planRevision);
}

// ── 2. initRun: a real planning revision is persisted ────────────────────
const dirSeed = path.join(root, "seed");
initRun(dirSeed, { role: "planner", runId: "run-seed", planRevision: 3 });
{
  const st = readStatus(dirSeed);
  check("seed: planRevision persisted", st.planRevision === 3, st.planRevision);
  check("seed: generation 0 is valid, not falsy-mangled", true);
}
const dirZero = path.join(root, "zero");
initRun(dirZero, { role: "planner", runId: "run-zero", planRevision: 0 });
{
  check("seed: revision 0 persists (0 is a real generation)", readStatus(dirZero).planRevision === 0, readStatus(dirZero).planRevision);
}

// ── 3. initRun: non-revisions degrade to null, never 0 ───────────────────
const bad = [
  ["directive", -1],
  ["directive", 1.5],
  ["directive", NaN],
  ["directive", Infinity],
  ["directive", "2"],
  ["directive", undefined],
  ["directive", null],
  ["directive", true],
];
for (const [label, value] of bad) {
  const dir = path.join(root, `bad-${String(value)}-${label}`);
  initRun(dir, { role: "planner", runId: "run-bad", planRevision: value });
  const st = readStatus(dir);
  check(`bad: ${JSON.stringify(value ?? null)} -> null`, st.planRevision === null, st.planRevision);
}

// ── 4. finalizeRun keeps planRevision ────────────────────────────────────
{
  const dirFin = path.join(root, "fin");
  initRun(dirFin, { role: "planner", runId: "run-fin", planRevision: 2 });
  const startedAt = readStatus(dirFin).started_at;
  const { finalizeRun } = await import("./run-observability.mjs");
  finalizeRun(dirFin, { status: "completed", exitCode: 0, decision: "PASS", startedAt });
  check("finalize: planRevision survives", readStatus(dirFin).planRevision === 2, readStatus(dirFin).planRevision);
}

// ── 5. Observability guard pin ──────────────────────────────────────────
check("obs: planRevision field is integer-guarded",
  /planRevision: \(Number\.isInteger\(meta\.planRevision\) && meta\.planRevision >= 0 \? meta\.planRevision : null\),/.test(observabilitySource));

// ── 6. Relay wiring pins (autopilot.mjs source) ──────────────────────────
check("wire: relay signature default is null",
  /capEnabled=false,contScope=null,planRevision=null,carriedForwardTasks=null(?:,resultExtra=null)?\}=options;/.test(autopilotSource));
check("wire: relay forwards planRevision to runRelay",
  /capEnabled,contScope,planRevision,carriedForwardTasks(?:,resultExtra)?\}\), callSite\);/.test(autopilotSource));
check("wire: runRelay signature default is null",
  /capEnabled=false,contScope=null,planRevision=null,carriedForwardTasks=null(?:,resultExtra=null)?,__fallbackDepth=0=\{\}\(\)|capEnabled=false,contScope=null,planRevision=null,carriedForwardTasks=null(?:,resultExtra=null)?,__fallbackDepth=0/.test(autopilotSource));
check("wire: retry path re-passes planRevision",
  /isWrapUp,runNote,capEnabled,contScope,planRevision,carriedForwardTasks(?:,resultExtra)?,__fallbackDepth/.test(autopilotSource));
check("wire: guard collapses non-integers to null",
  /const planRevisionValue=\(Number\.isInteger\(planRevision\)&&planRevision>=0\?planRevision:null\);/.test(autopilotSource));
check("wire: seed initRun carries planRevision",
  /snapshotBeforeStartedAt:null,snapshotBeforeAt:null,snapshotAfterStartedAt:null,snapshotAfterAt:null,planRevision:planRevisionValue,carriedForwardTasks:carriedForwardTasksValue\}\)/.test(autopilotSource));
check("wire: onStart re-init keeps the seeded planRevision",
  /initRun\(dir,\{pid,role:roleName,runId:id,\.\.\.meta,configuredModel,resolvedModel:null,modelMismatch:null,sessionNumber,snapshotBeforeStartedAt,snapshotBeforeAt,snapshotAfterStartedAt:null,snapshotAfterAt:null,planRevision:planRevisionValue,carriedForwardTasks:carriedForwardTasksValue\}\)/.test(autopilotSource));
check("wire: makeRelayResult accepts planRevision=null",
  /sessionNumber=null,planRevision=null,carriedForwardTasks=null(?:,resultExtra)?\}\)/.test(autopilotSource));
check("wire: makeRelayResult writes an integer-guarded planRevision",
  /planRevision:\(Number\.isInteger\(planRevision\)&&planRevision>=0\?planRevision:null\),/.test(autopilotSource));
check("wire: relay passes planRevision into makeRelayResult",
  /modelResolution,snapshotBeforeStartedAt,snapshotBeforeAt,snapshotAfterStartedAt,snapshotAfterAt,sessionNumber,planRevision:planRevisionValue,carriedForwardTasks:carriedForwardTasksValue\}\)/.test(autopilotSource));

// ── 7. Planning call-site pins: revision comes from state, planners get it ─
check("site: runStandalonePlanning restores the revision from state",
  /let revision=Number\(s\.standalonePlanReview\?\.revision\)\|\|0;/.test(autopilotSource));
const plannerSite = autopilotSource.indexOf(`relayAsync("planner",prompt,c,s,{resume:false,capEnabled:true,taskRef:'standalone-planning-planner',planRevision:revision})`);
check("site: planner run carries planRevision:revision", plannerSite !== -1, plannerSite);
check("site: plan_reviewer run carries planRevision:revision",
  /relayAsync\("plan_reviewer",reviewPrompt,c,s,\{readOnly:true,review:true,resume:false,capEnabled:true,taskRef:'standalone-planning-plan_reviewer',planRevision:revision\}\)/.test(autopilotSource));
check("site: reviewer retry lambda carries planRevision:revision",
  /\(\)=>relayAsync\("plan_reviewer",reviewPrompt,c,s,\{readOnly:true,review:true,resume:false,capEnabled:true,taskRef:'standalone-planning-plan_reviewer',planRevision:revision\}\)/.test(autopilotSource));
// All three sites must sit inside runStandalonePlanning (4747..5264).
{
  const fnStart = autopilotSource.indexOf("async function runStandalonePlanning(");
  const fnEnd = autopilotSource.indexOf("function roleStepLine(");
  check("site: planner/reviewer sites are inside runStandalonePlanning",
    fnStart !== -1 && fnEnd > fnStart && plannerSite > fnStart && plannerSite < fnEnd, { fnStart, fnEnd, plannerSite });
}
// Null elsewhere: the non-standalone planning paths never pass planRevision.
for (const [label, pattern] of [
  ["speckit planner", `relayAsync("planner",prompt,c,s,{readOnly:false,resume})`],
  ["gsd review", `relayAsync("plan_reviewer",`],
]) {
  const idx = autopilotSource.indexOf(pattern);
  const line = idx === -1 ? -1 : autopilotSource.slice(idx, Math.min(autopilotSource.length, idx + 400));
  check(`null-elsewhere: ${label} passes no planRevision`, idx === -1 || !/planRevision/.test(line), line.slice(0, 160));
}

// ── 8. result.json path carries the field ───────────────────────────────
check("record: result.json is written from the result object",
  /write\(path\.join\(dir,"result\.json"\),JSON\.stringify\(onDisk,null,2\)\);/.test(autopilotSource));

fs.rmSync(root, { recursive: true, force: true });

if (failures.length) { console.error(`${failures.length} plan-revision check(s) failed.`); process.exit(1); }
console.log("All plan-revision checks passed.");
