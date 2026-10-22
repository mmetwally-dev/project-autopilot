// Durable phase-stage resume checkpoint — pure contract module (TASK-7 / TASK-11 Phase 2).
//
// One shared checkpoint contract for the Standalone and SpecKit implementation
// loops in `scripts/autopilot.mjs`. Orchestration and role launches stay in
// `autopilot.mjs`; this module only validates, digests, decides transitions,
// and evaluates the planning-gate bypass. It is deliberately pure:
//
// - no filesystem, process, or network access (only `node:crypto` for sha256);
// - no state writes — every function takes values in and returns values out;
//   callers persist whatever they choose via their own `saveState()`.
// - never reads the filesystem: `evaluatePlanningGate()` receives the observed
//   task/delta digests (or a `deltaError`) as inputs. This is required because
//   `scripts/autopilot.mjs` runs `main()` at import with no `import.meta.url`
//   guard, so the gate predicate cannot be unit-tested unless it lives here.
//
// Checkpoint shape (stored in `state.json` under `CHECKPOINT_STATE_KEY`;
// exact property names below are the contract — Phase 4/6 wiring persists
// exactly these fields):
//
// ```json
// {
//   "version": 1,
//   "framework": "standalone",
//   "mission": "001-example",
//   "phaseIndex": 0,
//   "phaseName": "Foundation",
//   "phaseTaskDigest": "sha256:...",
//   "revision": 1,
//   "nextStage": "code_reviewer",
//   "runningStage": null,
//   "attempts": {"implementer": 1, "code_reviewer": 1, "verifier": 0},
//   "baselineKey": "mission-001-example-phase-0",
//   "deltaDigest": "sha256:...",
//   "implementer": {"runId": "...", "summary": "bounded summary"},
//   "codeReviewer": null,
//   "verifier": null,
//   "retryPauseStage": null,
//   "updatedAt": "ISO-8601"
// }
// ```
//
// `retryPauseStage` (TASK-29, additive): the stage a pending retry pause
// belongs to — `transition.nextStage` when `decideTransition()` returned
// `action:"retry"` (infrastructure/adapter failure, same stage re-run),
// `null` otherwise (functional `restart`, `advance`, `complete`). A
// checkpoint written before this landed has no field, which means "don't
// pause". The field is pacing metadata only: it is never folded into
// `phaseTaskDigest`/`deltaDigest` (both hash explicitly-constructed
// canonical objects), and `validateCheckpoint()` rejects no unknown keys,
// so old checkpoints without it stay structurally valid.
//
// Digest rules (TASK-7 "Stable phase/task identity"):
// - `phaseTaskDigest` is deterministic from framework + mission identity +
//   phase number/index + phase name + ordered task identities
//   (repository-relative file, normalized task text, ordinal within the
//   phase). Durable identity is never `file:line` alone — lines move. A task
//   edit, reorder, insertion, removal, mission change, or phase change must
//   change the digest and prevent stale approval reuse.
// - `deltaDigest` hashes the complete, untruncated scoped phase delta, never
//   the bounded handoff text shown to a model. It is recorded when the
//   Implementer completes and is consumed only by approval-reuse stages
//   (`code_reviewer`, `verifier`, `mark_tasks`): while `nextStage` or
//   `runningStage` is `implementer` an interrupted implementation has
//   legitimately left a partial delta, so the delta digest must never be
//   required, compared, or treated as drift there.
//
// Stage-conditional gate (TASK-7 "The digest requirement is stage-conditional"):
// approval-reuse stages require matching task AND delta digests; the
// implementer stage requires only the task digest.
//
// Accepted trade-off (TASK-11 task 14): a valid checkpoint deliberately skips
// the Planner reconciliation pass, so the plan-file sanity check is forgone
// on a mid-phase resume. The checkpoint digests (task + delta match at an
// approval-reuse stage) are the resume-time integrity evidence instead.
//
// Attempts relationship (TASK-7 "Attempts and failure budgets"): the
// per-stage `attempts` counters are a display/backoff aid only (they feed
// `retryDelay()` pacing). The sole retry/escalation authority remains
// `state.failureBudgets` via `recordFailureBudget()`/`enforceAttemptFailure()`.
// This module never compares an `attempts.*` counter against a limit.
import {createHash} from "node:crypto";

// Stored checkpoint version. Unknown versions fail closed with
// PHASE_CHECKPOINT_INVALID — never silently accepted.
export const CHECKPOINT_VERSION = 1;

// State.json key under which the checkpoint is stored.
export const CHECKPOINT_STATE_KEY = "phaseExecutionCheckpoint";

// Ordered pipeline stages. `mark_tasks` is a no-model crash-recovery stage
// that consumes a Verifier PASS (and is therefore an approval-reuse stage).
export const STAGES = Object.freeze(["implementer", "code_reviewer", "verifier", "mark_tasks"]);

// Stages that consume a stored approval and therefore require matching task
// AND delta digests before proceeding. The implementer stage is deliberately
// excluded: an interrupted implementation legitimately leaves a partial delta.
export const APPROVAL_REUSE_STAGES = Object.freeze(["code_reviewer", "verifier", "mark_tasks"]);

// Frameworks the checkpoint bypass applies to. GSD is out of scope: the gate
// returns `plan` for any other framework so GSD behaviour is untouched.
export const SUPPORTED_FRAMEWORKS = Object.freeze(["standalone", "speckit"]);

export const INVALID_CODE = "PHASE_CHECKPOINT_INVALID";
export const DRIFT_CODE = "PHASE_CHECKPOINT_DRIFT";

// Gate-result cache key: two sha256 digests joined by `|` (pre-gate delta
// digest + gate-commands digest). Stored as a plain object (JSON-safe, never
// a Map) under `checkpoint.gateCache`.
export const GATE_CACHE_KEY_RE = /^sha256:[0-9a-f]{64}\|sha256:[0-9a-f]{64}$/;

export function isGateCacheKey(value) {
  return typeof value === "string" && GATE_CACHE_KEY_RE.test(value);
}

// Read one cached gate result. Returns the stored entry, or `null` when
// absent (no cache, non-object checkpoint, or missing key). Pure read: never
// creates or mutates the cache.
export function getCachedGateResult(checkpoint, cacheKey) {
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) return null;
  const cache = checkpoint.gateCache;
  if (!cache || typeof cache !== "object" || Array.isArray(cache)) return null;
  if (typeof cacheKey !== "string") return null;
  const entry = cache[cacheKey];
  return entry === undefined ? null : entry;
}

// Store one gate result under `cacheKey`. Lazily creates `gateCache` as a
// plain object when absent; mutates the passed checkpoint object in place
// (callers persist via their own `saveState()`) and returns it for chaining.
export function setCachedGateResult(checkpoint, cacheKey, gateResult) {
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) {
    throw new TypeError("setCachedGateResult requires a checkpoint object");
  }
  if (typeof cacheKey !== "string" || !cacheKey) {
    throw new TypeError("setCachedGateResult requires a string cacheKey");
  }
  if (!checkpoint.gateCache || typeof checkpoint.gateCache !== "object" || Array.isArray(checkpoint.gateCache)) {
    checkpoint.gateCache = {};
  }
  checkpoint.gateCache[cacheKey] = gateResult;
  return checkpoint;
}

// Verifier-continuation gate stash (mission 069 task 1.1): a single-slot,
// consume-once cache of the last gate result so a verifier cap/incomplete/
// backstop continuation can reuse it without re-running gates when the
// phase delta is unchanged. Shape (additive; CHECKPOINT_VERSION stays 1):
// `checkpoint.continuationGate = {key, result}` where `key` is a non-empty
// string (callers pass the pre-gate composite digest key) and `result` is a
// gate-result object carrying a boolean `ok` (both ok:true and ok:false are
// reusable here — unlike `gateCache`, which only stores passes). Pure:
// mutates only the passed checkpoint object in place, no I/O.
export function recordContinuationGateResult(checkpoint, key, gateResult) {
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) {
    throw new TypeError("recordContinuationGateResult requires a checkpoint object");
  }
  if (typeof key !== "string" || !key) {
    throw new TypeError("recordContinuationGateResult requires a non-empty string key");
  }
  if (!gateResult || typeof gateResult !== "object" || Array.isArray(gateResult)) {
    throw new TypeError("recordContinuationGateResult requires a gateResult object");
  }
  checkpoint.continuationGate = {key, result: gateResult};
  return checkpoint;
}

// Consume-once read: always clears the stash, returns the stashed result
// only when the stored key matches `key`, otherwise null. Tolerant of a
// missing/non-object checkpoint (returns null) so gate-block consults never
// throw on an absent checkpoint.
export function takeContinuationGateResult(checkpoint, key) {
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) return null;
  const stashed = checkpoint.continuationGate;
  delete checkpoint.continuationGate;
  if (!stashed || typeof stashed !== "object" || Array.isArray(stashed)) return null;
  if (stashed.key !== key) return null;
  const result = stashed.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  return result;
}

// Clear the stash unconditionally. Tolerant: non-object checkpoints pass
// through unchanged; returns the checkpoint for chaining.
export function clearContinuationGateResult(checkpoint) {
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) return checkpoint;
  delete checkpoint.continuationGate;
  return checkpoint;
}

// Backlog #105: persistent last gate result (pass OR fail) keyed by the
// post-gate composite digest key. Unlike continuationGate it is NOT consumed
// and NOT cleared by stage transitions, so a verifier infrastructure retry or
// an operator stop+resume reuses it while the delta digest is unchanged; any
// delta/gate-command change makes the key differ (a miss -> gates re-run).
export function recordLastGateResult(checkpoint, key, gateResult) {
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) return checkpoint;
  if (typeof key !== "string" || !key) return checkpoint;
  if (!gateResult || typeof gateResult !== "object" || Array.isArray(gateResult) || typeof gateResult.ok !== "boolean") return checkpoint;
  // Only a green result or an ordinary non-zero test failure is reusable: a
  // shell-blocked, timed-out or signal-killed run has a cause outside the key.
  if (gateResult.ok !== true) {
    const code = gateResult.exitCode;
    if (gateResult.shellBlocked === true || gateResult.timedOut === true || typeof code !== "number" || code === 0 || code === 124 || code === 137 || code === 143) {
      delete checkpoint.lastGate;
      return checkpoint;
    }
  }
  checkpoint.lastGate = {key, result: gateResult};
  return checkpoint;
}

export function getLastGateResult(checkpoint, key) {
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) return null;
  const last = checkpoint.lastGate;
  if (!last || typeof last !== "object" || Array.isArray(last)) return null;
  if (typeof key !== "string" || last.key !== key) return null;
  const result = last.result;
  if (!result || typeof result !== "object" || Array.isArray(result) || typeof result.ok !== "boolean") return null;
  return result;
}

// Single consult entry point for verifier gate blocks: on a key hit the
// stashed result is returned (consumed via take) without calling `runGate`;
// on a miss `runGate()` is called and its return value passed through as-is
// (a returned promise is returned as-is, so async runners work with `await`).
export function resolveContinuationGateResult({checkpoint, key, runGate} = {}) {
  const hit = takeContinuationGateResult(checkpoint, key);
  if (hit !== null) return hit;
  if (typeof runGate !== "function") {
    throw new TypeError("resolveContinuationGateResult requires a runGate function on a stash miss");
  }
  return runGate();
}

// Single predicate distinguishing approval-reuse stages from the implementer
// stage. Both the gate evaluator and the loop wiring call this — never a
// hand-duplicated stage list.
export function isApprovalReuseStage(stage) {
  return APPROVAL_REUSE_STAGES.includes(stage);
}

// The stage a resume must run: a stage that was actually launched
// (`runningStage`) wins over the next queued stage; otherwise continue from
// `nextStage`. Pure read of the checkpoint object.
export function resumeStage(checkpoint) {
  if (!checkpoint || typeof checkpoint !== "object") return null;
  return checkpoint.runningStage ?? checkpoint.nextStage ?? null;
}

// Normalize one task text for digesting: strip inline `<!-- ... -->`
// annotations (e.g. `autopilot-requires`, `autopilot-deliverable`), trim, and
// collapse internal whitespace so formatting-only differences do not change
// the digest, while any real text edit does.
export function normalizeTaskText(text) {
  return String(text ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim()
    .replace(/\s+/g, " ");
}

// Normalize a task file path for digesting without touching the filesystem:
// forward slashes only, no leading `./`, no trailing whitespace. When
// `repoRoot` is provided, a matching prefix is stripped so the digest binds
// the repository-relative path (durable across checkouts) rather than the
// absolute path. Line numbers are never included: lines move.
export function normalizeRepoPath(file, repoRoot) {
  let p = String(file ?? "").replace(/\\/g, "/").trim().replace(/^\.\//, "");
  if (repoRoot) {
    const root = String(repoRoot).replace(/\\/g, "/").trim().replace(/\/+$/, "");
    if (root && (p === root || p.startsWith(root + "/"))) {
      p = p.slice(root.length).replace(/^\/+/, "");
    }
  }
  return p;
}

function sha256Hex(text) {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

// Deterministic phase-task digest. Every input that must invalidate stale
// approval is folded in: framework, mission identity, phase number/index,
// phase name, and the ordered task identities (relative file + normalized
// text + ordinal). Reorder changes the digest because ordinals move with
// positions; insertion/removal shift every later ordinal.
//
// The digest is hashed over a canonical JSON encoding of a freshly
// constructed object with fixed property order — never over an ad-hoc
// delimited string. Delimited serializations are ambiguous (`|`-joined
// `file:...|text:...` fields collide for distinct identities such as
// `{file:"a|text:b",text:"c"}` vs `{file:"a",text:"b|text:c"}`), and no hash
// can protect an identity contract that already collides before hashing.
export function phaseTaskDigest({framework, mission, phaseIndex, phaseNumber, phaseName, tasks, repoRoot} = {}) {
  const list = Array.isArray(tasks) ? tasks : [];
  const canonical = {
    framework: String(framework ?? ""),
    mission: String(mission ?? ""),
    phaseIndex: Number.isInteger(phaseIndex) ? phaseIndex : String(phaseIndex ?? ""),
    phaseNumber: Number.isInteger(phaseNumber) ? phaseNumber : String(phaseNumber ?? ""),
    phaseName: normalizeTaskText(phaseName),
    tasks: list.map((task, ordinal) => ({
      ordinal,
      file: normalizeRepoPath(task?.file, repoRoot),
      text: normalizeTaskText(task?.text),
    })),
  };
  return `sha256:${sha256Hex(JSON.stringify(canonical))}`;
}

// Digest over the complete, untruncated scoped phase delta text. The input
// must be a string (the empty string is a valid empty delta). Anything else
// — `null`, `undefined`, non-strings — throws: silently hashing a missing
// delta as empty would fabricate integrity evidence for a delta that was
// never supplied.
export function deltaDigest(deltaText) {
  if (typeof deltaText !== "string") {
    throw new TypeError(`deltaDigest requires a string delta, received ${deltaText === null ? "null" : typeof deltaText}`);
  }
  return `sha256:${sha256Hex(deltaText)}`;
}

function isDigest(value) {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isStage(value) {
  return STAGES.includes(value);
}

// Structural validation of a checkpoint object. Unknown versions, malformed
// data, empty identities, impossible stage values, and non-digest digests
// all fail closed with PHASE_CHECKPOINT_INVALID. Identity *binding* (wrong
// mission/framework/phase for the current run) is checked by
// `validateCheckpointFor()` / `evaluatePlanningGate()`, not here.
export function validateCheckpoint(checkpoint) {
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) {
    return {ok: false, code: INVALID_CODE, reason: "checkpoint is not an object", evidence: {}};
  }
  if (checkpoint.version !== CHECKPOINT_VERSION) {
    return {
      ok: false, code: INVALID_CODE,
      reason: `unknown checkpoint version: ${JSON.stringify(checkpoint.version)}`,
      evidence: {expected: CHECKPOINT_VERSION, observed: checkpoint.version},
    };
  }
  if (typeof checkpoint.framework !== "string" || !checkpoint.framework) {
    return {ok: false, code: INVALID_CODE, reason: "checkpoint is missing a valid framework", evidence: {}};
  }
  if (typeof checkpoint.mission !== "string" || !checkpoint.mission) {
    return {ok: false, code: INVALID_CODE, reason: "checkpoint is missing a valid mission identity", evidence: {}};
  }
  if (!Number.isInteger(checkpoint.phaseIndex) || checkpoint.phaseIndex < 0) {
    return {ok: false, code: INVALID_CODE, reason: "checkpoint has an invalid phaseIndex", evidence: {observed: checkpoint.phaseIndex}};
  }
  if (typeof checkpoint.phaseName !== "string" || !checkpoint.phaseName) {
    return {ok: false, code: INVALID_CODE, reason: "checkpoint is missing a valid phaseName", evidence: {}};
  }
  if (!isDigest(checkpoint.phaseTaskDigest)) {
    return {ok: false, code: INVALID_CODE, reason: "checkpoint has an invalid phaseTaskDigest", evidence: {}};
  }
  if (!Number.isInteger(checkpoint.revision) || checkpoint.revision < 1) {
    return {ok: false, code: INVALID_CODE, reason: "checkpoint has an invalid revision", evidence: {observed: checkpoint.revision}};
  }
  if (!isStage(checkpoint.nextStage)) {
    return {ok: false, code: INVALID_CODE, reason: `checkpoint has an invalid nextStage: ${JSON.stringify(checkpoint.nextStage)}`, evidence: {}};
  }
  if (checkpoint.runningStage !== null && checkpoint.runningStage !== undefined && !isStage(checkpoint.runningStage)) {
    return {ok: false, code: INVALID_CODE, reason: `checkpoint has an invalid runningStage: ${JSON.stringify(checkpoint.runningStage)}`, evidence: {}};
  }
  const attempts = checkpoint.attempts;
  if (!attempts || typeof attempts !== "object" || Array.isArray(attempts)) {
    return {ok: false, code: INVALID_CODE, reason: "checkpoint is missing a valid attempts record", evidence: {}};
  }
  for (const stage of ["implementer", "code_reviewer", "verifier"]) {
    if (!Number.isInteger(attempts[stage]) || attempts[stage] < 0) {
      return {ok: false, code: INVALID_CODE, reason: `checkpoint has an invalid attempts counter: ${stage}`, evidence: {observed: attempts[stage]}};
    }
  }
  if (typeof checkpoint.baselineKey !== "string" || !checkpoint.baselineKey) {
    return {ok: false, code: INVALID_CODE, reason: "checkpoint is missing a valid baselineKey", evidence: {}};
  }
  // An approval-reuse stage consumes a stored Implementer approval, which is
  // meaningless without the delta digest that approval was recorded against.
  // A checkpoint whose resume stage is approval-reuse but carries no delta
  // digest could otherwise advance through review, verification, and marking
  // without any recorded delta — only a later gate resume would notice.
  // Fail closed here instead. The implementer stage legitimately has none
  // yet (it is recorded when the Implementer completes).
  const resume = checkpoint.runningStage ?? checkpoint.nextStage;
  if (isApprovalReuseStage(resume) && (checkpoint.deltaDigest === null || checkpoint.deltaDigest === undefined)) {
    return {
      ok: false, code: INVALID_CODE,
      reason: `checkpoint at approval-reuse stage ${JSON.stringify(resume)} has no recorded delta digest`,
      evidence: {stage: resume},
    };
  }
  if (checkpoint.deltaDigest !== null && checkpoint.deltaDigest !== undefined && !isDigest(checkpoint.deltaDigest)) {
    return {ok: false, code: INVALID_CODE, reason: "checkpoint has an invalid deltaDigest", evidence: {}};
  }
  if (typeof checkpoint.updatedAt !== "string" || !checkpoint.updatedAt) {
    return {ok: false, code: INVALID_CODE, reason: "checkpoint is missing a valid updatedAt", evidence: {}};
  }
  // TASK-8 roleProgress (additive; CHECKPOINT_VERSION deliberately stays 1).
  // Same absent/present-malformed discipline as deltaDigest above: an absent
  // block is legitimate — every checkpoint written before this landed has
  // none, and so does any phase whose per-task dispatch has not started — but
  // a present block is validated, because nothing else in the read path
  // checks it. validateCheckpoint() rejects no unknown keys, so without this
  // an additive field would pass structurally and a corrupt or hand-edited
  // progress block would reach decideTransition()/evaluatePlanningGate()
  // untouched.
  if (checkpoint.roleProgress !== null && checkpoint.roleProgress !== undefined) {
    const progress = validateRoleProgress(checkpoint.roleProgress);
    if (!progress.ok) return progress;
  }
  // Gate-result cache (additive; CHECKPOINT_VERSION deliberately stays 1).
  // Absent is legitimate — every checkpoint written before this landed has
  // none — but a present block is validated: keys must be composite
  // `sha256:<64hex>|sha256:<64hex>` cache keys, values must be objects
  // carrying a boolean `ok`. Without this a corrupt or hand-edited cache
  // would pass structurally and be consumed as gate evidence downstream.
  if (checkpoint.gateCache !== null && checkpoint.gateCache !== undefined) {
    const cache = checkpoint.gateCache;
    if (!cache || typeof cache !== "object" || Array.isArray(cache)) {
      return {ok: false, code: INVALID_CODE, reason: "checkpoint gateCache must be an object", evidence: {}};
    }
    for (const key of Object.keys(cache)) {
      if (!isGateCacheKey(key)) {
        return {ok: false, code: INVALID_CODE, reason: `checkpoint gateCache has an invalid key ${JSON.stringify(key)}`, evidence: {key}};
      }
      const entry = cache[key];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return {ok: false, code: INVALID_CODE, reason: "checkpoint gateCache entry must be an object", evidence: {key}};
      }
      if (typeof entry.ok !== "boolean") {
        return {ok: false, code: INVALID_CODE, reason: "checkpoint gateCache entry must carry a boolean ok", evidence: {key, observed: entry.ok}};
      }
    }
  }
  // Continuation-gate stash (additive; CHECKPOINT_VERSION stays 1).
  // Absent (null/undefined) is legitimate — every checkpoint written before
  // this landed has none — but a present block is validated: it must be an
  // object with a non-empty string `key` and a `result` object carrying a
  // boolean `ok` (both ok:true and ok:false are reusable stash payloads).
  if (checkpoint.continuationGate !== null && checkpoint.continuationGate !== undefined) {
    const stashed = checkpoint.continuationGate;
    if (!stashed || typeof stashed !== "object" || Array.isArray(stashed)) {
      return {ok: false, code: INVALID_CODE, reason: "checkpoint continuationGate must be an object", evidence: {}};
    }
    if (typeof stashed.key !== "string" || !stashed.key) {
      return {ok: false, code: INVALID_CODE, reason: "checkpoint continuationGate must carry a non-empty string key", evidence: {}};
    }
    const stashedResult = stashed.result;
    if (!stashedResult || typeof stashedResult !== "object" || Array.isArray(stashedResult)) {
      return {ok: false, code: INVALID_CODE, reason: "checkpoint continuationGate result must be an object", evidence: {}};
    }
    if (typeof stashedResult.ok !== "boolean") {
      return {ok: false, code: INVALID_CODE, reason: "checkpoint continuationGate result must carry a boolean ok", evidence: {observed: stashedResult.ok}};
    }
  }
  return {ok: true};
}

// ---------------------------------------------------------------------------
// TASK-8 "Progress state" — bounded per-role, per-task progress.
// ---------------------------------------------------------------------------

export const ROLE_PROGRESS_ROLES = Object.freeze(["implementer", "codeReviewer", "verifier"]);
export const ROLE_PROGRESS_STATUSES = Object.freeze(["pending", "running", "complete"]);

// `taskLocalCheck` records what a task-local command actually did. TASK-8 is
// explicit that it is NOT a verification verdict, so the allowed statuses are
// the three truthful outcomes of running a command and nothing resembling
// approval.
export const TASK_LOCAL_CHECK_STATUSES = Object.freeze(["attempted", "passed", "failed"]);

// Bounds. TASK-8 Test 12 requires that bounded facts cannot grow prompts
// without limit, so every field that a role can influence is capped, and the
// whole block is capped again by serialized size as a backstop — per-field
// caps alone still grow linearly with the task count.
export const ROLE_PROGRESS_MAX_TASKS = 500;
export const ROLE_PROGRESS_SUMMARY_MAX_CHARS = 2000;
export const ROLE_PROGRESS_COMMAND_MAX_CHARS = 500;
export const ROLE_PROGRESS_MAX_FILES = 200;
export const ROLE_PROGRESS_MAX_ITEMS = 100;
export const ROLE_PROGRESS_MAX_BYTES = 262144;

// Keys that would let `taskLocalCheck` be read as the phase Verifier's
// verdict. TASK-8 names the failure directly: the field must not be shaped
// like approval. Rejecting these makes the distinction structural rather than
// a naming convention, so a block carrying one fails closed instead of being
// quietly consumed as a verdict downstream.
const VERDICT_SHAPED_KEYS = Object.freeze([
  "verified", "verifyResult", "verdict", "decision", "approved", "approval", "reviewPassed", "pass",
]);

const ROLE_FACT_KEY = Object.freeze({
  implementer: "factsByTask",
  codeReviewer: "findingsByTask",
  verifier: "evidenceByTask",
});
const ROLE_ITEM_KEY = Object.freeze({
  codeReviewer: "findings",
  verifier: "evidence",
});

function invalid(reason, evidence = {}) {
  return {ok: false, code: INVALID_CODE, reason, evidence};
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value, max, label, evidence) {
  if (typeof value !== "string") return invalid(`${label} must be a string`, evidence);
  if (value.length > max) return invalid(`${label} exceeds ${max} characters`, {...evidence, length: value.length});
  return {ok: true};
}

function boundedStringArray(value, max, label, evidence) {
  if (!Array.isArray(value)) return invalid(`${label} must be an array`, evidence);
  if (value.length > max) return invalid(`${label} exceeds ${max} entries`, {...evidence, length: value.length});
  for (const entry of value) {
    if (typeof entry !== "string") return invalid(`${label} must contain only strings`, evidence);
    if (entry.length > ROLE_PROGRESS_SUMMARY_MAX_CHARS) {
      return invalid(`${label} contains an over-long entry`, {...evidence, length: entry.length});
    }
  }
  return {ok: true};
}

function validateTaskLocalCheck(check, evidence) {
  if (check === null || check === undefined) return {ok: true};
  if (!isPlainObject(check)) return invalid("taskLocalCheck must be an object", evidence);
  for (const key of VERDICT_SHAPED_KEYS) {
    if (Object.prototype.hasOwnProperty.call(check, key)) {
      return invalid(
        `taskLocalCheck must not carry the verdict-shaped key ${JSON.stringify(key)}; it records a task-local command, never the phase Verifier's verdict`,
        {...evidence, key},
      );
    }
  }
  const command = boundedString(check.command, ROLE_PROGRESS_COMMAND_MAX_CHARS, "taskLocalCheck.command", evidence);
  if (!command.ok) return command;
  if (!TASK_LOCAL_CHECK_STATUSES.includes(check.status)) {
    return invalid(`taskLocalCheck.status must be one of ${TASK_LOCAL_CHECK_STATUSES.join("/")}`, {...evidence, observed: check.status});
  }
  if (check.exitCode !== null && !Number.isInteger(check.exitCode)) {
    return invalid("taskLocalCheck.exitCode must be an integer or null", {...evidence, observed: check.exitCode});
  }
  const summary = boundedString(check.summary, ROLE_PROGRESS_SUMMARY_MAX_CHARS, "taskLocalCheck.summary", evidence);
  if (!summary.ok) return summary;
  return {ok: true};
}

function validateFactEntry(role, taskId, entry) {
  const evidence = {role, taskId};
  if (!isPlainObject(entry)) return invalid(`${ROLE_FACT_KEY[role]} entry must be an object`, evidence);
  const summary = boundedString(entry.summary, ROLE_PROGRESS_SUMMARY_MAX_CHARS, `${ROLE_FACT_KEY[role]}.summary`, evidence);
  if (!summary.ok) return summary;
  if (role === "implementer") {
    const files = boundedStringArray(entry.files ?? [], ROLE_PROGRESS_MAX_FILES, "factsByTask.files", evidence);
    if (!files.ok) return files;
    const check = validateTaskLocalCheck(entry.taskLocalCheck, evidence);
    if (!check.ok) return check;
    return {ok: true};
  }
  const itemKey = ROLE_ITEM_KEY[role];
  const items = boundedStringArray(entry[itemKey] ?? [], ROLE_PROGRESS_MAX_ITEMS, `${ROLE_FACT_KEY[role]}.${itemKey}`, evidence);
  if (!items.ok) return items;
  return {ok: true};
}

function allowedRoleKeys(role) {
  const keys = ["status", "taskCursor", "completedTaskIds", "currentTaskId", ROLE_FACT_KEY[role]];
  if (role !== "implementer") keys.push("phaseWidePassComplete");
  return keys;
}

function validateRoleEntry(role, entry) {
  const evidence = {role};
  if (!isPlainObject(entry)) return invalid(`roleProgress.${role} must be an object`, evidence);
  // Unknown keys are rejected rather than ignored: the entire point of this
  // validator is that a hand-edited block cannot ride through unchecked, and
  // silently tolerating extra fields would reopen exactly that hole.
  const allowed = new Set(allowedRoleKeys(role));
  for (const key of Object.keys(entry)) {
    if (!allowed.has(key)) return invalid(`roleProgress.${role} has an unknown key ${JSON.stringify(key)}`, evidence);
  }
  if (!ROLE_PROGRESS_STATUSES.includes(entry.status)) {
    return invalid(`roleProgress.${role}.status must be one of ${ROLE_PROGRESS_STATUSES.join("/")}`, {...evidence, observed: entry.status});
  }
  if (!Number.isInteger(entry.taskCursor) || entry.taskCursor < 0) {
    return invalid(`roleProgress.${role}.taskCursor must be a non-negative integer`, {...evidence, observed: entry.taskCursor});
  }
  const completed = boundedStringArray(entry.completedTaskIds, ROLE_PROGRESS_MAX_TASKS, `roleProgress.${role}.completedTaskIds`, evidence);
  if (!completed.ok) return completed;
  if (new Set(entry.completedTaskIds).size !== entry.completedTaskIds.length) {
    return invalid(`roleProgress.${role}.completedTaskIds contains duplicates`, evidence);
  }
  if (entry.currentTaskId !== null && typeof entry.currentTaskId !== "string") {
    return invalid(`roleProgress.${role}.currentTaskId must be a string or null`, {...evidence, observed: entry.currentTaskId});
  }
  const factKey = ROLE_FACT_KEY[role];
  const facts = entry[factKey];
  if (!isPlainObject(facts)) return invalid(`roleProgress.${role}.${factKey} must be an object`, evidence);
  const taskIds = Object.keys(facts);
  if (taskIds.length > ROLE_PROGRESS_MAX_TASKS) {
    return invalid(`roleProgress.${role}.${factKey} exceeds ${ROLE_PROGRESS_MAX_TASKS} entries`, {...evidence, length: taskIds.length});
  }
  for (const taskId of taskIds) {
    const result = validateFactEntry(role, taskId, facts[taskId]);
    if (!result.ok) return result;
  }
  if (role !== "implementer" && typeof entry.phaseWidePassComplete !== "boolean") {
    return invalid(`roleProgress.${role}.phaseWidePassComplete must be a boolean`, {...evidence, observed: entry.phaseWidePassComplete});
  }
  return {ok: true};
}

// Pure structural validation of a `roleProgress` block. Absent is legitimate
// and is the caller's decision, not this function's: callers pass only a
// present block. Returns the same {ok,code,reason,evidence} shape every other
// validator in this module returns.
export function validateRoleProgress(progress) {
  if (!isPlainObject(progress)) return invalid("roleProgress must be an object");
  for (const key of Object.keys(progress)) {
    if (!ROLE_PROGRESS_ROLES.includes(key)) {
      return invalid(`roleProgress has an unknown role ${JSON.stringify(key)}`, {observed: key});
    }
  }
  for (const role of ROLE_PROGRESS_ROLES) {
    if (progress[role] === undefined) continue;
    const result = validateRoleEntry(role, progress[role]);
    if (!result.ok) return result;
  }
  // Serialized-size backstop. Per-field caps bound each fact but not their
  // number times their size; this is the bound that actually answers TASK-8
  // Test 12 for a phase with many tasks.
  const serialized = JSON.stringify(progress);
  if (typeof serialized === "string" && serialized.length > ROLE_PROGRESS_MAX_BYTES) {
    return invalid(`roleProgress exceeds ${ROLE_PROGRESS_MAX_BYTES} serialized bytes`, {length: serialized.length});
  }
  return {ok: true};
}

// Empty progress for one role, in the shape validateRoleProgress() accepts.
export function emptyRoleProgress() {
  const progress = {};
  for (const role of ROLE_PROGRESS_ROLES) {
    progress[role] = {
      status: "pending",
      taskCursor: 0,
      completedTaskIds: [],
      currentTaskId: null,
      [ROLE_FACT_KEY[role]]: {},
    };
    if (role !== "implementer") progress[role].phaseWidePassComplete = false;
  }
  return progress;
}

// Identity binding: the checkpoint is structurally valid AND bound to this
// exact framework/mission/phase. Wrong mission, wrong framework, or wrong
// phase each yield PHASE_CHECKPOINT_INVALID with expected/observed evidence.
export function validateCheckpointFor(checkpoint, {framework, mission, phaseIndex} = {}) {
  const structural = validateCheckpoint(checkpoint);
  if (!structural.ok) return structural;
  if (framework !== undefined && checkpoint.framework !== framework) {
    return {
      ok: false, code: INVALID_CODE, reason: "checkpoint framework mismatch",
      evidence: {field: "framework", expected: checkpoint.framework, observed: framework},
    };
  }
  if (mission !== undefined && checkpoint.mission !== mission) {
    return {
      ok: false, code: INVALID_CODE, reason: "checkpoint mission mismatch",
      evidence: {field: "mission", expected: checkpoint.mission, observed: mission},
    };
  }
  if (phaseIndex !== undefined && checkpoint.phaseIndex !== phaseIndex) {
    return {
      ok: false, code: INVALID_CODE, reason: "checkpoint phase mismatch",
      evidence: {field: "phaseIndex", expected: checkpoint.phaseIndex, observed: phaseIndex},
    };
  }
  return {ok: true};
}

// Allowed stage transitions. `to === null` means the terminal edge:
// `mark_tasks` completed, so the checkpoint is cleared and the phase
// advances. Everything not listed here is impossible (e.g.
// implementer→verifier skips review; code_reviewer→mark_tasks skips
// verification; verifier→code_reviewer runs backward).
//
// `mark_tasks`→`mark_tasks` is allowed: marking is idempotent
// (re-applying the checkbox states then re-reading the files), so an
// interrupted marking run must be able to retry the same stage. The terminal
// advance out of `mark_tasks` is the `null` edge, not a stage edge.
const ALLOWED_TRANSITIONS = Object.freeze({
  implementer: Object.freeze(["implementer", "code_reviewer"]),
  code_reviewer: Object.freeze(["implementer", "code_reviewer", "verifier"]),
  verifier: Object.freeze(["implementer", "verifier", "mark_tasks"]),
  mark_tasks: Object.freeze(["mark_tasks"]),
});

export function isAllowedTransition(from, to) {
  if (from === null || from === undefined) return to === "implementer";
  if (!isStage(from)) return false;
  if (to === null || to === undefined) return from === "mark_tasks";
  if (!isStage(to)) return false;
  return (ALLOWED_TRANSITIONS[from] || []).includes(to);
}

export function validateTransition(from, to) {
  if (isAllowedTransition(from, to)) return {ok: true};
  return {
    ok: false, code: INVALID_CODE,
    reason: `impossible stage transition: ${String(from)} -> ${String(to)}`,
    evidence: {from, to},
  };
}

// Create the revision-1 checkpoint for a phase with no checkpoint yet.
// Pure construction only — the caller persists it.
//
// `at` (a caller-supplied timestamp string; production passes ISO-8601 from
// the orchestrator's `now()`) is required from the caller. Reading the clock
// inside this module would make identical inputs produce different
// checkpoints, breaking referential transparency for a module whose contract
// is purity; the orchestrator owns time and passes it in.
export function createCheckpoint({framework, mission, phaseIndex, phaseNumber, phaseName, tasks, repoRoot, baselineKey, at} = {}) {
  if (typeof at !== "string" || !at) {
    throw new TypeError("createCheckpoint requires an explicit `at` timestamp string from the caller");
  }
  const digest = phaseTaskDigest({framework, mission, phaseIndex, phaseNumber, phaseName, tasks, repoRoot});
  return {
    version: CHECKPOINT_VERSION,
    framework, mission, phaseIndex, phaseName,
    ...(Number.isInteger(phaseNumber) ? {phaseNumber} : {}),
    phaseTaskDigest: digest,
    revision: 1,
    nextStage: "implementer",
    runningStage: null,
    attempts: {implementer: 0, code_reviewer: 0, verifier: 0},
    baselineKey,
    deltaDigest: null,
    implementer: null,
    codeReviewer: null,
    verifier: null,
    updatedAt: at,
  };
}

// Invalidation helper: fold any failure into the fail-closed INVALID shape
// with evidence. Never routes a corrupt checkpoint to planning.
export function invalidateCheckpoint(checkpoint, {reason, evidence} = {}) {
  return {
    ok: false, code: INVALID_CODE,
    reason: reason ?? "checkpoint invalidated",
    evidence: {checkpoint: checkpoint ?? null, ...(evidence ?? {})},
  };
}

// Clearing helper: the cleared checkpoint is simply absent (`null`). Callers
// remove the state key and persist.
export function clearCheckpoint() {
  return null;
}

// Predicate: is this checkpoint bound to the given framework/mission/phase?
// Structural validity is not checked here — use `validateCheckpointFor()`
// when the distinction matters.
export function isCheckpointForPhase(checkpoint, {framework, mission, phaseIndex} = {}) {
  if (!checkpoint || typeof checkpoint !== "object") return false;
  if (framework !== undefined && checkpoint.framework !== framework) return false;
  if (mission !== undefined && checkpoint.mission !== mission) return false;
  if (phaseIndex !== undefined && checkpoint.phaseIndex !== phaseIndex) return false;
  return true;
}

function incrementedAttempts(checkpoint, stage) {
  const base = checkpoint?.attempts ?? {};
  return {
    implementer: Number.isInteger(base.implementer) ? base.implementer : 0,
    code_reviewer: Number.isInteger(base.code_reviewer) ? base.code_reviewer : 0,
    verifier: Number.isInteger(base.verifier) ? base.verifier : 0,
    ...(isStage(stage) && stage !== "mark_tasks" ? {[stage]: ((Number.isInteger(base[stage]) ? base[stage] : 0) + 1)} : {}),
  };
}

// The stage-transition decision shared identically by both loops (never
// hand-duplicated). Given the checkpoint plus either:
// - a role result `{stage, status, decision?, findings?, policyViolation?,
//   failure?, runId?, summary?, deltaDigest?}`, or
// - an `enforceAttemptFailure()` return value `{failure: {domain,
//   sourceRole?}, budget: {allowed, ...}, scope?}`,
// compute the next `nextStage` and whether `revision` increments.
//
// Two fail-closed bindings hold for every call:
//
// 1. Stage binding. The authoritative current stage is derived from the
//    checkpoint (`resumeStage()` = `runningStage ?? nextStage`). Any stage
//    the outcome claims — `outcome.stage`, or the stage mapped from
//    `failure.sourceRole` — must equal it; a result for any other stage is
//    rejected with PHASE_CHECKPOINT_INVALID instead of advancing some stage
//    the checkpoint never reached. Every resulting edge, including same-stage
//    retries, is validated through `validateTransition()`.
//
// 2. Budget authority. Raw role results are accepted only for successful
//    completion (implementer completed, reviewer/verifier PASS, mark_tasks
//    completed) and for policy violations (fail-closed escalation, no retry
//    involved). Anything else — an interrupted role (`status !==
//    "completed"`), a classified `failure`, or a functional FAIL verdict —
//    returns ENFORCEMENT_REQUIRED: the caller must run it through
//    `enforceAttemptFailure()` and supply that `{failure, budget}` outcome,
//    because `state.failureBudgets` is the sole retry/escalation authority.
//    The infra-vs-functional split is then read exclusively off the existing
//    `failure.domain` (`adapter`/`infrastructure` = retry the interrupted
//    stage; `implementation`/`verification`/`planning` = functional rejection,
//    back to Implementer with `revision + 1` and cleared downstream
//    approval). No new `attempts.* >= N` limit check exists anywhere here:
//    `attempts` counters are incremented as a display/backoff aid only, and
//    retry authority stays with `enforceAttemptFailure()`'s `budget.allowed`.
export function decideTransition(checkpoint, outcome = {}) {
  const structural = validateCheckpoint(checkpoint);
  if (!structural.ok) {
    return {ok: false, code: INVALID_CODE, reason: structural.reason, evidence: structural.evidence};
  }
  const current = resumeStage(checkpoint);
  if (!isStage(current)) {
    return {ok: false, code: INVALID_CODE, reason: "checkpoint has no valid current stage", evidence: {}};
  }

  // enforceAttemptFailure() shape: honor its verdict, never re-derive it.
  if (outcome && typeof outcome === "object" && "budget" in outcome) {
    const failure = outcome.failure ?? {};
    const budget = outcome.budget ?? {};
    // The current stage is the fallback only when no source role is named.
    // A named role that maps to no checkpoint stage (e.g. "planner") must
    // never silently pass as the current stage.
    const mapped = failure.sourceRole == null ? current : stageOfRole(failure.sourceRole);
    if (mapped === null || mapped === undefined || mapped !== current) {
      return {
        ok: false, code: INVALID_CODE,
        reason: `failure source role ${JSON.stringify(failure.sourceRole)} does not match checkpoint stage ${JSON.stringify(current)}`,
        evidence: {expected: current, observed: failure.sourceRole ?? null},
      };
    }
    if (budget.allowed !== true) {
      return {
        ok: false,
        code: budget.budget ? `${String(budget.budget).toUpperCase()}_EXHAUSTED` : "FAILURE_BUDGET_EXHAUSTED",
        reason: "failure budget exhausted; human intervention required",
        evidence: {failure, budget: budget.budget ?? null},
      };
    }
    const domain = String(failure.domain ?? "");
    if (domain === "adapter" || domain === "infrastructure") {
      const edge = validateTransition(current, current);
      if (!edge.ok) return {ok: false, code: edge.code, reason: edge.reason, evidence: edge.evidence};
      return {
        ok: true, action: "retry", nextStage: current, revision: checkpoint.revision,
        attempts: incrementedAttempts(checkpoint, current),
        clearApprovals: false, reason: `infrastructure failure; retry ${current}`,
      };
    }
    // Functional rejection (implementation/verification/planning domain):
    // invalidate downstream approval and return to the Implementer.
    const edge = validateTransition(current, "implementer");
    if (!edge.ok) return {ok: false, code: edge.code, reason: edge.reason, evidence: edge.evidence};
    return {
      ok: true, action: "restart", nextStage: "implementer", revision: checkpoint.revision + 1,
      attempts: incrementedAttempts(checkpoint, current),
      clearApprovals: true, reason: `functional rejection (${domain}); return to implementer`,
      findings: failure.findings ?? null,
    };
  }

  // Role-result shape: accepted only for successful completion and policy
  // violations. Everything else requires budget enforcement first.
  const policyViolation = outcome?.policyViolation;
  if (policyViolation) {
    return {
      ok: false, code: "RELAY_POLICY_VIOLATION",
      reason: `relay policy violation: ${String(policyViolation)}`,
      evidence: {policyViolation},
    };
  }
  const claimed = outcome?.stage ?? current;
  if (claimed !== current) {
    return {
      ok: false, code: INVALID_CODE,
      reason: `role result for stage ${JSON.stringify(claimed)} does not match checkpoint stage ${JSON.stringify(current)}`,
      evidence: {expected: current, observed: claimed},
    };
  }
  const stage = claimed;
  if (outcome?.status !== "completed") {
    return {
      ok: false, code: "ENFORCEMENT_REQUIRED",
      reason: `interrupted ${stage} result (status ${JSON.stringify(outcome?.status)}) requires an enforceAttemptFailure() outcome; raw role results are accepted only for successful completion`,
      evidence: {stage, status: outcome?.status ?? null},
    };
  }
  if (outcome?.failure !== null && outcome?.failure !== undefined) {
    return {
      ok: false, code: "ENFORCEMENT_REQUIRED",
      reason: `classified failure on ${stage} requires an enforceAttemptFailure() outcome; raw role results are accepted only for successful completion`,
      evidence: {stage, failure: outcome.failure},
    };
  }
  if (stage === "implementer") {
    // The delta digest is the approval evidence every later stage reuses:
    // entering code_reviewer without recording one would let review,
    // verification, and marking advance with no recorded delta. Fail closed.
    if (!isDigest(outcome?.deltaDigest)) {
      return {
        ok: false, code: INVALID_CODE,
        reason: "implementer completion is missing a valid deltaDigest; refusing to enter code_reviewer without recorded approval evidence",
        evidence: {observed: outcome?.deltaDigest ?? null},
      };
    }
    const edge = validateTransition(current, "code_reviewer");
    if (!edge.ok) return {ok: false, code: edge.code, reason: edge.reason, evidence: edge.evidence};
    return {
      ok: true, action: "advance", nextStage: "code_reviewer", revision: checkpoint.revision,
      attempts: incrementedAttempts(checkpoint, stage),
      clearApprovals: false, reason: "implementer completed; proceed to code review",
      recordDelta: true, runId: outcome?.runId ?? null, summary: outcome?.summary ?? null,
      deltaDigest: outcome.deltaDigest,
    };
  }
  if (stage === "code_reviewer" || stage === "verifier") {
    const decision = outcome?.review?.decision ?? outcome?.decision;
    if (decision === "PASS") {
      const to = stage === "code_reviewer" ? "verifier" : "mark_tasks";
      const edge = validateTransition(current, to);
      if (!edge.ok) return {ok: false, code: edge.code, reason: edge.reason, evidence: edge.evidence};
      return {
        ok: true, action: "advance", nextStage: to, revision: checkpoint.revision,
        attempts: incrementedAttempts(checkpoint, stage),
        clearApprovals: false, reason: `${stage} PASS; proceed to ${to}`,
        runId: outcome?.runId ?? null,
      };
    }
    if (decision === "FAIL") {
      return {
        ok: false, code: "ENFORCEMENT_REQUIRED",
        reason: `${stage} functional FAIL requires an enforceAttemptFailure() outcome; raw role results are accepted only for successful completion`,
        evidence: {stage, decision, findings: outcome?.review?.findings ?? outcome?.findings ?? []},
      };
    }
    return {
      ok: false, code: "INVALID_REVIEW_DECISION",
      reason: `${stage} completed without a PASS/FAIL decision`,
      evidence: {stage, decision: decision ?? null},
    };
  }
  // mark_tasks completed: terminal edge — the caller marks via
  // setTaskCheckboxes(), advances phaseIndex, and clears the checkpoint.
  const edge = validateTransition(current, null);
  if (!edge.ok) return {ok: false, code: edge.code, reason: edge.reason, evidence: edge.evidence};
  return {
    ok: true, action: "complete", nextStage: null, revision: checkpoint.revision,
    attempts: incrementedAttempts(checkpoint, stage),
    clearApprovals: false, reason: "mark_tasks completed; clear checkpoint and advance",
  };
}

// TASK-29: which stage (if any) owns the pending retry pause for a
// `decideTransition()` result. A `retry` action re-runs the same stage
// after an infrastructure/adapter failure, so the pause belongs to
// `nextStage`; every other action (`restart` after a functional rejection,
// `advance`, `complete`) — and any non-ok transition — carries no pause.
export function retryPauseStageOf(transition) {
  if (!transition || typeof transition !== "object" || transition.ok !== true) return null;
  if (transition.action !== "retry") return null;
  return transition.nextStage ?? null;
}

// TASK-29: does this checkpoint authorize a retry pause before relaunching
// `stage`? Only an exact match pauses. A checkpoint from before this field
// existed (or any checkpoint whose field is null/a different stage) means
// "don't pause": functional re-runs, re-reviews, and crash-resumes relaunch
// silently. Pure read of the checkpoint object.
export function shouldRetryPause(checkpoint, stage) {
  if (!checkpoint || typeof checkpoint !== "object") return false;
  if (typeof stage !== "string" || !stage) return false;
  return checkpoint.retryPauseStage === stage;
}

function stageOfRole(role) {
  if (role === "implementer") return "implementer";
  if (role === "code_reviewer") return "code_reviewer";
  if (role === "verifier") return "verifier";
  if (role === "mark_tasks") return "mark_tasks";
  return null;
}

// Pure planning-gate evaluator for `runImplementation`. Computes no digests
// and reads nothing: the caller supplies the observed task digest, the
// observed full delta digest, or a `deltaError` captured when computing the
// delta threw `DECLARATION_MISMATCH`.
//
// Signature: `evaluatePlanningGate(checkpoint, framework, phase, observed)`
// - `checkpoint`: the stored checkpoint object, or null/undefined when absent.
// - `framework`: the current planning framework (`standalone` / `speckit` / …).
// - `phase`: `{mission, phaseIndex, allChecked?, exists?, phaseCount?, expectedBaselineKey?}` —
//   the current phase identity; `allChecked` is true when every task in the
//   phase is already checked. `exists` is false when the checkpoint's phase
//   index names no phase in the current phase list (the caller derived it
//   from authority, never from the checkpoint); `phaseCount` carries the
//   available phase range for evidence. `expectedBaselineKey` is the
//   authority-derived baseline key for the current mission and phase — when
//   provided, the checkpoint's persisted key must equal it exactly before
//   any approval is reused, so a corrupted or traversal-shaped key can never
//   select a foreign baseline. Both are optional: callers without an
//   authority-derived phase list (the in-loop gates, which index their own
//   phase list in bounds) omit them and the checks are skipped.
// - `observed`: `{phaseTaskDigest, deltaDigest?, deltaError?}`.
//
// Returns a decision object — never a boolean:
// - `{action: "resume", code, evidence}` — valid checkpoint; skip planning.
// - `{action: "plan", code, evidence}` — no checkpoint, or a checkpoint not
//   applicable to this framework/phase (including GSD, which is out of scope,
//   and an already-completed phase). The caller routes to planning as today.
// - `{action: "escalate", code, evidence}` — invalid or drifted checkpoint;
//   `code` is PHASE_CHECKPOINT_INVALID or PHASE_CHECKPOINT_DRIFT with the
//   expected/observed values in `evidence`. Never routes to planning.
export function evaluatePlanningGate(checkpoint, framework, phase = {}, observed = {}) {
  if (!SUPPORTED_FRAMEWORKS.includes(framework)) {
    return {action: "plan", code: "FRAMEWORK_NOT_APPLICABLE", evidence: {framework: framework ?? null}};
  }
  if (checkpoint === null || checkpoint === undefined) {
    return {action: "plan", code: "NO_CHECKPOINT", evidence: {}};
  }
  const structural = validateCheckpoint(checkpoint);
  if (!structural.ok) {
    return {action: "escalate", code: INVALID_CODE, evidence: {reason: structural.reason, ...(structural.evidence ?? {})}};
  }
  if (checkpoint.framework !== framework) {
    return {
      action: "plan", code: "FRAMEWORK_MISMATCH",
      evidence: {expected: checkpoint.framework, observed: framework},
    };
  }
  if (phase.mission !== undefined && checkpoint.mission !== phase.mission) {
    return {
      action: "escalate", code: INVALID_CODE,
      evidence: {reason: "checkpoint mission mismatch", expected: checkpoint.mission, observed: phase.mission},
    };
  }
  if (phase.phaseIndex !== undefined && checkpoint.phaseIndex !== phase.phaseIndex) {
    return {
      action: "escalate", code: INVALID_CODE,
      evidence: {reason: "checkpoint phase mismatch", expected: checkpoint.phaseIndex, observed: phase.phaseIndex},
    };
  }
  if (phase.exists === false) {
    // The checkpoint names a phase the current phase list does not contain
    // (out of range, or an empty phase list). Resuming would skip
    // implementation for work that was never done — fail closed before any
    // digest is compared or any approval consumed.
    return {
      action: "escalate", code: INVALID_CODE,
      evidence: {reason: "checkpoint phase does not exist", phaseIndex: checkpoint.phaseIndex, phaseCount: phase.phaseCount ?? null},
    };
  }
  if (phase.expectedBaselineKey !== undefined && checkpoint.baselineKey !== phase.expectedBaselineKey) {
    // The persisted baseline key is comparison data only — it must equal the
    // authority-derived key exactly. A corrupted or traversal-shaped key can
    // therefore never select a foreign baseline: the mismatch fails closed
    // here, before any approval is reused.
    return {
      action: "escalate", code: INVALID_CODE,
      evidence: {reason: "checkpoint baseline key mismatch", expected: phase.expectedBaselineKey, observed: checkpoint.baselineKey ?? null},
    };
  }
  if (phase.allChecked === true) {
    // Bypass requires outstanding work: an all-checked phase holds only a
    // stale checkpoint, which the normal flow clears while advancing.
    return {action: "plan", code: "PHASE_COMPLETE", evidence: {phaseIndex: checkpoint.phaseIndex}};
  }
  const stage = resumeStage(checkpoint);
  if (!isApprovalReuseStage(stage)) {
    // Implementer stage (including the interrupted case): partial work has
    // legitimately changed the delta, so the delta digest is neither
    // required nor compared and a mismatch is not drift. Only the task
    // digest binds.
    if (typeof observed.phaseTaskDigest !== "string" || !observed.phaseTaskDigest) {
      return {
        action: "escalate", code: INVALID_CODE,
        evidence: {reason: "missing observed task digest", expected: checkpoint.phaseTaskDigest, observed: observed.phaseTaskDigest ?? null},
      };
    }
    if (observed.phaseTaskDigest !== checkpoint.phaseTaskDigest) {
      return {
        action: "escalate", code: DRIFT_CODE,
        evidence: {reason: "task drift", expectedTaskDigest: checkpoint.phaseTaskDigest, observedTaskDigest: observed.phaseTaskDigest},
      };
    }
    return {action: "resume", code: "CHECKPOINT_RESUME", evidence: {stage, revision: checkpoint.revision}};
  }
  // Approval-reuse stages: both digests must match the recorded approval.
  // (`validateCheckpoint()` already rejects an approval-reuse checkpoint
  // with no recorded delta digest, so `checkpoint.deltaDigest` is a valid
  // digest on every path below.)
  if (observed.deltaError !== undefined && observed.deltaError !== null) {
    return {
      action: "escalate", code: DRIFT_CODE,
      evidence: {
        reason: "delta computation failed",
        deltaError: String(observed.deltaError?.code ?? observed.deltaError),
        expectedDeltaDigest: checkpoint.deltaDigest, observedDeltaDigest: null,
      },
    };
  }
  if (typeof observed.phaseTaskDigest !== "string" || !observed.phaseTaskDigest) {
    return {
      action: "escalate", code: INVALID_CODE,
      evidence: {reason: "missing observed task digest", expected: checkpoint.phaseTaskDigest, observed: observed.phaseTaskDigest ?? null},
    };
  }
  if (observed.phaseTaskDigest !== checkpoint.phaseTaskDigest) {
    return {
      action: "escalate", code: DRIFT_CODE,
      evidence: {
        reason: "task drift", expectedTaskDigest: checkpoint.phaseTaskDigest, observedTaskDigest: observed.phaseTaskDigest,
        expectedDeltaDigest: checkpoint.deltaDigest ?? null, observedDeltaDigest: observed.deltaDigest ?? null,
      },
    };
  }
  if (typeof observed.deltaDigest !== "string" || !observed.deltaDigest) {
    return {
      action: "escalate", code: INVALID_CODE,
      evidence: {reason: "missing observed delta digest", expected: checkpoint.deltaDigest, observed: observed.deltaDigest ?? null},
    };
  }
  if (observed.deltaDigest !== checkpoint.deltaDigest) {
    return {
      action: "escalate", code: DRIFT_CODE,
      evidence: {
        reason: "delta drift",
        expectedTaskDigest: checkpoint.phaseTaskDigest, observedTaskDigest: observed.phaseTaskDigest,
        expectedDeltaDigest: checkpoint.deltaDigest, observedDeltaDigest: observed.deltaDigest,
      },
    };
  }
  return {action: "resume", code: "CHECKPOINT_RESUME", evidence: {stage, revision: checkpoint.revision}};
}
