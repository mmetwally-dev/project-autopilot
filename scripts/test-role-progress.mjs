#!/usr/bin/env node
// Phase 1 task 3 — unit tests for TASK-8's stable task IDs (task 1) and the
// roleProgress progress-state schema (task 2).
//
// Two independent concerns, each case asserted on its own:
//
// 1. `scripts/role-progress-ids.mjs` — deterministic task IDs. Identical input
//    is stable; an edit, reorder, insert, and removal each change the ID set
//    (four separate cases); and two identities that a naive `|`-delimited
//    join renders identically must not collide under the canonical-JSON hash.
//
// 2. `scripts/phase-stage-checkpoint.mjs` — `roleProgress` shape validation.
//    Bounded facts cannot grow without limit; `taskLocalCheck` is structurally
//    distinct from a verifier verdict (a `verified: true` check is rejected);
//    and the absent-passes / present-malformed-fails-closed split is asserted
//    through `validateCheckpoint()` (the read path), not only through
//    `validateRoleProgress()` directly.
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
  TASK_ID_HASH_LENGTH, taskIdentity, stableTaskId, stableTaskIds, isStableTaskId,
} from "./role-progress-ids.mjs";
import {
  CHECKPOINT_VERSION, INVALID_CODE, ROLE_PROGRESS_ROLES, ROLE_PROGRESS_STATUSES,
  TASK_LOCAL_CHECK_STATUSES, ROLE_PROGRESS_MAX_TASKS, ROLE_PROGRESS_SUMMARY_MAX_CHARS,
  ROLE_PROGRESS_COMMAND_MAX_CHARS, ROLE_PROGRESS_MAX_FILES, ROLE_PROGRESS_MAX_ITEMS,
  ROLE_PROGRESS_MAX_BYTES, validateRoleProgress, emptyRoleProgress,
  validateCheckpoint, createCheckpoint,
} from "./phase-stage-checkpoint.mjs";

let ok = 0;
let failed = 0;
function check(name, condition, evidence) {
  if (condition) { console.log(`PASS ${name}`); ok += 1; return; }
  console.error(`FAIL ${name}${evidence !== undefined ? ` :: ${JSON.stringify(evidence)}` : ""}`);
  failed += 1;
}

// Accept / reject helpers keep each case a single named assertion while
// preserving the {ok,code,reason,evidence} shape in the failure output.
function rejects(name, result) {
  check(name, !result.ok && result.code === INVALID_CODE, result);
}
function accepts(name, result) {
  check(name, result.ok, result);
}

const here = path.dirname(fileURLToPath(import.meta.url));

// ── Fixtures ─────────────────────────────────────────────────────────────
const basePhase = {
  framework: "standalone",
  mission: "001-example",
  phaseIndex: 0,
  phaseNumber: 1,
  phaseName: "Foundation",
  tasks: [
    {file: "/repo/TASKS.md", line: 3, text: "Build the widget"},
    {file: "/repo/TASKS.md", line: 4, text: "Ship the widget"},
  ],
  repoRoot: "/repo",
};

const baseCheckpointInput = {
  ...basePhase,
  baselineKey: "mission-001-example-phase-0",
};
const AT = "2026-01-01T00:00:00.000Z";

function makeCheckpoint(overrides = {}) {
  return {...createCheckpoint({...baseCheckpointInput, at: AT}), ...overrides};
}

// A fully valid roleProgress block, built from the module's own empty shape so
// the fixture cannot drift from the contract.
function validProgress() {
  const progress = emptyRoleProgress();
  const task0 = "standalone:P1:T0:0123456789ab";
  const task1 = "standalone:P1:T1:abcdef012345";
  progress.implementer = {
    status: "running",
    taskCursor: 1,
    completedTaskIds: [task0],
    currentTaskId: task1,
    factsByTask: {
      [task0]: {
        summary: "Added the widget module",
        files: ["scripts/widget.mjs"],
        taskLocalCheck: {
          command: "node --check scripts/widget.mjs",
          status: "passed",
          exitCode: 0,
          summary: "syntax ok",
        },
      },
    },
  };
  return progress;
}

// ── Exports ──────────────────────────────────────────────────────────────
for (const fn of ["taskIdentity", "stableTaskId", "stableTaskIds", "isStableTaskId"]) {
  const mod = await import("./role-progress-ids.mjs");
  check(`exports ${fn}`, typeof mod[fn] === "function");
}
for (const fn of ["validateRoleProgress", "emptyRoleProgress"]) {
  const mod = await import("./phase-stage-checkpoint.mjs");
  check(`exports ${fn}`, typeof mod[fn] === "function");
}

// ── Purity: the ID generator touches no filesystem/process/network ───────
{
  const source = fs.readFileSync(path.join(here, "role-progress-ids.mjs"), "utf8");
  for (const token of [
    "node:fs", "node:child_process", "node:net", "node:http", "node:https",
    "process.", "new Date(", "writeFileSync", "readFileSync", "renameSync",
    "spawnSync", "execSync", "fetch(", "XMLHttpRequest",
  ]) {
    check(`id generator pure: no ${token}`, !source.includes(token), token);
  }
}

// ── Task-ID determinism ──────────────────────────────────────────────────
{
  const a = stableTaskIds(basePhase);
  const b = stableTaskIds(JSON.parse(JSON.stringify(basePhase)));
  check("ids: identical input is stable", JSON.stringify(a) === JSON.stringify(b), {a, b});
  check("ids: one ID per task", a.length === basePhase.tasks.length, a);
  check("ids: repeated call is stable", stableTaskId(basePhase, basePhase.tasks[0], 0) === a[0]);
  for (const id of a) {
    check(`ids: ${id} matches the stable-ID shape`, isStableTaskId(id), id);
  }
  check("ids: hash suffix length", a[0].endsWith(`:${a[0].split(":").pop()}`) &&
    a[0].split(":").pop().length === TASK_ID_HASH_LENGTH, a[0]);
  check("ids: phase segment uses the phase number", a[0].startsWith("standalone:P1:T0:"), a[0]);
  check("ids: non-ID string is rejected", !isStableTaskId("not-a-task-id"));
  check("ids: non-string is rejected", !isStableTaskId(42));
}

// ── Task-ID sensitivity: four independent mutations ──────────────────────
{
  const base = stableTaskIds(basePhase);

  const edited = {
    ...basePhase,
    tasks: [{...basePhase.tasks[0], text: "Build the gadget"}, basePhase.tasks[1]],
  };
  const editIds = stableTaskIds(edited);
  check("ids: text edit changes the ID set", JSON.stringify(editIds) !== JSON.stringify(base), {base, editIds});
  check("ids: text edit changes the edited task's ID", editIds[0] !== base[0]);
  check("ids: text edit leaves the sibling task's ID unchanged", editIds[1] === base[1]);

  const reordered = {...basePhase, tasks: [basePhase.tasks[1], basePhase.tasks[0]]};
  const reorderIds = stableTaskIds(reordered);
  check("ids: reorder changes the ID set", JSON.stringify(reorderIds) !== JSON.stringify(base), {base, reorderIds});
  check("ids: reorder changes every moved ID", reorderIds[0] !== base[0] && reorderIds[1] !== base[1]);

  const inserted = {
    ...basePhase,
    tasks: [...basePhase.tasks, {file: "/repo/TASKS.md", line: 5, text: "Document the widget"}],
  };
  const insertIds = stableTaskIds(inserted);
  check("ids: insertion changes the ID set", JSON.stringify(insertIds) !== JSON.stringify(base), {base, insertIds});

  const removed = {...basePhase, tasks: [basePhase.tasks[0]]};
  const removeIds = stableTaskIds(removed);
  check("ids: removal changes the ID set", JSON.stringify(removeIds) !== JSON.stringify(base), {base, removeIds});

  // A line-only move is not an edit: durable identity is never `file:line`.
  const moved = {
    ...basePhase,
    tasks: [{...basePhase.tasks[0], line: 99}, {...basePhase.tasks[1], line: 100}],
  };
  check("ids: line-only move does not change the ID set",
    JSON.stringify(stableTaskIds(moved)) === JSON.stringify(base));

  // Formatting-only differences normalize away, exactly as phaseTaskDigest().
  const padded = {
    ...basePhase,
    tasks: [
      {...basePhase.tasks[0], text: "  Build   the widget  <!-- autopilot-requires: commands.execute -->"},
      basePhase.tasks[1],
    ],
  };
  check("ids: whitespace/annotation-only difference does not change the ID set",
    JSON.stringify(stableTaskIds(padded)) === JSON.stringify(base));
}

// ── Task-ID collision resistance ─────────────────────────────────────────
// These two identities render identically under a naive `file:${f}|text:${t}`
// join (`a|text:b|c`) but are distinct under the canonical-JSON identity the
// generator hashes. No hash can repair a contract that collides pre-hash.
{
  const left = {...basePhase, tasks: [{file: "/repo/a|text:b", text: "c"}]};
  const right = {...basePhase, tasks: [{file: "/repo/a", text: "b|text:c"}]};
  const leftId = stableTaskIds(left)[0];
  const rightId = stableTaskIds(right)[0];
  check("ids: delimiter-collision identities produce distinct IDs", leftId !== rightId, {leftId, rightId});
  check("ids: collision identities are genuinely distinct inputs",
    JSON.stringify(taskIdentity(left, left.tasks[0], 0)) !== JSON.stringify(taskIdentity(right, right.tasks[0], 0)));
}

// ── roleProgress: absent passes through the read path ────────────────────
// The task's point is the read path: a checkpoint with no roleProgress must
// still validate, because every checkpoint written before this landed has none.
{
  accepts("checkpoint: absent roleProgress validates", validateCheckpoint(makeCheckpoint()));
  accepts("checkpoint: explicitly undefined roleProgress validates",
    validateCheckpoint(makeCheckpoint({roleProgress: undefined})));
  accepts("checkpoint: explicitly null roleProgress validates",
    validateCheckpoint(makeCheckpoint({roleProgress: null})));
  check("checkpoint: roleProgress is additive, CHECKPOINT_VERSION stays 1",
    CHECKPOINT_VERSION === 1 && makeCheckpoint({roleProgress: validProgress()}).version === 1);
}

// ── roleProgress: present and valid ──────────────────────────────────────
{
  const progress = validProgress();
  accepts("roleProgress: emptyRoleProgress() is accepted", validateRoleProgress(emptyRoleProgress()));
  accepts("roleProgress: valid populated block is accepted", validateRoleProgress(progress));
  accepts("checkpoint: valid roleProgress validates through the read path",
    validateCheckpoint(makeCheckpoint({roleProgress: progress})));
  accepts("roleProgress: empty object (no roles started) is accepted", validateRoleProgress({}));
  accepts("checkpoint: roleProgress survives a JSON round-trip unchanged",
    validateCheckpoint(JSON.parse(JSON.stringify(makeCheckpoint({roleProgress: progress})))));
  check("roleProgress: shape is one sub-object per role",
    JSON.stringify(Object.keys(emptyRoleProgress()).sort()) === JSON.stringify([...ROLE_PROGRESS_ROLES].sort()));
}

// ── roleProgress: present but malformed fails closed ─────────────────────
// Each case is asserted independently. The first three also prove the
// integration point: a malformed block is rejected by validateCheckpoint(),
// not merely by the validator called in isolation.
{
  const nonObject = validateCheckpoint(makeCheckpoint({roleProgress: "not-an-object"}));
  rejects("checkpoint: string roleProgress fails closed with PHASE_CHECKPOINT_INVALID", nonObject);
  rejects("checkpoint: array roleProgress fails closed",
    validateCheckpoint(makeCheckpoint({roleProgress: []})));
  const badStatus = emptyRoleProgress();
  badStatus.implementer.status = "approved";
  rejects("checkpoint: malformed roleProgress fails closed via validateCheckpoint()",
    validateCheckpoint(makeCheckpoint({roleProgress: badStatus})));

  for (const [label, value] of [["null", null], ["number", 42], ["array", []]]) {
    rejects(`roleProgress: non-object (${label}) rejected`, validateRoleProgress(value));
  }
  rejects("roleProgress: unknown role rejected", validateRoleProgress({planner: {}}));
  rejects("roleProgress: role entry must be an object", validateRoleProgress({implementer: "x"}));
  rejects("roleProgress: unknown key within a role rejected",
    validateRoleProgress({...emptyRoleProgress(), implementer: {...emptyRoleProgress().implementer, extra: 1}}));
  for (const status of ["approved", "done", "", null]) {
    const p = emptyRoleProgress();
    p.implementer.status = status;
    rejects(`roleProgress: invalid status ${JSON.stringify(status)} rejected`, validateRoleProgress(p));
  }
  for (const cursor of [-1, 1.5, "0", null]) {
    const p = emptyRoleProgress();
    p.implementer.taskCursor = cursor;
    rejects(`roleProgress: invalid taskCursor ${JSON.stringify(cursor)} rejected`, validateRoleProgress(p));
  }
  {
    const p = emptyRoleProgress();
    p.implementer.completedTaskIds = ["dup", "dup"];
    rejects("roleProgress: duplicate completedTaskIds rejected", validateRoleProgress(p));
  }
  {
    const p = emptyRoleProgress();
    p.implementer.currentTaskId = 7;
    rejects("roleProgress: non-string non-null currentTaskId rejected", validateRoleProgress(p));
  }
  {
    const p = emptyRoleProgress();
    p.implementer.factsByTask = [];
    rejects("roleProgress: non-object fact map rejected", validateRoleProgress(p));
  }
  {
    const p = emptyRoleProgress();
    p.implementer.factsByTask = {t: "not-an-object"};
    rejects("roleProgress: non-object fact entry rejected", validateRoleProgress(p));
  }
  {
    const p = emptyRoleProgress();
    p.implementer.factsByTask = {t: {files: []}};
    rejects("roleProgress: fact entry without summary rejected", validateRoleProgress(p));
  }
  for (const role of ["codeReviewer", "verifier"]) {
    const p = emptyRoleProgress();
    delete p[role].phaseWidePassComplete;
    rejects(`roleProgress: ${role} without phaseWidePassComplete rejected`, validateRoleProgress(p));
    const q = emptyRoleProgress();
    q[role].phaseWidePassComplete = "yes";
    rejects(`roleProgress: ${role} non-boolean phaseWidePassComplete rejected`, validateRoleProgress(q));
  }
  check("roleProgress: statuses and task-local statuses are the contract's sets",
    JSON.stringify(ROLE_PROGRESS_STATUSES) === JSON.stringify(["pending", "running", "complete"]) &&
    JSON.stringify(TASK_LOCAL_CHECK_STATUSES) === JSON.stringify(["attempted", "passed", "failed"]));
}

// ── taskLocalCheck: structurally distinct from a verifier verdict ────────
{
  const withCheck = (check0) => {
    const p = emptyRoleProgress();
    p.implementer.factsByTask = {t: {summary: "s", files: [], taskLocalCheck: check0}};
    return validateRoleProgress(p);
  };
  accepts("taskLocalCheck: a plain attempted/passed/failed command is accepted",
    withCheck({command: "npm test", status: "passed", exitCode: 0, summary: "ok"}));
  accepts("taskLocalCheck: absent is accepted", withCheck(undefined));
  accepts("taskLocalCheck: null is accepted", withCheck(null));
  rejects("taskLocalCheck: non-object rejected", withCheck("passed"));

  for (const key of ["verified", "verifyResult", "verdict", "decision", "approved", "approval", "reviewPassed", "pass"]) {
    const result = withCheck({command: "npm test", status: "passed", [key]: true});
    rejects(`taskLocalCheck: verdict-shaped key ${key} rejected`, result);
    check(`taskLocalCheck: ${key} rejection names the offending key`, result.evidence?.key === key, result);
  }
  // The affirmative half: a check carrying `verified: true` is exactly the
  // confusion TASK-8 forbids, and it is rejected as its own case.
  const verified = withCheck({command: "npm test", status: "passed", verified: true});
  rejects("taskLocalCheck: verified: true rejected (never a verification verdict)", verified);

  rejects("taskLocalCheck: unknown status rejected", withCheck({command: "npm test", status: "approved"}));
  rejects("taskLocalCheck: missing command rejected", withCheck({status: "passed"}));
  rejects("taskLocalCheck: non-integer exitCode rejected", withCheck({command: "npm test", status: "failed", exitCode: "1"}));
  rejects("taskLocalCheck: over-long command rejected",
    withCheck({command: "x".repeat(ROLE_PROGRESS_COMMAND_MAX_CHARS + 1), status: "passed"}));
}

// ── Bounded facts cannot grow without limit ──────────────────────────────
{
  {
    const p = emptyRoleProgress();
    p.implementer.completedTaskIds = Array.from({length: ROLE_PROGRESS_MAX_TASKS + 1}, (_, i) => `id-${i}`);
    rejects("bounded: completedTaskIds beyond the task cap rejected", validateRoleProgress(p));
  }
  {
    const p = emptyRoleProgress();
    p.implementer.factsByTask = {t: {summary: "x".repeat(ROLE_PROGRESS_SUMMARY_MAX_CHARS + 1), files: []}};
    rejects("bounded: over-long summary rejected", validateRoleProgress(p));
  }
  {
    const p = emptyRoleProgress();
    p.implementer.factsByTask = {
      t: {summary: "s", files: Array.from({length: ROLE_PROGRESS_MAX_FILES + 1}, (_, i) => `f-${i}.mjs`)},
    };
    rejects("bounded: files beyond the per-task file cap rejected", validateRoleProgress(p));
  }
  {
    const p = emptyRoleProgress();
    p.codeReviewer.findingsByTask = {
      t: {summary: "s", findings: Array.from({length: ROLE_PROGRESS_MAX_ITEMS + 1}, (_, i) => `finding-${i}`)},
    };
    rejects("bounded: findings beyond the per-task item cap rejected", validateRoleProgress(p));
  }
  {
    const p = emptyRoleProgress();
    const facts = {};
    for (let i = 0; i < 150; i += 1) {
      facts[`standalone:P1:T${i}:${"a".repeat(12)}`] = {
        summary: "x".repeat(ROLE_PROGRESS_SUMMARY_MAX_CHARS),
        files: [],
      };
    }
    p.implementer.factsByTask = facts;
    const serialized = JSON.stringify(p);
    check("bounded: fixture actually exceeds the serialized byte cap", serialized.length > ROLE_PROGRESS_MAX_BYTES,
      {length: serialized.length, cap: ROLE_PROGRESS_MAX_BYTES});
    rejects("bounded: roleProgress beyond the serialized byte cap rejected", validateRoleProgress(p));
    rejects("bounded: oversized roleProgress fails closed via validateCheckpoint()",
      validateCheckpoint(makeCheckpoint({roleProgress: p})));
  }
}

// ── Discovery (task 4) ───────────────────────────────────────────────────
// The ID generator is a module, not a test; the test file must be a runner
// candidate and absent from both exclusion sets. Asserted statically here so
// a rename or an exclusion entry fails loudly rather than silently.
{
  const runner = fs.readFileSync(path.join(here, "test-all.mjs"), "utf8");
  check("discovery: test-role-progress.mjs matches the runner discovery regex",
    /^test-.*\.mjs$/.test("test-role-progress.mjs"));
  check("discovery: role-progress-ids.mjs is not a runner candidate",
    !/^test-.*\.mjs$/.test("role-progress-ids.mjs"));
  check("discovery: test-role-progress.mjs absent from both test-all exclusion sets",
    !runner.includes("test-role-progress.mjs"));
}

console.log(`\n${ok} passed, ${failed} failed`);
if (failed) process.exit(1);
