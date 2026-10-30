#!/usr/bin/env node
// Mission 093 Part 1 task 2.5: carriedForwardTasks on implementer attempt runs.
// Source of truth is the implementer loop's carryDecision (autopilot.mjs:6960
// in runStandaloneImplementation, :8561 in runImplementation), threaded into
// the attempt run record through the relay/runRelay/relayAsync
// `carriedForwardTasks` option into initRun (status.json) and
// makeRelayResult (result.json). Accept: carriedForwardTasks present on
// attempt runs that carry tasks in both loops and null everywhere else,
// never fabricated (only a non-empty task-id list survives; empty/null
// degrades to null, never []).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initRun, finalizeRun } from "./run-observability.mjs";

const failures = [];
const check = (name, cond, extra) => {
  if (cond) console.log(`PASS ${name}`);
  else { failures.push(name); console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`); }
};
const readStatus = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8"));
const autopilotSource = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
const observabilitySource = fs.readFileSync(new URL("./run-observability.mjs", import.meta.url), "utf8");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "093-carried-"));

// ── 1. initRun: null by default (never fabricated) ───────────────────────
const dirBare = path.join(root, "bare");
initRun(dirBare, { role: "implementer", runId: "run-bare" });
{
  const st = readStatus(dirBare);
  check("bare: carriedForwardTasks null", st.carriedForwardTasks === null, st.carriedForwardTasks);
}

// ── 2. initRun: a real carry list is persisted ───────────────────────────
const dirSeed = path.join(root, "seed");
initRun(dirSeed, { role: "implementer", runId: "run-seed", carriedForwardTasks: ["T1", "T2"] });
{
  const st = readStatus(dirSeed);
  check("seed: carriedForwardTasks persisted", JSON.stringify(st.carriedForwardTasks) === JSON.stringify(["T1", "T2"]), st.carriedForwardTasks);
  check("seed: order preserved as loop's plan order", st.carriedForwardTasks[0] === "T1" && st.carriedForwardTasks[1] === "T2", st.carriedForwardTasks);
}

// ── 3. initRun: empty array degrades to null, never [] ───────────────────
const dirEmpty = path.join(root, "empty");
initRun(dirEmpty, { role: "implementer", runId: "run-empty", carriedForwardTasks: [] });
{
  const st = readStatus(dirEmpty);
  check("empty: empty array -> null", st.carriedForwardTasks === null, st.carriedForwardTasks);
}

// ── 4. initRun: null input stays null ────────────────────────────────────
const dirNull = path.join(root, "null-in");
initRun(dirNull, { role: "implementer", runId: "run-null", carriedForwardTasks: null });
{
  const st = readStatus(dirNull);
  check("null-in: explicit null -> null", st.carriedForwardTasks === null, st.carriedForwardTasks);
}

// ── 5. initRun: non-array input degrades to null ─────────────────────────
for (const [label, value] of [
  ["string", "T1"],
  ["number", 1],
  ["object", { task: "T1" }],
  ["undefined", undefined],
  ["boolean", true],
]) {
  const dir = path.join(root, `bad-${label}`);
  initRun(dir, { role: "implementer", runId: "run-bad", carriedForwardTasks: value });
  const st = readStatus(dir);
  check(`bad: ${label} -> null`, st.carriedForwardTasks === null, st.carriedForwardTasks);
}

// ── 6. finalizeRun keeps carriedForwardTasks ─────────────────────────────
{
  const dirFin = path.join(root, "fin");
  initRun(dirFin, { role: "implementer", runId: "run-fin", carriedForwardTasks: ["T3"] });
  const startedAt = readStatus(dirFin).started_at;
  finalizeRun(dirFin, { status: "completed", exitCode: 0, decision: "PASS", startedAt });
  check("finalize: carriedForwardTasks survives", JSON.stringify(readStatus(dirFin).carriedForwardTasks) === JSON.stringify(["T3"]), readStatus(dirFin).carriedForwardTasks);
}

// ── 7. Observability guard pin ──────────────────────────────────────────
check("obs: carriedForwardTasks field is array-guarded",
  /carriedForwardTasks: \(Array\.isArray\(meta\.carriedForwardTasks\) && meta\.carriedForwardTasks\.length > 0 \? meta\.carriedForwardTasks : null\),/.test(observabilitySource));

// ── 8. Relay wiring pins (autopilot.mjs source) ──────────────────────────
check("wire: relay signature default is null",
  /capEnabled=false,contScope=null,planRevision=null,carriedForwardTasks=null(?:,resultExtra=null)?\}=options;/.test(autopilotSource));
check("wire: relay forwards carriedForwardTasks to runRelay",
  /capEnabled,contScope,planRevision,carriedForwardTasks(?:,resultExtra)?\}\), callSite\);/.test(autopilotSource));
check("wire: runRelay signature default is null",
  /capEnabled=false,contScope=null,planRevision=null,carriedForwardTasks=null(?:,resultExtra=null)?,__fallbackDepth=0=\{\}\(\)|capEnabled=false,contScope=null,planRevision=null,carriedForwardTasks=null(?:,resultExtra=null)?,__fallbackDepth=0/.test(autopilotSource));
check("wire: retry path re-passes carriedForwardTasks",
  /isWrapUp,runNote,capEnabled,contScope,planRevision,carriedForwardTasks(?:,resultExtra)?,__fallbackDepth/.test(autopilotSource));
check("wire: guard collapses non-arrays/empty to null",
  /const carriedForwardTasksValue=\(Array\.isArray\(carriedForwardTasks\)&&carriedForwardTasks\.length>0\?carriedForwardTasks:null\);/.test(autopilotSource));
check("wire: seed initRun carries carriedForwardTasks",
  /snapshotBeforeStartedAt:null,snapshotBeforeAt:null,snapshotAfterStartedAt:null,snapshotAfterAt:null,planRevision:planRevisionValue,carriedForwardTasks:carriedForwardTasksValue(?:,[^}]*)?\}\)/.test(autopilotSource));
check("wire: onStart re-init keeps the seeded carriedForwardTasks",
  /initRun\(dir,\{pid,role:roleName,runId:id,\.\.\.meta,configuredModel,resolvedModel:null,modelMismatch:null,sessionNumber,snapshotBeforeStartedAt,snapshotBeforeAt,snapshotAfterStartedAt:null,snapshotAfterAt:null,planRevision:planRevisionValue,carriedForwardTasks:carriedForwardTasksValue\}\)/.test(autopilotSource));
check("wire: makeRelayResult accepts carriedForwardTasks=null",
  /sessionNumber=null,planRevision=null,carriedForwardTasks=null(?:,resultExtra)?\}\)/.test(autopilotSource));
check("wire: makeRelayResult writes an array-guarded carriedForwardTasks",
  /carriedForwardTasks:\(Array\.isArray\(carriedForwardTasks\)&&carriedForwardTasks\.length>0\?carriedForwardTasks:null\),/.test(autopilotSource));
check("wire: relay passes carriedForwardTasks into makeRelayResult",
  /modelResolution,snapshotBeforeStartedAt,snapshotBeforeAt,snapshotAfterStartedAt,snapshotAfterAt,sessionNumber,planRevision:planRevisionValue,carriedForwardTasks:carriedForwardTasksValue\}\)/.test(autopilotSource));

// ── 9. Standalone implementer loop call-site pins ────────────────────────
// The loop's carriedTasks array is built up and passed to relay.
const standaloneFnStart = autopilotSource.indexOf("async function runStandaloneImplementation(");
const standaloneFnEnd = autopilotSource.indexOf("async function runImplementation(", standaloneFnStart);
const standaloneBody = autopilotSource.slice(standaloneFnStart, standaloneFnEnd !== -1 ? standaloneFnEnd : standaloneFnStart + 50000);
check("site: standalone loop declares carriedTasks array",
  /const carriedTasks=\[\]/.test(standaloneBody));
check("site: standalone loop pushes carried task ids",
  /carriedTasks\.push\(taskId\)/.test(standaloneBody));
check("site: standalone implementer attempt relay passes carriedForwardTasks",
  /relay\("implementer",`[\s\S]*?`,c,s,\{[\s\S]*?carriedForwardTasks:\[...carriedTasks\]\}/.test(standaloneBody));

// ── 10. SpecKit implementer loop call-site pins ──────────────────────────
const speckitFnStart = autopilotSource.indexOf("async function runImplementation(");
const speckitFnEnd = autopilotSource.indexOf("async function runStandalonePlanning(", speckitFnStart);
const speckitBody = autopilotSource.slice(speckitFnStart, speckitFnEnd !== -1 ? speckitFnEnd : speckitFnStart + 50000);
check("site: speckit loop declares carriedTasks array",
  /const carriedTasks=\[\]/.test(speckitBody));
check("site: speckit loop pushes carried task ids",
  /carriedTasks\.push\(taskId\)/.test(speckitBody));
check("site: speckit implementer attempt relay passes carriedForwardTasks",
  /relay\("implementer",`[\s\S]*?`,c,s,\{[\s\S]*?carriedForwardTasks:\[...carriedTasks\]\}/.test(speckitBody));

// ── 11. Null elsewhere: non-implementer roles never pass it ──────────────
for (const [label, pattern] of [
  ["planner", `relayAsync("planner",prompt,c,s,{`],
  ["plan_reviewer", `relayAsync("plan_reviewer",`],
  ["code_reviewer", `relayAsync("code_reviewer",`],
  ["verifier", `relayAsync("verifier",`],
]) {
  // Find a call site for this role that is NOT inside the implementer loops
  const idx = autopilotSource.indexOf(pattern);
  if (idx !== -1) {
    // Check a reasonable window around the call
    const window = autopilotSource.slice(idx, idx + 400);
    // These roles should not pass carriedForwardTasks
    check(`null-elsewhere: ${label} passes no carriedForwardTasks`, !/carriedForwardTasks/.test(window), window.slice(0, 160));
  }
}

// ── 12. result.json path carries the field ───────────────────────────────
check("record: result.json is written from the result object",
  /write\(path\.join\(dir,"result\.json"\),JSON\.stringify\(onDisk,null,2\)\);/.test(autopilotSource));

fs.rmSync(root, { recursive: true, force: true });

if (failures.length) { console.error(`${failures.length} carried-forward check(s) failed.`); process.exit(1); }
console.log("All carried-forward checks passed.");