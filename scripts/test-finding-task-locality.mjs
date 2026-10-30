#!/usr/bin/env node
// TASK-20 step 1 — which task does each review finding concern? (record-only.)
//
// Part 1 (runs on every platform): the pure contract of
// scripts/finding-task-locality.mjs — label↔ordinal conversion, the
// declared → file → none resolution order, `affected`/`allMapped`, the
// 1:1 alignment with normalizeFindings(), the fail-closed load posture of the
// persisted record, and the `[T1]` label the reviewer's task list now carries.
//
// Part 2 (behavioural, all platforms): one real `node scripts/autopilot.mjs run` mission per
// framework whose Code Reviewer FAILs the phase with a STRUCTURED finding that
// names `T1`. The harness kills the whole process tree at the marker the
// retrying Implementer writes — the only instant at which the persisted
// finding→task record, the wiped roleProgress, and the retry brief that still
// carries every finding are all on disk at once. Both framework halves now run
// on every platform.
import fs from "node:fs";
import path from "node:path";
import {
  taskLabel, labelToIndex, mapFindingsToTasks, affectedTaskIds,
  recordFindingTasks, loadFindingTasks, carryDecision, findingsForTask,
  renderHandledFindings, HANDLED_FINDINGS_HEADING,
  clearFindingTasks, clearFindingTasksByPrefix,
  FINDING_TASKS_STATE_KEY,
} from "./finding-task-locality.mjs";
import {
  normalizeFindings, normalizeFindingsWithSource, saveReviewFeedback,
  loadReviewFeedback, MAX_FINDINGS, MAX_FINDING_CHARS, MAX_TOTAL_CHARS,
} from "./review-feedback.mjs";
import {buildStandaloneHandoff} from "./standalone-handoff.mjs";
import {phaseTaskDigest, CHECKPOINT_STATE_KEY} from "./phase-stage-checkpoint.mjs";
import {stableTaskIds} from "./role-progress-ids.mjs";
import {resolveStandaloneMission} from "./mission-naming.mjs";
import * as standalone from "../adapters/standalone.mjs";
import * as speckit from "../adapters/speckit.mjs";
import {
  makeFixtureRepo, makeFixtureBin, makeSpecKitWorkflowOnly, makeClaudeMdBaseline,
  setScenario, writeConfig, runAutopilot, runAutopilotUntilMarker, readObservedEvents, hangStarted, cleanup,
} from "./test-fixtures/workflow-order-harness.mjs";

const SCENARIO = "finding_task_locality";
const MARKER_NAME = ".autopilot-test-finding-task-locality-retry";
const PROBLEM = "Task T1 ships a stub with no implementation.";
const FINDING = {
  tasks: ["T1"],
  location: "docs/finding-task-locality.md",
  problem: PROBLEM,
  correction: "Replace the stub with the real implementation.",
};
const SPECKIT_TASK_CANDIDATES = [".specify/tasks.md", "specs/*/tasks.md", "specs/*/tasks/*.md"];
const REQUEST = "finding task locality fixture request";
// Native Windows' disposable-copy read-only role is a real filesystem copy per
// launch, so the same budget test-task14-speckit-task-marking.mjs gives a
// marker that fires after six planning roles: this marker fires after those
// six plus Implementer + Code Reviewer + the retrying Implementer.
const RUN_TIMEOUT_MS = process.platform === "win32" ? 240000 : 150000;

let ok = 0;
let failed = 0;

// AP_TEST_SHARD="k/n" (set by scripts/test-all.mjs, see suite-schedule.mjs)
// runs only every n-th end-to-end case below, starting at case k, so the
// cases can run in parallel; each case owns its own fixture repo. Unset runs
// every case, exactly as before.
const [shardIndex, shardCount] = (process.env.AP_TEST_SHARD ?? "0/1").split("/").map(Number);
if (!Number.isInteger(shardIndex) || !Number.isInteger(shardCount) || shardCount < 1 || shardIndex < 0 || shardIndex >= shardCount) {
  console.error(`Invalid AP_TEST_SHARD: ${process.env.AP_TEST_SHARD} (expected k/n with 0 <= k < n)`);
  process.exit(2);
}
let caseNumber = 0;
const inShard = () => caseNumber++ % shardCount === shardIndex;
function check(name, condition, evidence) {
  if (condition) { console.log(`PASS ${name}`); ok += 1; return; }
  console.error(`FAIL ${name}${evidence !== undefined ? ` :: ${JSON.stringify(evidence)}` : ""}`);
  failed += 1;
}
function skips(name, why) {
  console.log(`SKIP ${name} — ${why}`);
}
function readState(repo) {
  return JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
}
function briefsFor(repo, role) {
  return readObservedEvents(repo)
    .filter((e) => e.role === role)
    .map((e) => readBrief(path.join(path.dirname(e.file), "brief.txt")));
}
function readBrief(file) {
  try { return fs.readFileSync(file, "utf8"); }
  catch { return ""; }
}
// Every brief the mission ever wrote, including the ones from relay calls that
// never COMPLETED — the killed retry has a brief.txt but no result.json, so
// readObservedEvents() alone cannot see it.
function allBriefs(repo) {
  return walkFor(path.join(repo, ".autopilot"), "brief.txt").map(readBrief);
}
function walkFor(root, name, out = []) {
  if (!fs.existsSync(root)) return out;
  for (const entry of fs.readdirSync(root, {withFileTypes: true})) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) walkFor(full, name, out);
    else if (entry.name === name) out.push(full);
  }
  return out;
}
// Relay run folders are named `<seq>-<role>-<shortid>`; counting them proves a
// role launched N times even when the Nth launch was killed before it wrote its
// result.json.
function relayRunDirs(repo, role) {
  const pattern = new RegExp(`-${role}-[0-9a-f]{8}$`, "i");
  const found = [];
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (pattern.test(entry.name)) found.push(full);
      else walk(full);
    }
  })(path.join(repo, ".autopilot"));
  return found;
}
// The result.json each completed relay wrote to disk (a killed relay has none).
function runResults(repo, role) {
  return relayRunDirs(repo, role).map((dir) => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8")); }
    catch { return null; }
  }).filter(Boolean);
}

// Three task IDs, as the orchestrator would produce them (ordinal in the `T`
// segment, hash suffix), so every mapping assertion below is exercised against
// real-shaped IDs rather than "t1"/"t2" stand-ins.
const IDS = ["standalone:P1:T0:0123456789ab", "standalone:P1:T1:abcdef012345", "standalone:P1:T2:89abcdef0123"];
const FACTS = {
  [IDS[0]]: {files: ["src/a.js"]},
  [IDS[1]]: {files: ["src/a.js", "other.js"]},
  [IDS[2]]: {files: ["docs/readme.md"]},
};

// ══════════════════════════════════════════════════════════════════════
// 1. Label ↔ ordinal: the ONLY two places the 1-based label is converted.
// ══════════════════════════════════════════════════════════════════════
{
  check("label: taskLabel is 1-based", taskLabel(0) === "T1" && taskLabel(8) === "T9" && taskLabel(9) === "T10",
    [taskLabel(0), taskLabel(8), taskLabel(9)]);
  let threw = false;
  try { taskLabel(-1); } catch { threw = true; }
  check("label: taskLabel rejects a negative index", threw);
  threw = false;
  try { taskLabel(1.5); } catch { threw = true; }
  check("label: taskLabel rejects a non-integer index", threw);

  check("label: labelToIndex accepts bare and bracketed forms",
    labelToIndex("T3") === 2 && labelToIndex("t3") === 2 && labelToIndex("[T3]") === 2 && labelToIndex(" [T3] ") === 2,
    [labelToIndex("T3"), labelToIndex("t3"), labelToIndex("[T3]")]);
  check("label: labelToIndex rejects T0, full IDs, and junk",
    labelToIndex("T0") === -1 && labelToIndex("standalone:P1:T0:0123456789ab") === -1 &&
    labelToIndex("3") === -1 && labelToIndex("") === -1 && labelToIndex(null) === -1 &&
    labelToIndex("Task 3") === -1,
    [labelToIndex("T0"), labelToIndex("standalone:P1:T0:0123456789ab"), labelToIndex("3")]);
  check("label: unbalanced brackets are not a task reference",
    labelToIndex("[T3") === -1 && labelToIndex("T3]") === -1,
    [labelToIndex("[T3"), labelToIndex("T3]")]);
}

// ══════════════════════════════════════════════════════════════════════
// 2. Resolution: declared → file → phase → none, first hit wins, ONE owner.
// ══════════════════════════════════════════════════════════════════════
{
  const map = (findings) => mapFindingsToTasks({findings, taskIds: IDS, factsByTask: FACTS});

  const declaredByLabel = map([{...FINDING, tasks: ["T2"]}]);
  check("resolve: declared reviewer label resolves to that ordinal",
    declaredByLabel.length === 1 && declaredByLabel[0].source === "declared" &&
    JSON.stringify(declaredByLabel[0].taskIds) === JSON.stringify([IDS[1]]), declaredByLabel);

  const declaredById = map([{...FINDING, tasks: [IDS[2]]}]);
  check("resolve: a full stable task ID resolves directly",
    declaredById[0].source === "declared" && JSON.stringify(declaredById[0].taskIds) === JSON.stringify([IDS[2]]), declaredById);

  const declaredWithFile = map([{...FINDING, tasks: ["T3"], location: "src/a.js"}]);
  check("resolve: declared wins over a contradicting file location",
    declaredWithFile[0].source === "declared" &&
    JSON.stringify(declaredWithFile[0].taskIds) === JSON.stringify([IDS[2]]), declaredWithFile);

  const declaredMany = map([{...FINDING, tasks: ["T2", "T1"]}]);
  check("resolve: several declared tasks resolve to exactly the first in taskIds order",
    declaredMany.length === 1 && declaredMany[0].source === "declared" &&
    JSON.stringify(declaredMany[0].taskIds) === JSON.stringify([IDS[0]]), declaredMany);

  const unknown = map([{...FINDING, tasks: ["T9", "nope"]}]);
  check("resolve: invented labels are dropped, not guessed",
    unknown[0].source === "none" && unknown[0].taskIds.length === 0, unknown);

  const byFile = map([{location: "src/a.js:12", problem: "shared file"}]);
  check("resolve: a location several tasks own resolves to exactly the first in taskIds order",
    byFile[0].source === "file" && JSON.stringify(byFile[0].taskIds) === JSON.stringify([IDS[0]]), byFile);

  const backslashes = map([{location: "src\\a.js:12:4", problem: "windows authored path"}]);
  check("resolve: Windows separators and :line:col still match the ownership fact",
    backslashes[0].source === "file" && JSON.stringify(backslashes[0].taskIds) === JSON.stringify([IDS[0]]), backslashes);

  const single = map([{location: "./other.js", problem: "one owner"}]);
  check("resolve: a file owned by one task maps to exactly that task",
    single[0].source === "file" && JSON.stringify(single[0].taskIds) === JSON.stringify([IDS[1]]), single);

  const unowned = map([{location: "nope.js", problem: "nobody owns this"}]);
  check("resolve: a location no task owns maps to none, never a near-miss",
    unowned[0].source === "none" && unowned[0].taskIds.length === 0, unowned);

  const noLocation = map([{problem: "nowhere in particular"}]);
  check("resolve: an object with no location maps to none", noLocation[0].source === "none", noLocation);

  const plainString = map(["a plain string finding"]);
  check("resolve: a plain-string finding maps to none (no path to extract)",
    plainString.length === 1 && plainString[0].source === "none" && plainString[0].taskIds.length === 0, plainString);
}

// ══════════════════════════════════════════════════════════════════════
// 3. affected / allMapped — the fail-closed signal step 2 will read.
// ══════════════════════════════════════════════════════════════════════
{
  // First finding names T2 alone; the second matches two tasks by file.
  const entries = mapFindingsToTasks({
    findings: [{...FINDING, tasks: ["T2"]}, {location: "src/a.js:12", problem: "shared"}],
    taskIds: IDS, factsByTask: FACTS,
  });
  const {taskIds: affected, allMapped} = affectedTaskIds(entries, IDS);
  check("affected: the union is ordered by taskIds, never by finding order",
    JSON.stringify(affected) === JSON.stringify([IDS[0], IDS[1]]), affected);
  check("affected: fully mapped entries yield allMapped true", allMapped === true, {entries, allMapped});

  const withNone = mapFindingsToTasks({
    findings: [{...FINDING, tasks: ["T1"]}, {location: "nope.js", problem: "unattributable"}],
    taskIds: IDS, factsByTask: FACTS,
  });
  const partial = affectedTaskIds(withNone, IDS);
  check("affected: one unattributable finding fails allMapped closed, keeping what mapped",
    partial.allMapped === false && JSON.stringify(partial.taskIds) === JSON.stringify([IDS[0]]), partial);

  const empty = affectedTaskIds([], IDS);
  check("affected: ZERO findings is allMapped false — 'redo everything', not 'redo nothing'",
    empty.allMapped === false && empty.taskIds.length === 0, empty);

  const malformed = affectedTaskIds([{source: "declared"}], IDS);
  check("affected: a malformed entry fails closed instead of being trusted",
    malformed.allMapped === false && malformed.taskIds.length === 0, malformed);
}

// ══════════════════════════════════════════════════════════════════════
// 4. Alignment with normalizeFindings() — same entries kept, dropped, order.
// ══════════════════════════════════════════════════════════════════════
{
  const mixed = [
    {problem: "first", location: "src/a.js"},
    {location: "no problem statement at all"},   // dropped: no problem
    "a plain string",                            // kept
    {problem: "second", tasks: ["T3"]},
    null,                                        // dropped
    {problem: "third", location: "docs/readme.md"},
  ];
  const texts = normalizeFindings(mixed);
  const mapped = mapFindingsToTasks({findings: mixed, taskIds: IDS, factsByTask: FACTS});
  check("align: mapping is 1:1 with normalizeFindings on a mixed list",
    texts.length === mapped.length, {texts: texts.length, mapped: mapped.length});
  check("align: the drop does not shift the entries after it",
    mapped.length === 4 &&
    mapped[0].source === "file" && mapped[1].source === "none" &&
    mapped[2].source === "declared" && JSON.stringify(mapped[2].taskIds) === JSON.stringify([IDS[2]]) &&
    mapped[3].source === "file",
    mapped);

  const many = Array.from({length: MAX_FINDINGS + 5}, (_, i) => ({problem: `finding ${i}`}));
  check("align: both functions cap at MAX_FINDINGS identically",
    normalizeFindings(many).length === MAX_FINDINGS &&
    mapFindingsToTasks({findings: many, taskIds: IDS, factsByTask: FACTS}).length === MAX_FINDINGS,
    {normalized: normalizeFindings(many).length, mapped: mapFindingsToTasks({findings: many, taskIds: IDS, factsByTask: FACTS}).length});

  // MAX_FINDINGS × MAX_FINDING_CHARS > MAX_TOTAL_CHARS, so the whole-list
  // budget bites before MAX_FINDINGS does — and both functions must stop at
  // the same entry. Sized from the constants so a limit change keeps it valid.
  if (MAX_FINDINGS * MAX_FINDING_CHARS <= MAX_TOTAL_CHARS) throw new Error("fixture premise broken: the total budget can no longer bite");
  const heavy = Array.from({length: MAX_FINDINGS}, (_, i) => ({problem: `${i}`.padEnd(MAX_FINDING_CHARS, "x")}));
  const heavyNormalized = normalizeFindings(heavy);
  const heavyMapped = mapFindingsToTasks({findings: heavy, taskIds: IDS, factsByTask: FACTS});
  check("align: the whole-list character budget truncates both identically",
    heavyNormalized.length > 0 && heavyNormalized.length < MAX_FINDINGS &&
    heavyMapped.length === heavyNormalized.length,
    {normalized: heavyNormalized.length, mapped: heavyMapped.length});

  check("align: normalizeFindings is byte-identical to the sourced form",
    JSON.stringify(normalizeFindings(mixed)) === JSON.stringify(normalizeFindingsWithSource(mixed).map((e) => e.text)),
    normalizeFindings(mixed));
  check("align: the rendered feedback shape is unchanged",
    normalizeFindings([{location: "a.js", problem: "p", correction: "c"}, {problem: "only"}]).join("|") ===
    "a.js: p Required correction: c|only",
    normalizeFindings([{location: "a.js", problem: "p", correction: "c"}, {problem: "only"}]));
}

// ══════════════════════════════════════════════════════════════════════
// 5. The persisted record: round trip, then fail closed on every load.
// ══════════════════════════════════════════════════════════════════════
{
  const KEY = "standalone-phase:0";
  const DIGEST = "sha256:0123456789abcdef";
  const state = {};
  saveReviewFeedback(state, KEY, [FINDING]);
  // TASK-21: the FAIL sites record revision N (pre-transition) with
  // carryAllowed:true for a code-review FAIL. T2/T3 are unflagged and have
  // facts, so they land in `carry`; T1 is affected and must not.
  const RICH_FACTS = {
    [IDS[0]]: {summary: "t1", files: ["src/a.js"]},
    [IDS[1]]: {summary: "t2", files: ["other.js"]},
    [IDS[2]]: {summary: "t3", files: ["docs/readme.md"]},
  };
  const record = recordFindingTasks(state, KEY, {
    phaseTaskDigest: DIGEST, findings: [FINDING], taskIds: IDS, factsByTask: RICH_FACTS,
    revision: 1, carryAllowed: true,
  });

  check("record: written under the SAME key the feedback uses",
    Object.hasOwn(state[FINDING_TASKS_STATE_KEY], KEY) && Object.hasOwn(state.reviewFeedback, KEY),
    Object.keys(state[FINDING_TASKS_STATE_KEY] ?? {}));
  check("record: shape",
    record.phaseTaskDigest === DIGEST &&
    JSON.stringify(record.taskIds) === JSON.stringify(IDS) &&
    record.entries.length === 1 && record.entries[0].source === "declared" &&
    JSON.stringify(record.entries[0].taskIds) === JSON.stringify([IDS[0]]) &&
    JSON.stringify(record.affected) === JSON.stringify([IDS[0]]) &&
    record.allMapped === true && typeof record.at === "string",
    record);
  check("record: revision is the FAIL-time revision N",
    record.revision === 1, record.revision);
  check("record: carry holds exactly the unflagged tasks' facts",
    JSON.stringify(Object.keys(record.carry).sort()) === JSON.stringify([IDS[1], IDS[2]]) &&
    JSON.stringify(record.carry[IDS[1]]) === JSON.stringify(RICH_FACTS[IDS[1]]),
    record.carry);
  check("record: saving the map never disturbs the findings it describes",
    loadReviewFeedback(state, KEY).length === 1, loadReviewFeedback(state, KEY));

  const loaded = loadFindingTasks(state, KEY, {phaseTaskDigest: DIGEST});
  check("load: round trip returns the record", loaded !== null &&
    JSON.stringify(loaded.affected) === JSON.stringify([IDS[0]]) && loaded.allMapped === true &&
    loaded.revision === 1 &&
    JSON.stringify(loaded.carry) === JSON.stringify(record.carry), loaded);

  check("load: a foreign digest fails closed", loadFindingTasks(state, KEY, {phaseTaskDigest: `${DIGEST}x`}) === null);
  check("load: no digest offered fails closed", loadFindingTasks(state, KEY) === null);
  check("load: a missing slot fails closed", loadFindingTasks({}, KEY, {phaseTaskDigest: DIGEST}) === null);
  check("load: an unknown key fails closed", loadFindingTasks(state, "speckit-phase:0", {phaseTaskDigest: DIGEST}) === null);

  const misaligned = JSON.parse(JSON.stringify(state));
  misaligned[FINDING_TASKS_STATE_KEY][KEY].entries = [];   // tampered: no longer 1:1 with the findings
  check("load: an entry list that no longer matches the stored findings fails closed",
    loadFindingTasks(misaligned, KEY, {phaseTaskDigest: DIGEST}) === null);

  const malformed = JSON.parse(JSON.stringify(state));
  malformed[FINDING_TASKS_STATE_KEY][KEY].taskIds = "not-an-array";
  check("load: a malformed slot fails closed", loadFindingTasks(malformed, KEY, {phaseTaskDigest: DIGEST}) === null);

  const dangling = JSON.parse(JSON.stringify(state));
  dangling[FINDING_TASKS_STATE_KEY][KEY].affected = ["standalone:P1:T9:ffffffffffff"];
  check("load: an affected id outside the record's own task list fails closed",
    loadFindingTasks(dangling, KEY, {phaseTaskDigest: DIGEST}) === null);

  clearFindingTasks(state, KEY);
  check("clear: removes the record and leaves the findings alone",
    !Object.hasOwn(state[FINDING_TASKS_STATE_KEY], KEY) && loadReviewFeedback(state, KEY).length === 1,
    state[FINDING_TASKS_STATE_KEY]);

  const prefixed = {};
  saveReviewFeedback(prefixed, "standalone-task:1", [FINDING]);
  recordFindingTasks(prefixed, "standalone-task:1", {phaseTaskDigest: DIGEST, findings: [FINDING], taskIds: IDS, factsByTask: FACTS, revision: 1, carryAllowed: true});
  saveReviewFeedback(prefixed, "standalone-phase:0", [FINDING]);
  recordFindingTasks(prefixed, "standalone-phase:0", {phaseTaskDigest: DIGEST, findings: [FINDING], taskIds: IDS, factsByTask: FACTS, revision: 1, carryAllowed: true});
  clearFindingTasksByPrefix(prefixed, "standalone-task:");
  check("clear: the prefix clear takes the task slots and keeps the phase slot",
    !Object.hasOwn(prefixed[FINDING_TASKS_STATE_KEY], "standalone-task:1") &&
    Object.hasOwn(prefixed[FINDING_TASKS_STATE_KEY], "standalone-phase:0"),
    Object.keys(prefixed[FINDING_TASKS_STATE_KEY]));
}

// ══════════════════════════════════════════════════════════════════════
// 6. The standalone reviewer prompt shows the same labels, without a run.
// ══════════════════════════════════════════════════════════════════════
{
  const tasks = [
    {file: "/repo/TASKS.md", line: 3, text: "Do the thing"},
    {file: "/repo/TASKS.md", line: 4, text: "Then the other"},
  ];
  const handoff = buildStandaloneHandoff({
    kind: "PHASE_REVIEW", phaseName: "Phase 1 — Build", phaseIndex: 0, phaseTotal: 1,
    phaseTasks: tasks, attempt: 1, deltaChunks: [{path: "a.js", text: "diff --git a/a.js b/a.js\n+one"}],
    baselineKey: "k", declaredPaths: [], implementationSummary: "",
  });
  check("prompt: the standalone phase reviewer sees [T1] and [T2] against the right files",
    handoff.text.includes("- [T1] Do the thing (/repo/TASKS.md:3)") &&
    handoff.text.includes("- [T2] Then the other (/repo/TASKS.md:4)"),
    (handoff.text.match(/Tasks:\n[\s\S]{0,220}/) || [])[0]);
  check("prompt: the tag is on the task line, not the prose",
    !/\[T1\]Review the whole phase/.test(handoff.text), handoff.text.slice(0, 200));
}

// ══════════════════════════════════════════════════════════════════════
// 7. TASK-21 carry forward: the record's revision/carry and carryDecision().
// ══════════════════════════════════════════════════════════════════════
{
  const DIGEST = "sha256:0123456789abcdef";
  const TAGGED_T2 = [{tasks: ["T2"], location: "docs/x.md", problem: "t2 is wrong", correction: "fix t2"}];
  const TAGGED_T1 = [{tasks: ["T1"], location: "docs/x.md", problem: "t1 is wrong", correction: "fix t1"}];
  const PLAIN = ["a plain string finding"];
  const FACTS_ALL = {
    [IDS[0]]: {summary: "t1 done", files: ["src/a.js"], taskLocalCheck: {command: "true", status: "passed", exitCode: 0, summary: "ok"}},
    [IDS[1]]: {summary: "t2 done", files: ["other.js"], taskLocalCheck: {command: "true", status: "passed", exitCode: 0, summary: "ok"}},
    [IDS[2]]: {summary: "t3 done", files: ["docs/readme.md"]},
  };
  const KEY = "standalone-phase:0";
  const makeState = (findings, facts, revision, carryAllowed) => {
    const st = {};
    saveReviewFeedback(st, KEY, findings);
    const rec = recordFindingTasks(st, KEY, {
      phaseTaskDigest: DIGEST, findings, taskIds: IDS, factsByTask: facts, revision, carryAllowed,
    });
    return {st, rec};
  };
  const slotOf = (st) => st[FINDING_TASKS_STATE_KEY][KEY];
  const progressWith = (completed, factsByTask) => ({
    implementer: {completedTaskIds: [...completed], factsByTask: {...factsByTask}},
  });
  const decide = (st, taskId, completed, factsByTask, revision, digest = DIGEST) =>
    carryDecision({
      record: loadFindingTasks(st, KEY, {phaseTaskDigest: DIGEST}),
      taskId, progress: progressWith(completed, factsByTask), revision, phaseTaskDigest: digest,
    });

  // Happy path: T2 named, T1/T3 replayable on the N+1 revision.
  {
    const {st, rec} = makeState(TAGGED_T2, FACTS_ALL, 1, true);
    check("carry: record holds exactly the unflagged tasks",
      JSON.stringify(Object.keys(rec.carry).sort()) === JSON.stringify([IDS[0], IDS[2]]), Object.keys(rec.carry));
    const d = decide(st, IDS[0], [], {}, 2);
    check("carry: happy path carries with a copy of the facts",
      d.carry === true && d.reason === "carry" &&
      JSON.stringify(d.facts) === JSON.stringify(FACTS_ALL[IDS[0]]), d);
  }

  // Each no-carry condition.
  {
    const {st} = makeState(TAGGED_T2, FACTS_ALL, 1, true);
    check("carry: null record never carries",
      carryDecision({record: null, taskId: IDS[0], progress: progressWith([], {}), revision: 2, phaseTaskDigest: DIGEST}).carry === false);
    check("carry: same revision N never carries",
      decide(st, IDS[0], [], {}, 1).reason === "revision-mismatch" && decide(st, IDS[0], [], {}, 1).carry === false);
    check("carry: revision N+2 never carries",
      decide(st, IDS[0], [], {}, 3).reason === "revision-mismatch" && decide(st, IDS[0], [], {}, 3).carry === false);
    check("carry: a task in affected never carries",
      decide(st, IDS[1], [], {}, 2).reason === "affected" && decide(st, IDS[1], [], {}, 2).carry === false);
    check("carry: a foreign digest never carries",
      decide(st, IDS[0], [], {}, 2, `${DIGEST}x`).reason === "digest-mismatch");
    check("carry: malformed progress never carries",
      carryDecision({record: loadFindingTasks(st, KEY, {phaseTaskDigest: DIGEST}), taskId: IDS[0], progress: {}, revision: 2, phaseTaskDigest: DIGEST}).reason === "bad-progress");
  }

  // allMapped:false and carryAllowed:false both mean redo everything.
  {
    const untagged = makeState(PLAIN, FACTS_ALL, 1, true);
    check("carry: allMapped false records empty carry",
      untagged.rec.allMapped === false && JSON.stringify(untagged.rec.carry) === JSON.stringify({}), untagged.rec);
    check("carry: allMapped false never carries",
      decide(untagged.st, IDS[0], [], {}, 2).carry === false);
    const disallowed = makeState(TAGGED_T2, FACTS_ALL, 1, false);
    check("carry: carryAllowed false records empty carry",
      JSON.stringify(disallowed.rec.carry) === JSON.stringify({}), disallowed.rec.carry);
    check("carry: carryAllowed false never carries",
      decide(disallowed.st, IDS[0], [], {}, 2).carry === false);
    const omitted = makeState(TAGGED_T2, FACTS_ALL, 1, undefined);
    check("carry: omitted carryAllowed records empty carry",
      JSON.stringify(omitted.rec.carry) === JSON.stringify({}), omitted.rec.carry);
    // c-gap 2: the verifier FAIL sites now pass carryAllowed:true even when
    // the gate command is red, so the ONLY thing that keeps a gate failure
    // from narrowing the retry is `allMapped` — and an EMPTY entry list
    // (a red gate with no findings at all) fails it closed.
    const noFindings = makeState([], FACTS_ALL, 1, true);
    check("carry: no findings with carryAllowed true still records empty carry",
      noFindings.rec.allMapped === false && JSON.stringify(noFindings.rec.carry) === JSON.stringify({}), noFindings.rec);
    check("carry: no findings with carryAllowed true never carries",
      decide(noFindings.st, IDS[0], [], {}, 2).carry === false);
    const unmapped = makeState(PLAIN, FACTS_ALL, 1, true);
    check("carry: any unmapped finding with carryAllowed true still records empty carry",
      unmapped.rec.allMapped === false && JSON.stringify(unmapped.rec.carry) === JSON.stringify({}), unmapped.rec);
  }

  // Overlap rule: a redone fix that touched a carried task's file re-runs it.
  {
    const facts = {
      [IDS[0]]: {summary: "t1", files: ["src/a.js"]},
      [IDS[1]]: {summary: "t2", files: ["other.js"]},
      [IDS[2]]: {summary: "t3", files: ["shared.js"]},
    };
    const {st} = makeState(TAGGED_T1, facts, 4, true);
    // T1 (affected) already redone in the current revision, owning shared.js.
    const current = {[IDS[0]]: {summary: "t1 redo", files: ["src/a.js", "shared.js"]}};
    check("carry: overlap with an already-redone affected task re-runs",
      decide(st, IDS[2], [IDS[0]], current, 5).reason === "overlap");
    check("carry: a disjoint task still carries",
      decide(st, IDS[1], [IDS[0]], current, 5).carry === true);
    // Not-yet-run affected tasks cannot overlap (known limit: the
    // whole-phase review after the retry is the backstop).
    check("carry: an affected task that has not run yet does not block",
      decide(st, IDS[2], [], {}, 5).carry === true);
  }

  // The overlap check normalizes :line and backslashes.
  {
    const facts = {
      [IDS[0]]: {summary: "t1", files: ["src/a.js"]},
      [IDS[2]]: {summary: "t3", files: ["src/a.js"]},
    };
    const {st} = makeState(TAGGED_T1, facts, 1, true);
    const current = {[IDS[0]]: {summary: "t1 redo", files: ["src\\a.js:12:4"]}};
    check("carry: overlap normalizes backslashes and :line:col",
      decide(st, IDS[2], [IDS[0]], current, 2).reason === "overlap");
  }

  // Rule 3, second half: a known-failed local check is re-run, never carried.
  {
    const facts = {
      [IDS[1]]: {summary: "t2", files: ["other.js"], taskLocalCheck: {command: "lint", status: "failed", exitCode: 1, summary: "lint failed"}},
      [IDS[2]]: {summary: "t3", files: ["docs/readme.md"], taskLocalCheck: {command: "lint", status: "passed", exitCode: 0, summary: "ok"}},
    };
    const {st} = makeState(TAGGED_T1, facts, 1, true);
    check("carry: taskLocalCheck failed is re-run, never carried",
      decide(st, IDS[1], [], {}, 2).reason === "local-check-failed");
    check("carry: taskLocalCheck passed still carries",
      decide(st, IDS[2], [], {}, 2).carry === true);
  }

  // facts is a copy: mutating it leaves the record unchanged.
  {
    const {st} = makeState(TAGGED_T2, FACTS_ALL, 1, true);
    const first = decide(st, IDS[0], [], {}, 2);
    first.facts.files.push("evil.js");
    first.facts.summary = "mutated";
    const second = decide(st, IDS[0], [], {}, 2);
    check("carry: returned facts are a copy",
      second.carry === true &&
      JSON.stringify(second.facts) === JSON.stringify(FACTS_ALL[IDS[0]]), second.facts);
  }

  // Load fails closed on the new fields.
  {
    const {st} = makeState(TAGGED_T2, FACTS_ALL, 1, true);
    const tamperedSummary = JSON.parse(JSON.stringify(st));
    tamperedSummary[FINDING_TASKS_STATE_KEY][KEY].carry[IDS[0]] = {files: ["x.js"]};
    check("carry: a carry entry without a summary loads as empty carry",
      JSON.stringify(loadFindingTasks(tamperedSummary, KEY, {phaseTaskDigest: DIGEST}).carry) === JSON.stringify({}));
    const tamperedFiles = JSON.parse(JSON.stringify(st));
    tamperedFiles[FINDING_TASKS_STATE_KEY][KEY].carry[IDS[0]] = {summary: "t", files: "not-an-array"};
    check("carry: a carry entry without a files array loads as empty carry",
      JSON.stringify(loadFindingTasks(tamperedFiles, KEY, {phaseTaskDigest: DIGEST}).carry) === JSON.stringify({}));
    const tamperedKey = JSON.parse(JSON.stringify(st));
    tamperedKey[FINDING_TASKS_STATE_KEY][KEY].carry["standalone:P1:T9:ffffffffffff"] = {summary: "t", files: []};
    check("carry: a carry key outside taskIds loads as empty carry",
      JSON.stringify(loadFindingTasks(tamperedKey, KEY, {phaseTaskDigest: DIGEST}).carry) === JSON.stringify({}));
    const tamperedAffected = JSON.parse(JSON.stringify(st));
    tamperedAffected[FINDING_TASKS_STATE_KEY][KEY].carry[IDS[1]] = {summary: "t", files: []};
    check("carry: a carry key inside affected loads as empty carry",
      JSON.stringify(loadFindingTasks(tamperedAffected, KEY, {phaseTaskDigest: DIGEST}).carry) === JSON.stringify({}));
    const tooLong = JSON.parse(JSON.stringify(st));
    tooLong[FINDING_TASKS_STATE_KEY][KEY].carry[IDS[0]] = {summary: "x".repeat(2001), files: []};
    check("carry: an over-long summary loads as empty carry",
      JSON.stringify(loadFindingTasks(tooLong, KEY, {phaseTaskDigest: DIGEST}).carry) === JSON.stringify({}));
    const noRevision = JSON.parse(JSON.stringify(st));
    delete noRevision[FINDING_TASKS_STATE_KEY][KEY].revision;
    check("carry: a record without a revision (pre-step-2) fails closed to null",
      loadFindingTasks(noRevision, KEY, {phaseTaskDigest: DIGEST}) === null);
    const unrevisioned = makeState(TAGGED_T2, FACTS_ALL, undefined, true);
    check("carry: recording without a revision is unloadable",
      loadFindingTasks(unrevisioned.st, KEY, {phaseTaskDigest: DIGEST}) === null);
  }
}

// ══════════════════════════════════════════════════════════════════════
// 7b. TASK-22: the explicit phase-wide tag, the allow-list, and the load
// recompute. Plus the review-contract wording pins.
// ══════════════════════════════════════════════════════════════════════
{
  const DIGEST = "sha256:fedcba9876543210";
  const KEY = "standalone-phase:0";
  const OWNED = {
    [IDS[0]]: {files: ["src/a.js"]},
    [IDS[1]]: {files: ["other.js"]},
    [IDS[2]]: {files: ["docs/readme.md"]},
  };
  const map = (findings, factsByTask = OWNED) =>
    mapFindingsToTasks({findings, taskIds: IDS, factsByTask});
  const record = (findings, factsByTask = OWNED, revision = 1, carryAllowed = true) => {
    const st = {};
    saveReviewFeedback(st, KEY, findings);
    const rec = recordFindingTasks(st, KEY, {
      phaseTaskDigest: DIGEST, findings, taskIds: IDS, factsByTask, revision, carryAllowed,
    });
    return {st, rec};
  };

  // 1. `tasks: []` loses to a cited file a task owns (c-gap 1): the file
  // match is evidence about that task, the empty tag is not. The finding only
  // stays `source:"phase"` when no location is given or no task owns the file.
  {
    const phase = map([{tasks: [], location: "src/a.js:12", problem: "wiring"}]);
    check("phase: an explicit empty tag with a file exactly one task owns resolves to that task",
      phase.length === 1 && phase[0].source === "file" &&
      JSON.stringify(phase[0].taskIds) === JSON.stringify([IDS[0]]), phase);
    const bare = map([{tasks: [], problem: "wiring"}]);
    check("phase: an explicit empty tag with no location stays phase",
      bare.length === 1 && bare[0].source === "phase" && bare[0].taskIds.length === 0, bare);
    const unowned = map([{tasks: [], location: "nope.js", problem: "wiring"}]);
    check("phase: an explicit empty tag with a file no task owns stays phase",
      unowned.length === 1 && unowned[0].source === "phase" && unowned[0].taskIds.length === 0, unowned);
  }

  // 2. Missing `tasks`: no file match → "none"; file match → "file".
  // Unknown-only labels fall through to the file fallback, then to "none".
  {
    check("phase: missing tag with no file match is reviewer error (none)",
      map([{location: "nope.js", problem: "x"}])[0].source === "none");
    check("phase: missing tag with a file match still resolves by file",
      JSON.stringify(map([{location: "other.js", problem: "x"}])[0]) ===
      JSON.stringify({taskIds: [IDS[1]], source: "file"}));
    const unknownFile = map([{tasks: ["T5"], location: "other.js", problem: "x"}]);
    check("phase: unknown-only labels fall through to the file fallback",
      unknownFile[0].source === "file" &&
      JSON.stringify(unknownFile[0].taskIds) === JSON.stringify([IDS[1]]), unknownFile);
    const unknownNone = map([{tasks: ["T5"], location: "nope.js", problem: "x"}]);
    check("phase: unknown-only labels with no file match resolve to none",
      unknownNone[0].source === "none" && unknownNone[0].taskIds.length === 0, unknownNone);
  }

  // 4c. `["T5"]` in a 3-task phase is "none"; `["T1","T5"]` is declared T1.
  {
    check("phase: [T5] alone in a T1-T3 phase is none",
      map([{tasks: ["T5"], problem: "x"}])[0].source === "none");
    const mixed = map([{tasks: ["T1", "T5"], problem: "x"}]);
    check("phase: [T1,T5] resolves to declared T1 only",
      mixed[0].source === "declared" &&
      JSON.stringify(mixed[0].taskIds) === JSON.stringify([IDS[0]]), mixed);
  }

  // 3. `affectedTaskIds`: "phase" fails allMapped closed; mixed
  // declared+phase unions the declared task and reports false.
  {
    const only = affectedTaskIds([{taskIds: [], source: "phase"}], IDS);
    check("phase: a phase entry yields allMapped false and no affected tasks",
      only.allMapped === false && only.taskIds.length === 0, only);
    const mixed = affectedTaskIds(
      [{taskIds: [IDS[1]], source: "declared"}, {taskIds: [], source: "phase"}], IDS);
    check("phase: declared+phase unions the declared task with allMapped false",
      mixed.allMapped === false &&
      JSON.stringify(mixed.taskIds) === JSON.stringify([IDS[1]]), mixed);
    const declaredEmpty = affectedTaskIds([{taskIds: [], source: "declared"}], IDS);
    check("phase: the allow-list also rejects an empty declared entry",
      declaredEmpty.allMapped === false, declaredEmpty);
  }

  // 4. Load accepts "phase" records and rejects unknown sources; a stored
  // allMapped:true next to a "phase"/"none" entry fails closed to null.
  {
    const {st} = record([
      {tasks: ["T2"], location: "docs/x.md", problem: "t2", correction: "fix"},
      {tasks: [], location: "docs/x.md", problem: "wiring", correction: "rewire"},
    ]);
    const loaded = loadFindingTasks(st, KEY, {phaseTaskDigest: DIGEST});
    check("phase: a record containing a phase entry loads",
      loaded !== null && loaded.allMapped === false &&
      loaded.entries[1].source === "phase" &&
      JSON.stringify(loaded.affected) === JSON.stringify([IDS[1]]), loaded);

    const unknown = JSON.parse(JSON.stringify(st));
    unknown[FINDING_TASKS_STATE_KEY][KEY].entries[1].source = "someday";
    check("phase: an unknown source still fails closed to null",
      loadFindingTasks(unknown, KEY, {phaseTaskDigest: DIGEST}) === null);

    const liedPhase = JSON.parse(JSON.stringify(st));
    liedPhase[FINDING_TASKS_STATE_KEY][KEY].allMapped = true;
    check("phase: stored allMapped:true next to a phase entry returns null",
      loadFindingTasks(liedPhase, KEY, {phaseTaskDigest: DIGEST}) === null);

    const {st: plain} = record(["a plain string finding"]);
    const liedNone = JSON.parse(JSON.stringify(plain));
    liedNone[FINDING_TASKS_STATE_KEY][KEY].allMapped = true;
    check("phase: stored allMapped:true next to a none entry returns null",
      loadFindingTasks(liedNone, KEY, {phaseTaskDigest: DIGEST}) === null);

    const reordered = JSON.parse(JSON.stringify(st));
    reordered[FINDING_TASKS_STATE_KEY][KEY].affected = [IDS[1]];
    check("phase: a matching recompute still loads (sanity)",
      loadFindingTasks(reordered, KEY, {phaseTaskDigest: DIGEST}) !== null);
  }

  // 4b (unit). One declared-T1 entry plus one phase entry carries nothing.
  {
    const {st} = record([
      {tasks: ["T1"], location: "docs/x.md", problem: "t1", correction: "fix"},
      {tasks: [], problem: "wiring", correction: "rewire"},
    ], {
      [IDS[0]]: {summary: "t1", files: ["src/a.js"]},
      [IDS[1]]: {summary: "t2", files: ["other.js"]},
      [IDS[2]]: {summary: "t3", files: ["docs/readme.md"]},
    });
    const loaded = loadFindingTasks(st, KEY, {phaseTaskDigest: DIGEST});
    check("phase: declared+phase records empty carry",
      loaded !== null && JSON.stringify(loaded.carry) === JSON.stringify({}), loaded?.carry);
    for (const id of IDS) {
      const d = carryDecision({
        record: loaded, taskId: id,
        progress: {implementer: {completedTaskIds: [], factsByTask: {}}},
        revision: 2, phaseTaskDigest: DIGEST,
      });
      check(`phase: declared+phase carries nothing (task ${id})`, d.carry === false, d);
    }
  }

  // 4d. Legacy state: null without throwing, and carryDecision says no.
  {
    const noCarry = (record) => carryDecision({
      record, taskId: IDS[0],
      progress: {implementer: {completedTaskIds: [], factsByTask: {}}},
      revision: 2, phaseTaskDigest: DIGEST,
    });
    check("legacy: no reviewFindingTasks key loads null",
      loadFindingTasks({}, KEY, {phaseTaskDigest: DIGEST}) === null);
    check("legacy: no key means carryDecision says no",
      noCarry(loadFindingTasks({}, KEY, {phaseTaskDigest: DIGEST})).carry === false);

    const era20 = {};
    saveReviewFeedback(era20, KEY, [{tasks: ["T1"], problem: "t1", correction: "fix"}]);
    era20[FINDING_TASKS_STATE_KEY] = {[KEY]: {
      phaseTaskDigest: DIGEST, taskIds: [...IDS],
      entries: [{taskIds: [IDS[0]], source: "declared"}],
      affected: [IDS[0]], allMapped: true, at: new Date().toISOString(),
    }};
    check("legacy: a TASK-20-era record (no revision/carry) loads null",
      loadFindingTasks(era20, KEY, {phaseTaskDigest: DIGEST}) === null);
    check("legacy: TASK-20-era means carryDecision says no",
      noCarry(loadFindingTasks(era20, KEY, {phaseTaskDigest: DIGEST})).carry === false);

    const strings = {};
    saveReviewFeedback(strings, KEY, [{tasks: ["T1"], problem: "t1", correction: "fix"}]);
    strings[FINDING_TASKS_STATE_KEY] = {[KEY]: {
      phaseTaskDigest: DIGEST, taskIds: [...IDS],
      entries: ["declared"], affected: [IDS[0]], allMapped: true,
      revision: 1, carry: {},
    }};
    check("legacy: entries holding plain strings load null without throwing",
      loadFindingTasks(strings, KEY, {phaseTaskDigest: DIGEST}) === null);

    const unknownSource = {};
    saveReviewFeedback(unknownSource, KEY, [{tasks: ["T1"], problem: "t1", correction: "fix"}]);
    unknownSource[FINDING_TASKS_STATE_KEY] = {[KEY]: {
      phaseTaskDigest: DIGEST, taskIds: [...IDS],
      entries: [{taskIds: [IDS[0]], source: "someday"}], affected: [IDS[0]],
      allMapped: true, revision: 1, carry: {},
    }};
    check("legacy: entries with an unknown source load null",
      loadFindingTasks(unknownSource, KEY, {phaseTaskDigest: DIGEST}) === null);

    const noFlag = {};
    saveReviewFeedback(noFlag, KEY, [{tasks: ["T1"], problem: "t1", correction: "fix"}]);
    noFlag[FINDING_TASKS_STATE_KEY] = {[KEY]: {
      phaseTaskDigest: DIGEST, taskIds: [...IDS],
      entries: [{taskIds: [IDS[0]], source: "declared"}], affected: [IDS[0]],
      revision: 1, carry: {},
    }};
    check("legacy: a missing allMapped loads null",
      loadFindingTasks(noFlag, KEY, {phaseTaskDigest: DIGEST}) === null);
    check("legacy: missing allMapped means carryDecision says no",
      noCarry(loadFindingTasks(noFlag, KEY, {phaseTaskDigest: DIGEST})).carry === false);
  }

  // 5. The review contract requires tags when labels are shown.
  {
    const contract = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
    check("contract: findings must tag tasks when labels are shown",
      contract.includes('every finding MUST include "tasks"'), contract.slice(1194, 200));
    check("contract: no labels means omit the tag",
      contract.includes('show no [Tn] task labels at all, omit "tasks"'));
    check("contract: the old optional-tasks sentence is gone",
      !contract.includes('The optional "tasks" field'));
    check("contract: the tagged example is kept",
      contract.includes('{"tasks":["T1"]'));
  }
}

// ══════════════════════════════════════════════════════════════════════
// 7c. TASK-24: findingsForTask() — each re-run task gets only its own
// findings plus every phase-wide/unlinked one. Plus the overlap detail
// on carryDecision().
// ══════════════════════════════════════════════════════════════════════
{
  const DIGEST = "sha256:0123456789abcdef";
  const KEY = "standalone-phase:0";
  const makeRecord = (rawFindings, facts = FACTS, revision = 1, carryAllowed = true) => {
    const st = {};
    saveReviewFeedback(st, KEY, rawFindings);
    const rec = recordFindingTasks(st, KEY, {
      phaseTaskDigest: DIGEST, findings: rawFindings, taskIds: IDS, factsByTask: facts,
      revision, carryAllowed,
    });
    const findings = loadReviewFeedback(st, KEY);
    const record = loadFindingTasks(st, KEY, {phaseTaskDigest: DIGEST});
    return {st, rec, findings, record};
  };
  const decide = (record, taskId, extra = {}) => carryDecision({
    record, taskId,
    progress: {implementer: {completedTaskIds: [], factsByTask: {}}},
    revision: 2, phaseTaskDigest: DIGEST, ...extra,
  });

  // A declared T1 finding plus a declared T2 finding → T1 gets only its own.
  {
    const raw = [
      {tasks: ["T1"], location: "docs/a.md", problem: "t1 wrong", correction: "fix t1"},
      {tasks: ["T2"], location: "docs/a.md", problem: "t2 wrong", correction: "fix t2"},
    ];
    const {findings, record} = makeRecord(raw);
    const g = findingsForTask({findings, record, taskId: IDS[0], revision: 2});
    check("per-task: T1 gets only its own declared finding",
      g.fallback === false && g.own.length === 1 && g.own[0] === findings[0] &&
      g.phaseWide.length === 0 && g.unlinked.length === 0, g);
    const g2 = findingsForTask({findings, record, taskId: IDS[1], revision: 2});
    check("per-task: T2 gets only its own declared finding",
      g2.fallback === false && g2.own.length === 1 && g2.own[0] === findings[1], g2);
  }

  // A "file" finding citing a shared file → exactly the first owner gets it.
  {
    const raw = [{location: "src/a.js:12", problem: "shared file"}];
    const {findings, record} = makeRecord(raw);
    check("per-task: record maps the shared file to exactly one task",
      record.entries[0].source === "file" && record.entries[0].taskIds.length === 1 &&
      record.entries[0].taskIds[0] === IDS[0], record.entries);
    const owner = findingsForTask({findings, record, taskId: IDS[0], revision: 2});
    check("per-task: the shared file finding reaches its one owner",
      owner.fallback === false && owner.own.length === 1 && owner.own[0] === findings[0] &&
      owner.handled.length === 0, owner);
    // Every task that does not own the file gets the finding ONLY as
    // read-only `handled` context, labelled with the single owner — never
    // as work, and never silently dropped.
    for (const id of [IDS[1], IDS[2]]) {
      const other = findingsForTask({findings, record, taskId: id, revision: 2});
      check(`per-task: a non-owner (${id}) sees the shared file finding as read-only handled`,
        other.fallback === false && other.own.length === 0 && other.phaseWide.length === 0 &&
        other.unlinked.length === 0 && other.handled.length === 1 &&
        other.handled[0].taskLabel === "T1" && other.handled[0].finding === findings[0], other);
    }
  }

  // "phase" lands in phaseWide and "none" lands in unlinked, never swapped,
  // and every task gets both; an unknown source lands in unlinked.
  {
    const raw = [
      {tasks: [], location: "docs/w.md", problem: "wiring", correction: "rewire"},
      {location: "nope.js", problem: "nowhere"},
    ];
    const {findings, record} = makeRecord(raw);
    check("per-task: fixture sources are phase then none",
      record.entries[0].source === "phase" && record.entries[1].source === "none", record.entries);
    for (const id of IDS) {
      const g = findingsForTask({findings, record, taskId: id, revision: 2});
      check(`per-task: every task gets the phase-wide finding (${id})`,
        g.fallback === false && g.own.length === 0 &&
        g.phaseWide.length === 1 && g.phaseWide[0] === findings[0] &&
        g.unlinked.length === 1 && g.unlinked[0] === findings[1] &&
        g.handled.length === 0, g);
    }
    const tampered = JSON.parse(JSON.stringify(record));
    tampered.entries[0].source = "someday";
    const g = findingsForTask({findings, record: tampered, taskId: IDS[0], revision: 2});
    check("per-task: an unknown future source lands in unlinked, never phase-wide",
      g.fallback === false && g.phaseWide.length === 0 &&
      g.unlinked.length === 2 &&
      g.unlinked[0] === findings[0] && g.unlinked[1] === findings[1] &&
      g.handled.length === 0, g);
  }

  // A declared finding for another task is no work for this task, and
  // read-only context (mission 052 (a)).
  {
    const raw = [{tasks: ["T2"], location: "docs/x.md", problem: "t2 only", correction: "fix"}];
    const {findings, record} = makeRecord(raw);
    const g = findingsForTask({findings, record, taskId: IDS[0], revision: 2});
    check("per-task: another task's declared finding is dropped from every action group",
      g.fallback === false && g.own.length === 0 && g.phaseWide.length === 0 && g.unlinked.length === 0, g);
    check("per-task: another task's declared finding appears only in handled",
      g.handled.length === 1 && g.handled[0].taskLabel === "T2" &&
      g.handled[0].finding === findings[0], g.handled);
    const owner = findingsForTask({findings, record, taskId: IDS[1], revision: 2});
    check("per-task: the owner gets it in own and nothing in handled",
      owner.fallback === false && owner.own.length === 1 && owner.own[0] === findings[0] &&
      owner.phaseWide.length === 0 && owner.unlinked.length === 0 && owner.handled.length === 0, owner);
  }

  // carryDecision's overlap result carries overlap.taskIds/files; others unchanged.
  {
    const facts = {
      [IDS[0]]: {summary: "t1", files: ["src/a.js"]},
      [IDS[1]]: {summary: "t2", files: ["other.js"]},
      [IDS[2]]: {summary: "t3", files: ["shared.js"]},
    };
    const raw = [{tasks: ["T1"], location: "docs/x.md", problem: "t1", correction: "fix"}];
    const {record} = makeRecord(raw, facts, 4, true);
    const current = {[IDS[0]]: {summary: "t1 redo", files: ["src/a.js", "shared.js"]}};
    const d = carryDecision({
      record, taskId: IDS[2],
      progress: {implementer: {completedTaskIds: [IDS[0]], factsByTask: current}},
      revision: 5, phaseTaskDigest: DIGEST,
    });
    check("per-task: overlap carries the colliding task and file",
      d.carry === false && d.reason === "overlap" &&
      JSON.stringify(d.overlap.taskIds) === JSON.stringify([IDS[0]]) &&
      d.overlap.files.length === 1 && d.overlap.files[0] === "shared.js", d);
    const ok = decide(record, IDS[1], {
      progress: {implementer: {completedTaskIds: [IDS[0]], factsByTask: current}},
      revision: 5,
    });
    check("per-task: disjoint task still carries with no overlap field",
      ok.carry === true && ok.reason === "carry" && ok.overlap === undefined, ok);
  }

  // Each fallback case → all findings in own with fallback:true.
  {
    const raw = [
      {tasks: ["T1"], location: "docs/x.md", problem: "t1", correction: "fix"},
      {tasks: ["T2"], location: "docs/x.md", problem: "t2", correction: "fix"},
    ];
    const {findings} = makeRecord(raw);
    const nullRec = findingsForTask({findings, record: null, taskId: IDS[0], revision: 2});
    check("per-task: null record falls back to all findings",
      nullRec.fallback === true && JSON.stringify(nullRec.own) === JSON.stringify(findings) &&
      nullRec.handled.length === 0, nullRec);
    const {record} = makeRecord(raw);
    const wrongRev = findingsForTask({findings, record, taskId: IDS[0], revision: 3});
    check("per-task: wrong revision falls back to all findings",
      wrongRev.fallback === true && JSON.stringify(wrongRev.own) === JSON.stringify(findings), wrongRev);
    const short = findings.slice(0, 1);
    const misaligned = findingsForTask({findings: short, record, taskId: IDS[0], revision: 2});
    check("per-task: misaligned lengths fall back to all (passed) findings",
      misaligned.fallback === true && JSON.stringify(misaligned.own) === JSON.stringify(short), misaligned);
  }

  // No finding for the task → empty action groups; the other task's
  // finding is read-only handled context, never work.
  {
    const raw = [{tasks: ["T2"], location: "docs/x.md", problem: "t2", correction: "fix"}];
    const {findings, record} = makeRecord(raw);
    const g = findingsForTask({findings, record, taskId: IDS[0], revision: 2});
    check("per-task: no finding for the task yields empty action groups",
      g.fallback === false && g.own.length === 0 && g.phaseWide.length === 0 && g.unlinked.length === 0, g);
    check("per-task: no finding for the task still shows the other task's as handled",
      g.handled.length === 1 && g.handled[0].taskLabel === "T2" && g.handled[0].finding === findings[0], g.handled);
  }

  // Order within each group is the original finding order.
  {
    const raw = [
      {tasks: ["T1"], location: "docs/x.md", problem: "first t1", correction: "fix"},
      {tasks: ["T2"], location: "docs/x.md", problem: "other", correction: "fix"},
      {tasks: ["T1"], location: "docs/x.md", problem: "second t1", correction: "fix"},
    ];
    const {findings, record} = makeRecord(raw);
    const g = findingsForTask({findings, record, taskId: IDS[0], revision: 2});
    check("per-task: own keeps the original order",
      g.fallback === false && JSON.stringify(g.own) === JSON.stringify([findings[0], findings[2]]), g);
  }

  // Order within `handled` is the original finding order too.
  {
    const raw = [
      {tasks: ["T2"], location: "docs/x.md", problem: "first other", correction: "fix"},
      {tasks: ["T3"], location: "docs/x.md", problem: "second other", correction: "fix"},
    ];
    const {findings, record} = makeRecord(raw);
    const g = findingsForTask({findings, record, taskId: IDS[0], revision: 2});
    check("per-task: handled keeps the original order and the per-finding owner",
      g.fallback === false && g.own.length === 0 && g.handled.length === 2 &&
      JSON.stringify(g.handled) === JSON.stringify([
        {taskLabel: "T2", finding: findings[0]},
        {taskLabel: "T3", finding: findings[1]},
      ]), g.handled);
  }

  // Legacy records: `entries[i].taskIds` stays an ARRAY and may hold
  // several ids (pre-single-owner). The handled label joins them all
  // instead of trusting length 1.
  {
    const raw = [{tasks: ["T1"], location: "docs/x.md", problem: "legacy", correction: "fix"}];
    const {findings, record} = makeRecord(raw);
    const legacy = JSON.parse(JSON.stringify(record));
    legacy.entries[0].taskIds = [IDS[0], IDS[1]];
    const g = findingsForTask({findings, record: legacy, taskId: IDS[2], revision: 2});
    check("handled: a legacy multi-owner entry renders every owner label",
      g.fallback === false && g.own.length === 0 && g.handled.length === 1 &&
      g.handled[0].taskLabel === "T1, T2" && g.handled[0].finding === findings[0], g.handled);
    // The owner itself still gets it in own, never in handled, even when
    // the legacy entry names more than one task.
    const owner = findingsForTask({findings, record: legacy, taskId: IDS[1], revision: 2});
    check("handled: a legacy multi-owner entry does not shadow its own owner",
      owner.own.length === 1 && owner.own[0] === findings[0] && owner.handled.length === 0, owner);
  }

  // The read-only section renderer.
  {
    check("handled: an empty group renders nothing",
      renderHandledFindings([]) === "" && renderHandledFindings(undefined) === "" &&
      renderHandledFindings("nope") === "", renderHandledFindings([]));
    const text = renderHandledFindings([{taskLabel: "T2", finding: "t2 ships a stub"}]);
    check("handled: the section names the owner and forbids fixing it here",
      text.includes("T2") && text.includes("t2 ships a stub") &&
      /do not fix/i.test(text), text);
    const mixed = renderHandledFindings([
      null,
      {taskLabel: "T3"},
      {taskLabel: "T1", finding: 42},
      {taskLabel: "T2", finding: "  real one  "},
    ]);
    check("handled: malformed entries are dropped, real ones keep their text",
      mixed.startsWith("Findings already handled by another task") &&
      mixed.includes("- Already handled by T2 — do not fix it here: real one") &&
      !mixed.includes("42") && mixed.split("\n").length === 2, mixed);
    const two = renderHandledFindings([
      {taskLabel: "T2", finding: "one"},
      {taskLabel: "T3", finding: "two"},
    ]);
    check("handled: one line per handled finding, one heading",
      two.split("\n").length === 3 &&
      two.includes("- Already handled by T2 — do not fix it here: one") &&
      two.includes("- Already handled by T3 — do not fix it here: two"), two);
  }

  // Mission 052 (a) task 1.3 — the read-only handled section is wired into
  // BOTH fix-brief loops, exactly once each, straight out of
  // `grouped.handled`, while the excerpt block stays fed by
  // own+phaseWide+unlinked only.
  {
    const source = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
    const count = (haystack, needle) => haystack.split(needle).length - 1;
    const RENDER_CALL = "renderHandledFindings(grouped.handled)";
    const APPEND_CALL = "if(handledBlock) taskRetryFindings+=`";
    // The SpecKit twin is the SECOND loop; everything before this anchor is
    // the standalone half, everything after it is the twin.
    const twin = source.indexOf("TASK-24 step 4, SpecKit twin");
    check("contract: the SpecKit twin anchor exists", twin > 0, twin);
    const standaloneHalf = twin > 0 ? source.slice(0, twin) : "";
    const twinHalf = twin > 0 ? source.slice(twin) : "";
    check("contract: autopilot imports the handled renderer",
      source.includes("renderHandledFindings, fixPassBriefExcerpts"));
    check("contract: the standalone half renders the handled section once",
      count(standaloneHalf, RENDER_CALL) === 1, count(standaloneHalf, RENDER_CALL));
    check("contract: the SpecKit twin renders the handled section once",
      count(twinHalf, RENDER_CALL) === 1, count(twinHalf, RENDER_CALL));
    check("contract: only the two fix-brief loops render it",
      count(source, RENDER_CALL) === 2, count(source, RENDER_CALL));
    check("contract: both loops append the rendered section to the brief",
      count(standaloneHalf, APPEND_CALL) === 1 && count(twinHalf, APPEND_CALL) === 1);
    // `fixPassBriefExcerpts` takes ONE argument list here, with no nested
    // parens, so a simple match extracts it. It must keep naming exactly
    // own+phaseWide+unlinked — never `grouped.handled`.
    const excerptCalls = [...source.matchAll(/fixPassBriefExcerpts\(([^)]*)\)/g)].map(m => m[1]);
    check("contract: both loops feed the excerpt block the same groups",
      excerptCalls.length === 2 &&
      excerptCalls.every(arg => arg === "[...grouped.own,...grouped.phaseWide,...grouped.unlinked],fixPassBriefReadFile"),
      excerptCalls);
    check("contract: no excerpt ever comes from a handled finding",
      excerptCalls.length === 2 && excerptCalls.every(arg => !arg.includes("handled")),
      excerptCalls);
  }
}

// ══════════════════════════════════════════════════════════════════════
// 8. Behavioural: one real mission per framework, killed at the retry.
// ══════════════════════════════════════════════════════════════════════
function phasesOf(repo, framework, state) {
  if (framework === "speckit") return speckit.phases(repo, SPECKIT_TASK_CANDIDATES);
  return standalone.phases(repo, missionOf(repo, framework, state));
}
function missionOf(repo, framework, state) {
  if (framework === "speckit") return state.mission || state.missionSeq || state.speckitFeatureDir || "mission";
  return resolveStandaloneMission(repo, state, "");
}

async function runFindingCase(label, framework) {
  const prefix = `ftl-${framework}`;
  const repo = makeFixtureRepo(prefix);
  const binDir = makeFixtureBin(prefix);
  try {
    if (framework === "speckit") {
      makeSpecKitWorkflowOnly(repo);
      makeClaudeMdBaseline(repo);
    }
    writeConfig(repo, {planningFramework: framework});
    setScenario(repo, SCENARIO);

    const run = await runAutopilotUntilMarker(repo, binDir, {
      request: REQUEST, markerFile: path.join(repo, MARKER_NAME), timeoutMs: RUN_TIMEOUT_MS,
    });
    check(`${label}: the retrying Implementer's marker appeared and the tree was killed`,
      run.markerObserved === true && run.killed === true,
      {markerObserved: run.markerObserved, killed: run.killed, timedOut: run.timedOut,
        tail: String(run.stderr || run.stdout || "").slice(-600)});

    const state = readState(repo);
    const key = `${framework}-phase:0`;
    const record = state?.[FINDING_TASKS_STATE_KEY]?.[key];
    check(`${label}: the record is persisted under the feedback key`,
      !!record, Object.keys(state?.[FINDING_TASKS_STATE_KEY] ?? {}));
    if (!record) return;

    check(`${label}: the record carries exactly the reviewer's declared T1`,
      record.entries?.length === 1 && record.entries[0].source === "declared" &&
      record.entries[0].taskIds.length === 1 &&
      record.entries[0].taskIds[0] === record.taskIds[0],
      record.entries);
    // "exactly one" only means something if the phase offered at least two
    // candidates; a one-task fixture would make the check below vacuous.
    check(`${label}: the phase fixture offers at least two tasks`,
      Array.isArray(record.taskIds) && record.taskIds.length >= 2,
      record.taskIds);
    check(`${label}: affected is exactly that one task and allMapped is true`,
      Array.isArray(record.affected) && record.affected.length === 1 &&
      record.affected[0] === record.taskIds[0] && record.allMapped === true,
      {affected: record.affected, allMapped: record.allMapped});
    // TASK-21: the FAIL-time revision is recorded (the transition below
    // bumps it to N+1), and every unflagged task's pre-wipe facts are in
    // `carry` for the retry to replay.
    check(`${label}: the record carries the FAIL-time revision`,
      record.revision === 1, record.revision);
    check(`${label}: carry holds every unflagged task and no flagged one`,
      !!record.carry && !Object.hasOwn(record.carry, record.taskIds[0]) &&
      record.taskIds.slice(1).every((id) => Object.hasOwn(record.carry, id)),
      Object.keys(record.carry ?? {}));
    check(`${label}: the findings it describes are still stored alongside it`,
      loadReviewFeedback(state, key).length === 1, state.reviewFeedback?.[key]);

    // The disk copy of a verdict must not carry the raw findings (they would
    // double every result.json — the Playwright verifier's single finding is a
    // large base64 probe), while the in-memory one must still have them: if
    // result.json were written by mutating `result`, the record above could no
    // longer be "declared".
    const reviewResults = runResults(repo, "code_reviewer");
    const failedReview = reviewResults.find((r) => r?.verdict?.decision === "FAIL") ?? reviewResults[0];
    check(`${label}: the code_reviewer result.json keeps findings and drops rawFindings`,
      !!failedReview && Array.isArray(failedReview.verdict?.findings) &&
      failedReview.verdict.findings.length === 1 &&
      !Object.hasOwn(failedReview.verdict, "rawFindings"),
      failedReview?.verdict);
    check(`${label}: the in-memory raw copy survived, so T1 still maps as declared`,
      record.entries?.[0]?.source === "declared" &&
      record.entries[0].taskIds[0] === record.taskIds[0],
      record.entries);

    const phase = phasesOf(repo, framework, state).find((p) => p.tasks.some((t) => !t.done));
    check(`${label}: the fixture phase is present`, !!phase, phasesOf(repo, framework, state).map((p) => p.name));
    if (!phase) return;
    const mission = missionOf(repo, framework, state);
    const identities = phase.tasks.filter((t) => !t.done).map((t) => ({file: t.file, text: t.text}));
    // phaseTaskDigest is called WITHOUT a phaseNumber by BOTH loops' record
    // closures (canonical phaseNumber ""), while stableTaskIds always gets
    // `phaseIndex + 1`. Phase 0 ⇒ 1 for the ID, "" for the digest.
    const digest = phaseTaskDigest({
      framework, mission, phaseIndex: 0, phaseName: phase.name, tasks: identities, repoRoot: repo,
    });
    const ids = stableTaskIds({
      framework, mission, phaseIndex: 0, phaseNumber: 1, phaseName: phase.name, tasks: identities, repoRoot: repo,
    });
    check(`${label}: the stored digest describes THIS phase's task list`,
      record.phaseTaskDigest === digest, {stored: record.phaseTaskDigest, digest});
    check(`${label}: the stored task IDs are the phase's stable IDs`,
      JSON.stringify(record.taskIds) === JSON.stringify(ids), {stored: record.taskIds, ids});

    check(`${label}: loadFindingTasks accepts the current digest`,
      loadFindingTasks(state, key, {phaseTaskDigest: digest}) !== null);
    check(`${label}: loadFindingTasks rejects a foreign digest`,
      loadFindingTasks(state, key, {phaseTaskDigest: `${digest}x`}) === null);

    const progress = state[CHECKPOINT_STATE_KEY]?.roleProgress?.implementer;
    check(`${label}: roleProgress is STILL wiped after the FAIL (step 2 replays unflagged tasks through the commit path instead of un-wiping)`,
      Array.isArray(progress?.completedTaskIds) && progress.completedTaskIds.length === 0 &&
      Object.keys(progress?.factsByTask ?? {}).length === 0,
      {completedTaskIds: progress?.completedTaskIds, factsByTask: progress?.factsByTask});

    const reviewBriefs = briefsFor(repo, "code_reviewer");
    check(`${label}: the phase reviewer's brief shows the [T1] task label`,
      reviewBriefs.some((b) => b.includes("Tasks:") && /\[T1\] /.test(b)),
      reviewBriefs.map((b) => (b.match(/Tasks:\n[\s\S]{0,160}/) || [b.slice(0, 160)])[0]));

    const briefs = allBriefs(repo);
    check(`${label}: the retrying Implementer's brief still carries every finding`,
      briefs.some((b) => b.includes("Reviewer feedback from the previous attempt") && b.includes(PROBLEM)),
      briefs.filter((b) => b.includes(PROBLEM)).length);
    const implementerRuns = relayRunDirs(repo, "implementer");
    // One launch per task is the normal first pass; only the FAIL's retry puts
    // a launch count ABOVE the task count, so this stays a real retry check
    // even now that the fixture phase carries more than one task.
    check(`${label}: the retry really was an extra Implementer launch beyond one per task`,
      implementerRuns.length > record.taskIds.length,
      {launches: implementerRuns.length, tasks: record.taskIds.length});
  } finally {
    cleanup(repo, binDir);
  }
}

// ══════════════════════════════════════════════════════════════════════
// 9. TASK-21 end-to-end: a FAIL carries unflagged tasks forward (both loops).
//
// Each case runs a 3-task phase whose Implementer writes one ordinal-derived
// file per task (output/carry-T0/T1/T2.txt — the intra_role_ten mechanism,
// so every task owns a known file). Run 1 is killed as soon as the SECOND
// review hang is visible on disk, with the post-retry state on disk: the record, the
// wiped-then-replayed roleProgress, and every implementer brief. Run 2
// resumes the same repo to completion, proving the second review PASSes.
// ══════════════════════════════════════════════════════════════════════
const CARRY_MISSION = "001-carry-forward";
const CARRY_REQUEST = "carry forward fixture request";
const NEVER_MARKER = ".autopilot-test-never-appears";
const STANDALONE_KILL_MS = 90000;
const SPECKIT_KILL_MS = 180000;
const CARRY_MISSION_MS = 180000;
const CARRY_CASES = [
  // First code review FAILs tagged ["T2"]: the retry launches ONLY T2;
  // T1 and T3 are committed as carried with their original facts.
  {scenario: "carry_forward_tagged", affectedIndexes: [1], allMapped: true, recordCarryIndexes: [0, 2], carryIndexes: [0, 2], retryIndexes: [1], totalLaunches: 4, hangRole: "review"},
  // First code review FAILs with a plain-string finding: all 3 re-launched.
  {scenario: "carry_forward_untagged", affectedIndexes: [], allMapped: false, recordCarryIndexes: [], carryIndexes: [], retryIndexes: [0, 1, 2], totalLaunches: 6, hangRole: "review"},
  // FAIL tagged ["T1"], and T1's retry rewrites T3's file: T1 re-launched,
  // T2 carried, T3 re-launched via the overlap rule. The RECORD still holds
  // every unflagged task (T2 and T3) — the overlap rule only bites at
  // decision time, once T1's redo is committed.
  {scenario: "carry_forward_overlap", affectedIndexes: [0], allMapped: true, recordCarryIndexes: [1, 2], carryIndexes: [1], retryIndexes: [0, 2], totalLaunches: 5, hangRole: "review"},
  // Code review PASSes; the verifier FAILs once with a finding tagged ["T1"]
  // while the gate command fails once too (TASK-21 step 2, c-gap 2):
  // `carryAllowed` is true, so T2/T3 carry and only T1 re-launches.
  {scenario: "carry_forward_gate", affectedIndexes: [0], allMapped: true, recordCarryIndexes: [1, 2], carryIndexes: [1, 2], retryIndexes: [0], totalLaunches: 4, hangRole: "verify"},
  // Code review FAILs with one finding tagged ["T2"] and one explicitly
  // phase-wide (`tasks: []`): allMapped is false, so all 3 re-launch.
  {scenario: "carry_forward_phasewide", affectedIndexes: [1], allMapped: false, recordCarryIndexes: [], carryIndexes: [], retryIndexes: [0, 1, 2], totalLaunches: 6, hangRole: "review"},
];

function writeCarryStandaloneMission(repo) {
  const planFile = standalone.planPath(repo, CARRY_MISSION);
  const tasksFile = standalone.tasksPath(repo, CARRY_MISSION);
  fs.mkdirSync(path.dirname(planFile), {recursive: true});
  fs.writeFileSync(planFile, "# Plan\n\nObjective: fixture task.\n");
  fs.writeFileSync(tasksFile, [
    "## Phase 1: General", "",
    "- [ ] Do the first carry-forward task",
    "- [ ] Do the second carry-forward task",
    "- [ ] Do the third carry-forward task", "",
  ].join("\n"));
  fs.mkdirSync(path.join(repo, ".autopilot"), {recursive: true});
  fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify({
    version: 1, phase: "tasks_ready", step: "tasks_ready",
    phaseIndex: 0, attempt: 1, mission: CARRY_MISSION, planningRequest: "fixture request",
  }));
  return {planFile, tasksFile};
}

function speckitCarryTasksFile(repo) {
  const specsDir = path.join(repo, "specs");
  const matches = [];
  for (const entry of fs.readdirSync(specsDir)) {
    const candidate = path.join(specsDir, entry, "tasks.md");
    if (fs.existsSync(candidate)) matches.push(candidate);
  }
  if (matches.length !== 1) throw new Error(`expected exactly one SpecKit tasks.md, found ${matches.length}: ${matches.join(", ")}`);
  return matches[0];
}

// The gate command for carry_forward_gate: fail exactly ONCE (the first
// gate invocation), then pass. A flag file under .autopilot/ (excluded from
// every scoped delta) records that the failure already fired, so the check
// is independent of any counting. Lives uncommitted on disk for every run
// of the same repo dir. networkIsolation:false is passed to writeConfig so
// the command actually executes on Native Windows too (see harness docs).
function writeCarryGateCommand(repo) {
  fs.mkdirSync(path.join(repo, ".autopilot"), {recursive: true});
  fs.writeFileSync(path.join(repo, ".autopilot", "carry-gate.mjs"), [
    "import fs from \"node:fs\";",
    "const flag = \".autopilot/carry-gate-fired\";",
    "if (fs.existsSync(flag)) process.exit(0);",
    "fs.mkdirSync(\".autopilot\", {recursive: true});",
    "fs.writeFileSync(flag, \"fired\");",
    "process.exit(1);",
    "",
  ].join("\n"));
}

// Chronological implementer task IDs, one per COMPLETED relay (every
// implementer relay completes in run 1 — the kill lands in the review),
// read from each run's brief.
function implementerLaunchedIds(repo) {
  return readObservedEvents(repo).filter((e) => e.role === "implementer").map((e) => {
    const brief = readBrief(path.join(path.dirname(e.file), "brief.txt"));
    const m = /^Task ID: (.*)$/m.exec(brief) || /^currentTaskId: (.*)$/m.exec(brief);
    return m ? m[1].trim() : null;
  });
}

function baseNameSet(files) {
  return [...(files ?? [])].map((f) => String(f).split("/").pop()).sort();
}

async function runCarryCase(label, framework, def) {
  const tag = `${label}/${def.scenario}`;
  const prefix = `cf-${framework}-${def.scenario}`;
  const repo = makeFixtureRepo(prefix);
  const binDir = makeFixtureBin(prefix);
  try {
    let request = CARRY_REQUEST;
    let tasksFile = null;
    const configExtra = {};
    if (framework === "speckit") {
      makeSpecKitWorkflowOnly(repo);
      makeClaudeMdBaseline(repo);
    } else {
      request = "fixture request";
    }
    if (def.scenario === "carry_forward_gate") {
      configExtra.gatesCommands = ["node .autopilot/carry-gate.mjs"];
      configExtra.networkIsolation = false;
    }
    writeConfig(repo, {planningFramework: framework, ...configExtra});
    setScenario(repo, def.scenario);
    if (framework === "speckit") {
      // Planning (planner-written 3-task feature) is part of run 1.
    } else {
      ({tasksFile} = writeCarryStandaloneMission(repo));
    }
    if (def.scenario === "carry_forward_gate") writeCarryGateCommand(repo);

    // Run 1: killed as soon as the second review/verifier hang is visible on
    // disk (the first launch completed with result.json; the second is still
    // in progress). timeoutMs stays only as the safety net.
    const killMs = framework === "speckit" ? SPECKIT_KILL_MS : STANDALONE_KILL_MS;
    const hangRole = def.hangRole === "verify" ? "verifier" : "code_reviewer";
    const run1 = await runAutopilotUntilMarker(repo, binDir, {
      request, markerFile: path.join(repo, NEVER_MARKER),
      readyWhen: () => hangStarted(repo, hangRole, 2), timeoutMs: killMs,
    });
    check(`${tag}: run 1 was killed while the second ${def.hangRole} hang was in progress (ready observed, no marker, tree confirmed dead)`,
      run1.readyObserved === true && run1.killed === true && run1.terminationConfirmed === true && run1.markerObserved === false,
      {readyObserved: run1.readyObserved, killed: run1.killed, terminationConfirmed: run1.terminationConfirmed,
        markerObserved: run1.markerObserved, timedOut: run1.timedOut});

    const state = readState(repo);
    const key = `${framework}-phase:0`;
    const record = state?.[FINDING_TASKS_STATE_KEY]?.[key];
    check(`${tag}: the finding→task record is persisted`, !!record);
    if (!record) return;
    const ids = record.taskIds;
    check(`${tag}: the phase offers three tasks`, Array.isArray(ids) && ids.length === 3, ids);
    if (!Array.isArray(ids) || ids.length !== 3) return;
    const expectedAffected = def.affectedIndexes.map((i) => ids[i]);
    check(`${tag}: affected names exactly the flagged tasks`,
      JSON.stringify(record.affected) === JSON.stringify(expectedAffected) &&
      record.allMapped === def.allMapped,
      {affected: record.affected, allMapped: record.allMapped});
    check(`${tag}: the record carries the FAIL-time revision`,
      record.revision === 1, record.revision);
    const expectedRecordCarry = (def.recordCarryIndexes ?? def.carryIndexes).map((i) => ids[i]).sort();
    check(`${tag}: carry holds exactly the unflagged tasks`,
      JSON.stringify(Object.keys(record.carry ?? {}).sort()) === JSON.stringify(expectedRecordCarry),
      Object.keys(record.carry ?? {}));
    if (def.scenario === "carry_forward_gate") {
      // c-gap 2: the gate command is red at this FAIL, yet every finding is
      // mapped, so the unaffected tasks (T2/T3) still carry forward. The
      // empty-carry rule stays with `allMapped`: a gate FAIL with NO findings,
      // and any unmapped or phase-wide finding, still records an empty carry
      // (redo everything).
      check(`${tag}: a red-gate FAIL with every finding mapped records carry`,
        record.entries.length > 0 && record.allMapped === true &&
        Object.keys(record.carry ?? {}).length === 2,
        {entries: record.entries.length, allMapped: record.allMapped, carry: Object.keys(record.carry ?? {})});
    }

    const progress = state[CHECKPOINT_STATE_KEY]?.roleProgress?.implementer;
    check(`${tag}: completedTaskIds ends as the full ordered list`,
      !!progress && JSON.stringify(progress.completedTaskIds) === JSON.stringify(ids),
      progress?.completedTaskIds);
    if (!progress) return;
    for (const i of def.carryIndexes) {
      check(`${tag}: carried task T${i + 1} facts equal the pre-FAIL entry`,
        JSON.stringify(progress.factsByTask?.[ids[i]]) === JSON.stringify(record.carry[ids[i]]),
        {committed: progress.factsByTask?.[ids[i]], recorded: record.carry[ids[i]]});
      check(`${tag}: carried task T${i + 1} owns its known file`,
        JSON.stringify(baseNameSet(progress.factsByTask?.[ids[i]]?.files)) === JSON.stringify([`carry-T${i}.txt`]),
        progress.factsByTask?.[ids[i]]?.files);
    }
    if (def.scenario === "carry_forward_overlap") {
      // T1's retry changed T3's file (its own file rewrite was byte-
      // identical, hence unattributed): the overlap proof.
      check(`${tag}: the T1 retry owns T3's changed file`,
        JSON.stringify(baseNameSet(progress.factsByTask?.[ids[0]]?.files)) === JSON.stringify(["carry-T2.txt"]),
        progress.factsByTask?.[ids[0]]?.files);
    }

    const launchCount = relayRunDirs(repo, "implementer").length;
    check(`${tag}: implementer launch count is exact, not a lower bound`,
      launchCount === def.totalLaunches, launchCount);
    const launched = implementerLaunchedIds(repo);
    const expectedLaunched = [...ids, ...def.retryIndexes.map((i) => ids[i])];
    check(`${tag}: first pass runs T1→T2→T3, the retry runs exactly the expected subset`,
      JSON.stringify(launched) === JSON.stringify(expectedLaunched), launched);

    // Run 2: the same repo resumes to completion — the second review
    // PASSes, the verifier PASSes, and the phase is marked done.
    const run2 = runAutopilot(repo, binDir, {request, timeoutMs: CARRY_MISSION_MS});
    if (framework === "speckit") tasksFile = speckitCarryTasksFile(repo);
    const tasksText = fs.readFileSync(tasksFile, "utf8");
    check(`${tag}: the resumed run completes the phase (exit 0, every checkbox marked)`,
      run2.status === 0 && !/^- \[ \]/m.test(tasksText),
      {status: run2.status, timedOut: run2.timedOut, tail: String(run2.stderr || run2.stdout || "").slice(-400)});
  } finally {
    cleanup(repo, binDir);
  }
}

// The crash case (speckit loop, so it runs on every platform): arm the
// carry-prep crash marker, crash between the first carried task's prep and
// its commit, then prove the restart carries the same task with no launch
// before completing.
async function runCarryCrashCase() {
  const tag = "speckit/carry_crash_after_carry_prep";
  const repo = makeFixtureRepo("cf-crash");
  const binDir = makeFixtureBin("cf-crash");
  try {
    makeSpecKitWorkflowOnly(repo);
    makeClaudeMdBaseline(repo);
    writeConfig(repo, {planningFramework: "speckit"});
    setScenario(repo, "carry_forward_tagged");
    // Empty marker: crash on the first carried task (T1).
    fs.writeFileSync(path.join(repo, ".autopilot", ".autopilot-test-crash-after-carry-prep"), "");

    // Run 1: the retry carries T1 and crashes before committing it. This is
    // a scheduled crash (the orchestrator's own marker check exits 137 in
    // seconds), not a hang, so there is no readyWhen to observe here and the
    // NEVER_MARKER only keeps the marker trigger out of the way.
    const run1 = await runAutopilotUntilMarker(repo, binDir, {
      request: CARRY_REQUEST, markerFile: path.join(repo, NEVER_MARKER), timeoutMs: SPECKIT_KILL_MS,
    });
    check(`${tag}: run 1 crashed with exit 137 (not a deadline kill)`,
      run1.status === 137 && run1.killed === false && run1.markerObserved === false,
      {status: run1.status, killed: run1.killed, timedOut: run1.timedOut});
    check(`${tag}: the crash marker was consumed so the resume does not re-crash`,
      !fs.existsSync(path.join(repo, ".autopilot", ".autopilot-test-crash-after-carry-prep")));
    let state = readState(repo);
    let record = state?.[FINDING_TASKS_STATE_KEY]?.["speckit-phase:0"];
    check(`${tag}: the record survived the crash`, !!record);
    if (!record) return;
    const ids = record.taskIds;
    const progress1 = state[CHECKPOINT_STATE_KEY]?.roleProgress?.implementer;
    check(`${tag}: the crash left the cursor on the carried task (nothing committed)`,
      !!progress1 && progress1.completedTaskIds.length === 0 && progress1.currentTaskId === ids[0],
      {completedTaskIds: progress1?.completedTaskIds, currentTaskId: progress1?.currentTaskId});

    // Run 2: killed as soon as the second review hang is visible on disk.
    // Run 1 never reached a second review (it crashed in the carry prep), so
    // the hang is still the second code_reviewer launch overall.
    const run2 = await runAutopilotUntilMarker(repo, binDir, {
      request: CARRY_REQUEST, markerFile: path.join(repo, NEVER_MARKER),
      readyWhen: () => hangStarted(repo, "code_reviewer", 2), timeoutMs: SPECKIT_KILL_MS,
    });
    check(`${tag}: run 2 was killed while the second review hang was in progress (ready observed, tree confirmed dead)`,
      run2.readyObserved === true && run2.killed === true && run2.terminationConfirmed === true,
      {readyObserved: run2.readyObserved, killed: run2.killed, terminationConfirmed: run2.terminationConfirmed,
        timedOut: run2.timedOut});
    state = readState(repo);
    record = state?.[FINDING_TASKS_STATE_KEY]?.["speckit-phase:0"];
    const progress2 = state[CHECKPOINT_STATE_KEY]?.roleProgress?.implementer;
    check(`${tag}: the restart carried the same task with no launch (T1 launched exactly once, ever)`,
      !!progress2 && JSON.stringify(progress2.completedTaskIds) === JSON.stringify(ids) &&
      JSON.stringify(progress2.factsByTask?.[ids[0]]) === JSON.stringify(record.carry[ids[0]]) &&
      JSON.stringify(implementerLaunchedIds(repo)) === JSON.stringify([...ids, ids[1]]),
      {completedTaskIds: progress2?.completedTaskIds, launched: implementerLaunchedIds(repo)});

    // Run 3: completes.
    const run3 = runAutopilot(repo, binDir, {request: CARRY_REQUEST, timeoutMs: CARRY_MISSION_MS});
    const tasksText = fs.readFileSync(speckitCarryTasksFile(repo), "utf8");
    check(`${tag}: the resumed run completes the phase`,
      run3.status === 0 && !/^- \[ \]/m.test(tasksText),
      {status: run3.status, tail: String(run3.stderr || run3.stdout || "").slice(-400)});
  } finally {
    cleanup(repo, binDir);
  }
}

for (const def of CARRY_CASES) {
  if (inShard()) await runCarryCase("speckit", "speckit", def);
}
if (inShard()) await runCarryCrashCase();

// 10. TASK-23 end-to-end: a re-review sees only the old findings plus the
// fix's changes (both loops, one run each — no hang needed).
//
// The first code review FAILs tagged ["T2"]; the retry re-runs T2 only
// (carry-forward) with a NEW change. The second review's prompt must carry
// the FIX marker with a delta containing exactly T2's new change (none of
// T1's or T3's original changes) plus FEEDBACK TO ADDRESS with the T2
// finding. The verifier still gets the full phase delta, and after phase
// PASS no -review-r* baseline directories remain.
async function runScopedRereviewCase(label, framework) {
  const tag = `${label}/scoped_rereview`;
  const repo = makeFixtureRepo(`sr-${framework}-rereview`);
  const binDir = makeFixtureBin(`sr-${framework}-rereview`);
  try {
    let request = CARRY_REQUEST;
    let tasksFile = null;
    if (framework === "speckit") {
      makeSpecKitWorkflowOnly(repo);
      makeClaudeMdBaseline(repo);
    } else {
      request = "fixture request";
    }
    writeConfig(repo, {planningFramework: framework});
    setScenario(repo, "scoped_rereview");
    if (framework !== "speckit") ({tasksFile} = writeCarryStandaloneMission(repo));

    const run = runAutopilot(repo, binDir, {request, timeoutMs: CARRY_MISSION_MS});
    if (framework === "speckit") tasksFile = speckitCarryTasksFile(repo);
    const tasksText = fs.readFileSync(tasksFile, "utf8");
    check(`${tag}: the run completes the phase (exit 0, every checkbox marked)`,
      run.status === 0 && !/^- \[ \]/m.test(tasksText),
      {status: run.status, timedOut: run.timedOut, tail: String(run.stderr || run.stdout || "").slice(-400)});
    if (run.status !== 0) return;

    const reviews = briefsFor(repo, "code_reviewer").filter((b) => /^Phase: /m.test(b));
    check(`${tag}: exactly two phase code reviews ran (the mission-final review has no Phase line)`,
      reviews.length === 2, reviews.length);
    if (reviews.length !== 2) return;
    const [first, second] = reviews;
    check(`${tag}: the first review is whole-phase (PHASE marker, no FIX marker)`,
      first.includes("AUTOPILOT_SCOPED_DELTA_BEGIN:PHASE") && !first.includes("AUTOPILOT_SCOPED_DELTA_BEGIN:FIX"));
    check(`${tag}: the second review is the scoped re-review (FIX marker, no PHASE marker)`,
      second.includes("AUTOPILOT_SCOPED_DELTA_BEGIN:FIX") && !second.includes("AUTOPILOT_SCOPED_DELTA_BEGIN:PHASE"));
    check(`${tag}: the re-review carries FEEDBACK TO ADDRESS with the T2 finding`,
      second.includes("FEEDBACK TO ADDRESS") && second.includes("ships a stub"));
    // Scope the file assertions to the FIX delta section: the changed-files
    // line names every phase file by design.
    const fixStart = second.indexOf("AUTOPILOT_SCOPED_DELTA_BEGIN:FIX");
    const fixEnd = second.indexOf("AUTOPILOT_SCOPED_DELTA_END", fixStart);
    const fixSection = fixStart >= 0 && fixEnd > fixStart ? second.slice(fixStart, fixEnd) : "";
    check(`${tag}: the fix delta contains T2's new change`,
      fixSection.includes("carry-T1.txt") && fixSection.includes("task output retry"), fixSection.slice(0, 300));
    check(`${tag}: the fix delta contains none of T1's or T3's original changes`,
      !fixSection.includes("carry-T0.txt") && !fixSection.includes("carry-T2.txt"), fixSection.slice(0, 300));
    check(`${tag}: the re-review lists the phase's changed files`,
      second.includes("Changed files in this phase so far:") &&
      second.includes("carry-T0.txt") && second.includes("carry-T2.txt"));

    const verifies = briefsFor(repo, "verifier");
    check(`${tag}: exactly one verifier ran`, verifies.length === 1, verifies.length);
    if (verifies.length === 1) {
      const vStart = verifies[0].indexOf("AUTOPILOT_SCOPED_DELTA_BEGIN:PHASE");
      const vEnd = verifies[0].indexOf("AUTOPILOT_SCOPED_DELTA_END", vStart);
      const vSection = vStart >= 0 && vEnd > vStart ? verifies[0].slice(vStart, vEnd) : "";
      check(`${tag}: the verifier's delta is the full phase (all three tasks' changes)`,
        vSection.includes("carry-T0.txt") && vSection.includes("carry-T1.txt") && vSection.includes("carry-T2.txt"),
        vSection.slice(0, 300));
    }

    const baselineDir = path.join(repo, ".autopilot", "baseline");
    const leftovers = fs.existsSync(baselineDir)
      ? fs.readdirSync(baselineDir).filter((d) => d.includes("-review-r"))
      : [];
    check(`${tag}: no -review-r* baseline directories remain after phase PASS`,
      leftovers.length === 0, leftovers);

    // Carry-forward still happened underneath: first pass T1→T2→T3, the
    // retry launched only T2 (4 implementer launches total).
    const launched = implementerLaunchedIds(repo);
    check(`${tag}: the retry re-ran only T2`,
      launched.length === 4 && new Set(launched.slice(0, 3)).size === 3 && launched[3] === launched[1],
      launched);
  } finally {
    cleanup(repo, binDir);
  }
}

// 11. TASK-23 fallback (speckit only): the retry deletes the -review-r1
// manifest before the re-review. The second review must then be the
// whole-phase handoff (PHASE marker, no FIX marker) — proof of fallback is
// the marker itself: with the snapshot present it would be FIX. No crash.
async function runScopedRereviewFallbackCase() {
  const tag = "speckit/scoped_rereview_fallback";
  const repo = makeFixtureRepo("sr-fallback");
  const binDir = makeFixtureBin("sr-fallback");
  try {
    makeSpecKitWorkflowOnly(repo);
    makeClaudeMdBaseline(repo);
    writeConfig(repo, {planningFramework: "speckit"});
    setScenario(repo, "scoped_rereview_fallback");

    const run = runAutopilot(repo, binDir, {request: CARRY_REQUEST, timeoutMs: CARRY_MISSION_MS});
    const tasksText = fs.readFileSync(speckitCarryTasksFile(repo), "utf8");
    check(`${tag}: the run completes the phase (exit 0, every checkbox marked)`,
      run.status === 0 && !/^- \[ \]/m.test(tasksText),
      {status: run.status, timedOut: run.timedOut, tail: String(run.stderr || run.stdout || "").slice(-400)});
    if (run.status !== 0) return;
    const reviews = briefsFor(repo, "code_reviewer").filter((b) => /^Phase: /m.test(b));
    check(`${tag}: exactly two phase code reviews ran (the mission-final review has no Phase line)`,
      reviews.length === 2, reviews.length);
    if (reviews.length !== 2) return;
    check(`${tag}: the second review fell back to whole-phase (PHASE marker, no FIX marker, no crash)`,
      reviews[1].includes("AUTOPILOT_SCOPED_DELTA_BEGIN:PHASE") && !reviews[1].includes("AUTOPILOT_SCOPED_DELTA_BEGIN:FIX"));
  } finally {
    cleanup(repo, binDir);
  }
}

// 12. TASK-24 end-to-end: each re-run task's brief gets only its own
// findings (both loops, one run each — no hang needed).
//
// findings_per_task FAILs once with T1/FINDING-ONE + T3/FINDING-THREE,
// then PASSes. The retry re-runs T1+T3 and carries T2.
// Mission 052 (a) task 1.3: a finding another task owns still reaches this
// brief, but only as read-only context under the handled heading — never as
// work the implementer must fix. These two helpers split a retry brief at
// that heading so an assertion can demand exactly that.
function briefWorkPart(brief) {
  const at = brief.indexOf(HANDLED_FINDINGS_HEADING);
  return at >= 0 ? brief.slice(0, at) : brief;
}
function briefHandledPart(brief) {
  const at = brief.indexOf(HANDLED_FINDINGS_HEADING);
  return at >= 0 ? brief.slice(at) : "";
}

function implementerBriefsByTask(repo) {
  const out = new Map();
  for (const e of readObservedEvents(repo).filter((ev) => ev.role === "implementer")) {
    const brief = readBrief(path.join(path.dirname(e.file), "brief.txt"));
    const m = /^Task ID: (.*)$/m.exec(brief) || /^currentTaskId: (.*)$/m.exec(brief);
    const id = m ? m[1].trim() : null;
    if (!id) continue;
    if (!out.has(id)) out.set(id, []);
    out.get(id).push(brief);
  }
  return out;
}

async function runFindingsPerTaskCase(label, framework) {
  const tag = `${label}/findings_per_task`;
  const repo = makeFixtureRepo(`fpt-${framework}`);
  const binDir = makeFixtureBin(`fpt-${framework}`);
  try {
    let request = CARRY_REQUEST;
    let tasksFile = null;
    if (framework === "speckit") {
      makeSpecKitWorkflowOnly(repo);
      makeClaudeMdBaseline(repo);
    } else {
      request = "fixture request";
    }
    writeConfig(repo, {planningFramework: framework});
    setScenario(repo, "findings_per_task");
    if (framework !== "speckit") ({tasksFile} = writeCarryStandaloneMission(repo));

    const run = runAutopilot(repo, binDir, {request, timeoutMs: CARRY_MISSION_MS});
    if (framework === "speckit") tasksFile = speckitCarryTasksFile(repo);
    const tasksText = fs.readFileSync(tasksFile, "utf8");
    check(`${tag}: the run completes the phase (exit 0, every checkbox marked)`,
      run.status === 0 && !/^- \[ \]/m.test(tasksText),
      {status: run.status, timedOut: run.timedOut, tail: String(run.stderr || run.stdout || "").slice(-400)});
    if (run.status !== 0) return;

    // NOTE: the finding→task record is cleared on phase PASS (with the
    // findings it describes), so a completed run has no record left to
    // assert on — the retry launch pattern plus the brief contents below
    // are the evidence. First pass T1→T2→T3, retry T1+T3 (T2 carried).
    const launched = implementerLaunchedIds(repo);
    check(`${tag}: first pass runs three tasks, retry runs exactly two more`,
      launched.length === 5 && new Set(launched.slice(0, 3)).size === 3, launched);
    const ids = launched.slice(0, 3);
    check(`${tag}: the retry re-runs the first and third tasks (T2 carried)`,
      launched.length === 5 && launched[3] === ids[0] && launched[4] === ids[2], launched);

    const byTask = implementerBriefsByTask(repo);
    const retryBrief = (id) => (byTask.get(id) ?? []).find((b) => b.includes("Reviewer feedback from the previous attempt")) ?? "";
    const t1 = retryBrief(ids[0]);
    const t3 = retryBrief(ids[2]);
    check(`${tag}: T1 retry brief exists`, !!t1);
    check(`${tag}: T3 retry brief exists`, !!t3);
    // Mission 052 (a): the neighbour's finding is present, but only under the
    // read-only handled heading — the part of the brief that is work (own /
    // phase-wide / unlinked headings plus the excerpt block) never mentions it.
    if (t1) {
      check(`${tag}: T1 brief contains FINDING-ONE`, t1.includes("FINDING-ONE"), t1.slice(0, 400));
      check(`${tag}: T1 brief labels its own finding`, t1.includes("Findings for this task:"), t1.slice(0, 400));
      check(`${tag}: T1 sees FINDING-THREE only as read-only handled context`,
        !briefWorkPart(t1).includes("FINDING-THREE") && briefHandledPart(t1).includes("FINDING-THREE"),
        t1.slice(0, 400));
    }
    if (t3) {
      check(`${tag}: T3 brief contains FINDING-THREE`, t3.includes("FINDING-THREE"), t3.slice(0, 400));
      check(`${tag}: T3 sees FINDING-ONE only as read-only handled context`,
        !briefWorkPart(t3).includes("FINDING-ONE") && briefHandledPart(t3).includes("FINDING-ONE"),
        t3.slice(0, 400));
    }

    const reviews = briefsFor(repo, "code_reviewer").filter((b) => /^Phase: /m.test(b));
    check(`${tag}: exactly two phase code reviews ran`, reviews.length === 2, reviews.length);
    if (reviews.length === 2) {
      check(`${tag}: the second review still carries both findings under FEEDBACK TO ADDRESS`,
        reviews[1].includes("FEEDBACK TO ADDRESS") &&
        reviews[1].includes("FINDING-ONE") && reviews[1].includes("FINDING-THREE"),
        reviews[1].slice(0, 400));
    }
  } finally {
    cleanup(repo, binDir);
  }
}

// 13. TASK-24 (one loop is enough): phase-wide + T2 → all 3 re-run with
// per-task headings; plus the overlap brief from the TASK-21 case.
async function runFindingsPhasewideCase() {
  const tag = "speckit/findings_per_task_phasewide";
  const repo = makeFixtureRepo("fpt-phasewide");
  const binDir = makeFixtureBin("fpt-phasewide");
  try {
    makeSpecKitWorkflowOnly(repo);
    makeClaudeMdBaseline(repo);
    writeConfig(repo, {planningFramework: "speckit"});
    setScenario(repo, "findings_per_task_phasewide");

    // Six implementer launches need a longer budget than the four-launch
    // cases on Native Windows (one disposable copy per launch).
    const run = runAutopilot(repo, binDir, {request: CARRY_REQUEST, timeoutMs: 300000});
    const tasksText = fs.readFileSync(speckitCarryTasksFile(repo), "utf8");
    check(`${tag}: the run completes the phase`,
      run.status === 0 && !/^- \[ \]/m.test(tasksText),
      {status: run.status, timedOut: run.timedOut, tail: String(run.stderr || run.stdout || "").slice(-400)});
    if (run.status !== 0) return;
    const launched = implementerLaunchedIds(repo);
    check(`${tag}: all 3 tasks re-ran (6 launches)`, launched.length === 6, launched);

    const byTask = implementerBriefsByTask(repo);
    const retryBrief = (id) => {
      const all = byTask.get(id) ?? [];
      return all.find((b) => b.includes("Reviewer feedback from the previous attempt")) ?? "";
    };
    // NOTE: the record is cleared on phase PASS, so derive the three task
    // ids from the first-pass launch order instead of state.json.
    const ids = launched.slice(0, 3);
    if (ids.length === 3) {
      const t1 = retryBrief(ids[0]);
      const t2 = retryBrief(ids[1]);
      const t3 = retryBrief(ids[2]);
      // Mission 052 (a): FINDING-TWO is T2's own finding; the neighbours see
      // it only as read-only handled context, never as work of their own.
      check(`${tag}: T1 gets FINDING-PHASEWIDE as work and FINDING-TWO only read-only`,
        t1.includes("FINDING-PHASEWIDE") &&
        !briefWorkPart(t1).includes("FINDING-TWO") && briefHandledPart(t1).includes("FINDING-TWO"),
        t1.slice(0, 400));
      check(`${tag}: T3 gets FINDING-PHASEWIDE as work and FINDING-TWO only read-only`,
        t3.includes("FINDING-PHASEWIDE") &&
        !briefWorkPart(t3).includes("FINDING-TWO") && briefHandledPart(t3).includes("FINDING-TWO"),
        t3.slice(0, 400));
      check(`${tag}: T2 gets both findings`,
        t2.includes("FINDING-PHASEWIDE") && t2.includes("FINDING-TWO"), t2.slice(0, 400));
      check(`${tag}: T1 shows the [] finding under the Phase-wide heading`,
        t1.includes("Phase-wide findings") && t1.includes("FINDING-PHASEWIDE"), t1.slice(0, 400));
      check(`${tag}: T1 never files anything under Findings not linked`,
        !t1.includes("Findings not linked"), t1.slice(0, 400));
    } else {
      check(`${tag}: three task ids recorded`, false, ids);
    }
  } finally {
    cleanup(repo, binDir);
  }
}

// 14. TASK-24 (one loop is enough): the TASK-21 overlap retry brief names
// the causing task's label and the overlapping file, says "do not redo
// it", and carries no finding text as work — Mission 052 (a) lets the
// causing task's findings in as read-only context only.
async function runOverlapBriefCase() {
  const tag = "speckit/carry_forward_overlap_brief";
  const repo = makeFixtureRepo("fpt-overlap");
  const binDir = makeFixtureBin("fpt-overlap");
  try {
    makeSpecKitWorkflowOnly(repo);
    makeClaudeMdBaseline(repo);
    writeConfig(repo, {planningFramework: "speckit"});
    setScenario(repo, "carry_forward_overlap");
    const run1 = await runAutopilotUntilMarker(repo, binDir, {
      request: CARRY_REQUEST, markerFile: path.join(repo, NEVER_MARKER),
      readyWhen: () => hangStarted(repo, "code_reviewer", 2), timeoutMs: SPECKIT_KILL_MS,
    });
    check(`${tag}: run 1 was killed while the second review hang was in progress (ready observed, tree confirmed dead)`,
      run1.readyObserved === true && run1.killed === true && run1.terminationConfirmed === true,
      {readyObserved: run1.readyObserved, killed: run1.killed, terminationConfirmed: run1.terminationConfirmed,
        timedOut: run1.timedOut});
    const state = readState(repo);
    const record = state?.[FINDING_TASKS_STATE_KEY]?.["speckit-phase:0"];
    check(`${tag}: the record is persisted`, !!record);
    if (!record) return;
    const ids = record.taskIds;
    const byTask = implementerBriefsByTask(repo);
    const t3Retry = (byTask.get(ids[2]) ?? []).find((b) => b.includes("being re-run because the fix")) ?? "";
    check(`${tag}: the overlap re-run brief exists for T3`, !!t3Retry, (byTask.get(ids[2]) ?? []).length);
    if (t3Retry) {
      check(`${tag}: the brief names the causing task label T1`, t3Retry.includes("T1"), t3Retry.slice(0, 500));
      check(`${tag}: the brief names the overlapping file`, t3Retry.includes("carry-T2.txt"), t3Retry.slice(0, 500));
      check(`${tag}: the brief says do not redo it`, t3Retry.includes("do not redo it"), t3Retry.slice(0, 500));
      check(`${tag}: the brief carries no finding text as work`,
        !briefWorkPart(t3Retry).includes("ships a stub") &&
        briefHandledPart(t3Retry).includes("ships a stub"), t3Retry.slice(0, 500));
    }
  } finally {
    cleanup(repo, binDir);
  }
}

if (inShard()) await runScopedRereviewCase("speckit", "speckit");
if (inShard()) await runScopedRereviewFallbackCase();

for (const def of CARRY_CASES) {
  if (inShard()) await runCarryCase("standalone", "standalone", def);
}
if (inShard()) await runScopedRereviewCase("standalone", "standalone");

if (inShard()) await runFindingCase("speckit", "speckit");

if (inShard()) await runFindingCase("standalone", "standalone");

// 12+13+14. TASK-24 per-task findings (both loops for the main case, one
// loop for the phase-wide and overlap briefs).
if (inShard()) await runFindingsPerTaskCase("speckit", "speckit");
if (inShard()) await runFindingsPhasewideCase();
if (inShard()) await runOverlapBriefCase();

if (inShard()) await runFindingsPerTaskCase("standalone", "standalone");

console.log(`\n${ok} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
