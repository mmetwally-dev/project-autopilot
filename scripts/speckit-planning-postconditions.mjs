// SpecKit planning-stage postcondition validation (TASK 15.6B).
//
// Real failure this fixes: during the Native Windows smoke test the Claude
// Planner exited 0 but produced no files (blocked internally on a Write
// permission prompt). Autopilot recorded the relay as completed, printed
// "Spec ready", launched Plan Reviewer, and relied on the reviewer to
// discover that spec.md and feature.json were missing.
//
// The planning command itself must validate its required on-disk output
// before advancing: immediately after each successful Planner relay and the
// planning-boundary check — before "<stage> ready" is printed, before
// planningStepIndex advances, and before the following Plan Reviewer gate
// launches — the current stage's required artifacts are validated directly
// from disk (never from touchedFiles counts: touchedFiles=[] with absent
// output is failure, while valid pre-existing artifacts on a legitimate
// retry satisfy the check even with zero new touches).
//
//   specify: .specify/feature.json (exact real schema, via the existing
//            validateFeatureJson()) resolving to the session feature, plus
//            specs/<feature>/spec.md as a regular file with non-whitespace
//            content.
//   plan:    specs/<active-feature>/plan.md as a regular file with
//            non-whitespace content.
//   tasks:   specs/<active-feature>/tasks.md as a regular file with
//            non-whitespace content that parses (via the existing SpecKit
//            task parser used by implementation) to at least one valid
//            unchecked actionable task.
//
// An unrelated pre-existing feature's artifacts can never satisfy any stage:
// the resolved directory must match the session feature and must not be one
// of the directories frozen as pre-existing at session start.
//
// This module is filesystem validation only — it never mutates, fabricates,
// or repairs anything, and contains no test hooks. Orchestration (checkpoint,
// resume, die) lives in autopilot.mjs's runPlanningPhase().
import fs from "node:fs";
import path from "node:path";
import {validateFeatureJson} from "./planning-boundary.mjs";
// TASK 15.6E: BOTH production SpecKit parsers are the joint authority here.
// tasks() finds every checkbox line; phases() is what runImplementation
// actually executes (specKitPhases). A tasks.md that parses to unchecked
// loose checkboxes but zero executable phases previously passed this
// postcondition and then died at Implementation with "No unchecked SpecKit
// tasks found." — no second, incompatible parser is introduced; the exact
// same functions implementation consumes decide acceptance.
import {tasks as parseSpecTasks, phases as parseSpecPhases} from "../adapters/speckit.mjs";

export const SPECKIT_POSTCONDITION_STAGES = Object.freeze(["specify", "plan", "tasks"]);

// A session feature directory name is a single path segment (e.g.
// "999-smoke-test"), never empty, absolute, or traversal.
function isSaneFeatureDirName(name) {
  return typeof name === "string" && name.length > 0 && name !== "." && name !== ".." &&
    !name.includes("/") && !name.includes("\\");
}

// Lexical containment: is `resolvedAbs` strictly inside `dirAbs`? Both must
// already be canonical (fully resolved, normalized) for the answer to be
// meaningful — callers obtain them via fs.realpathSync.
function isWithinDir(resolvedAbs, dirAbs) {
  const rel = path.relative(dirAbs, resolvedAbs);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// Read a required artifact strictly. Repo-relative `rel` must be a plain
// relative path (no absolutes, no `..` escapes); EVERY path component from
// the repository root down — not just the final file — must exist and must
// not be a symlink; the fully canonicalized artifact (fs.realpathSync,
// which additionally resolves Windows junctions and any other reparse
// points lstat cannot see) must remain inside the canonical repository and,
// when `confineRel` is given, inside that repo-relative directory (the
// active feature directory); and the target must be a regular file with
// non-whitespace content.
//
// Returns {ok:true, content} or {ok:false, reason} where reason is one of:
// path_escape, missing, symlink_rejected, outside_feature_directory,
// not_a_regular_file, unreadable, empty, repo_unavailable.
function readRequiredFile(repo, rel, {confineRel = null} = {}) {
  const normalized = String(rel).replaceAll("\\", "/");
  if (path.isAbsolute(normalized) || normalized.split("/").some(seg => seg === "..")) {
    return {ok: false, reason: "path_escape"};
  }
  const segments = normalized.split("/").filter(seg => seg !== "" && seg !== ".");
  if (segments.length === 0) return {ok: false, reason: "path_escape"};
  // Component walk: a symlink (or junction masquerading at this layer) in
  // ANY parent directory redirects the whole subtree, so every level is
  // inspected — not just the final file.
  let cursor = path.resolve(repo);
  for (const seg of segments) {
    cursor = path.join(cursor, seg);
    let lst;
    try {
      lst = fs.lstatSync(cursor);
    } catch {
      return {ok: false, reason: "missing"};
    }
    if (lst.isSymbolicLink()) return {ok: false, reason: "symlink_rejected"};
  }
  let repoReal;
  try {
    repoReal = fs.realpathSync(path.resolve(repo));
  } catch {
    return {ok: false, reason: "repo_unavailable"};
  }
  let resolved;
  try {
    resolved = fs.realpathSync(cursor);
  } catch {
    return {ok: false, reason: "missing"};
  }
  // Canonical containment: catches Windows junctions, POSIX symlinks missed
  // above, mount-point redirections, and any other reparse-point escape.
  if (!isWithinDir(resolved, repoReal)) return {ok: false, reason: "path_escape"};
  if (confineRel !== null) {
    const confineAbs = path.join(repoReal, ...String(confineRel).replaceAll("\\", "/").split("/").filter(Boolean));
    if (!isWithinDir(resolved, confineAbs)) return {ok: false, reason: "outside_feature_directory"};
  }
  let st;
  try {
    st = fs.statSync(resolved);
  } catch {
    return {ok: false, reason: "missing"};
  }
  if (!st.isFile()) return {ok: false, reason: "not_a_regular_file"};
  let content;
  try {
    content = fs.readFileSync(resolved, "utf8");
  } catch {
    return {ok: false, reason: "unreadable"};
  }
  if (!content.trim()) return {ok: false, reason: "empty"};
  return {ok: true, content};
}

// Resolve the session feature directory. The specify contract ALWAYS
// requires a valid exact-schema .specify/feature.json on disk — a locked
// sessionFeatureDir never excuses a missing, malformed, symlinked, or
// disagreeing file (fail closed); it only additionally constrains which
// directory the file may resolve to. Resolution order:
//   1. read .specify/feature.json strictly (escapes, symlinks at any level,
//      non-regular files all rejected) and validate its exact schema;
//   2. when a sane lock is held, the file must resolve to exactly that
//      directory — a disagreement is a mismatch, never a silent re-pick;
//   3. the resolved directory must not be frozen as pre-existing.
// Returns {ok:true, featureDir} or {ok:false, reason, artifact, expected}.
function resolveSessionFeature({repo, sessionFeatureDir = null, preexistingFeatureDirs = []}) {
  const preexisting = new Set(preexistingFeatureDirs);
  const locked = isSaneFeatureDirName(sessionFeatureDir) ? sessionFeatureDir : null;

  const file = readRequiredFile(repo, ".specify/feature.json");
  if (!file.ok) {
    return {
      ok: false, reason: `feature_json_${file.reason}`,
      artifact: ".specify/feature.json", expected: ".specify/feature.json"
    };
  }
  const fileVerdict = validateFeatureJson(file.content, {});
  if (!fileVerdict.ok) {
    return {
      ok: false, reason: fileVerdict.reason,
      artifact: ".specify/feature.json", expected: ".specify/feature.json"
    };
  }
  if (locked && fileVerdict.featureDir !== locked) {
    return {
      ok: false, reason: "feature_directory_mismatch",
      artifact: ".specify/feature.json", expected: ".specify/feature.json",
      detail: `session feature is '${locked}' but feature.json resolves to '${fileVerdict.featureDir}'`
    };
  }
  if (preexisting.has(fileVerdict.featureDir)) {
    return {
      ok: false, reason: "feature_directory_preexisting",
      artifact: ".specify/feature.json", expected: ".specify/feature.json",
      detail: `feature.json resolves to pre-existing unrelated feature '${fileVerdict.featureDir}'`
    };
  }
  return {ok: true, featureDir: fileVerdict.featureDir};
}

function fail(reason, artifact, expected, detail) {
  return {ok: false, reason, artifact, expected, ...(detail ? {detail} : {})};
}

// Like fail(), but preserves an already-resolved session feature directory
// so a retry keeps the same session identity.
function failResolved(featureDir, reason, artifact, expected, detail) {
  return {ok: false, featureDir, reason, artifact, expected, ...(detail ? {detail} : {})};
}

// specify: exact-schema feature.json resolving to the session feature, plus
// a non-whitespace specs/<feature>/spec.md regular file confined to the
// active feature directory.
export function validateSpecifyPostcondition({repo, sessionFeatureDir = null, preexistingFeatureDirs = []} = {}) {
  if (!repo) return fail("repo_unavailable", ".specify/feature.json", ".specify/feature.json");
  const resolved = resolveSessionFeature({repo, sessionFeatureDir, preexistingFeatureDirs});
  if (!resolved.ok) return resolved;
  const specRel = `specs/${resolved.featureDir}/spec.md`;
  const spec = readRequiredFile(repo, specRel, {confineRel: `specs/${resolved.featureDir}`});
  if (!spec.ok) return failResolved(resolved.featureDir, `spec_md_${spec.reason}`, "spec.md", specRel);
  return {ok: true, featureDir: resolved.featureDir};
}

// plan: the session feature must already be resolved; its plan.md must be a
// regular file with non-whitespace content, confined to the feature dir.
export function validatePlanPostcondition({repo, sessionFeatureDir = null, preexistingFeatureDirs = []} = {}) {
  if (!repo) return fail("repo_unavailable", "plan.md", "specs/<feature>/plan.md");
  const cross = resolveSessionFeature({repo, sessionFeatureDir, preexistingFeatureDirs});
  if (!cross.ok) return fail("feature_unresolved", "plan.md", "specs/<feature>/plan.md", cross.reason);
  const planRel = `specs/${cross.featureDir}/plan.md`;
  const plan = readRequiredFile(repo, planRel, {confineRel: `specs/${cross.featureDir}`});
  if (!plan.ok) return failResolved(cross.featureDir, `plan_md_${plan.reason}`, "plan.md", planRel);
  return {ok: true, featureDir: cross.featureDir};
}

// tasks: the session feature must already be resolved; its tasks.md must be
// a regular file with non-whitespace content that parses — with the same
// SpecKit parsers implementation uses — to at least one EXECUTABLE phase
// (a recognized `## Phase N` heading, the exact structure consumed by
// production) containing at least one valid unchecked actionable task.
// Empty, malformed, completed-only, phase-less, and orphan-task files fail.
//
// TASK 15.6E: the flat tasks() check alone is insufficient — the real
// incident had 5 unchecked loose checkboxes (no `## Phase` headings) that
// passed here and then died at Implementation, where specKitPhases() (the
// phases() parser) found zero executable phases. Acceptance is therefore
// decided by the production phase parser, with the flat parser retained
// only to distinguish "no tasks at all" from "tasks but no phases" and to
// detect unchecked orphans (task lines outside any recognized phase, which
// production would silently ignore and never execute).
export function validateTasksPostcondition({repo, sessionFeatureDir = null, preexistingFeatureDirs = []} = {}) {
  if (!repo) return fail("repo_unavailable", "tasks.md", "specs/<feature>/tasks.md");
  // Resolve the feature exactly like the plan stage (lock constrains, the
  // on-disk file is always required), but report tasks-scoped reasons.
  const cross = resolveSessionFeature({repo, sessionFeatureDir, preexistingFeatureDirs});
  if (!cross.ok) return fail("feature_unresolved", "tasks.md", "specs/<feature>/tasks.md", cross.reason);
  const featureDir = cross.featureDir;
  const tasksRel = `specs/${featureDir}/tasks.md`;
  const file = readRequiredFile(repo, tasksRel, {confineRel: `specs/${featureDir}`});
  if (!file.ok) return failResolved(featureDir, `tasks_md_${file.reason}`, "tasks.md", tasksRel);
  let parsed;
  try {
    parsed = parseSpecTasks(repo, [tasksRel]);
  } catch {
    return failResolved(featureDir, "tasks_unparseable", "tasks.md", tasksRel);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return failResolved(featureDir, "tasks_no_parseable_tasks", "tasks.md", tasksRel);
  }
  const actionable = parsed.filter(t => t && !t.done && typeof t.text === "string" && t.text.trim().length > 0);
  if (actionable.length === 0) {
    return failResolved(featureDir, "tasks_no_unchecked_actionable_tasks", "tasks.md", tasksRel);
  }
  // Production authority: the exact phase parser runImplementation executes.
  // Scoped to this feature's own tasks.md (the same single-file scope this
  // stage validates), never repo-wide, so unrelated features cannot satisfy
  // or pollute the verdict.
  let phased;
  try {
    phased = parseSpecPhases(repo, [tasksRel]);
  } catch {
    return failResolved(featureDir, "tasks_unparseable", "tasks.md", tasksRel);
  }
  const executable = (Array.isArray(phased) ? phased : [])
    .filter(p => p && Array.isArray(p.tasks) && p.tasks.some(t => t && !t.done));
  if (executable.length === 0) {
    return failResolved(
      featureDir,
      "tasks_no_executable_phases",
      "tasks.md",
      tasksRel,
      `${actionable.length} unchecked task(s) found but none lives under a recognized '## Phase N' heading — production executes phases, not loose checkboxes`
    );
  }
  // Orphan rejection: every unchecked task line must be assigned to a
  // recognized phase. Identity is file+line from the production parsers
  // themselves (both report the same absolute file for this candidate), so
  // no line-text heuristics are trusted here.
  const phasedKeys = new Set();
  for (const p of phased) {
    for (const t of (p && Array.isArray(p.tasks) ? p.tasks : [])) {
      phasedKeys.add(`${t.file}::${t.line}`);
    }
  }
  const orphans = actionable.filter(t => !phasedKeys.has(`${t.file}::${t.line}`));
  if (orphans.length > 0) {
    // Repo-relative location only: checkpoints persist this detail into
    // state.json and the retry prompt, so absolute machine paths stay out.
    let where = `line ${orphans[0].line}`;
    try {
      where = `${path.relative(repo, orphans[0].file).replaceAll("\\", "/")}:${orphans[0].line}`;
    } catch { /* keep the line-only fallback */ }
    return failResolved(
      featureDir,
      "tasks_no_executable_phases",
      "tasks.md",
      tasksRel,
      `${orphans.length} unchecked orphan task(s) outside any recognized '## Phase N' heading would never execute (e.g. ${where})`
    );
  }
  return {ok: true, featureDir};
}

// Dispatcher over the three planning stages. Unknown stages fail closed.
export function validatePlanningStagePostcondition({repo, stage, sessionFeatureDir = null, preexistingFeatureDirs = []} = {}) {
  if (stage === "specify") return validateSpecifyPostcondition({repo, sessionFeatureDir, preexistingFeatureDirs});
  if (stage === "plan") return validatePlanPostcondition({repo, sessionFeatureDir, preexistingFeatureDirs});
  if (stage === "tasks") return validateTasksPostcondition({repo, sessionFeatureDir, preexistingFeatureDirs});
  throw new Error(`Unknown SpecKit planning stage: ${String(stage)}`);
}

// Concise operator-facing error: names the stage, the missing/invalid
// artifact, and the expected path.
export function formatPostconditionError(stage, verdict) {
  const what = verdict?.artifact || "required artifact";
  const where = verdict?.expected || "(unknown path)";
  const why = verdict?.reason || "invalid";
  const extra = verdict?.detail ? ` ${verdict.detail}` : "";
  return `SpecKit planning postcondition failed at stage '${stage}': ${what} is ${why} (expected: ${where}).${extra}`;
}
