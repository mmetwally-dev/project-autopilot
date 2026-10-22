#!/usr/bin/env node
// Mission 054 Phase 1 task 1.1 — planner-prompt verify-length pins.
//
// The plan-time verify-length rule (every task verify is ONE short command
// naming a test file, at most 500 characters, never an inline `node -e`
// script) must reach the Planner before any plan is written. This file pins
// BOTH prompt sites that carry it:
//   site A — the standalone planner `tasksLine` (scripts/autopilot.mjs), one
//            const shared by the fresh AND the revision prompt branch;
//   site B — the SpecKit tasks-stage artifact contract (artifactContractNoteFor,
//            `tasks` branch).
// Static source assertions only: no imports, no fixtures, no clock. They fail
// if either site drops the wording. Tasks 1.2 (pure helpers) and 1.3
// (plan-time gate wiring) append their own pins to this same file.
import fs from "node:fs";
import {phaseTaskCountFindings, unrecognizedAnnotationFindings} from "./verify-denylist.mjs";
import {verifyLengthFindings, speckitTaskVerifyLengthFindings} from "./verify-denylist.mjs";
import {parseTaskResultContract} from "./task-result-contract.mjs";
import {validateRoleProgress, ROLE_PROGRESS_COMMAND_MAX_CHARS, emptyRoleProgress} from "./phase-stage-checkpoint.mjs";

let failures = 0;
function check(name, condition) {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}`); }
}

const src = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");

// One region slice per prompt site: a file-global contains() would not catch a
// single site dropping the rule while another keeps it.
function sliceBetween(startMarker, endMarker, fromIndex = 0) {
  const start = src.indexOf(startMarker, fromIndex);
  if (start < 0) return "";
  const end = src.indexOf(endMarker, start + startMarker.length);
  if (end < 0) return "";
  return src.slice(start, end + endMarker.length);
}

function withoutNeedle(region, needle) {
  return region.split(needle).join("");
}

// ── Region slices ──
// Site A: the standalone planner tasksLine const. The statement ends `:"");`
// so `";` cannot delimit it — the next const in the same function does.
const tasksLineDef = sliceBetween('const tasksLine="Content for TASKS.md:', 'const taskSizeLine="');
// Site B: the SpecKit tasks-stage artifact contract branch.
const tasksContract = sliceBetween('if(step==="tasks") return `', 'return "";', src.indexOf("function artifactContractNoteFor"));
// The canonical rule string itself.
const ruleDef = sliceBetween('const VERIFY_LENGTH_RULE="', '";');
// The whole standalone planner function, for the both-branches use count.
const plannerFn = sliceBetween("async function runStandalonePlanning", "const STEP_LABELS");

check("regions: both planner prompt sites located",
  tasksLineDef.length > 0 && tasksContract.length > 0);
check("regions: canonical rule const located", ruleDef.length > 0);
check("regions: standalone planner function located", plannerFn.length > 0);

// ── 1. The canonical rule string carries the whole rule ──
const BOUND = "at most 500 characters";
const SHORT_COMMAND = "ONE short command";
const TEST_FILE = "naming a test file";
const NO_INLINE = "never an inline";
const NODE_E = "node -e";
check("rule: const carries the 500-character bound", ruleDef.includes(BOUND));
check("rule: const requires ONE short command naming a test file",
  ruleDef.includes(SHORT_COMMAND) && ruleDef.includes(TEST_FILE));
check("rule: const forbids an inline node -e script",
  ruleDef.includes(NO_INLINE) && ruleDef.includes(NODE_E));
check("rule: const carries no semicolon (the tasksLine statement is sliced on it)",
  !ruleDef.slice('const VERIFY_LENGTH_RULE="'.length, -2).includes(";"));

// A site carries the rule only while it interpolates the canonical const, and
// that const still spells out every clause. Both regions are arguments so the
// negative controls below can drop a clause from a COPY and see the pin fail.
function citesRule(region) {
  return region.includes("VERIFY_LENGTH_RULE");
}
function clauses(ruleRegion) {
  return ruleRegion.includes(BOUND) && ruleRegion.includes(SHORT_COMMAND)
    && ruleRegion.includes(TEST_FILE) && ruleRegion.includes(NO_INLINE)
    && ruleRegion.includes(NODE_E);
}
function siteCarries(promptRegion, ruleRegion = ruleDef) {
  return citesRule(promptRegion) && clauses(ruleRegion);
}

// ── 2. Site A: standalone planner tasksLine ──
check("site A (standalone tasksLine): carries the verify-length rule",
  siteCarries(tasksLineDef));
check("site A: shared by both prompt branches (fresh + revision)",
  plannerFn.includes("tasksLine,")
  && (plannerFn.match(/tasksLine,/g) || []).length >= 2);
check("site A: fails when the rule is dropped",
  !siteCarries(withoutNeedle(tasksLineDef, "VERIFY_LENGTH_RULE")));
check("site A: fails when the 500-character bound is dropped",
  !siteCarries(tasksLineDef, withoutNeedle(ruleDef, BOUND)));
check("site A: fails when the no-inline-node -e rule is dropped",
  !siteCarries(tasksLineDef, withoutNeedle(ruleDef, NODE_E)));

// ── 3. Site B: SpecKit tasks-stage artifact contract ──
check("site B (speckit tasks contract): carries the verify-length rule",
  siteCarries(tasksContract));
check("site B: rule is a bullet in the artifact contract",
  tasksContract.includes("- ${VERIFY_LENGTH_RULE}"));
check("site B: fails when the rule is dropped",
  !siteCarries(withoutNeedle(tasksContract, "VERIFY_LENGTH_RULE")));

// ── 4. No other prompt text changed: the pre-existing rules stay put ──
check("site A: existing TASKS.md contract unchanged",
  tasksLineDef.includes("stable per-phase ID")
  && tasksLineDef.includes("a task's verify runs only the tests linked to that task")
  && tasksLineDef.includes("tasksLineSuffix")
  && tasksLineDef.includes("unrecognized annotation fails the mission at verification"));
check("site B: existing artifact contract unchanged",
  tasksContract.includes("## Phase N: <name>")
  && (tasksContract.includes("Size every task to fit one implementer session") || tasksContract.includes("taskSizingRuleText(sizeTarget)"))
  && tasksContract.includes("build-then-wire")
  && tasksContract.includes("AUTOPILOT_PLANNING_CORRECTION"));

// ── 5. Both sites carry the SAME wording (one canonical string) ──
check("both sites: one canonical rule string, referenced at both sites",
  siteCarries(tasksLineDef) && siteCarries(tasksContract)
  && (src.match(/const VERIFY_LENGTH_RULE=/g) || []).length === 1);

// ── 6. Task 1.2: pure length helpers bounded by ROLE_PROGRESS_COMMAND_MAX_CHARS ──
check("length: bound is 500", ROLE_PROGRESS_COMMAND_MAX_CHARS === 500);
{
  const at = "x".repeat(500);
  const over = "y".repeat(501);
  const zero = verifyLengthFindings([{taskLabel: "1.1", verify: at}]);
  check("length: verify of exactly 500 chars yields zero findings", zero.length === 0);
  const one = verifyLengthFindings([{taskLabel: "1.2", verify: over}]);
  check("length: verify of 501 chars yields one finding", one.length === 1);
  check("length: 501 finding carries the observed length",
    one.length === 1 && one[0].problem.includes("501"));
  check("length: 501 finding carries correction text",
    one.length === 1 && typeof one[0].correction === "string" && one[0].correction.length > 0
    && one[0].location.includes("1.2"));
  check("length: entry without a verify is never flagged",
    verifyLengthFindings([{taskLabel: "1.3"}]).length === 0
    && verifyLengthFindings([{taskLabel: "1.4", verify: ""}]).length === 0);
  check("length: helpers are bounded by the imported checkpoint bound",
    verifyLengthFindings([{taskLabel: "t", verify: "z".repeat(ROLE_PROGRESS_COMMAND_MAX_CHARS)}]).length === 0
    && verifyLengthFindings([{taskLabel: "t", verify: "z".repeat(ROLE_PROGRESS_COMMAND_MAX_CHARS + 1)}]).length === 1);
}
{
  const at = "x".repeat(500);
  const over = "y".repeat(501);
  const mdAt = `## Phase 1: Build\n- [ ] T001 Do the thing ; verify: ${at}`;
  const mdOver = `## Phase 1: Build\n- [ ] T001 Do the thing ; verify: ${over}`;
  const mdNone = `## Phase 1: Build\n- [ ] T001 Do the thing with no verify segment`;
  check("speckit length: 500-char verify yields zero findings",
    speckitTaskVerifyLengthFindings(mdAt).length === 0);
  const one = speckitTaskVerifyLengthFindings(mdOver);
  check("speckit length: 501-char verify yields one finding", one.length === 1);
  check("speckit length: 501 finding carries the observed length and correction",
    one.length === 1 && one[0].problem.includes("501")
    && typeof one[0].correction === "string" && one[0].correction.length > 0);
  check("speckit length: line without a verify segment is never flagged",
    speckitTaskVerifyLengthFindings(mdNone).length === 0);
  const mdAnnotated = `## Phase 1: Build\n- [ ] T001 Do the thing ; verify: ${over} <!-- note -->`;
  const annotated = speckitTaskVerifyLengthFindings(mdAnnotated);
  check("speckit length: verify extracted the autopilot way (annotation stripped, still flagged)",
    annotated.length === 1 && annotated[0].problem.includes("501"));
  const mdAnnotatedAt = `## Phase 1: Build\n- [ ] T001 Do the thing ; verify: ${at} <!-- note -->`;
  check("speckit length: annotated 500-char verify yields zero findings",
    speckitTaskVerifyLengthFindings(mdAnnotatedAt).length === 0);
}
{
  const denySrc = fs.readFileSync(new URL("./verify-denylist.mjs", import.meta.url), "utf8");
  check("length: verify-denylist imports the bound from phase-stage-checkpoint",
    denySrc.includes("ROLE_PROGRESS_COMMAND_MAX_CHARS") && denySrc.includes("phase-stage-checkpoint.mjs"));
  check("length: verify-denylist exports both length helpers",
    denySrc.includes("export function verifyLengthFindings") && denySrc.includes("export function speckitTaskVerifyLengthFindings"));
  const contractSrc = fs.readFileSync(new URL("./task-result-contract.mjs", import.meta.url), "utf8");
  check("length: task-result-contract clamps with the truncation marker",
    contractSrc.includes("…truncated"));
}

// ── 7. Task 1.2: parser clamps an over-long taskLocalCheck.command ──
{
  const sentinel = (obj) => `AUTOPILOT_TASK_RESULT=${JSON.stringify(obj)}`;
  const cmd500 = "c".repeat(500);
  const cmd501 = "d".repeat(501);
  const verbatim = parseTaskResultContract(sentinel({summary: "s", taskLocalCheck: {command: cmd500, status: "passed", exitCode: 0, summary: "ok"}}));
  check("parser: 500-char command stored verbatim",
    verbatim.ok && verbatim.taskLocalCheck.command === cmd500);
  const clamped = parseTaskResultContract(sentinel({summary: "s", taskLocalCheck: {command: cmd501, status: "passed", exitCode: 0, summary: "ok"}}));
  check("parser: 501-char command clamped to at most 500 chars",
    clamped.ok && clamped.taskLocalCheck.command.length <= 500);
  check("parser: clamped command carries the marker and the full original length",
    clamped.ok && clamped.taskLocalCheck.command.includes("…truncated") && clamped.taskLocalCheck.command.includes("501"));
  check("parser: clamped record keeps status/exitCode/summary",
    clamped.ok && clamped.taskLocalCheck.status === "passed" && clamped.taskLocalCheck.exitCode === 0 && clamped.taskLocalCheck.summary === "ok");
  check("parser: clamped record keeps the exact four-field shape",
    clamped.ok && JSON.stringify(Object.keys(clamped.taskLocalCheck).sort()) === JSON.stringify(["command", "exitCode", "status", "summary"]));
  if (clamped.ok) {
    const progress = emptyRoleProgress();
    progress.implementer.status = "running";
    progress.implementer.taskCursor = 1;
    progress.implementer.factsByTask = {
      "standalone:P1:T1:x": {summary: "did work", files: [], taskLocalCheck: {command: clamped.taskLocalCheck.command, status: "passed", exitCode: 0, summary: "ok"}},
    };
    check("parser: clamped record still passes validateRoleProgress",
      validateRoleProgress(progress).ok);
  } else {
    check("parser: clamped record still passes validateRoleProgress", false);
  }
  const bypass = emptyRoleProgress();
  bypass.implementer.status = "running";
  bypass.implementer.taskCursor = 1;
  bypass.implementer.factsByTask = {
    "standalone:P1:T1:x": {summary: "did work", files: [], taskLocalCheck: {command: cmd501, status: "passed", exitCode: 0, summary: "ok"}},
  };
  const rejected = validateRoleProgress(bypass);
  check("parser: over-long command bypassing the parser is still rejected by validateRoleProgress",
    !rejected.ok);
}

// ── 8. Task 1.3: plan-time gate wiring merges length findings at all three sites ──
{
  check("wiring: autopilot imports both length helpers",
    src.includes("verifyLengthFindings") && src.includes("speckitTaskVerifyLengthFindings")
    && src.includes("verifyShardFindings") && src.includes("speckitTaskVerifyShardFindings")
    && src.includes('import {verifyDenylistFindings, effectiveVerifyDenylist, speckitTaskDenylistFindings, verifyLengthFindings, speckitTaskVerifyLengthFindings, verifyShardFindings, speckitTaskVerifyShardFindings, phaseTaskCountFindings, unrecognizedAnnotationFindings, MAX_PHASE_TASKS} from "./verify-denylist.mjs"'));
  // Site 1: standalone denylist gate hoists the shared entries const.
  check("wiring site 1 (standalone): shared entries hoisted into one const",
    src.includes("const standaloneVerifyEntries=standaloneTaskVerifyEntries(tasksFile)"));
  check("wiring site 1 (standalone): denylist and length findings merged",
    src.includes("verifyLengthFindings(standaloneVerifyEntries)")
    && src.includes("verifyShardFindings(standaloneVerifyEntries)")
    && src.includes("[...verifyDenylistFindings(standaloneVerifyEntries,effectiveVerifyDenylist(c)),...verifyLengthFindings(standaloneVerifyEntries),...verifyShardFindings(standaloneVerifyEntries),...phaseTaskCountFindings(standaloneTasksText),...unrecognizedAnnotationFindings(standaloneTasksText)]"));
  // Site 2: SpecKit initial tasks gate merges on tasksMdText.
  check("wiring site 2 (speckit initial): length findings merged on tasksMdText",
    src.includes("[...speckitTaskDenylistFindings(tasksMdText,effectiveVerifyDenylist(c)),...speckitTaskVerifyLengthFindings(tasksMdText),...speckitTaskVerifyShardFindings(tasksMdText)]"));
  // Site 3: SpecKit post-revision retry gate merges on revisedText.
  check("wiring site 3 (speckit retry): length findings merged on revisedText",
    src.includes("[...speckitTaskDenylistFindings(revisedText,effectiveVerifyDenylist(c)),...speckitTaskVerifyLengthFindings(revisedText),...speckitTaskVerifyShardFindings(revisedText)]"));
  // Negative controls: dropping the merge at any one site fails that site's pin.
  check("wiring: fails when the standalone merge is dropped",
    !withoutNeedle(src, "verifyLengthFindings(standaloneVerifyEntries)").includes("[...verifyDenylistFindings(standaloneVerifyEntries,effectiveVerifyDenylist(c)),...verifyLengthFindings(standaloneVerifyEntries),...verifyShardFindings(standaloneVerifyEntries),...phaseTaskCountFindings(standaloneTasksText),...unrecognizedAnnotationFindings(standaloneTasksText)]"));
  check("wiring: fails when the standalone shard merge is dropped",
    !withoutNeedle(src, "verifyShardFindings(standaloneVerifyEntries)").includes("[...verifyDenylistFindings(standaloneVerifyEntries,effectiveVerifyDenylist(c)),...verifyLengthFindings(standaloneVerifyEntries),...verifyShardFindings(standaloneVerifyEntries),...phaseTaskCountFindings(standaloneTasksText),...unrecognizedAnnotationFindings(standaloneTasksText)]"));
  check("wiring: fails when the speckit initial merge is dropped",
    !withoutNeedle(src, "speckitTaskVerifyLengthFindings(tasksMdText)").includes("speckitTaskVerifyLengthFindings(tasksMdText)"));
  check("wiring: fails when the speckit retry merge is dropped",
    !withoutNeedle(src, "speckitTaskVerifyLengthFindings(revisedText)").includes("speckitTaskVerifyLengthFindings(revisedText)"));
  // GSD gate is out of scope: it keeps the denylist-only check.
  const gsdGate = sliceBetween("const gsdDenied=verifyDenylistFindings", 'if(gsdDenied.length)');
  check("wiring: GSD gate keeps the denylist-only check",
    gsdGate.includes("const gsdDenied=verifyDenylistFindings(gsdEntries,effectiveVerifyDenylist(c))")
    && !gsdGate.includes("verifyLengthFindings") && !gsdGate.includes("VerifyLengthFindings"));
}

// Backlog #85: phase-size and annotation findings.
{
  const mk = (n, h = "## Phase 1: A") => [h, ...Array.from({length: n}, (_, i) => `- [ ] **1.${i + 1}** t; verify: x`)].join("\n");
  check("phase-size: 10-task phase -> no finding", phaseTaskCountFindings(mk(10)).length === 0);
  const eleven = phaseTaskCountFindings(mk(11, "## Phase 2: B"));
  check("phase-size: 11-task phase -> one finding naming it", eleven.length === 1 && eleven[0].location === "TASKS.md Phase 2" && /split this phase/.test(eleven[0].correction));
  check("phase-size: phases 11 and 3 -> one finding", phaseTaskCountFindings(mk(11) + "\n" + mk(3, "## Phase 2: B")).length === 1);
  check("phase-size: fenced tasks not counted", phaseTaskCountFindings(mk(3) + "\n```\n" + mk(4, "## Phase 9: X") + "\n```\n").length === 0);
  check("phase-size: checked tasks counted", phaseTaskCountFindings(mk(11).replace(/\[ \]/g, "[x]")).length === 1);
  const ann = (t) => unrecognizedAnnotationFindings(`## Phase 1: A\n- [ ] **1.1** x; verify: y <!-- autopilot-requires: ${t} -->`);
  check("annotation: recognised capability -> no finding", ann("commands.execute").length === 0);
  check("annotation: unrecognised token -> one finding", ann("read").length === 1 && ann("read")[0].location === "TASKS.md 1.1");
  check("annotation: none -> no finding", unrecognizedAnnotationFindings("- [ ] **1.1** x").length === 0);
  const wired = sliceBetween("const denied=[", "if(denied.length)");
  check("wiring: standalone denied array includes phaseTaskCountFindings and unrecognizedAnnotationFindings",
    wired.includes("phaseTaskCountFindings(") && wired.includes("unrecognizedAnnotationFindings("));
  check("wiring: standalone reviewPrompt FAILs phases over the task cap",
    src.includes("FAIL any phase with more than ${MAX_PHASE_TASKS} tasks"));
}

if (failures) {
  console.error(`${failures} verify-length check(s) failed.`);
  process.exit(1);
}
console.log("verify-length tests passed");
