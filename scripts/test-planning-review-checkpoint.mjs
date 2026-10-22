#!/usr/bin/env node
// Planning-review checkpoint unit tests: the pure module is exercised
// directly (never the filesystem, never a subprocess).
//
// Covers:
// - artifact-digest determinism, sensitivity (content edit, path change,
//   inclusion change), and collision-resistance vs a delimited join;
// - unknown version and mismatched mission/feature identity → invalid, for
//   both models;
// - the eight malformed-shape cases, each as its own distinct case;
// - reviewer-position digest present-but-mismatched → escalate, vs
//   writable-position content change → resume (two explicit cases);
// - the per-gate manifest (review-spec → spec only; review-plan →
//   spec+plan; review-tasks → all three);
// - standalone's explicit three-state model (absence is never equivalent
//   to an explicit "planner-pending" reading, nor to a present-but-
//   incomplete object).
//
// Control-case note: `checkpoint == null` (the checkpoint key genuinely
// not present) is NOT asserted here at all. Absence never reaches this
// module's structural validator — the Phase 5/6 wiring decides that case
// before this module is consulted — so the null case stays anchored to
// the wiring-layer tests (tasks 17/21), not duplicated here as a
// pseudo-valid input to the pure validator.
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
  PLANNING_REVIEW_CHECKPOINT_VERSION,
  STANDALONE_PLANNING_REVIEW_CHECKPOINT_KEY,
  SPECKIT_GATE_REVIEW_CHECKPOINT_KEY,
  STANDALONE_PLANNER_POSITION,
  STANDALONE_REVIEWER_POSITION,
  STANDALONE_POSITIONS,
  SPECKIT_INITIAL_REVIEW,
  SPECKIT_PLANNER_REVISION,
  SPECKIT_POST_REVISION_REVIEW,
  SPECKIT_SUBSTAGES,
  SPECKIT_GATES,
  SPECKIT_GATE_MANIFEST,
  STANDALONE_ARTIFACT_ROLES,
  INVALID_CODE,
  DRIFT_CODE,
  manifestForGate,
  isReviewerPosition,
  isWritablePosition,
  normalizeRepoPath,
  artifactDigest,
  validateStandaloneCheckpoint,
  validateStandaloneCheckpointFor,
  evaluateStandaloneReview,
  validateSpeckitCheckpoint,
  validateSpeckitCheckpointFor,
  evaluateSpeckitGateReview,
  createStandaloneCheckpoint,
  createSpeckitCheckpoint,
} from "./planning-review-checkpoint.mjs";

let ok = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); ok += 1; return; }
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  failed += 1;
}

// ── Exports ──────────────────────────────────────────────────────────────
for (const fn of [
  "manifestForGate", "isReviewerPosition", "isWritablePosition",
  "normalizeRepoPath", "artifactDigest",
  "validateStandaloneCheckpoint", "validateStandaloneCheckpointFor",
  "evaluateStandaloneReview",
  "validateSpeckitCheckpoint", "validateSpeckitCheckpointFor",
  "evaluateSpeckitGateReview",
  "createStandaloneCheckpoint", "createSpeckitCheckpoint",
]) {
  const mod = await import("./planning-review-checkpoint.mjs");
  check(`exports ${fn}`, typeof mod[fn] === "function");
}
check("VERSION is 1", PLANNING_REVIEW_CHECKPOINT_VERSION === 1);
check("standalone state key", STANDALONE_PLANNING_REVIEW_CHECKPOINT_KEY === "standalonePlanningReviewCheckpoint");
check("speckit state key", SPECKIT_GATE_REVIEW_CHECKPOINT_KEY === "speckitGateReviewCheckpoint");
check("codes", INVALID_CODE === "PLANNING_REVIEW_CHECKPOINT_INVALID" && DRIFT_CODE === "PLANNING_REVIEW_CHECKPOINT_DRIFT");
check("standalone positions", JSON.stringify(STANDALONE_POSITIONS) === JSON.stringify(["planner-pending", "reviewer-pending"]));
check("speckit substages",
  JSON.stringify(SPECKIT_SUBSTAGES) === JSON.stringify(["initial_review", "planner_revision", "post_revision_review"]));
check("speckit gates", JSON.stringify(SPECKIT_GATES) === JSON.stringify(["review-spec", "review-plan", "review-tasks"]));

// ── Purity: no filesystem, process, or network access; no clock reads ────
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.join(here, "planning-review-checkpoint.mjs"), "utf8");
  for (const token of [
    "node:fs", "node:child_process", "node:net", "node:http", "node:https",
    "process.", "new Date(", "Date.now(", "writeFileSync", "readFileSync", "renameSync",
    "spawnSync", "execSync", "fetch(", "XMLHttpRequest",
  ]) {
    check(`pure: no ${token}`, !source.includes(token), token);
  }
  // Single digest constructor: both evaluators hash through artifactDigest,
  // never an independent or delimited-string implementation.
  const standaloneBody = source.split("export function evaluateStandaloneReview")[1].split("export function ")[0];
  const speckitBody = source.split("export function evaluateSpeckitGateReview")[1].split("export function ")[0];
  check("standalone evaluator hashes via artifactDigest()", standaloneBody.includes("artifactDigest("), standaloneBody.slice(0, 120));
  check("speckit evaluator hashes via artifactDigest()", speckitBody.includes("artifactDigest("), speckitBody.slice(0, 120));
  check("no delimited-string digest", !source.includes("join(\"|\")") && !source.includes("join('|')"));
}

// ── Fixtures ─────────────────────────────────────────────────────────────
const MISSION = "003-planning-review-attempt-failure";
const FEATURE = "001-foo";
const AT = "2026-09-19T00:00:00.000Z";

const SA_PATHS = ["PLAN.md", "TASKS.md"];
const SA_CONTENTS = ["# Plan v1\n", "- [ ] task one\n"];
const saDigest = () => artifactDigest({paths: SA_PATHS, contents: SA_CONTENTS});
const saObserved = (contents = SA_CONTENTS, paths = SA_PATHS) => ({
  artifacts: paths.map((entryPath, index) => ({path: entryPath, content: contents[index]})),
});
const saContext = (overrides = {}) => ({mission: MISSION, ...overrides});
function saCheckpoint(overrides = {}) {
  return createStandaloneCheckpoint({
    mission: MISSION, position: STANDALONE_REVIEWER_POSITION,
    artifacts: [...SA_PATHS], artifactDigest: saDigest(), at: AT, ...overrides,
  });
}

const SPEC = "specs/001-foo/spec.md";
const PLAN = "specs/001-foo/plan.md";
const TASKS = "specs/001-foo/tasks.md";
const SPEC_C = "# Spec\n";
const PLAN_C = "# Plan\n";
const TASKS_C = "- [ ] t\n";
const GATE_TABLE = {
  "review-spec": {paths: [SPEC], contents: [SPEC_C], gateIndex: 1},
  "review-plan": {paths: [SPEC, PLAN], contents: [SPEC_C, PLAN_C], gateIndex: 3},
  "review-tasks": {paths: [SPEC, PLAN, TASKS], contents: [SPEC_C, PLAN_C, TASKS_C], gateIndex: 5},
};
const skContext = (gate, overrides = {}) => ({
  mission: MISSION, feature: FEATURE, gate, gateIndex: GATE_TABLE[gate].gateIndex, ...overrides,
});
const skObserved = (gate, contents) => ({
  artifacts: GATE_TABLE[gate].paths.map((entryPath, index) => ({
    path: entryPath,
    content: (contents ?? GATE_TABLE[gate].contents)[index],
  })),
});
function skCheckpoint(gate, substage, overrides = {}) {
  const table = GATE_TABLE[gate];
  return createSpeckitCheckpoint({
    mission: MISSION, feature: FEATURE, gate, gateIndex: table.gateIndex, substage,
    artifacts: [...table.paths], artifactDigest: artifactDigest({paths: table.paths, contents: table.contents}),
    at: AT, ...overrides,
  });
}

function isEscalate(result, code) {
  return result !== null && typeof result === "object" && typeof result !== "boolean"
    && result.action === "escalate" && (code === undefined || result.code === code);
}
function isResume(result) {
  return result !== null && typeof result === "object" && typeof result !== "boolean" && result.action === "resume";
}

// ── Digest determinism and sensitivity ───────────────────────────────────
{
  const first = artifactDigest({paths: SA_PATHS, contents: SA_CONTENTS});
  const second = artifactDigest({paths: [...SA_PATHS], contents: [...SA_CONTENTS]});
  check("digest: identical input is stable", first === second, {first, second});
  const pairShape = artifactDigest({artifacts: SA_PATHS.map((p, i) => ({path: p, content: SA_CONTENTS[i]}))});
  check("digest: {paths,contents} and {artifacts} shapes hash identically", pairShape === first, {pairShape, first});
  check("digest: order-independent for the same set",
    artifactDigest({paths: [...SA_PATHS].reverse(), contents: [...SA_CONTENTS].reverse()}) === first);
  const edited = artifactDigest({paths: SA_PATHS, contents: ["# Plan v2\n", SA_CONTENTS[1]]});
  check("digest: a content edit changes the digest", edited !== first, {edited, first});
  const moved = artifactDigest({paths: ["PLAN.md", "TASKS-moved.md"], contents: SA_CONTENTS});
  check("digest: a path change changes the digest", moved !== first, {moved, first});
  const dropped = artifactDigest({paths: ["PLAN.md"], contents: [SA_CONTENTS[0]]});
  check("digest: a change in which files are included changes the digest", dropped !== first, {dropped, first});
  // Two distinct path+content combinations that collide under a naive
  // delimited join must not collide here.
  const naive = (paths, contents) => [...paths, ...contents].join("|");
  const aPaths = ["a|b"], aContents = ["c"];
  const bPaths = ["a"], bContents = ["b|c"];
  check("collision fixture really collides naively", naive(aPaths, aContents) === naive(bPaths, bContents));
  const digestA = artifactDigest({paths: aPaths, contents: aContents});
  const digestB = artifactDigest({paths: bPaths, contents: bContents});
  check("digest: delimiter-colliding inputs do not collide", digestA !== digestB, {digestA, digestB});
  // Paths fold through normalizeRepoPath: repoRoot prefix, backslashes,
  // and a leading ./ all name the same repository-relative file.
  const rooted = artifactDigest({artifacts: [{path: "/repo/PLAN.md", content: SA_CONTENTS[0]}], repoRoot: "/repo"});
  const plain = artifactDigest({artifacts: [{path: "PLAN.md", content: SA_CONTENTS[0]}]});
  check("digest: repoRoot-prefixed path equals the relative path", rooted === plain, {rooted, plain});
  const slashed = artifactDigest({artifacts: [{path: ".\\PLAN.md", content: SA_CONTENTS[0]}]});
  check("digest: backslash/leading-dot paths normalize", slashed === plain, {slashed, plain});
  let threw = 0;
  try { artifactDigest({paths: SA_PATHS, contents: [SA_CONTENTS[0]]}); } catch { threw += 1; }
  try { artifactDigest({paths: SA_PATHS, contents: [SA_CONTENTS[0], null]}); } catch { threw += 1; }
  try { artifactDigest({paths: ["", "TASKS.md"], contents: SA_CONTENTS}); } catch { threw += 1; }
  check("digest: mismatched arrays, non-string content, and empty paths throw (never hashed as empty)", threw === 3, threw);
}

// ── Stage-sensitivity predicate: all five named positions ────────────────
for (const [position, reviewer, writable] of [
  ["planner-pending", false, true],
  ["reviewer-pending", true, false],
  ["initial_review", true, false],
  ["planner_revision", false, true],
  ["post_revision_review", true, false],
]) {
  check(`predicate: ${position} reviewer=${reviewer} writable=${writable}`,
    isReviewerPosition(position) === reviewer && isWritablePosition(position) === writable);
}
check("predicate: unknown position is neither reviewer nor writable",
  isReviewerPosition("bogus") === false && isWritablePosition("bogus") === false);
check("predicate: null position is neither reviewer nor writable",
  isReviewerPosition(null) === false && isWritablePosition(null) === false);

// ── Per-gate manifest ────────────────────────────────────────────────────
check("manifest: review-spec → spec only",
  JSON.stringify(manifestForGate("review-spec")) === JSON.stringify(["spec"]));
check("manifest: review-plan → spec+plan",
  JSON.stringify(manifestForGate("review-plan")) === JSON.stringify(["spec", "plan"]));
check("manifest: review-tasks → spec+plan+tasks",
  JSON.stringify(manifestForGate("review-tasks")) === JSON.stringify(["spec", "plan", "tasks"]));
check("manifest: unknown gate → null", manifestForGate("review-docs") === null && manifestForGate(null) === null);
check("manifest: standalone binds plan+tasks",
  JSON.stringify(STANDALONE_ARTIFACT_ROLES) === JSON.stringify(["plan", "tasks"]));
check("manifest export matches accessor",
  JSON.stringify(SPECKIT_GATE_MANIFEST["review-spec"]) === JSON.stringify(manifestForGate("review-spec")));

// ── Valid baselines resume ───────────────────────────────────────────────
{
  const result = evaluateStandaloneReview(saCheckpoint(), saContext(), saObserved());
  check("standalone reviewer-pending with matching content resumes", isResume(result), result);
  const planner = evaluateStandaloneReview(
    saCheckpoint({position: STANDALONE_PLANNER_POSITION, artifactDigest: null}),
    saContext(), saObserved()
  );
  check("standalone planner-pending resumes (digest legitimately null)", isResume(planner)
    && planner.evidence?.position === STANDALONE_PLANNER_POSITION, planner);
  for (const [gate, substage] of [
    ["review-spec", "initial_review"],
    ["review-plan", "planner_revision"],
    ["review-tasks", "post_revision_review"],
  ]) {
    const checkpoint = substage === "planner_revision"
      ? skCheckpoint(gate, substage, {artifactDigest: null})
      : skCheckpoint(gate, substage);
    const observed = substage === "planner_revision"
      ? {artifacts: GATE_TABLE[gate].paths.map((p) => ({path: p, content: null}))}
      : skObserved(gate);
    const outcome = evaluateSpeckitGateReview(checkpoint, skContext(gate), observed);
    check(`speckit ${gate}/${substage} with matching state resumes`, isResume(outcome)
      && outcome.evidence?.substage === substage && outcome.evidence?.gate === gate, outcome);
  }
}

// ── Unknown version and mismatched identity → invalid, both models ──────
{
  const standaloneVersioned = {...saCheckpoint(), version: 999};
  const standaloneVersion = validateStandaloneCheckpoint(standaloneVersioned);
  check("standalone unknown version is invalid",
    standaloneVersion.ok === false && standaloneVersion.code === INVALID_CODE, standaloneVersion);
  check("standalone unknown version escalates (never treated as absent)",
    isEscalate(evaluateStandaloneReview({...saCheckpoint(), version: 999}, saContext(), saObserved()), INVALID_CODE));
  const speckitVersioned = {...skCheckpoint("review-plan", "initial_review"), version: 999};
  const speckitVersion = validateSpeckitCheckpoint(speckitVersioned);
  check("speckit unknown version is invalid",
    speckitVersion.ok === false && speckitVersion.code === INVALID_CODE, speckitVersion);
  check("speckit unknown version escalates (never treated as absent)",
    isEscalate(evaluateSpeckitGateReview(
      {...skCheckpoint("review-plan", "initial_review"), version: 999}, skContext("review-plan"), skObserved("review-plan")
    ), INVALID_CODE));
  check("standalone mismatched mission escalates",
    isEscalate(evaluateStandaloneReview(saCheckpoint(), saContext({mission: "999-other"}), saObserved()), INVALID_CODE));
  check("speckit mismatched feature escalates",
    isEscalate(evaluateSpeckitGateReview(
      skCheckpoint("review-plan", "initial_review"), skContext("review-plan", {feature: "999-other"}), skObserved("review-plan")
    ), INVALID_CODE));
  check("speckit mismatched mission escalates",
    isEscalate(evaluateSpeckitGateReview(
      skCheckpoint("review-plan", "initial_review"), skContext("review-plan", {mission: "999-other"}), skObserved("review-plan")
    ), INVALID_CODE));
}

// ── Malformed-shape case 1: missing a required identity field entirely ──
// (Distinct from present-but-mismatched above: the field is absent, not wrong.)
{
  const missing = {...saCheckpoint()};
  delete missing.mission;
  check("case 1a: standalone checkpoint missing its mission field is invalid",
    validateStandaloneCheckpoint(missing).ok === false
    && isEscalate(evaluateStandaloneReview(missing, saContext(), saObserved()), INVALID_CODE), missing);
  const speckitMissing = {...skCheckpoint("review-plan", "initial_review")};
  delete speckitMissing.feature;
  check("case 1b: speckit checkpoint missing its feature field is invalid",
    validateSpeckitCheckpoint(speckitMissing).ok === false
    && isEscalate(evaluateSpeckitGateReview(speckitMissing, skContext("review-plan"), skObserved("review-plan")), INVALID_CODE),
    speckitMissing);
}

// ── Malformed-shape case 2: present object, position field missing/null ──
// (This is "field absent from a present object" — not "no checkpoint at
// all", which never reaches this validator.)
{
  const missing = {...saCheckpoint()};
  delete missing.position;
  check("case 2a: present standalone object with missing position is invalid",
    validateStandaloneCheckpoint(missing).ok === false
    && isEscalate(evaluateStandaloneReview(missing, saContext(), saObserved()), INVALID_CODE), missing);
  const nulled = saCheckpoint({position: null});
  check("case 2b: present standalone object with null position is invalid",
    validateStandaloneCheckpoint(nulled).ok === false
    && isEscalate(evaluateStandaloneReview(nulled, saContext(), saObserved()), INVALID_CODE), nulled);
}

// ── Malformed-shape case 3: present object, position present but wrong ───
{
  const wrong = saCheckpoint({position: "reviewer-done"});
  check("case 3: standalone position other than planner/reviewer-pending is invalid",
    validateStandaloneCheckpoint(wrong).ok === false
    && isEscalate(evaluateStandaloneReview(wrong, saContext(), saObserved()), INVALID_CODE), wrong);
}

// ── Malformed-shape case 4: present object, substage field missing/null ──
{
  const missing = {...skCheckpoint("review-plan", "initial_review")};
  delete missing.substage;
  check("case 4a: present speckit object with missing substage is invalid",
    validateSpeckitCheckpoint(missing).ok === false
    && isEscalate(evaluateSpeckitGateReview(missing, skContext("review-plan"), skObserved("review-plan")), INVALID_CODE),
    missing);
  const nulled = skCheckpoint("review-plan", "initial_review", {substage: null});
  check("case 4b: present speckit object with null substage is invalid",
    validateSpeckitCheckpoint(nulled).ok === false
    && isEscalate(evaluateSpeckitGateReview(nulled, skContext("review-plan"), skObserved("review-plan")), INVALID_CODE),
    nulled);
}

// ── Malformed-shape case 5: substage present but unrecognized ────────────
{
  const wrong = skCheckpoint("review-plan", "re_review");
  check("case 5: speckit substage outside the three known values is invalid",
    validateSpeckitCheckpoint(wrong).ok === false
    && isEscalate(evaluateSpeckitGateReview(wrong, skContext("review-plan"), skObserved("review-plan")), INVALID_CODE),
    wrong);
}

// ── Malformed-shape case 6: malformed digest/manifest field ──────────────
{
  const badDigest = saCheckpoint({artifactDigest: 12345});
  check("case 6a: recorded digest that is not a string is invalid",
    validateStandaloneCheckpoint(badDigest).ok === false
    && isEscalate(evaluateStandaloneReview(badDigest, saContext(), saObserved()), INVALID_CODE), badDigest);
  const badManifest = skCheckpoint("review-spec", "initial_review", {
    artifacts: [SPEC, PLAN],
    artifactDigest: artifactDigest({paths: [SPEC, PLAN], contents: [SPEC_C, PLAN_C]}),
  });
  check("case 6b: manifest not matching the recorded gate (review-spec with two artifacts) is invalid",
    validateSpeckitCheckpoint(badManifest).ok === false
    && isEscalate(evaluateSpeckitGateReview(badManifest, skContext("review-spec"), skObserved("review-spec")), INVALID_CODE),
    badManifest);
}

// ── Malformed-shape case 7: recorded gate id/index vs governed gate ─────
{
  const checkpoint = skCheckpoint("review-spec", "initial_review");
  check("case 7a: gate id consulted at a different gate escalates",
    isEscalate(evaluateSpeckitGateReview(checkpoint, skContext("review-plan"), skObserved("review-plan")), INVALID_CODE));
  check("case 7b: gate index consulted at a different index escalates",
    isEscalate(evaluateSpeckitGateReview(
      checkpoint, skContext("review-spec", {gateIndex: 99}), skObserved("review-spec")
    ), INVALID_CODE));
}

// ── Malformed-shape case 8: reviewer position with no digest at all ─────
// (Distinct from present-but-mismatched below: the field is missing, not wrong.)
{
  const standalone = {...saCheckpoint()};
  delete standalone.artifactDigest;
  check("case 8a: reviewer-pending checkpoint with no digest field is invalid (not 'nothing to compare')",
    validateStandaloneCheckpoint(standalone).ok === false
    && isEscalate(evaluateStandaloneReview(standalone, saContext(), saObserved()), INVALID_CODE), standalone);
  const speckit = {...skCheckpoint("review-tasks", "post_revision_review")};
  delete speckit.artifactDigest;
  check("case 8b: post_revision_review checkpoint with no digest field is invalid",
    validateSpeckitCheckpoint(speckit).ok === false
    && isEscalate(evaluateSpeckitGateReview(speckit, skContext("review-tasks"), skObserved("review-tasks")), INVALID_CODE),
    speckit);
}

// ── Reviewer digest present but no longer matching → escalate ────────────
{
  const staleObserved = saObserved(["# Plan edited after review started\n", SA_CONTENTS[1]]);
  const result = evaluateStandaloneReview(saCheckpoint(), saContext(), staleObserved);
  check("reviewer-pending with changed content escalates with drift evidence",
    isEscalate(result, DRIFT_CODE)
    && result.evidence?.expectedArtifactDigest === saDigest()
    && isNonEmptyStringCompat(result.evidence?.observedArtifactDigest), result);
  const speckitStale = skObserved("review-plan", [SPEC_C, "# Plan edited\n"]);
  const speckitResult = evaluateSpeckitGateReview(
    skCheckpoint("review-plan", "initial_review"), skContext("review-plan"), speckitStale
  );
  check("initial_review with changed content escalates with drift evidence",
    isEscalate(speckitResult, DRIFT_CODE)
    && isNonEmptyStringCompat(speckitResult.evidence?.observedArtifactDigest), speckitResult);
}
function isNonEmptyStringCompat(value) {
  return typeof value === "string" && value.length > 0;
}

// ── Writable content change → resume, content never compared ─────────────
{
  const changed = saObserved(["# Plan rewritten mid-planner-run\n", SA_CONTENTS[1]]);
  const standalone = evaluateStandaloneReview(
    saCheckpoint({position: STANDALONE_PLANNER_POSITION}), saContext(), changed
  );
  check("planner-pending with changed content resumes (recorded digest ignored)",
    isResume(standalone) && standalone.evidence?.position === STANDALONE_PLANNER_POSITION, standalone);
  const speckitChanged = skObserved("review-plan", [SPEC_C, "# Plan rewritten mid-revision\n"]);
  const speckit = evaluateSpeckitGateReview(
    skCheckpoint("review-plan", "planner_revision"), skContext("review-plan"), speckitChanged
  );
  check("planner_revision with changed content resumes (recorded digest ignored)",
    isResume(speckit) && speckit.evidence?.substage === "planner_revision", speckit);
}

// ── Per-gate manifest evaluation ─────────────────────────────────────────
{
  const specOnly = evaluateSpeckitGateReview(
    skCheckpoint("review-spec", "initial_review"), skContext("review-spec"), skObserved("review-spec")
  );
  check("review-spec validates the spec artifact alone (plan/tasks not required)", isResume(specOnly), specOnly);
  const planGate = evaluateSpeckitGateReview(
    skCheckpoint("review-plan", "post_revision_review"), skContext("review-plan"), skObserved("review-plan")
  );
  check("review-plan covers spec+plan", isResume(planGate), planGate);
  const tasksGate = evaluateSpeckitGateReview(
    skCheckpoint("review-tasks", "post_revision_review"), skContext("review-tasks"), skObserved("review-tasks")
  );
  check("review-tasks covers all three artifacts", isResume(tasksGate), tasksGate);
  const missingTasks = evaluateSpeckitGateReview(
    skCheckpoint("review-tasks", "post_revision_review"), skContext("review-tasks"),
    {artifacts: [{path: SPEC, content: SPEC_C}, {path: PLAN, content: PLAN_C}]}
  );
  check("review-tasks with tasks.md missing escalates", isEscalate(missingTasks, INVALID_CODE), missingTasks);
}

// ── Standalone three-state model pinning ─────────────────────────────────
// Absence is handled by wiring (never evaluated here); what this pins is
// that an explicit planner-pending reading resumes at the planner with
// its own position evidence, while a present-but-incomplete object
// escalates — the three are never conflated.
{
  const planner = evaluateStandaloneReview(
    saCheckpoint({position: STANDALONE_PLANNER_POSITION, artifactDigest: null}), saContext(), saObserved()
  );
  const reviewer = evaluateStandaloneReview(saCheckpoint(), saContext(), saObserved());
  check("explicit planner-pending resumes at the planner (not the reviewer)",
    isResume(planner) && planner.evidence?.position === "planner-pending"
    && reviewer.evidence?.position === "reviewer-pending", {planner, reviewer});
  check("present-but-incomplete object ({}) escalates — never read as absent",
    isEscalate(evaluateStandaloneReview({}, saContext(), saObserved()), INVALID_CODE));
  check("present-but-incomplete speckit object ({}) escalates — never read as absent",
    isEscalate(evaluateSpeckitGateReview({}, skContext("review-spec"), skObserved("review-spec")), INVALID_CODE));
}

// ── Cross-model shapes fail closed ───────────────────────────────────────
{
  check("speckit checkpoint is invalid to the standalone validator",
    validateStandaloneCheckpoint(skCheckpoint("review-plan", "initial_review")).ok === false);
  check("standalone checkpoint is invalid to the speckit validator",
    validateSpeckitCheckpoint(saCheckpoint()).ok === false);
}

// ── Decision objects, never booleans ─────────────────────────────────────
{
  const results = [
    evaluateStandaloneReview(saCheckpoint(), saContext(), saObserved()),
    evaluateStandaloneReview({...saCheckpoint(), version: 2}, saContext(), saObserved()),    evaluateSpeckitGateReview(skCheckpoint("review-tasks", "post_revision_review"),
      skContext("review-tasks"), skObserved("review-tasks")),
    evaluateSpeckitGateReview(skCheckpoint("review-tasks", "post_revision_review"),
      skContext("review-tasks"), skObserved("review-tasks", [SPEC_C, PLAN_C, "# edited\n"])),
  ];
  check("every evaluator returns a decision object with a string action (never a boolean)",
    results.every((result) => result !== null && typeof result === "object" && typeof result.action === "string"
      && typeof result.code === "string" && result !== true && result !== false),
    results);
}

console.log(`\n${ok} passed, ${failed} failed`);
if (failed) process.exit(1);
