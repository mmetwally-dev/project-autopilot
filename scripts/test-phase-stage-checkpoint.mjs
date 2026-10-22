#!/usr/bin/env node
// Phase 2 task 5 — pure checkpoint module contract tests.
//
// Covers: digest determinism and sensitivity; allowed vs impossible
// transitions; unknown version, malformed data, wrong mission, wrong
// framework, and wrong phase each yielding PHASE_CHECKPOINT_INVALID; drift
// yielding PHASE_CHECKPOINT_DRIFT with expected and observed digests
// preserved at an approval-reuse stage; and no delta match required while
// the implementer stage is pending.
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
  CHECKPOINT_VERSION, CHECKPOINT_STATE_KEY, STAGES, APPROVAL_REUSE_STAGES,
  SUPPORTED_FRAMEWORKS, INVALID_CODE, DRIFT_CODE,
  isApprovalReuseStage, resumeStage, normalizeTaskText, normalizeRepoPath,
  phaseTaskDigest, deltaDigest, validateCheckpoint, validateCheckpointFor,
  isAllowedTransition, validateTransition, createCheckpoint,
  invalidateCheckpoint, clearCheckpoint, isCheckpointForPhase,
  decideTransition, evaluatePlanningGate,
  getCachedGateResult, setCachedGateResult, isGateCacheKey, GATE_CACHE_KEY_RE,
} from "./phase-stage-checkpoint.mjs";

let ok = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); ok += 1; return; }
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  failed += 1;
}

// ── Exports ──────────────────────────────────────────────────────────────
for (const fn of [
  "isApprovalReuseStage", "resumeStage", "normalizeTaskText", "normalizeRepoPath",
  "phaseTaskDigest", "deltaDigest", "validateCheckpoint", "validateCheckpointFor",
  "isAllowedTransition", "validateTransition", "createCheckpoint",
  "invalidateCheckpoint", "clearCheckpoint", "isCheckpointForPhase",
  "decideTransition", "evaluatePlanningGate",
  "getCachedGateResult", "setCachedGateResult",
]) {
  const mod = await import("./phase-stage-checkpoint.mjs");
  check(`exports ${fn}`, typeof mod[fn] === "function");
}
check("CHECKPOINT_VERSION is 1", CHECKPOINT_VERSION === 1);
check("approval-reuse predicate covers reviewer/verifier/mark_tasks only",
  isApprovalReuseStage("code_reviewer") && isApprovalReuseStage("verifier") &&
  isApprovalReuseStage("mark_tasks") && !isApprovalReuseStage("implementer"));
check("STAGES order", JSON.stringify(STAGES) === JSON.stringify(["implementer", "code_reviewer", "verifier", "mark_tasks"]));
check("CHECKPOINT_STATE_KEY", CHECKPOINT_STATE_KEY === "phaseExecutionCheckpoint");
check("codes", INVALID_CODE === "PHASE_CHECKPOINT_INVALID" && DRIFT_CODE === "PHASE_CHECKPOINT_DRIFT");
check("supported frameworks scope standalone+speckit (GSD untouched)",
  SUPPORTED_FRAMEWORKS.includes("standalone") && SUPPORTED_FRAMEWORKS.includes("speckit") &&
  !SUPPORTED_FRAMEWORKS.includes("gsd"));

// ── Purity: no filesystem, process, or network access; no state writes ────
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.join(here, "phase-stage-checkpoint.mjs"), "utf8");
  for (const token of [
    "node:fs", "node:child_process", "node:net", "node:http", "node:https",
    "process.", "new Date(", "writeFileSync", "readFileSync", "renameSync",
    "spawnSync", "execSync", "fetch(", "XMLHttpRequest",
  ]) {
    check(`pure module: no ${token}`, !source.includes(token), token);
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────
const baseInput = {
  framework: "standalone",
  mission: "001-example",
  phaseIndex: 0,
  phaseName: "Foundation",
  tasks: [
    {file: "/repo/TASKS.md", line: 3, text: "Build the widget"},
    {file: "/repo/TASKS.md", line: 4, text: "Ship the widget"},
  ],
  repoRoot: "/repo",
  baselineKey: "mission-001-example-phase-0",
};

function makeCheckpoint(overrides = {}) {
  const cp = createCheckpoint({...baseInput, at: "2026-01-01T00:00:00.000Z"});
  return {...cp, ...overrides};
}

// ── Digest determinism and sensitivity ────────────────────────────────────
{
  const a = phaseTaskDigest(baseInput);
  const b = phaseTaskDigest(JSON.parse(JSON.stringify(baseInput)));
  check("digest: identical input is stable", a === b, {a, b});
  check("digest: sha256 shape", /^sha256:[0-9a-f]{64}$/.test(a), a);

  const edit = {...baseInput, tasks: [{...baseInput.tasks[0], text: "Build the gadget"}, baseInput.tasks[1]]};
  check("digest: task text edit changes digest", phaseTaskDigest(edit) !== a);

  const reorder = {...baseInput, tasks: [baseInput.tasks[1], baseInput.tasks[0]]};
  check("digest: reorder changes digest", phaseTaskDigest(reorder) !== a);

  const insert = {...baseInput, tasks: [...baseInput.tasks, {file: "/repo/TASKS.md", line: 5, text: "Document the widget"}]};
  check("digest: insertion changes digest", phaseTaskDigest(insert) !== a);

  const remove = {...baseInput, tasks: [baseInput.tasks[0]]};
  check("digest: removal changes digest", phaseTaskDigest(remove) !== a);

  check("digest: mission change changes digest", phaseTaskDigest({...baseInput, mission: "002-other"}) !== a);
  check("digest: phase name change changes digest", phaseTaskDigest({...baseInput, phaseName: "Other"}) !== a);
  check("digest: phase index change changes digest", phaseTaskDigest({...baseInput, phaseIndex: 1}) !== a);
  check("digest: framework change changes digest", phaseTaskDigest({...baseInput, framework: "speckit"}) !== a);

  // Durable identity is never file:line alone: moving lines without
  // reordering or editing text must NOT change the digest.
  const moved = {
    ...baseInput,
    tasks: [
      {...baseInput.tasks[0], line: 10},
      {...baseInput.tasks[1], line: 11},
    ],
  };
  check("digest: line-only move does not change digest", phaseTaskDigest(moved) === a);

  // Formatting-only differences normalize away.
  const padded = {
    ...baseInput,
    tasks: [
      {...baseInput.tasks[0], text: "  Build   the widget  <!-- autopilot-requires: commands.execute -->"},
      baseInput.tasks[1],
    ],
  };
  check("digest: whitespace/annotation-only difference does not change digest", phaseTaskDigest(padded) === a);

  const d1 = deltaDigest("diff --git a/a.js b/a.js\n+one");
  check("digest: delta stable", d1 === deltaDigest("diff --git a/a.js b/a.js\n+one"));
  check("digest: delta edit changes digest", deltaDigest("diff --git a/a.js b/a.js\n+two") !== d1);
  check("digest: empty delta is a valid digest", /^sha256:[0-9a-f]{64}$/.test(deltaDigest("")));
  for (const [label, bad] of [["undefined", undefined], ["null", null], ["number", 42], ["object", {}]]) {
    let threw = false;
    try { deltaDigest(bad); } catch (e) { threw = e instanceof TypeError; }
    check(`digest: non-string delta (${label}) throws instead of hashing as empty`, threw);
  }

  // Delimited-serialization collision regression: these distinct identities
  // share the same `|`-joined `file:...|text:...` rendering, so a delimited
  // encoding hashes them identically. The JSON canonical encoding must not.
  {
    const left = {...baseInput, tasks: [{file: "/repo/a|text:b", text: "c"}]};
    const right = {...baseInput, tasks: [{file: "/repo/a", text: "b|text:c"}]};
    check("digest: delimiter-collision identities produce distinct digests",
      phaseTaskDigest(left) !== phaseTaskDigest(right),
      {left: phaseTaskDigest(left), right: phaseTaskDigest(right)});
  }

  // Referential transparency: identical construction inputs (with an
  // explicit `at`) produce identical checkpoints.
  {
    const params = {...baseInput, at: "2026-01-01T00:00:00.000Z"};
    check("checkpoint: identical inputs produce identical checkpoints",
      JSON.stringify(createCheckpoint(params)) === JSON.stringify(createCheckpoint({...params})));
    let threw = false;
    try { createCheckpoint({...baseInput}); } catch (e) { threw = e instanceof TypeError; }
    check("checkpoint: missing `at` timestamp throws (clock is caller-owned)", threw);
  }
}

// ── Allowed vs impossible transitions ────────────────────────────────────
{
  const allowed = [
    [null, "implementer"],
    ["implementer", "implementer"],
    ["implementer", "code_reviewer"],
    ["code_reviewer", "code_reviewer"],
    ["code_reviewer", "implementer"],
    ["code_reviewer", "verifier"],
    ["verifier", "verifier"],
    ["verifier", "implementer"],
    ["verifier", "mark_tasks"],
    ["mark_tasks", "mark_tasks"],
    ["mark_tasks", null],
  ];
  for (const [from, to] of allowed) {
    check(`transition allowed: ${String(from)} -> ${String(to)}`,
      isAllowedTransition(from, to) && validateTransition(from, to).ok);
  }
  const impossible = [
    ["implementer", "verifier"],
    ["implementer", "mark_tasks"],
    ["implementer", null],
    ["implementer", "bogus"],
    ["code_reviewer", "mark_tasks"],
    ["code_reviewer", null],
    ["verifier", "code_reviewer"],
    ["verifier", null],
    ["mark_tasks", "implementer"],
    ["mark_tasks", "verifier"],
    ["mark_tasks", "code_reviewer"],
    ["bogus", "implementer"],
  ];
  for (const [from, to] of impossible) {
    const v = validateTransition(from, to);
    check(`transition impossible: ${String(from)} -> ${String(to)}`,
      !isAllowedTransition(from, to) && !v.ok && v.code === INVALID_CODE, v);
  }
}

// ── Checkpoint validation ────────────────────────────────────────────────
{
  const good = makeCheckpoint();
  check("validate: well-formed checkpoint passes", validateCheckpoint(good).ok, validateCheckpoint(good));

  check("validate: unknown version rejected",
    (() => { const r = validateCheckpoint({...good, version: 99}); return !r.ok && r.code === INVALID_CODE; })());
  for (const [label, bad] of [["null", null], ["undefined", undefined], ["number", 42], ["string", "x"], ["array", []], ["array-of-object", [{...good}]]]) {
    const r = validateCheckpoint(bad);
    check(`validate: malformed (${label}) rejected`,
      !r.ok && r.code === INVALID_CODE, r);
  }
  check("validate: missing mission rejected",
    (() => { const c = {...good}; delete c.mission; const r = validateCheckpoint(c); return !r.ok && r.code === INVALID_CODE; })());
  check("validate: bad nextStage rejected",
    (() => { const r = validateCheckpoint({...good, nextStage: "planner"}); return !r.ok && r.code === INVALID_CODE; })());
  check("validate: negative attempts rejected",
    (() => { const r = validateCheckpoint({...good, attempts: {...good.attempts, verifier: -1}}); return !r.ok && r.code === INVALID_CODE; })());
  check("validate: malformed digest rejected",
    (() => { const r = validateCheckpoint({...good, phaseTaskDigest: "not-a-digest"}); return !r.ok && r.code === INVALID_CODE; })());
  // Approval-integrity: an approval-reuse stage with no recorded delta
  // digest is invalid (it could otherwise advance through review,
  // verification, and marking with no recorded delta); the implementer
  // stage legitimately has none yet.
  for (const stage of ["code_reviewer", "verifier", "mark_tasks"]) {
    const r = validateCheckpoint({...good, nextStage: stage, runningStage: null, deltaDigest: null});
    check(`validate: ${stage} without recorded delta rejected`,
      !r.ok && r.code === INVALID_CODE, r);
  }
  check("validate: implementer without recorded delta passes",
    validateCheckpoint({...good, nextStage: "implementer", runningStage: null, deltaDigest: null}).ok);

  const wrongMission = validateCheckpointFor(good, {framework: "standalone", mission: "002-other", phaseIndex: 0});
  check("validate: wrong mission yields INVALID",
    !wrongMission.ok && wrongMission.code === INVALID_CODE &&
    wrongMission.evidence.expected === "001-example" && wrongMission.evidence.observed === "002-other", wrongMission);
  const wrongFramework = validateCheckpointFor(good, {framework: "speckit", mission: "001-example", phaseIndex: 0});
  check("validate: wrong framework yields INVALID",
    !wrongFramework.ok && wrongFramework.code === INVALID_CODE, wrongFramework);
  const wrongPhase = validateCheckpointFor(good, {framework: "standalone", mission: "001-example", phaseIndex: 2});
  check("validate: wrong phase yields INVALID",
    !wrongPhase.ok && wrongPhase.code === INVALID_CODE &&
    wrongPhase.evidence.expected === 0 && wrongPhase.evidence.observed === 2, wrongPhase);
  check("validate: matching identity passes",
    validateCheckpointFor(good, {framework: "standalone", mission: "001-example", phaseIndex: 0}).ok);

  check("helpers: clear returns null", clearCheckpoint() === null);
  check("helpers: invalidate yields INVALID",
    (() => { const r = invalidateCheckpoint(good, {reason: "test"}); return !r.ok && r.code === INVALID_CODE; })());
  check("helpers: isCheckpointForPhase",
    isCheckpointForPhase(good, {framework: "standalone", mission: "001-example", phaseIndex: 0}) &&
    !isCheckpointForPhase(good, {framework: "standalone", mission: "001-example", phaseIndex: 1}));
  check("helpers: resumeStage prefers runningStage",
    resumeStage({...good, nextStage: "verifier", runningStage: "code_reviewer"}) === "code_reviewer" &&
    resumeStage({...good, nextStage: "verifier", runningStage: null}) === "verifier");
}

// ── Stage-transition decisions ───────────────────────────────────────────
// Every outcome below is stage-bound: the claimed stage must equal the
// checkpoint's current stage (`runningStage ?? nextStage`), and raw role
// results are accepted only for successful completion and policy
// violations — anything else requires an enforceAttemptFailure() outcome.
{
  const implementing = makeCheckpoint({nextStage: "implementer", runningStage: null, deltaDigest: null});
  const d1 = decideTransition(implementing, {stage: "implementer", status: "completed", runId: "r1", summary: "did it", deltaDigest: deltaDigest("delta-1")});
  check("decide: implementer completed advances to code_reviewer",
    d1.ok && d1.action === "advance" && d1.nextStage === "code_reviewer" && d1.revision === 1, d1);

  // Missing/malformed implementer delta can never enter code_reviewer: the
  // recorded digest is the approval evidence every later stage reuses.
  for (const [label, outcome] of [
    ["missing", {stage: "implementer", status: "completed", runId: "r1"}],
    ["malformed", {stage: "implementer", status: "completed", runId: "r1", deltaDigest: "not-a-digest"}],
  ]) {
    const r = decideTransition(implementing, outcome);
    check(`decide: implementer completion with ${label} delta cannot enter code_reviewer`,
      !r.ok && r.code === INVALID_CODE, r);
  }

  const reviewing = makeCheckpoint({nextStage: "code_reviewer", runningStage: null, deltaDigest: deltaDigest("delta-1")});
  const d2 = decideTransition(reviewing, {stage: "code_reviewer", status: "completed", decision: "PASS", runId: "r2"});
  check("decide: reviewer PASS advances to verifier", d2.ok && d2.nextStage === "verifier", d2);

  // Raw failures never decide retries/restarts: a functional FAIL must come
  // back as an enforceAttemptFailure() outcome (sole budget authority).
  const d3 = decideTransition(reviewing, {stage: "code_reviewer", status: "completed", decision: "FAIL", findings: ["fix it"]});
  check("decide: raw reviewer FAIL requires enforcement (no direct restart)",
    !d3.ok && d3.code === "ENFORCEMENT_REQUIRED", d3);

  const verifying = makeCheckpoint({nextStage: "verifier", deltaDigest: deltaDigest("delta-1")});
  const d4 = decideTransition(verifying, {stage: "verifier", status: "completed", decision: "PASS", runId: "r3"});
  check("decide: verifier PASS advances to mark_tasks", d4.ok && d4.nextStage === "mark_tasks", d4);

  const d5 = decideTransition(verifying, {stage: "verifier", status: "completed", decision: "FAIL", findings: ["broken"]});
  check("decide: raw verifier FAIL requires enforcement (no direct restart)",
    !d5.ok && d5.code === "ENFORCEMENT_REQUIRED", d5);

  const interrupted = makeCheckpoint({nextStage: "code_reviewer", runningStage: "code_reviewer", deltaDigest: deltaDigest("delta-1")});
  const d6 = decideTransition(interrupted, {stage: "code_reviewer", status: "crashed"});
  check("decide: raw interrupted result requires enforcement (no direct retry)",
    !d6.ok && d6.code === "ENFORCEMENT_REQUIRED", d6);

  const d7 = decideTransition(verifying,
    {failure: {domain: "infrastructure", sourceRole: "verifier"}, budget: {allowed: true}, scope: "task:x"});
  check("decide: infra budget outcome retries the interrupted stage",
    d7.ok && d7.action === "retry" && d7.nextStage === "verifier", d7);

  const d8 = decideTransition(verifying,
    {failure: {domain: "verification", sourceRole: "verifier"}, budget: {allowed: true}, scope: "task:x"});
  check("decide: functional budget outcome returns to implementer",
    d8.ok && d8.action === "restart" && d8.nextStage === "implementer" && d8.revision === 2, d8);

  const d8b = decideTransition(reviewing,
    {failure: {domain: "implementation", sourceRole: "code_reviewer"}, budget: {allowed: true}, scope: "task:x"});
  check("decide: reviewer functional FAIL via enforcement returns to implementer with revision+1 and cleared approval",
    d8b.ok && d8b.action === "restart" && d8b.nextStage === "implementer" && d8b.revision === 2 && d8b.clearApprovals === true, d8b);

  const d9 = decideTransition(reviewing,
    {failure: {domain: "infrastructure", sourceRole: "code_reviewer"}, budget: {allowed: false, budget: "verificationFailureBudget"}, scope: "task:x"});
  check("decide: exhausted budget escalates (no attempts-limit check)", !d9.ok, d9);

  const d10 = decideTransition(reviewing, {stage: "implementer", status: "completed", policyViolation: "git_commit_detected"});
  check("decide: policy violation escalates", !d10.ok, d10);

  const marking = makeCheckpoint({nextStage: "mark_tasks", deltaDigest: deltaDigest("delta-1")});
  const d11 = decideTransition(marking, {stage: "mark_tasks", status: "completed"});
  check("decide: mark_tasks completed is terminal", d11.ok && d11.action === "complete" && d11.nextStage === null, d11);

  const d12 = decideTransition(marking,
    {failure: {domain: "infrastructure", sourceRole: "mark_tasks"}, budget: {allowed: true}, scope: "task:x"});
  check("decide: interrupted marking retries mark_tasks (idempotent crash-recovery edge)",
    d12.ok && d12.action === "retry" && d12.nextStage === "mark_tasks", d12);

  // Stage binding: a result for any other stage than the checkpoint's
  // current stage is rejected, never applied.
  const dBind1 = decideTransition(implementing, {stage: "code_reviewer", status: "completed", decision: "PASS"});
  check("decide: outcome stage must match checkpoint stage (reviewer result at implementer rejected)",
    !dBind1.ok && dBind1.code === INVALID_CODE &&
    dBind1.evidence.expected === "implementer" && dBind1.evidence.observed === "code_reviewer", dBind1);
  const dBind2 = decideTransition(implementing,
    {failure: {domain: "infrastructure", sourceRole: "verifier"}, budget: {allowed: true}, scope: "task:x"});
  check("decide: mismatched failure sourceRole rejected",
    !dBind2.ok && dBind2.code === INVALID_CODE, dBind2);
  const dBind3 = decideTransition(reviewing,
    {failure: {domain: "infrastructure", sourceRole: "planner"}, budget: {allowed: true}, scope: "task:x"});
  check("decide: unknown failure sourceRole rejected (never treated as current stage)",
    !dBind3.ok && dBind3.code === INVALID_CODE, dBind3);

  // Attempts are a display/backoff aid: incremented, never limit-checked here.
  check("decide: attempts increment without any limit comparison",
    d2.attempts.code_reviewer === 1 && d4.attempts.verifier === 1 && d1.attempts.implementer === 1, {d1: d1.attempts, d2: d2.attempts});
}

// ── Planning-gate evaluator: three-way decision, never a boolean ─────────
{
  const phase = {mission: "001-example", phaseIndex: 0, allChecked: false};
  const reviewing = makeCheckpoint({nextStage: "code_reviewer", deltaDigest: deltaDigest("delta-1")});
  const observed = {phaseTaskDigest: reviewing.phaseTaskDigest, deltaDigest: deltaDigest("delta-1")};

  const g0 = evaluatePlanningGate(null, "standalone", phase, observed);
  check("gate: no checkpoint plans", typeof g0 === "object" && g0.action === "plan", g0);

  const gGsd = evaluatePlanningGate(reviewing, "gsd", phase, observed);
  check("gate: GSD framework untouched (plans)", typeof gGsd === "object" && gGsd.action === "plan", gGsd);

  const gFw = evaluatePlanningGate(reviewing, "speckit", phase, observed);
  check("gate: checkpoint not applicable to this framework plans", gFw.action === "plan", gFw);

  const g1 = evaluatePlanningGate(reviewing, "standalone", phase, observed);
  check("gate: valid checkpoint at approval-reuse stage resumes",
    typeof g1 === "object" && typeof g1 !== "boolean" && g1.action === "resume", g1);

  const gDrift = evaluatePlanningGate(reviewing, "standalone", phase,
    {phaseTaskDigest: reviewing.phaseTaskDigest, deltaDigest: deltaDigest("changed-tree")});
  check("gate: drifted delta at approval-reuse stage escalates with expected+observed",
    gDrift.action === "escalate" && gDrift.code === DRIFT_CODE &&
    gDrift.evidence.expectedDeltaDigest === reviewing.deltaDigest &&
    gDrift.evidence.observedDeltaDigest === deltaDigest("changed-tree"), gDrift);

  const gTaskDrift = evaluatePlanningGate(reviewing, "standalone", phase,
    {phaseTaskDigest: phaseTaskDigest({...baseInput, phaseName: "Renamed"}), deltaDigest: deltaDigest("delta-1")});
  check("gate: drifted tasks escalate with expected+observed task digests",
    gTaskDrift.action === "escalate" && gTaskDrift.code === DRIFT_CODE &&
    gTaskDrift.evidence.expectedTaskDigest === reviewing.phaseTaskDigest &&
    typeof gTaskDrift.evidence.observedTaskDigest === "string", gTaskDrift);

  const gBad = evaluatePlanningGate({...reviewing, version: 99}, "standalone", phase, observed);
  check("gate: unknown version escalates INVALID", gBad.action === "escalate" && gBad.code === INVALID_CODE, gBad);

  const gWrongMission = evaluatePlanningGate(reviewing, "standalone", {...phase, mission: "002-other"}, observed);
  check("gate: wrong mission escalates INVALID", gWrongMission.action === "escalate" && gWrongMission.code === INVALID_CODE, gWrongMission);

  const gDecl = evaluatePlanningGate(reviewing, "standalone", phase,
    {phaseTaskDigest: reviewing.phaseTaskDigest, deltaError: Object.assign(new Error("mismatch"), {code: "DECLARATION_MISMATCH"})});
  check("gate: DECLARATION_MISMATCH treated as drift, never a crash",
    gDecl.action === "escalate" && gDecl.code === DRIFT_CODE, gDecl);

  const marking = makeCheckpoint({nextStage: "mark_tasks", deltaDigest: deltaDigest("delta-1")});
  const gMark = evaluatePlanningGate(marking, "standalone", phase,
    {phaseTaskDigest: marking.phaseTaskDigest, deltaDigest: deltaDigest("post-pass-edit")});
  check("gate: mark_tasks delta drift escalates rather than marking",
    gMark.action === "escalate" && gMark.code === DRIFT_CODE, gMark);

  // No delta match required while the implementer stage is pending: partial
  // work legitimately changed the delta, so even a wholly different (or
  // absent) delta and a deltaError must still resume without drift.
  const implementing = makeCheckpoint({nextStage: "implementer", runningStage: "implementer", deltaDigest: null});
  const i1 = evaluatePlanningGate(implementing, "standalone", phase,
    {phaseTaskDigest: implementing.phaseTaskDigest, deltaDigest: deltaDigest("partial-work")});
  check("gate: interrupted implementer resumes despite delta change (no drift)", i1.action === "resume", i1);
  const i2 = evaluatePlanningGate(implementing, "standalone", phase,
    {phaseTaskDigest: implementing.phaseTaskDigest});
  check("gate: implementer resume needs no delta digest at all", i2.action === "resume", i2);
  const i3 = evaluatePlanningGate(implementing, "standalone", phase,
    {phaseTaskDigest: implementing.phaseTaskDigest, deltaError: Object.assign(new Error("mismatch"), {code: "DECLARATION_MISMATCH"})});
  check("gate: implementer ignores deltaError", i3.action === "resume", i3);

  const gDone = evaluatePlanningGate(reviewing, "standalone", {...phase, allChecked: true}, observed);
  check("gate: all-checked phase does not bypass to resume", gDone.action !== "resume", gDone);
}

// ── Planning-gate evaluator: TASK-11 task 13 branch completions ─────────
// Additive pins for branches the block above leaves implicit. Every decision
// is asserted as a named action on an object — never a boolean.
{
  const phase = {mission: "001-example", phaseIndex: 0, allChecked: false};
  const reviewing = makeCheckpoint({nextStage: "code_reviewer", deltaDigest: deltaDigest("delta-1")});
  const observed = {phaseTaskDigest: reviewing.phaseTaskDigest, deltaDigest: deltaDigest("delta-1")};

  const gDonePlan = evaluatePlanningGate(reviewing, "standalone", {...phase, allChecked: true}, observed);
  check("gate: all-checked phase returns plan (today's planning route)",
    gDonePlan.action === "plan", gDonePlan);

  const gWrongPhase = evaluatePlanningGate(reviewing, "standalone", {...phase, phaseIndex: 2}, observed);
  check("gate: wrong phaseIndex escalates INVALID with expected+observed",
    gWrongPhase.action === "escalate" && gWrongPhase.code === INVALID_CODE &&
    gWrongPhase.evidence.expected === 0 && gWrongPhase.evidence.observed === 2, gWrongPhase);

  const speckitCp = {
    ...createCheckpoint({...baseInput, framework: "speckit", at: "2026-01-01T00:00:00.000Z"}),
    nextStage: "verifier", deltaDigest: deltaDigest("delta-1"),
  };
  const gSpeckit = evaluatePlanningGate(speckitCp, "speckit", phase,
    {phaseTaskDigest: speckitCp.phaseTaskDigest, deltaDigest: deltaDigest("delta-1")});
  check("gate: valid speckit checkpoint at approval-reuse stage resumes",
    typeof gSpeckit === "object" && gSpeckit.action === "resume", gSpeckit);

  // Every decision object in this block carries a string action — a boolean
  // can never satisfy a strict action comparison below.
  for (const [name, decision] of [["plan-on-done", gDonePlan], ["phase-mismatch", gWrongPhase], ["speckit-resume", gSpeckit]]) {
    check(`gate: ${name} decision is an object with a string action (never a boolean)`,
      typeof decision === "object" && decision !== null && typeof decision.action === "string", decision);
  }

  // Authority-derived phase inputs (TASK-11 task 12 gate bypass): a phase
  // index with no phase, and a baseline key that does not equal the
  // authority-derived key, each escalate INVALID before any digest is
  // compared or approval consumed. Matching inputs proceed.
  const gNoPhase = evaluatePlanningGate(reviewing, "standalone",
    {...phase, exists: false, phaseCount: 1, expectedBaselineKey: reviewing.baselineKey}, observed);
  check("gate: nonexistent phase escalates INVALID with index and range",
    gNoPhase.action === "escalate" && gNoPhase.code === INVALID_CODE &&
    gNoPhase.evidence.phaseIndex === 0 && gNoPhase.evidence.phaseCount === 1, gNoPhase);

  const gBadKey = evaluatePlanningGate(reviewing, "standalone",
    {...phase, exists: true, phaseCount: 1, expectedBaselineKey: "mission-001-example-phase-1"}, observed);
  check("gate: foreign baseline key escalates INVALID with expected+observed",
    gBadKey.action === "escalate" && gBadKey.code === INVALID_CODE &&
    gBadKey.evidence.expected === "mission-001-example-phase-1" &&
    gBadKey.evidence.observed === reviewing.baselineKey, gBadKey);

  const gTraversalCp = {...reviewing, baselineKey: "../../evil-baseline"};
  const gTraversal = evaluatePlanningGate(gTraversalCp, "standalone",
    {...phase, exists: true, phaseCount: 1, expectedBaselineKey: "mission-001-example-phase-0"}, observed);
  check("gate: traversal-shaped baseline key escalates INVALID",
    gTraversal.action === "escalate" && gTraversal.code === INVALID_CODE &&
    gTraversal.evidence.observed === "../../evil-baseline", gTraversal);

  const gGoodKey = evaluatePlanningGate(reviewing, "standalone",
    {...phase, exists: true, phaseCount: 1, expectedBaselineKey: reviewing.baselineKey}, observed);
  check("gate: matching phase and baseline key proceed to resume",
    gGoodKey.action === "resume", gGoodKey);
}

// ── Gate-result cache (mission 040 task 1.1) ─────────────────────────────
{
  const key = `${deltaDigest("delta-1")}|${deltaDigest('["cmd"]')}`;
  check("gateCache: composite key matches sha256:<64hex>|sha256:<64hex>",
    GATE_CACHE_KEY_RE.test(key) && isGateCacheKey(key), key);
  check("gateCache: bare digest key rejected",
    !isGateCacheKey(deltaDigest("delta-1")) && !GATE_CACHE_KEY_RE.test(deltaDigest("delta-1")));
  check("gateCache: malformed key rejected",
    !isGateCacheKey("not-a-key") && !isGateCacheKey("") && !isGateCacheKey(null));

  // Helpers read/write.
  const cp = makeCheckpoint();
  check("gateCache: miss returns null", getCachedGateResult(cp, key) === null);
  const gateResult = {ok: true, summary: "pass"};
  setCachedGateResult(cp, key, gateResult);
  check("gateCache: hit returns stored entry",
    JSON.stringify(getCachedGateResult(cp, key)) === JSON.stringify(gateResult));
  check("gateCache: stored as plain object, not Map",
    cp.gateCache !== null && typeof cp.gateCache === "object" &&
    !(cp.gateCache instanceof Map) && !Array.isArray(cp.gateCache));

  // Validation accepts a well-formed cache.
  check("gateCache: well-formed cache validates", validateCheckpoint(cp).ok, validateCheckpoint(cp));

  // JSON round-trip preserves the cache.
  const roundTripped = JSON.parse(JSON.stringify(cp));
  check("gateCache: JSON round-trip preserves entry",
    JSON.stringify(getCachedGateResult(roundTripped, key)) === JSON.stringify(gateResult) &&
    validateCheckpoint(roundTripped).ok);

  // Absent cache stays valid (pre-existing checkpoints).
  check("gateCache: absent cache validates", validateCheckpoint(makeCheckpoint()).ok);

  // Malformed caches fail closed.
  const badCases = [
    ["bare digest key", {[deltaDigest("delta-1")]: {ok: true}}],
    ["malformed key", {"not-a-key": {ok: true}}],
    ["non-object value", {[key]: true}],
    ["entry without boolean ok", {[key]: {summary: "no ok"}}],
    ["entry with non-boolean ok", {[key]: {ok: "yes"}}],
    ["non-object cache", []],
  ];
  for (const [label, gateCache] of badCases) {
    const r = validateCheckpoint({...makeCheckpoint(), gateCache});
    check(`gateCache: invalid (${label}) fails validation`,
      !r.ok && r.code === INVALID_CODE, r);
  }
}

console.log(`\n${ok} passed, ${failed} failed`);
if (failed) process.exit(1);
