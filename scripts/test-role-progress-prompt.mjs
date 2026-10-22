#!/usr/bin/env node
// TASK-19 Phase 3 task 11 — prompt-shape and exclusion tests for
// `scripts/role-progress-prompt.mjs` (task 9) and the phase-brief producer
// `scripts/role-progress-brief.mjs` (task 10).
//
// Asserts shape and exclusions directly — never complete prompt prose. Every
// required field and every exclusion is checked for BOTH Standalone and
// SpecKit, and the delta-slice case asserts both sides (the sliced prompt
// excludes the other files AND the whole-phase pass includes them) rather than
// only one.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
  buildTaskPrompt, sliceDeltaChunks, taskTitle, taskDisplayRef, taskRefRange,
  reviewTaskRef, allPhaseTaskRef, SECTION, readOnlyHandoffNoteReminder,
  READ_ONLY_ROLES, FORBIDDEN_INPUT_CODE, INVALID_INPUT_CODE, TASK_DELTA_BUDGET,
} from "./role-progress-prompt.mjs";
import {FINDING_TASKS_STATE_KEY} from "./finding-task-locality.mjs";
import {handoffNoteRelPath, scratchHandoffNotePath, SCRATCH_HANDOFF_NOTE_DEFAULT_DIR} from "./per-task-budget.mjs";
import {
  buildPhaseBrief, ensurePhaseBrief, phaseBriefPath, phaseBriefRelativePath,
  readPhaseBriefHeader, ensurePhaseBriefForCheckpoint, PHASE_BRIEF_BUDGET, truncationWarning,
} from "./role-progress-brief.mjs";
import {emptyRoleProgress} from "./phase-stage-checkpoint.mjs";

let ok = 0;
let failed = 0;
function check(name, condition, evidence) {
  if (condition) { console.log(`PASS ${name}`); ok += 1; return; }
  console.error(`FAIL ${name}${evidence !== undefined ? ` :: ${JSON.stringify(evidence)}` : ""}`);
  failed += 1;
}

const here = path.dirname(fileURLToPath(import.meta.url));

const DIGEST = "sha256:" + "d".repeat(64);
const DELTA_DIGEST = "sha256:" + "e".repeat(64);
const HUNK_A = "HUNK_A_ONLY_FOR_A";
const HUNK_B = "HUNK_B_ONLY_FOR_B";
const HUNK_C = "HUNK_C_ONLY_FOR_C";
const HUNK_X = "HUNK_X_UNATTRIBUTED";
const LATER_ONE_FULL = "LATER_ONE_FULL_TEXT_SENTINEL";
const LATER_TWO_FULL = "LATER_TWO_FULL_TEXT_SENTINEL";

function makeFixture(framework) {
  const prefix = framework === "standalone" ? "standalone" : "speckit";
  const taskIds = [`${prefix}:P1:T0:aaaa`, `${prefix}:P1:T1:bbbb`, `${prefix}:P1:T2:cccc`];
  const tasks = [
    {id: taskIds[0], text: "Build the widget\n\nCURRENT_TASK_DETAIL accept: widget works ; verify: node --check scripts/a.mjs", file: "scripts/a.mjs", line: 3},
    {id: taskIds[1], text: `Ship the widget\n\n${LATER_ONE_FULL}`, file: "scripts/b.mjs", line: 4},
    {id: taskIds[2], text: `Document the widget\n\n${LATER_TWO_FULL}`, file: "scripts/c.mjs", line: 5},
  ];
  const progress = emptyRoleProgress();
  progress.implementer.status = "complete";
  progress.implementer.completedTaskIds = [...taskIds];
  progress.implementer.taskCursor = taskIds.length;
  progress.implementer.factsByTask = {
    [taskIds[0]]: {summary: "built", files: ["scripts/a.mjs"], taskLocalCheck: {command: "node --check scripts/a.mjs", status: "passed", exitCode: 0, summary: "ok"}},
    [taskIds[1]]: {summary: "shipped", files: ["scripts/b.mjs"], taskLocalCheck: {command: "node --check scripts/b.mjs", status: "passed", exitCode: 0, summary: "ok"}},
    [taskIds[2]]: {summary: "documented", files: ["scripts/c.mjs"], taskLocalCheck: {command: "node --check scripts/c.mjs", status: "passed", exitCode: 0, summary: "ok"}},
  };
  progress.codeReviewer.status = "running";
  progress.codeReviewer.completedTaskIds = [taskIds[0]];
  progress.codeReviewer.taskCursor = 1;
  progress.codeReviewer.currentTaskId = taskIds[1];
  const deltaChunks = [
    {path: "scripts/a.mjs", text: HUNK_A},
    {path: "scripts/b.mjs", text: HUNK_B},
    {path: "scripts/c.mjs", text: HUNK_C},
    {path: "scripts/unattributed.mjs", text: HUNK_X},
  ];
  return {taskIds, tasks, progress, deltaChunks};
}

function baseOpts(framework, fixture, overrides = {}) {
  return {
    framework,
    mission: "001-example",
    phaseIndex: 0,
    phaseNumber: 1,
    phaseName: "Foundation",
    phaseTotal: 2,
    revision: 1,
    role: "codeReviewer",
    phaseTaskDigest: DIGEST,
    deltaDigest: DELTA_DIGEST,
    taskIds: fixture.taskIds,
    tasks: fixture.tasks,
    currentTaskId: fixture.taskIds[1],
    roleProgress: fixture.progress,
    deltaChunks: fixture.deltaChunks,
    phaseBriefPath: `.autopilot/missions/001-example/phase-briefs/phase-1.md`,
    ...overrides,
  };
}

// ── Both frameworks: shape, titles-only map, current task contract ───────
for (const framework of ["standalone", "speckit"]) {
  const fixture = makeFixture(framework);
  const built = buildTaskPrompt(baseOpts(framework, fixture, {role: "implementer", currentTaskId: fixture.taskIds[0]}));
  check(`[${framework}] implementer prompt assembles`, built.ok, built);
  const text = built.ok ? built.text : "";
  check(`[${framework}] phase map section present`, text.includes(SECTION.phaseMap));
  check(`[${framework}] current task contract section present`, text.includes(SECTION.currentTask));
  check(`[${framework}] current task carries its full text`, text.includes("CURRENT_TASK_DETAIL"));
  check(`[${framework}] later task titles are present in the map`, text.includes("Ship the widget") && text.includes("Document the widget"));
  check(`[${framework}] later tasks' full text is absent`, !text.includes(LATER_ONE_FULL) && !text.includes(LATER_TWO_FULL));
  check(`[${framework}] completed-task facts section present`, text.includes(SECTION.completedFacts));
  check(`[${framework}] worktree access section present`, text.includes(SECTION.worktree));
  check(`[${framework}] identity binding section present`, text.includes(SECTION.identities));
  check(`[${framework}] fresh-session contract present`, text.includes(SECTION.freshSession) && text.includes("resume:false"));
  check(`[${framework}] current-task-only instruction present`, text.includes(SECTION.currentTaskOnly));
  check(`[${framework}] repeat/checkpoint instructions present`,
    text.includes(SECTION.repeat) && text.includes(SECTION.checkpoint));
  check(`[${framework}] checkbox ownership stated`, text.includes(SECTION.noCheckboxes));
  check(`[${framework}] phase-brief path present and marked optional`,
    text.includes(SECTION.brief) && text.includes("phase-briefs/phase-1.md") && /optional/i.test(text));
  check(`[${framework}] revision and task digest bound`, text.includes("revision: 1") && text.includes(DIGEST));
  check(`[${framework}] single-verification contract present`, text.includes(SECTION.singleVerification));
  check(`[${framework}] dead-ends section absent without deadEnds opt`, !text.includes(SECTION.deadEnds));
  check(`[${framework}] implementer prompt carries the EOL-normalized diff fallback`,
    text.includes("git diff --ignore-cr-at-eol") && text.includes("git -c core.autocrlf=input diff"), text.slice(-300));
  for (const roRole of ["codeReviewer", "verifier"]) {
    const roBuilt = buildTaskPrompt(baseOpts(framework, fixture, {role: roRole, currentTaskId: fixture.taskIds[1]}));
    const roText = roBuilt.ok ? roBuilt.text : "";
    check(`[${framework}] ${roRole} prompt carries the EOL-normalized diff fallback`,
      roBuilt.ok && roText.includes("git diff --ignore-cr-at-eol") && roText.includes("git -c core.autocrlf=input diff"), roText.slice(-300));
  }
}

// ── Dead-ends transfer (backlog 003#15): orchestrator-assembled only ──────
{
  const fixture = makeFixture("standalone");
  const base = baseOpts("standalone", fixture, {role: "implementer", currentTaskId: fixture.taskIds[0]});
  const withDead = buildTaskPrompt({...base, deadEnds: [
    {generation: 1, reason: "turns", used: 41, limit: 40, tail: "kept re-reading the suite output"},
    {generation: 2, reason: "tokens", used: 11000000, limit: 10000000, tail: "x".repeat(900)},
  ]});
  check("deadends: section present with entries",
    withDead.ok && withDead.text.includes(SECTION.deadEnds) &&
    withDead.text.includes("turns") && withDead.text.includes("kept re-reading the suite output"), withDead);
  check("deadends: long tail rendered bounded (single per-entry handoff limit)",
    withDead.ok && !withDead.text.includes("x".repeat(2001)) && withDead.text.includes("x".repeat(900)));
  check("deadends: do-not-re-read instruction present (backlog #22)",
    withDead.ok && /already read by the previous session — do not re-read them in full/i.test(withDead.text)
    && /read only what you need/i.test(withDead.text));
  check("deadends: routes-around instruction present",
    withDead.ok && /route around/i.test(withDead.text));
  check("deadends: stopping-early-gains-nothing normalization present",
    withDead.ok && /relaunches automatically/i.test(withDead.text) && /Only a fully complete task ends the loop/i.test(withDead.text));
  const incomplete = buildTaskPrompt({...base, deadEnds: [
    {generation: 2, reason: "incomplete", used: null, limit: null, tail: "created 8-10, 30 remaining"},
  ]});
  check("deadends: voluntary stop renders as stopped-not-capped (never 'hit the incomplete cap')",
    incomplete.ok && /stopped voluntarily with work still remaining/i.test(incomplete.text) &&
    !/hit the incomplete cap/i.test(incomplete.text) && incomplete.text.includes("created 8-10, 30 remaining"));
  const bad = buildTaskPrompt({...base, deadEnds: "retry everything"});
  check("deadends: non-array rejected fail-closed", !bad.ok);
}

// ── Hand-off note, backlog #26 Step A ─────────────────────────────────────
{
  const fixture = makeFixture("standalone");
  const implBase = baseOpts("standalone", fixture, {role: "implementer", currentTaskId: fixture.taskIds[0]});
  const impl = buildTaskPrompt(implBase);
  const NOTE_PATH = ".autopilot/missions/001-example/handoff/T1.md";
  check("handoff: implementer brief tells the agent to keep the note at the exact path",
    impl.ok && impl.text.includes(SECTION.handoffNote) && impl.text.includes(`Keep a hand-off note at ${NOTE_PATH}`), impl.text.slice(0, 300));
  check("handoff: keep-current names OVERWRITE-never-append and the limit",
    impl.ok && impl.text.includes("OVERWRITE it (never append)") && impl.text.includes("max 4000 characters")
    && impl.text.includes("If your session is stopped, the next session starts from this note."));
  check("handoff: keep-current lists the four sections",
    impl.ok && impl.text.includes("1. Done") && impl.text.includes("2. Found")
    && impl.text.includes("3. Next") && impl.text.includes("4. Dead ends"));
  // Mission 049 Phase 1 task 1.3: milestone note-keeping reminders. The
  // implementer reminder sits adjacent to the current-task contract and
  // names the writable repo note; read-only roles (code reviewer, verifier)
  // cannot write the repo, so theirs names the shared 1.1 scratch-note path
  // under /workspace/scratch and marks the repo path read-only.
  check("milestone: implementer prompt carries the reminder adjacent to the current-task contract",
    impl.ok && impl.text.includes(SECTION.milestoneNote)
    && impl.text.includes(`OVERWRITE your hand-off note at ${NOTE_PATH}`)
    && impl.text.indexOf(SECTION.currentTask) < impl.text.indexOf(SECTION.milestoneNote)
    && impl.text.indexOf(SECTION.milestoneNote) < impl.text.indexOf(SECTION.completedFacts), impl.text.slice(0, 500));
  for (const role of ["codeReviewer", "verifier"]) {
    const other = buildTaskPrompt(baseOpts("standalone", fixture, {role, currentTaskId: fixture.taskIds[1]}));
    const otherText = other.ok ? other.text : "";
    const scratchPath = "/workspace/scratch/T2.md";
    const repoPath = ".autopilot/missions/001-example/handoff/T2.md";
    check(`milestone: ${role} prompt carries the scratch note-keeping instruction`,
      other.ok && otherText.includes(SECTION.milestoneNote)
      && otherText.includes(`OVERWRITE your hand-off note at ${scratchPath}`)
      && otherText.includes("/workspace/scratch/"), otherText.slice(0, 500));
    check(`milestone: ${role} prompt marks the repo note read-only`,
      other.ok && otherText.includes(repoPath) && /read-only for this role/i.test(otherText), otherText.slice(0, 500));
    check(`milestone: ${role} prompt has no repo keep-current section`,
      other.ok && !otherText.includes(SECTION.handoffNote));
    check(`milestone: ${role} reminder sits adjacent to the current-task contract`,
      other.ok && otherText.indexOf(SECTION.currentTask) < otherText.indexOf(SECTION.milestoneNote)
      && otherText.indexOf(SECTION.milestoneNote) < otherText.indexOf(SECTION.completedFacts));
  }
  // Mission 049 reviewer finding: multi-task review runs execute under a
  // range taskRef (reviewTaskRef/allPhaseTaskRef, e.g. "T1.1 > T1.3") while
  // taskDisplayRef names a single task — the wrap-up reads
  // scratchHandoffNotePath(effectiveScratchDir, taskRef), so a read-only
  // prompt built for such a run must name the note from that same range ref
  // (via handoffNoteRef), or the wrap-up never finds the note the role
  // wrote. The prompt renders the in-envelope form (/workspace/scratch) and
  // the wrap-up the host effectiveScratchDir form, so the pinned invariant
  // is the shared 1.1 helper output for the same ref.
  {
    const rangeRef = "T1.1 > T1.3";
    const expectedScratch = scratchHandoffNotePath(SCRATCH_HANDOFF_NOTE_DEFAULT_DIR, rangeRef);
    const expectedRepo = handoffNoteRelPath("001-example", rangeRef);
    for (const role of ["codeReviewer", "verifier"]) {
      const ranged = buildTaskPrompt(baseOpts("standalone", fixture, {role, currentTaskId: fixture.taskIds[1], handoffNoteRef: rangeRef}));
      const rangedText = ranged.ok ? ranged.text : "";
      const at = /OVERWRITE your hand-off note at (\S+)/.exec(rangedText)?.[1];
      check(`milestone: ${role} prompt with a range handoffNoteRef names the same scratch file the wrap-up reads`,
        ranged.ok && at === expectedScratch, at);
      check(`milestone: ${role} prompt with a range handoffNoteRef marks the range repo note read-only`,
        ranged.ok && rangedText.includes(expectedRepo) && /read-only for this role/i.test(rangedText));
    }
    const implRanged = buildTaskPrompt(baseOpts("standalone", fixture, {role: "implementer", currentTaskId: fixture.taskIds[0], handoffNoteRef: rangeRef}));
    check("milestone: implementer prompt with a range handoffNoteRef names the range repo note",
      implRanged.ok && implRanged.text.includes(`OVERWRITE your hand-off note at ${expectedRepo}`));
  }
  // Backlog #62: the read-only reminder is ONE shared helper —
  // buildTaskPrompt renders it verbatim (no behaviour change), and the
  // review-role relay prompts in autopilot.mjs append the same text under
  // the ref the relay runs under (the wrap-up reads
  // scratchHandoffNotePath(effectiveScratchDir, taskRef)).
  {
    const ref = "T1.1 > T1.3";
    const reminder = readOnlyHandoffNoteReminder({mission: "001-example", ref, noteLimit: 4000});
    check("helper: names the scratch note path for the ref",
      reminder.includes(scratchHandoffNotePath(SCRATCH_HANDOFF_NOTE_DEFAULT_DIR, ref)));
    check("helper: names the repo note path read-only for this role",
      reminder.includes(handoffNoteRelPath("001-example", ref)) && /read-only for this role/.test(reminder));
    check("helper: pins overwrite discipline, the four sections, and the limit",
      reminder.includes("OVERWRITE your hand-off note at") && reminder.includes("max 4000 characters")
      && reminder.includes("Done/Found/Next/Dead ends"));
    const ranged = buildTaskPrompt(baseOpts("standalone", fixture, {role: "codeReviewer", currentTaskId: fixture.taskIds[1], handoffNoteRef: ref}));
    const milestoneHeader = `\n## ${SECTION.milestoneNote}\n`;
    const milestoneStart = ranged.ok ? ranged.text.indexOf(milestoneHeader) : -1;
    const nextSection = milestoneStart !== -1 ? ranged.text.indexOf("\n## ", milestoneStart + milestoneHeader.length) : -1;
    check("milestone: read-only prompt milestone section is the helper's text verbatim",
      ranged.ok && milestoneStart !== -1 && nextSection > milestoneStart
      && ranged.text.slice(milestoneStart, nextSection - 1) === reminder,
      ranged.ok ? ranged.text.slice(Math.max(0, milestoneStart), nextSection - 1) : "");
  }
  check("milestone: whole-phase implementer pass has no milestone reminder",
    buildTaskPrompt({...implBase, wholePhasePass: true}).text.includes(SECTION.milestoneNote) === false);
  const whole = buildTaskPrompt({...implBase, wholePhasePass: true});
  check("handoff: whole-phase implementer pass (no current task) has no keep-current section",
    whole.ok && !whole.text.includes(SECTION.handoffNote));
  const prev = buildTaskPrompt({...implBase,
    deadEnds: [{generation: 1, reason: "turns", used: 41, limit: 40, tail: "digest text"}],
    handoffNote: "Done: nothing yet. Found: the retry prompt lives at autopilot.mjs:4392. Next: edit that line.",
  });
  check("handoff: previous-session note renders ABOVE dead ends with the trust line",
    prev.ok && prev.text.includes(SECTION.handoffNotePrev)
    && prev.text.indexOf(SECTION.handoffNotePrev) < prev.text.indexOf(SECTION.deadEnds)
    && prev.text.includes("Trust this note. Do not re-read what it already explains")
    && prev.text.includes("the retry prompt lives at autopilot.mjs:4392"), prev.text.slice(0, 300));
  // Backlog #32: edit-first order + orchestrator-quoted cited code.
  check("handoff: note carries the EDIT FIRST order",
    prev.ok && prev.text.includes("EDIT FIRST: if the note's \"Next\" names an edit, make that edit before any other read or search"));
  const quoted = buildTaskPrompt({...implBase,
    handoffNote: "Next: edit scripts/a.mjs:10",
    handoffNoteExcerpts: "scripts/a.mjs:9-11\n```\n10: const x = 1;\n```",
  });
  check("handoff: cited code renders right after the note, before dead ends",
    quoted.ok && quoted.text.includes(SECTION.handoffNoteCode) && quoted.text.includes("10: const x = 1;")
    && quoted.text.indexOf(SECTION.handoffNotePrev) < quoted.text.indexOf(SECTION.handoffNoteCode), quoted.text.slice(-600));
  check("handoff: empty excerpts render no cited-code section",
    buildTaskPrompt({...implBase, handoffNote: "x", handoffNoteExcerpts: "  "}).text.includes(SECTION.handoffNoteCode) === false);
  check("handoff: non-string excerpts rejected fail-closed",
    !buildTaskPrompt({...implBase, handoffNoteExcerpts: ["x"]}).ok);
  const long = buildTaskPrompt({...implBase, handoffNote: `HEAD MARKER ${"n".repeat(5000)}`});
  check("handoff: over-limit note bounded to the limit, head kept",
    long.ok && long.text.includes("HEAD MARKER") && !long.text.includes("n".repeat(4001)));
  const custom = buildTaskPrompt({...implBase, handoffNoteMaxChars: 1000, handoffNote: `HEAD ${"m".repeat(2000)}`});
  check("handoff: operator limit shortens the rendered note",
    custom.ok && custom.text.includes("max 1000 characters") && !custom.text.includes("m".repeat(1001)));
  const silent = buildTaskPrompt({...implBase, handoffNote: "   "});
  check("handoff: missing/empty note renders nothing (digest still appears)",
    silent.ok && !silent.text.includes(SECTION.handoffNotePrev));
  check("handoff: non-string note rejected fail-closed",
    !buildTaskPrompt({...implBase, handoffNote: {text: "x"}}).ok);
  check("handoff: invalid note limit rejected fail-closed",
    !buildTaskPrompt({...implBase, handoffNoteMaxChars: 0}).ok);
}

// ── Stage-appropriate identities differ between Implementer and read-only ─
{
  const fixture = makeFixture("standalone");
  const impl = buildTaskPrompt(baseOpts("standalone", fixture, {role: "implementer", currentTaskId: fixture.taskIds[0]}));
  const rev = buildTaskPrompt(baseOpts("standalone", fixture, {role: "codeReviewer", currentTaskId: fixture.taskIds[1]}));
  check("identities: implementer prompt never carries the frozen delta digest", !impl.text.includes(DELTA_DIGEST), impl.text.slice(0, 200));
  check("identities: implementer prompt states the delta is not approval/drift", /not an approval or drift signal/i.test(impl.text));
  check("identities: read-only prompt carries the frozen delta digest", rev.text.includes(DELTA_DIGEST));
  check("identities: read-only prompt uses the per-task slice section", rev.text.includes(SECTION.deltaSlice));
  check("identities: implementer prompt never inlines delta chunks", !impl.text.includes(HUNK_A) && !impl.text.includes(HUNK_B));
  check("identities: implementer prompt carries the task-result sentinel contract",
    impl.text.includes(SECTION.taskResult) && impl.text.includes("AUTOPILOT_TASK_RESULT"));
  check("identities: read-only prompt does not ask for a task-result sentinel",
    !rev.text.includes("AUTOPILOT_TASK_RESULT"));
}

// ── Per-task delta slicing: exclude the others, include in whole-phase ───
{
  const fixture = makeFixture("standalone");
  const perTask = buildTaskPrompt(baseOpts("standalone", fixture, {role: "verifier", currentTaskId: fixture.taskIds[1]}));
  check("slice: per-task prompt includes the current task's file hunks", perTask.text.includes(HUNK_B));
  check("slice: per-task prompt excludes the other tasks' file hunks",
    !perTask.text.includes(HUNK_A) && !perTask.text.includes(HUNK_C), perTask.meta?.delta);
  check("slice: per-task prompt excludes an unattributed chunk", !perTask.text.includes(HUNK_X));
  check("slice: per-task meta names only the task's files",
    JSON.stringify(perTask.meta.taskFiles) === JSON.stringify(["scripts/b.mjs"]), perTask.meta);

  const whole = buildTaskPrompt(baseOpts("standalone", fixture, {role: "verifier", wholePhasePass: true, currentTaskId: null}));
  check("slice: whole-phase pass includes all three task file hunks",
    whole.text.includes(HUNK_A) && whole.text.includes(HUNK_B) && whole.text.includes(HUNK_C));
  check("slice: whole-phase pass includes the unattributed chunk", whole.text.includes(HUNK_X));

  check("slice: frozen full-delta digest is byte-identical in sliced and whole-phase prompts",
    perTask.text.includes(DELTA_DIGEST) && whole.text.includes(DELTA_DIGEST));
  check("slice: sliceDeltaChunks filters by path",
    JSON.stringify(sliceDeltaChunks(fixture.deltaChunks, ["scripts/c.mjs"]).map((c) => c.path)) === JSON.stringify(["scripts/c.mjs"]));
}

// ── Prior transcripts / unbounded historical diffs are never inlined ─────
{
  const fixture = makeFixture("standalone");
  for (const key of ["priorTranscript", "priorChatHistory", "historicalDiffs"]) {
    const built = buildTaskPrompt(baseOpts("standalone", fixture, {[key]: "SECRET"}));
    check(`exclusion: forbidden input ${key} is rejected`,
      !built.ok && built.code === FORBIDDEN_INPUT_CODE, built);
  }
  const normal = buildTaskPrompt(baseOpts("standalone", fixture, {role: "implementer", currentTaskId: fixture.taskIds[0]}));
  check("exclusion: no prior-task full text leaks into a normal prompt",
    !normal.text.includes(LATER_ONE_FULL) && !normal.text.includes(LATER_TWO_FULL));
}

// ── Invalid inputs fail closed ───────────────────────────────────────────
{
  const fixture = makeFixture("standalone");
  check("invalid: unsupported framework rejected",
    !buildTaskPrompt(baseOpts("gsd", fixture)).ok);
  check("invalid: unknown role rejected",
    !buildTaskPrompt(baseOpts("standalone", fixture, {role: "planner"})).ok);
  check("invalid: currentTaskId outside taskIds rejected",
    !buildTaskPrompt(baseOpts("standalone", fixture, {currentTaskId: "nope"})).ok);
  check("invalid: read-only prompt without a frozen delta rejected",
    !buildTaskPrompt(baseOpts("standalone", fixture, {deltaDigest: null})).ok);
  // validateRoleProgress() permits a role's entry to be absent; a prompt for a
  // role that has not started must fail closed, not throw.
  check("invalid: absent roleProgress entry fails closed instead of throwing",
    (() => { const r = buildTaskPrompt(baseOpts("standalone", fixture, {role: "verifier", roleProgress: {}})); return r && !r.ok && r.code === INVALID_INPUT_CODE; })());
  check("invalid: partial roleProgress missing the prompted role fails closed",
    (() => {
      const partial = emptyRoleProgress();
      delete partial.verifier;
      const r = buildTaskPrompt(baseOpts("standalone", fixture, {role: "verifier", roleProgress: partial}));
      return r && !r.ok && r.code === INVALID_INPUT_CODE;
    })());
}

// ── Implementer single-verification sharded-verify guidance (mission 061) ─
{
  const fixture = makeFixture("standalone");
  const impl = buildTaskPrompt(baseOpts("standalone", fixture, {role: "implementer", currentTaskId: fixture.taskIds[0]}));
  const SENTINEL = "Prefer the focused task check; leave slow/sharded files to the gate.";
  check("singleverify: implementer prompt prefers the focused task check",
    impl.ok && impl.text.includes(SENTINEL));
  const TEST_SCOPE_SENTINEL = "never run scripts/test-all.mjs or the whole test suite";
  check("singleverify: implementer prompt forbids the full suite",
    impl.ok && impl.text.includes(TEST_SCOPE_SENTINEL));
  for (const role of ["codeReviewer", "verifier"]) {
    const other = buildTaskPrompt(baseOpts("standalone", fixture, {role, currentTaskId: fixture.taskIds[1]}));
    check(`singleverify: ${role} prompt has no implementer sharded-verify line`,
      other.ok && !other.text.includes(SENTINEL));
    check(`singleverify: ${role} prompt has no implementer full-suite rule`,
      other.ok && !other.text.includes(TEST_SCOPE_SENTINEL));
  }
}

// ── taskTitle and bounds ─────────────────────────────────────────────────
{
  check("title: first line only", taskTitle({text: "First line\nsecond line"}) === "First line");
  check("title: annotations stripped", taskTitle({text: "Do it <!-- autopilot-requires: commands.execute -->"}) === "Do it");
  const long = taskTitle({text: "x".repeat(400)});
  check("title: bounded length", long.length <= 160, long.length);

  const fixture = makeFixture("standalone");
  const huge = fixture.deltaChunks.map((c) => ({path: c.path, text: c.text.repeat(20000)}));
  const built = buildTaskPrompt(baseOpts("standalone", fixture, {role: "verifier", currentTaskId: fixture.taskIds[1], deltaChunks: huge}));
  check("bounds: oversized delta slice is truncated and announced",
    built.ok && built.meta.delta.truncated === true && /TRUNCATED/.test(built.text));
  check("bounds: truncated prompt stays near the delta budget",
    built.text.length <= TASK_DELTA_BUDGET + 5000, built.text.length);
}

// ── Phase brief producer (task 10), asserted on its own ──────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-phase-brief-"));
  const mission = "001-example";
  const rel = phaseBriefRelativePath(mission, 1);
  check("brief: decided path is per-mission and per-phase",
    rel === ".autopilot/missions/001-example/phase-briefs/phase-1.md", rel);

  const fixture = makeFixture("standalone");
  const write1 = ensurePhaseBrief({
    repo: dir, mission, phaseIndex: 0, phaseNumber: 1, phaseName: "Foundation", framework: "standalone",
    revision: 1, phaseTaskDigest: DIGEST, taskIds: fixture.taskIds, tasks: fixture.tasks,
    planContext: "plan context", priorRevisionNotes: "none",
  });
  const file = phaseBriefPath(dir, mission, 1);
  check("brief: exists on disk at the decided path before any per-task invocation",
    write1.ok && write1.written === true && fs.existsSync(file), write1);
  const rev1 = readPhaseBriefHeader(dir, mission, 1);
  check("brief: header records the revision and digest", rev1?.revision === 1 && rev1?.digest === DIGEST, rev1);

  const write1again = ensurePhaseBrief({
    repo: dir, mission, phaseIndex: 0, phaseNumber: 1, phaseName: "Foundation", framework: "standalone",
    revision: 1, phaseTaskDigest: DIGEST, taskIds: fixture.taskIds, tasks: fixture.tasks,
  });
  check("brief: same revision is not rewritten (idempotent)", write1again.ok && write1again.written === false, write1again);

  const before = fs.readFileSync(file, "utf8");
  const write2 = ensurePhaseBrief({
    repo: dir, mission, phaseIndex: 0, phaseNumber: 1, phaseName: "Foundation", framework: "standalone",
    revision: 2, phaseTaskDigest: DIGEST, taskIds: fixture.taskIds, tasks: fixture.tasks,
    planContext: "new revision context",
  });
  const after = fs.readFileSync(file, "utf8");
  check("brief: rewritten on revision change", write2.ok && write2.written === true && after !== before, write2);
  check("brief: rewritten header carries the new revision", readPhaseBriefHeader(dir, mission, 1)?.revision === 2);

  const bounded = buildPhaseBrief({
    mission, phaseName: "Foundation", framework: "standalone", revision: 1, phaseIndex: 0,
    phaseTaskDigest: DIGEST, taskIds: fixture.taskIds, tasks: fixture.tasks,
    planContext: "y".repeat(PHASE_BRIEF_BUDGET * 2),
  });
  check("brief: oversized content is capped", bounded.text.length <= PHASE_BRIEF_BUDGET + 400, bounded.text.length);
  check("brief: truncation is announced with a warning",
    bounded.meta.truncated === true && /TRUNCATED/.test(bounded.text) && truncationWarning(bounded.meta).includes("truncated"));

  const noProgress = ensurePhaseBriefForCheckpoint({repo: dir, mission, framework: "standalone", checkpoint: {revision: 1}, phase: {name: "Foundation"}, tasks: []});
  check("brief: checkpoint wiring is a no-op until roleProgress exists",
    noProgress.ok && noProgress.written === false && noProgress.skipped === "no-role-progress", noProgress);
}

// ── Display refs (watch report / status.json / progress.log) ─────────────
{
  const numbered = {text: "**1.1** Do the first thing"};
  const plain = {text: "1.2 Do the second thing"};
  const unnumbered = {text: "Do the fixture task"};
  check("ref: bold plan number parses to T-prefixed ref",
    taskDisplayRef(numbered, 0) === "T1.1", taskDisplayRef(numbered, 0));
  check("ref: plain plan number parses",
    taskDisplayRef(plain, 1) === "T1.2", taskDisplayRef(plain, 1));
  check("ref: unnumbered task falls back to the dotless position label",
    taskDisplayRef(unnumbered, 0) === "T1" && taskDisplayRef(unnumbered, 2) === "T3",
    [taskDisplayRef(unnumbered, 0), taskDisplayRef(unnumbered, 2)]);
  check("ref: fallback never collides with a plan ref (no dot)",
    !taskDisplayRef(unnumbered, 0).includes("."));
  check("ref: unusable index is null, never a throw",
    taskDisplayRef(unnumbered, -1) === null && taskDisplayRef(unnumbered, 1.5) === null &&
    taskDisplayRef({}, null) === null);
  check("ref: null task with a valid index still yields the position label",
    taskDisplayRef(null, 0) === "T1");
  check("range: single ref stands alone",
    taskRefRange(["T2.1"]) === "T2.1");
  check("range: first > last in phase order",
    taskRefRange(["T1.1", "T1.2", "T1.3"]) === "T1.1 > T1.3");
  check("range: non-consecutive refs stay listed, never a range",
    taskRefRange(["T1.1", "T1.3"]) === "T1.1, T1.3");
  check("range: gaps split into runs",
    taskRefRange(["T1.1", "T1.2", "T1.4"]) === "T1.1 > T1.2, T1.4");
  check("range: owned IDs judge adjacency numerically (leading zeros kept)",
    taskRefRange(["T001", "T002", "T004"]) === "T001 > T002, T004");
  check("range: a plan-number break never merges (T1.9 > T2.1 would lie)",
    taskRefRange(["T1.9", "T2.1"]) === "T1.9, T2.1");
  check("range: cross-shape refs never merge",
    taskRefRange(["T001", "T2"]) === "T001, T2");
  check("range: owned IDs never merge with position fallbacks, even adjacently numbered",
    taskRefRange(["T003", "T4"]) === "T003, T4" && taskRefRange(["T009", "T010"]) === "T009 > T010");
  check("range: position fallbacks merge by integer adjacency",
    taskRefRange(["T1", "T2", "T4"]) === "T1 > T2, T4");
  check("range: empty/unknown scope is null",
    taskRefRange([]) === null && taskRefRange(null) === null &&
    taskRefRange([null, ""]) === null);
}

// ── Owned IDs (speckit T001 style) ───────────────────────────────────────
{
  check("ref: leading owned ID is used verbatim",
    taskDisplayRef({text: "T001 Create the docs"}, 0) === "T001");
  check("ref: owned ID keeps its zeros (distinct from a T1 fallback)",
    taskDisplayRef({text: "T003 Third"}, 5) === "T003");
  check("ref: explicit ID beats an inferred plan number",
    taskDisplayRef({text: "T002 1.4 Do the thing"}, 0) === "T002");
  check("ref: dotted owned ID is kept whole, never truncated at the dot",
    taskDisplayRef({text: "T1.2 Do x"}, 5) === "T1.2");
}

// ── reviewTaskRef: scope narrowing rules ────────────────────────────────
{
  const TASKS = [
    {text: "**1.1** First"},
    {text: "**1.2** Second"},
    {text: "T003 Third owned"},
    {text: "Unnumbered fourth"},
  ];
  const IDS = ["id0", "id1", "id2", "id3"];
  const stateWith = (slot) => ({[FINDING_TASKS_STATE_KEY]: {phase0: slot}});
  const usable = {revision: 1, allMapped: true, affected: ["id1"]};
  check("scope: round 1 with no record covers the whole phase",
    reviewTaskRef({}, "phase0", TASKS, IDS, 1, false) === "T1.1 > T1.2, T003, T4");
  check("scope: re-review covers the affected task and every later re-run task",
    reviewTaskRef(stateWith(usable), "phase0", TASKS, IDS, 2, true) === "T1.2, T003, T4");
  check("scope: an earlier affected task makes the re-review the rest of the phase",
    reviewTaskRef(stateWith({revision: 1, allMapped: true, affected: ["id0", "id2"]}), "phase0", TASKS, IDS, 2, true) === "T1.1 > T1.2, T003, T4");
  {
    const TASKS7 = Array.from({length: 7}, (_, i) => ({text: `**1.${i + 1}** Task`}));
    const IDS7 = TASKS7.map((_, i) => `s${i}`);
    const carriedFirstFour = {s0: {}, s1: {}, s2: {}, s3: {}};
    check("scope: #213 findings on T1.5/T1.6 with T1.7 re-run shows T1.5 > T1.7",
      reviewTaskRef(stateWith({revision: 1, allMapped: true, affected: ["s4", "s5"], carry: carriedFirstFour}), "phase0", TASKS7, IDS7, 2, true) === "T1.5 > T1.7");
    check("scope: a later carried task is not part of the re-review",
      reviewTaskRef(stateWith({revision: 1, allMapped: true, affected: ["s4"], carry: {s0: {}, s1: {}, s2: {}, s3: {}, s5: {}, s6: {}}}), "phase0", TASKS7, IDS7, 2, true) === "T1.5");
    check("scope: carried tasks between affected ones stay out, later re-run ones stay in",
      reviewTaskRef(stateWith({revision: 1, allMapped: true, affected: ["id0", "id2"], carry: {id1: {}}}), "phase0", TASKS, IDS, 2, true) === "T1.1, T003, T4");
  }
  check("scope: allMapped false means everything re-ran — whole phase",
    reviewTaskRef(stateWith({revision: 1, allMapped: false, affected: ["id1"]}), "phase0", TASKS, IDS, 2, true) === "T1.1 > T1.2, T003, T4");
  check("scope: no previous snapshot means a whole-phase review — whole phase",
    reviewTaskRef(stateWith(usable), "phase0", TASKS, IDS, 2, false) === "T1.1 > T1.2, T003, T4");
  check("scope: stale record (wrong revision) means whole phase",
    reviewTaskRef(stateWith({...usable, revision: 0}), "phase0", TASKS, IDS, 2, true) === "T1.1 > T1.2, T003, T4");
  check("scope: empty affected means whole phase",
    reviewTaskRef(stateWith({revision: 1, allMapped: true, affected: []}), "phase0", TASKS, IDS, 2, true) === "T1.1 > T1.2, T003, T4");
  check("scope: unknown affected IDs fall back to whole phase",
    reviewTaskRef(stateWith({revision: 1, allMapped: true, affected: ["nope"]}), "phase0", TASKS, IDS, 2, true) === "T1.1 > T1.2, T003, T4");
  check("scope: allPhaseTaskRef always covers the whole phase",
    allPhaseTaskRef(TASKS) === "T1.1 > T1.2, T003, T4" && allPhaseTaskRef([]) === null);
}

// ── Discovery (task 11) ──────────────────────────────────────────────────
{
  const runner = fs.readFileSync(path.join(here, "test-all.mjs"), "utf8");
  check("discovery: test-role-progress-prompt.mjs matches the runner discovery regex",
    /^test-.*\.mjs$/.test("test-role-progress-prompt.mjs"));
  check("discovery: modules are not runner candidates",
    !/^test-.*\.mjs$/.test("role-progress-prompt.mjs") && !/^test-.*\.mjs$/.test("role-progress-brief.mjs"));
  check("discovery: test-role-progress-prompt.mjs absent from both test-all exclusion sets",
    !runner.includes("test-role-progress-prompt.mjs"));
}

console.log(`\n${ok} passed, ${failed} failed`);
if (failed) process.exit(1);
