#!/usr/bin/env node
// Unit and wiring test for backlog #8:
// 1. Pure helpers:
//    - parseTaskBlocks (block parsing incl. IDs like T011.2b and T033.1)
//    - changedTaskIds (edited, new, split tasks)
//    - taskSizeConfirmationLine (lists changed IDs or "none")
//    - demoteUnchangedTaskSizeFindings (unchanged -> notes, changed -> kept,
//      no id -> kept, non-size -> untouched)
// 2. Wiring checks:
//    - Runs real confirmation path for Standalone and SpecKit using the fixture harness
import fs from "node:fs";
import path from "node:path";
import {
  parseTaskBlocks,
  changedTaskIds,
  taskSizeConfirmationLine,
  demoteUnchangedTaskSizeFindings,
  extractCitedTaskIds,
  recordPlanReviewTaskHashes,
  getPlanReviewTaskHashes,
  clearPlanReviewTaskHashes,
  clearPlanReviewHistory,
} from "./plan-review-rounds.mjs";
import {
  makeFixtureRepo, makeFixtureBin, makeSpecKitWorkflowOnly, setScenario, writeConfig, runAutopilot, cleanup,
} from "./test-fixtures/workflow-order-harness.mjs";
import { fixtureGit } from "./test-fixtures/fixture-git.mjs";

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`PASS ${name}`);
    return;
  }
  failures += 1;
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// PART 1: PURE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

// 1. Block parsing including IDs like T011.2b and T033.1
{
  const tasksMarkdown = `
# Tasks Document

## Phase 1: Core Setup

- [ ] T011 Setup database schema in db/schema.sql
  accept: db connects ; verify: node test-db.js
- [ ] T011.2b Implement migration runner in scripts/migrate.mjs
  accept: migrations run ; verify: node test-migrate.js
  Additional details for T011.2b:
  Must handle rollbacks cleanly.

## Phase 2: Features

- [ ] T033.1 Refactor auth service in src/auth.mjs
  accept: tokens generated
- [x] T038 Final integration check in src/index.mjs
`;

  const hashes = parseTaskBlocks(tasksMarkdown);
  const keys = Object.keys(hashes);

  check("parseTaskBlocks parses T011", keys.includes("T011"), keys);
  check("parseTaskBlocks parses T011.2b", keys.includes("T011.2b"), keys);
  check("parseTaskBlocks parses T033.1", keys.includes("T033.1"), keys);
  check("parseTaskBlocks parses T038 (completed)", keys.includes("T038"), keys);
  check("parseTaskBlocks finds all 4 tasks", keys.length === 4, keys);

  // Hash format check
  check("hashes are 16-hex strings", typeof hashes["T011.2b"] === "string" && /^[0-9a-f]{16}$/.test(hashes["T011.2b"]));

  // Block boundary check: editing body changes hash
  const tasksMarkdownEditedBody = tasksMarkdown.replace("Must handle rollbacks cleanly.", "Must handle rollbacks and down migrations.");
  const hashesEdited = parseTaskBlocks(tasksMarkdownEditedBody);
  check("editing task body lines changes the task hash", hashes["T011.2b"] !== hashesEdited["T011.2b"]);
  check("other task hashes unchanged when one task body is edited", hashes["T011"] === hashesEdited["T011"] && hashes["T033.1"] === hashesEdited["T033.1"]);
}

// 2. Changed IDs for edited / new / split tasks
{
  const oldHashes = {
    T010: "aaaa111122223333",
    T011: "bbbb111122223333",
    T012: "cccc111122223333",
  };

  // Scenario:
  // - T010 is unchanged
  // - T011 is edited (different hash)
  // - T012 is split into T012.1 and T012.2 (new IDs)
  // - T013 is completely new
  const newHashes = {
    T010: "aaaa111122223333", // unchanged
    T011: "bbbb999988887777", // edited
    T012_1: "dddd111122223333", // split part 1
    T012_2: "eeee111122223333", // split part 2
    T013: "ffff111122223333", // new
  };

  const changed = changedTaskIds(oldHashes, newHashes);

  check("changedTaskIds detects edited task T011", changed.includes("T011"), changed);
  check("changedTaskIds detects split tasks T012_1 and T012_2", changed.includes("T012_1") && changed.includes("T012_2"), changed);
  check("changedTaskIds detects new task T013", changed.includes("T013"), changed);
  check("changedTaskIds excludes unchanged task T010", !changed.includes("T010"), changed);
  check("changedTaskIds contains exactly the 4 changed tasks", changed.length === 4, changed);

  // Empty old hashes -> all new tasks changed
  const allChanged = changedTaskIds({}, newHashes);
  check("empty old hashes reports all current tasks as changed", allChanged.length === Object.keys(newHashes).length);

  // Identical hashes -> no changed tasks
  const noneChanged = changedTaskIds(oldHashes, oldHashes);
  check("identical hashes reports zero changed tasks", noneChanged.length === 0);
}

// 3. Confirmation line text: lists changed IDs or "none"
{
  const lineMultiple = taskSizeConfirmationLine(["T011.2b", "T033.1"]);
  check("taskSizeConfirmationLine with changed IDs lists them",
    lineMultiple === 'Task-size rule in this confirmation review: raise a [RULE: task size] finding only for tasks changed since the last full review: T011.2b, T033.1. Put a size concern about any other task in notes.',
    lineMultiple);

  const lineSingle = taskSizeConfirmationLine(["T001"]);
  check("taskSizeConfirmationLine with single ID",
    lineSingle.includes("review: T001. Put a size concern"),
    lineSingle);

  const lineEmpty = taskSizeConfirmationLine([]);
  check("taskSizeConfirmationLine with empty array says none",
    lineEmpty === 'Task-size rule in this confirmation review: raise a [RULE: task size] finding only for tasks changed since the last full review: none. Put a size concern about any other task in notes.',
    lineEmpty);

  const lineNull = taskSizeConfirmationLine(null);
  check("taskSizeConfirmationLine with null says none",
    lineNull.includes("review: none. Put a size concern"),
    lineNull);
}

// 4. Demote unchanged task-size findings
{
  const changedIds = ["T011.2b", "T033.1"];

  // a. Unchanged task size finding moved to notes
  const rUnchanged = {
    decision: "FAIL",
    findings: ["[RULE: task size] T022.2 combines four distinct changes"],
    notes: ["existing note"],
  };
  const resUnchanged = demoteUnchangedTaskSizeFindings(rUnchanged, changedIds);
  check("unchanged task-size finding moved count is 1", resUnchanged.moved === 1, resUnchanged.moved);
  check("unchanged task-size finding demotes decision to PASS", resUnchanged.review.decision === "PASS", resUnchanged.review.decision);
  check("findings is empty after demotion", resUnchanged.review.findings.length === 0, resUnchanged.review.findings);
  check("note appended with moved finding", resUnchanged.review.notes.length === 2 && resUnchanged.review.notes[1].includes("T022.2"), resUnchanged.review.notes);

  // b. Changed task size finding kept
  const rChanged = {
    decision: "FAIL",
    findings: ["[RULE: task size] T011.2b is oversized: touches 3 files"],
  };
  const resChanged = demoteUnchangedTaskSizeFindings(rChanged, changedIds);
  check("changed task-size finding moved count is 0", resChanged.moved === 0, resChanged.moved);
  check("changed task-size finding decision stays FAIL", resChanged.review.decision === "FAIL", resChanged.review.decision);
  check("changed task-size finding kept in findings", resChanged.review.findings.length === 1 && resChanged.review.findings[0].includes("T011.2b"));

  // c. Task size finding without task IDs kept
  const rNoId = {
    decision: "FAIL",
    findings: ["[RULE: task size] too many changes in tasks overall"],
  };
  const resNoId = demoteUnchangedTaskSizeFindings(rNoId, changedIds);
  check("task-size finding without ID moved count is 0", resNoId.moved === 0, resNoId.moved);
  check("task-size finding without ID decision stays FAIL", resNoId.review.decision === "FAIL", resNoId.review.decision);
  check("task-size finding without ID kept in findings", resNoId.review.findings.length === 1);

  // d. Non-size finding untouched
  const rNonSize = {
    decision: "FAIL",
    findings: ["[HIGH] T022.2 has missing test coverage", "TASKS.md has syntax error"],
  };
  const resNonSize = demoteUnchangedTaskSizeFindings(rNonSize, changedIds);
  check("non-size findings moved count is 0", resNonSize.moved === 0, resNonSize.moved);
  check("non-size findings decision stays FAIL", resNonSize.review.decision === "FAIL", resNonSize.review.decision);
  check("non-size findings kept untouched in findings", resNonSize.review.findings.length === 2);

  // e. Object findings: cited via "tasks" array
  const rObjUnchanged = {
    decision: "FAIL",
    findings: [{ tasks: ["T022.2"], problem: "[RULE: task-size] multiple actions" }],
  };
  const resObjUnchanged = demoteUnchangedTaskSizeFindings(rObjUnchanged, changedIds);
  check("object task-size finding on unchanged task moved", resObjUnchanged.moved === 1 && resObjUnchanged.review.decision === "PASS");

  const rObjChanged = {
    decision: "FAIL",
    findings: [{ tasks: ["T033.1"], problem: "[RULE: task size] oversized action" }],
  };
  const resObjChanged = demoteUnchangedTaskSizeFindings(rObjChanged, changedIds);
  check("object task-size finding on changed task kept", resObjChanged.moved === 0 && resObjChanged.review.decision === "FAIL");

  // f. Object finding citing both changed and unchanged -> kept
  const rObjMixed = {
    decision: "FAIL",
    findings: [{ tasks: ["T011.2b", "T022.2"], problem: "[RULE: task size] these tasks overlap" }],
  };
  const resObjMixed = demoteUnchangedTaskSizeFindings(rObjMixed, changedIds);
  check("finding citing both changed and unchanged is kept", resObjMixed.moved === 0 && resObjMixed.review.decision === "FAIL");
}

// 5. State storage and clearing
{
  const state = {};
  const gateKey = "speckit-stage:tasks";
  const hashes = { T001: "hash1", T002: "hash2" };

  recordPlanReviewTaskHashes(state, gateKey, hashes);
  check("task hashes recorded in state", JSON.stringify(getPlanReviewTaskHashes(state, gateKey)) === JSON.stringify(hashes));

  clearPlanReviewHistory(state, gateKey);
  check("clearPlanReviewHistory clears task hashes for gateKey", Object.keys(getPlanReviewTaskHashes(state, gateKey)).length === 0);
  check("task hashes state key deleted when empty", state.planReviewTaskHashes === undefined);
}

// ─────────────────────────────────────────────────────────────────────────────
// PART 2: WIRING CHECKS (HARNESS RUNS FOR STANDALONE AND SPECKIT)
// ─────────────────────────────────────────────────────────────────────────────

const dirs = [];
const readState = (repo) => JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f, out); else out.push(f);
  }
  return out;
}

function runs(repo, role) {
  const out = [];
  for (const f of walk(path.join(repo, ".autopilot"))) {
    if (path.basename(f) !== "result.json") continue;
    let data; try { data = JSON.parse(fs.readFileSync(f, "utf8")); } catch { continue; }
    if (data.role !== role) continue;
    const briefFile = path.join(path.dirname(f), "brief.txt");
    let note = null;
    try { note = JSON.parse(fs.readFileSync(path.join(path.dirname(f), "status.json"), "utf8")).note ?? null; } catch { note = null; }
    out.push({
      data, decision: data.verdict?.decision ?? null, startedAt: Date.parse(data.startedAt), note,
      brief: fs.existsSync(briefFile) ? fs.readFileSync(briefFile, "utf8") : ""
    });
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

function installScriptedReviewer(binDir) {
  const target = path.join(binDir, "cursor-agent");
  const src = fs.readFileSync(target, "utf8");
  const anchor = src.indexOf("\nSCENARIO=\"success\"");
  if (anchor < 0) throw new Error("fake adapter layout changed");
  const prelude = `
if [ "$ROLE" = "plan_reviewer" ] && [ -f ./.autopilot/.pr-script ]; then
  _n=$(find ./.autopilot -name status.json -exec grep -l '"role": *"plan_reviewer"' {} + 2>/dev/null | wc -l)
  _act=$(sed -n "$_n"p ./.autopilot/.pr-script)
  case "$_act" in
    HANG) sleep 600 ;;
    FAIL) printf 'AUTOPILOT_REVIEW={"decision":"FAIL","findings":["gap-%s: scripted finding"]}\\n' "$_n" ;;
    FAIL_TASK_SIZE_UNCHANGED) printf 'AUTOPILOT_REVIEW={"decision":"FAIL","findings":["[RULE: task size] T999 is oversized"]}\\n' ;;
    *) printf 'AUTOPILOT_REVIEW={"decision":"PASS","findings":[]}\\n' ;;
  esac
  exit 0
fi`;
  fs.writeFileSync(target, src.slice(0, anchor) + prelude + src.slice(anchor));
}

function setScript(repo, lines) {
  fs.mkdirSync(path.join(repo, ".autopilot"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".autopilot", ".pr-script"), lines.join("\n") + "\n");
  fixtureGit(["add", "-f", ".autopilot/.pr-script"], { cwd: repo });
  fixtureGit(["commit", "-q", "-m", "reviewer script"], { cwd: repo });
}

function setup(prefix, framework, script, maxPlanRevisions = 4) {
  const repo = makeFixtureRepo(prefix);
  const binDir = makeFixtureBin(prefix);
  dirs.push(repo, binDir);
  installScriptedReviewer(binDir);
  writeConfig(repo, { planningFramework: framework, maxPlanRevisions });
  if (framework === "speckit") makeSpecKitWorkflowOnly(repo);
  setScenario(repo, "success");
  setScript(repo, script);
  return { repo, binDir };
}

const plan = (repo, binDir, request = "fixture request") => runAutopilot(repo, binDir, { request, stage: "planning", timeoutMs: 240000 });

try {
  // 1. Standalone confirmation path wiring check:
  // Initial FAIL -> scoped PASS -> confirmation review raises FAIL_TASK_SIZE_UNCHANGED.
  // Enforcement demotes the unchanged task-size finding to notes, so confirmation PASSes.
  {
    const { repo, binDir } = setup("w-sa", "standalone", ["FAIL", "PASS", "FAIL_TASK_SIZE_UNCHANGED"]);
    const r = plan(repo, binDir);
    const rv = runs(repo, "plan_reviewer");
    const st = readState(repo);

    check("standalone wiring: exits 0 and reaches tasks_ready", r.status === 0 && st.phase === "tasks_ready", { status: r.status, phase: st.phase, err: r.stderr.slice(-300) });
    check("standalone wiring: three reviewer runs executed", rv.length === 3, rv.length);

    // Confirmation run is #3
    const confirmationRun = rv[2];
    check("standalone wiring: confirmation brief contains task-size confirmation rule line",
      confirmationRun?.brief.includes("Task-size rule in this confirmation review: raise a [RULE: task size] finding only for tasks changed since the last full review:"),
      confirmationRun?.brief.slice(-500));

    check("standalone wiring: state cleaned on accept", !st.planReviewConfirmation && !st.planReviewTaskHashes && !st.planReviewHistory);
  }

  // 2. SpecKit confirmation path wiring check:
  // Gate review-tasks confirmation review gets the task-size rule line and demotes unchanged task-size finding.
  {
    const { repo, binDir } = setup("w-sk", "speckit", ["PASS", "PASS", "FAIL", "PASS", "FAIL_TASK_SIZE_UNCHANGED"]);
    const r = plan(repo, binDir);
    const rv = runs(repo, "plan_reviewer");
    const st = readState(repo);

    check("speckit wiring: exits 0 and reaches tasks_ready", r.status === 0 && st.phase === "tasks_ready", { status: r.status, phase: st.phase, err: r.stderr.slice(-300) });
    check("speckit wiring: five reviewer runs executed (spec, plan, tasks: full, scoped, conf)", rv.length === 5, rv.length);

    // Confirmation run for review-tasks is run #5
    const confirmationRun = rv[4];
    check("speckit wiring: review-tasks confirmation brief contains task-size confirmation rule line",
      confirmationRun?.brief.includes("Task-size rule in this confirmation review: raise a [RULE: task size] finding only for tasks changed since the last full review:"),
      confirmationRun?.brief.slice(-500));

    check("speckit wiring: state cleaned on accept", !st.planReviewConfirmation && !st.planReviewTaskHashes && !st.planReviewHistory);
  }
} finally {
  cleanup(...dirs);
}

process.exit(failures ? 1 : 0);
