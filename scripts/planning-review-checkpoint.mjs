// Planning-review resume checkpoint — pure contract module (Phase 4).
//
// Two independent resume-position checkpoints for the plan-review loops in
// `scripts/autopilot.mjs`, following the contract philosophy
// `scripts/phase-stage-checkpoint.mjs` (TASK-7 / TASK-11 Phase 2) already
// established: versioned, identity-bound, fail-closed. Unknown versions,
// missing identity fields, malformed shapes, and identity mismatches all
// resolve to PLANNING_REVIEW_CHECKPOINT_INVALID — never a silent fallback,
// never silently treated as absent.
//
// Absence vs. presence (load-bearing, not stylistic): "absent" means only
// one thing — the state key itself (`s.standalonePlanningReviewCheckpoint`
// / `s.speckitGateReviewCheckpoint`) is missing/null. That case is never
// passed into this module at all; the Phase 5/6 wiring decides what to do
// when there is no checkpoint object in the first place. A present
// checkpoint object is never eligible to be read as "absent" for any
// reason, no matter what its fields contain: a present object with a
// missing/null position (or substage) field is structurally malformed and
// fails closed, it is not "no checkpoint".
//
// Standalone checkpoint shape (state key STANDALONE_PLANNING_REVIEW_CHECKPOINT_KEY):
//
// ```json
// {
//   "version": 1,
//   "framework": "standalone",
//   "mission": "003-example",
//   "position": "reviewer-pending",
//   "artifacts": ["PLAN.md", "TASKS.md"],
//   "artifactDigest": "sha256:...",
//   "updatedAt": "ISO-8601"
// }
// ```
//
// SpecKit checkpoint shape (state key SPECKIT_GATE_REVIEW_CHECKPOINT_KEY):
//
// ```json
// {
//   "version": 1,
//   "framework": "speckit",
//   "mission": "003-example",
//   "feature": "001-foo",
//   "gate": "review-plan",
//   "gateIndex": 3,
//   "substage": "initial_review",
//   "artifacts": ["specs/001-foo/spec.md", "specs/001-foo/plan.md"],
//   "artifactDigest": "sha256:...",
//   "updatedAt": "ISO-8601"
// }
// ```
//
// Digest rule: `artifactDigest()` is the single canonical artifact-digest
// constructor used by both evaluators for every content/path comparison,
// so the two never implement incompatible or collision-prone hashing
// independently. Like `phaseTaskDigest()` in `phase-stage-checkpoint.mjs`,
// it hashes SHA-256 over a canonical JSON encoding of a freshly
// constructed object with fixed property order — never over an ad-hoc
// delimited string, which collides for distinct identities (e.g.
// `` `path:...|content:...` `` fields collide when a path itself contains
// the delimiter). Each artifact folds in its repository-relative path (via
// `normalizeRepoPath()`) and its full content.
//
// Stage sensitivity: content digests are compared only while the
// checkpoint's position names a reviewer stage (`reviewer-pending`,
// `initial_review`, `post_revision_review`) — the Planner has finished
// writing, so content is expected stable. While a writable/Planner stage
// is pending (`planner-pending`, `planner_revision`) content is never
// compared (the Planner is expected to be rewriting it); only version,
// identity, and artifact paths are validated. This mirrors the
// Implementer-stage exemption already established in
// `phase-stage-checkpoint.mjs`.
//
// Gate-specific manifest: `review-spec` runs before `plan`/`tasks` ever
// execute, so each gate binds only the artifacts it actually reviews:
// `review-spec` → spec only; `review-plan` → spec+plan; `review-tasks` →
// spec+plan+tasks. Standalone (single review stage, both files already
// exist) always binds plan+tasks.
//
// This module is deliberately pure:
// - no filesystem, process, or network access (only `node:crypto`);
// - no state writes and no clock reads — every function takes values in
//   and returns values out; `create*()` takes an explicit `at` timestamp
//   from the caller, which owns time;
// - never reads the filesystem: the evaluators receive the observed
//   artifact paths/contents as inputs and return a decision object, never
//   a boolean.
import {createHash} from "node:crypto";

// Stored checkpoint version. Unknown versions fail closed with
// PLANNING_REVIEW_CHECKPOINT_INVALID — never silently accepted.
export const PLANNING_REVIEW_CHECKPOINT_VERSION = 1;

// State.json keys under which the two checkpoints are stored.
export const STANDALONE_PLANNING_REVIEW_CHECKPOINT_KEY = "standalonePlanningReviewCheckpoint";
export const SPECKIT_GATE_REVIEW_CHECKPOINT_KEY = "speckitGateReviewCheckpoint";

// Standalone resume positions: explicit three-state model with absence.
// "planner-pending" is set only by transition logic, never the default
// for absence; "reviewer-pending" is set after the planner completes.
export const STANDALONE_PLANNER_POSITION = "planner-pending";
export const STANDALONE_REVIEWER_POSITION = "reviewer-pending";
export const STANDALONE_POSITIONS = Object.freeze([STANDALONE_PLANNER_POSITION, STANDALONE_REVIEWER_POSITION]);

// SpecKit gate-review substages. `planner_revision` covers the
// between-reviews planner call: a crash there resumes at the planner, not
// the reviewer.
export const SPECKIT_INITIAL_REVIEW = "initial_review";
export const SPECKIT_PLANNER_REVISION = "planner_revision";
export const SPECKIT_POST_REVISION_REVIEW = "post_revision_review";
export const SPECKIT_SUBSTAGES = Object.freeze([
  SPECKIT_INITIAL_REVIEW,
  SPECKIT_PLANNER_REVISION,
  SPECKIT_POST_REVISION_REVIEW,
]);

// SpecKit review gates, in workflow order.
export const SPECKIT_GATES = Object.freeze(["review-spec", "review-plan", "review-tasks"]);

// Gate-specific artifact manifest: artifact roles each gate reviews.
// Wiring resolves roles to repository-relative paths; checkpoints record
// the paths, and their count must match this manifest for the recorded gate.
export const SPECKIT_GATE_MANIFEST = Object.freeze({
  "review-spec": Object.freeze(["spec"]),
  "review-plan": Object.freeze(["spec", "plan"]),
  "review-tasks": Object.freeze(["spec", "plan", "tasks"]),
});

// Standalone always binds both artifacts (its review only runs after both
// files already exist).
export const STANDALONE_ARTIFACT_ROLES = Object.freeze(["plan", "tasks"]);

export const INVALID_CODE = "PLANNING_REVIEW_CHECKPOINT_INVALID";
export const DRIFT_CODE = "PLANNING_REVIEW_CHECKPOINT_DRIFT";

// Artifact roles bound by a gate id, or null when the gate id is unknown.
// Never throws: unknown gates yield null and fail closed downstream.
export function manifestForGate(gate) {
  if (gate === "review-spec" || gate === "review-plan" || gate === "review-tasks") {
    return SPECKIT_GATE_MANIFEST[gate];
  }
  return null;
}

// Single stage-sensitivity predicate over all five named positions.
// Reviewer positions expect stable artifact content (digest compared);
// writable/Planner positions are actively being rewritten (digest never
// compared). Both predicates return false for unrecognized values —
// unknown positions are rejected by structural validation, never silently
// classified here.
export function isReviewerPosition(position) {
  return position === STANDALONE_REVIEWER_POSITION
    || position === SPECKIT_INITIAL_REVIEW
    || position === SPECKIT_POST_REVISION_REVIEW;
}

export function isWritablePosition(position) {
  return position === STANDALONE_PLANNER_POSITION
    || position === SPECKIT_PLANNER_REVISION;
}

// Normalize an artifact path for digesting/binding without touching the
// filesystem: forward slashes only, no leading `./`, no surrounding
// whitespace. When `repoRoot` is provided, a matching prefix is stripped
// so the digest binds the repository-relative path (durable across
// checkouts) rather than the absolute path. Same contract as
// `normalizeRepoPath()` in `phase-stage-checkpoint.mjs`.
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

// The single canonical artifact-digest constructor. Accepts either an
// `artifacts` array of `{path, content}` entries or parallel
// `paths`+`contents` arrays; both shapes hash identically. Every entry
// folds in its repository-relative path and its full content, in fixed
// key order, sorted by normalized path so construction order cannot change
// the digest while any path/content/inclusion change does.
//
// The digest is hashed over a canonical JSON encoding of a freshly
// constructed object with fixed property order — never over an ad-hoc
// delimited string. Delimited serializations are ambiguous (`|`-joined
// `path:...|content:...` fields collide for distinct identities such as
// `{path:"a|b",content:"c"}` vs `{path:"a",content:"b|c"}`), and no hash
// can protect an identity contract that already collides before hashing.
//
// Content must be a string: hashing a missing artifact as empty would
// fabricate integrity evidence for content that was never supplied, so
// non-string content (and empty paths, and mismatched parallel arrays)
// throw instead of digesting.
export function artifactDigest({artifacts, paths, contents, repoRoot} = {}) {
  let entries;
  if (artifacts !== undefined) {
    if (!Array.isArray(artifacts)) {
      throw new TypeError("artifactDigest requires `artifacts` to be an array of {path, content}");
    }
    entries = artifacts.map((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new TypeError(`artifactDigest entry ${index} must be a {path, content} object`);
      }
      return {path: entry.path, content: entry.content, index};
    });
  } else {
    if (!Array.isArray(paths) || !Array.isArray(contents)) {
      throw new TypeError("artifactDigest requires `artifacts` or parallel `paths`+`contents` arrays");
    }
    if (paths.length !== contents.length) {
      throw new TypeError("artifactDigest requires `paths` and `contents` to have equal length");
    }
    entries = paths.map((entryPath, index) => ({path: entryPath, content: contents[index], index}));
  }
  const files = entries.map(({path, content, index}) => {
    if (typeof path !== "string" || !path.trim()) {
      throw new TypeError(`artifactDigest entry ${index} requires a non-empty path string`);
    }
    if (typeof content !== "string") {
      throw new TypeError(
        `artifactDigest entry ${index} requires a string content, received ${content === null ? "null" : typeof content}`
      );
    }
    return {path: normalizeRepoPath(path, repoRoot), content};
  }).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return `sha256:${sha256Hex(JSON.stringify({files}))}`;
}

function isDigest(value) {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function invalid(reason, evidence) {
  return {ok: false, code: INVALID_CODE, reason, evidence: evidence ?? {}};
}

// Structural validation of a standalone checkpoint object. Unknown
// versions, missing identity fields, missing/unrecognized positions,
// malformed artifact manifests or digests, and a reviewer position with no
// recorded digest all fail closed. Identity *binding* (wrong mission for
// the current run) is checked by `validateStandaloneCheckpointFor()` /
// `evaluateStandaloneReview()`, not here — except that a present object is
// never treated as absent: null/non-objects fail closed too.
export function validateStandaloneCheckpoint(checkpoint) {
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) {
    return invalid("checkpoint is not an object", {});
  }
  if (checkpoint.version !== PLANNING_REVIEW_CHECKPOINT_VERSION) {
    return invalid(`unknown checkpoint version: ${JSON.stringify(checkpoint.version)}`, {
      expected: PLANNING_REVIEW_CHECKPOINT_VERSION,
      observed: checkpoint.version,
    });
  }
  if (!isNonEmptyString(checkpoint.framework)) {
    return invalid("checkpoint is missing a valid framework", {});
  }
  if (!isNonEmptyString(checkpoint.mission)) {
    return invalid("checkpoint is missing a valid mission identity", {});
  }
  if (checkpoint.position === null || checkpoint.position === undefined) {
    return invalid("checkpoint is missing a position field", {});
  }
  if (!STANDALONE_POSITIONS.includes(checkpoint.position)) {
    return invalid(`checkpoint has an unrecognized position: ${JSON.stringify(checkpoint.position)}`, {
      expected: [...STANDALONE_POSITIONS],
      observed: checkpoint.position,
    });
  }
  if (!Array.isArray(checkpoint.artifacts)
    || checkpoint.artifacts.length !== STANDALONE_ARTIFACT_ROLES.length
    || checkpoint.artifacts.some((entry) => !isNonEmptyString(entry))) {
    return invalid("checkpoint has a malformed artifact manifest", {
      expected: STANDALONE_ARTIFACT_ROLES.length,
      observed: checkpoint.artifacts,
    });
  }
  // A reviewer position consumes a recorded content digest: a checkpoint
  // naming one but carrying no digest could otherwise resume review with
  // no recorded content — fail closed here instead. A writable position
  // legitimately has none yet (nothing stable to record while the Planner
  // is rewriting); a present-but-malformed digest still fails closed.
  if (isReviewerPosition(checkpoint.position) && (checkpoint.artifactDigest === null || checkpoint.artifactDigest === undefined)) {
    return invalid(
      `checkpoint at reviewer position ${JSON.stringify(checkpoint.position)} has no recorded artifact digest`, {
        position: checkpoint.position,
      }
    );
  }
  if (checkpoint.artifactDigest !== null && checkpoint.artifactDigest !== undefined && !isDigest(checkpoint.artifactDigest)) {
    return invalid("checkpoint has an invalid artifactDigest", {});
  }
  if (!isNonEmptyString(checkpoint.updatedAt)) {
    return invalid("checkpoint is missing a valid updatedAt", {});
  }
  return {ok: true};
}

// Identity binding: the checkpoint is structurally valid AND bound to this
// exact mission (and framework, when the caller supplies one). A present
// identity that does not match fails closed — it is never treated as
// absent. New-request precedence (clear-before-validate) is the wiring's
// job, not this module's: by the time this runs, the caller has already
// ruled out a genuine new request.
export function validateStandaloneCheckpointFor(checkpoint, {framework, mission} = {}) {
  const structural = validateStandaloneCheckpoint(checkpoint);
  if (!structural.ok) return structural;
  if (framework !== undefined && checkpoint.framework !== framework) {
    return invalid("checkpoint framework mismatch", {
      field: "framework",
      expected: checkpoint.framework,
      observed: framework,
    });
  }
  if (mission !== undefined && checkpoint.mission !== mission) {
    return invalid("checkpoint mission mismatch", {
      field: "mission",
      expected: checkpoint.mission,
      observed: mission,
    });
  }
  return {ok: true};
}

// Structural validation of a SpecKit checkpoint object. Same fail-closed
// posture as the standalone validator, plus gate binding: the recorded
// gate must be a known step id, the gate index a non-negative integer, the
// substage a known value, and the recorded artifact manifest must match
// the gate-specific manifest for the recorded gate exactly (a `review-spec`
// checkpoint recording two artifacts is malformed, not "extra evidence").
export function validateSpeckitCheckpoint(checkpoint) {
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) {
    return invalid("checkpoint is not an object", {});
  }
  if (checkpoint.version !== PLANNING_REVIEW_CHECKPOINT_VERSION) {
    return invalid(`unknown checkpoint version: ${JSON.stringify(checkpoint.version)}`, {
      expected: PLANNING_REVIEW_CHECKPOINT_VERSION,
      observed: checkpoint.version,
    });
  }
  if (!isNonEmptyString(checkpoint.framework)) {
    return invalid("checkpoint is missing a valid framework", {});
  }
  if (!isNonEmptyString(checkpoint.mission)) {
    return invalid("checkpoint is missing a valid mission identity", {});
  }
  if (!isNonEmptyString(checkpoint.feature)) {
    return invalid("checkpoint is missing a valid feature identity", {});
  }
  if (checkpoint.gate === null || checkpoint.gate === undefined || !SPECKIT_GATES.includes(checkpoint.gate)) {
    return invalid(`checkpoint has an unrecognized gate: ${JSON.stringify(checkpoint.gate ?? null)}`, {
      expected: [...SPECKIT_GATES],
      observed: checkpoint.gate ?? null,
    });
  }
  if (!Number.isInteger(checkpoint.gateIndex) || checkpoint.gateIndex < 0) {
    return invalid("checkpoint has an invalid gateIndex", {observed: checkpoint.gateIndex});
  }
  if (checkpoint.substage === null || checkpoint.substage === undefined) {
    return invalid("checkpoint is missing a substage field", {});
  }
  if (!SPECKIT_SUBSTAGES.includes(checkpoint.substage)) {
    return invalid(`checkpoint has an unrecognized substage: ${JSON.stringify(checkpoint.substage)}`, {
      expected: [...SPECKIT_SUBSTAGES],
      observed: checkpoint.substage,
    });
  }
  const manifest = manifestForGate(checkpoint.gate);
  if (!Array.isArray(checkpoint.artifacts)
    || checkpoint.artifacts.length !== manifest.length
    || checkpoint.artifacts.some((entry) => !isNonEmptyString(entry))) {
    return invalid("checkpoint artifact manifest does not match its recorded gate", {
      gate: checkpoint.gate,
      expected: [...manifest],
      observed: checkpoint.artifacts,
    });
  }
  if (isReviewerPosition(checkpoint.substage) && (checkpoint.artifactDigest === null || checkpoint.artifactDigest === undefined)) {
    return invalid(
      `checkpoint at reviewer substage ${JSON.stringify(checkpoint.substage)} has no recorded artifact digest`, {
        substage: checkpoint.substage,
      }
    );
  }
  if (checkpoint.artifactDigest !== null && checkpoint.artifactDigest !== undefined && !isDigest(checkpoint.artifactDigest)) {
    return invalid("checkpoint has an invalid artifactDigest", {});
  }
  if (!isNonEmptyString(checkpoint.updatedAt)) {
    return invalid("checkpoint is missing a valid updatedAt", {});
  }
  return {ok: true};
}

// Identity and gate binding: structurally valid AND bound to this exact
// mission/feature, and — when the caller names the gate it is consulting
// for — to that gate's step id and index. A checkpoint recorded at one
// gate never governs another: consulting it elsewhere fails closed.
export function validateSpeckitCheckpointFor(checkpoint, {framework, mission, feature, gate, gateIndex} = {}) {
  const structural = validateSpeckitCheckpoint(checkpoint);
  if (!structural.ok) return structural;
  if (framework !== undefined && checkpoint.framework !== framework) {
    return invalid("checkpoint framework mismatch", {
      field: "framework",
      expected: checkpoint.framework,
      observed: framework,
    });
  }
  if (mission !== undefined && checkpoint.mission !== mission) {
    return invalid("checkpoint mission mismatch", {
      field: "mission",
      expected: checkpoint.mission,
      observed: mission,
    });
  }
  if (feature !== undefined && checkpoint.feature !== feature) {
    return invalid("checkpoint feature mismatch", {
      field: "feature",
      expected: checkpoint.feature,
      observed: feature,
    });
  }
  if (gate !== undefined && checkpoint.gate !== gate) {
    return invalid("checkpoint gate mismatch", {
      field: "gate",
      expected: checkpoint.gate,
      observed: gate,
    });
  }
  if (gateIndex !== undefined && checkpoint.gateIndex !== gateIndex) {
    return invalid("checkpoint gate index mismatch", {
      field: "gateIndex",
      expected: checkpoint.gateIndex,
      observed: gateIndex,
    });
  }
  return {ok: true};
}

// Read the observed artifact state supplied by the caller (never the
// filesystem). Accepts an `artifacts` array of `{path, content}` or
// parallel `paths`+`contents` arrays. Paths are always required (both
// positions bind them); contents are required only for reviewer positions
// (writable positions never compare content, so the caller need not supply
// it). Returns `{ok:true, entries}` or `{ok:false, result}` where `result`
// is the escalate decision to return.
function readObserved(observed, {expectedCount, requireContents, repoRoot}) {
  if (!observed || typeof observed !== "object") {
    return {
      ok: false,
      result: {
        action: "escalate",
        code: INVALID_CODE,
        evidence: {reason: "missing observed artifact state", observed: observed ?? null},
      },
    };
  }
  let entries;
  if (observed.artifacts !== undefined) {
    if (!Array.isArray(observed.artifacts) || observed.artifacts.length !== expectedCount) {
      return {
        ok: false,
        result: {
          action: "escalate",
          code: INVALID_CODE,
          evidence: {
            reason: "observed artifact manifest does not match the checkpoint manifest",
            expected: expectedCount,
            observed: Array.isArray(observed.artifacts) ? observed.artifacts.length : observed.artifacts ?? null,
          },
        },
      };
    }
    entries = observed.artifacts.map((entry) => ({path: entry?.path, content: entry?.content}));
  } else {
    if (!Array.isArray(observed.paths) || !Array.isArray(observed.contents)
      || observed.paths.length !== expectedCount || observed.contents.length !== expectedCount) {
      return {
        ok: false,
        result: {
          action: "escalate",
          code: INVALID_CODE,
          evidence: {
            reason: "observed artifact manifest does not match the checkpoint manifest",
            expected: expectedCount,
            observed: observed.paths ?? null,
          },
        },
      };
    }
    entries = observed.paths.map((entryPath, index) => ({path: entryPath, content: observed.contents[index]}));
  }
  for (let index = 0; index < entries.length; index += 1) {
    if (!isNonEmptyString(entries[index].path)) {
      return {
        ok: false,
        result: {
          action: "escalate",
          code: INVALID_CODE,
          evidence: {reason: `observed artifact ${index} is missing a path`, observed: entries[index].path ?? null},
        },
      };
    }
    if (requireContents && typeof entries[index].content !== "string") {
      return {
        ok: false,
        result: {
          action: "escalate",
          code: INVALID_CODE,
          evidence: {reason: `observed artifact ${index} is missing content`, observed: null},
        },
      };
    }
  }
  return {
    ok: true,
    entries: entries.map(({path, content}) => ({
      path: normalizeRepoPath(path, repoRoot),
      content: typeof content === "string" ? content : null,
    })),
  };
}

function sortedPathList(paths) {
  return [...paths].sort();
}

// Pure resume evaluator for the standalone three-state model. Returns a
// decision object — never a boolean:
// - `{action:"resume", ...}` with `evidence.position` naming the position
//   to resume at (`reviewer-pending` → resume at the reviewer with content
//   validated; `planner-pending` → resume at the planner, content never
//   compared);
// - `{action:"escalate", ...}` with INVALID for structural/identity/path
//   failures or DRIFT for a reviewer-position content mismatch (expected
//   and observed digests preserved in evidence).
//
// `observed` carries the on-disk artifact state for exactly the two bound
// files. Absence (`checkpoint == null`) is never evaluated here — the
// wiring decides that case before this module is consulted.
export function evaluateStandaloneReview(checkpoint, {framework, mission} = {}, observed = {}) {
  const bound = validateStandaloneCheckpointFor(checkpoint, {framework, mission});
  if (!bound.ok) {
    return {action: "escalate", code: bound.code, evidence: {reason: bound.reason, ...(bound.evidence ?? {})}};
  }
  const reviewer = isReviewerPosition(checkpoint.position);
  const read = readObserved(observed, {
    expectedCount: STANDALONE_ARTIFACT_ROLES.length,
    requireContents: reviewer,
    repoRoot: observed?.repoRoot,
  });
  if (!read.ok) return read.result;
  const recordedPaths = checkpoint.artifacts.map((entry) => normalizeRepoPath(entry, observed?.repoRoot));
  const observedPaths = read.entries.map((entry) => entry.path);
  if (JSON.stringify(sortedPathList(recordedPaths)) !== JSON.stringify(sortedPathList(observedPaths))) {
    return {
      action: "escalate",
      code: INVALID_CODE,
      evidence: {
        reason: "checkpoint artifact paths do not match the observed artifacts",
        expected: [...checkpoint.artifacts],
        observed: observed?.artifacts?.map?.((entry) => entry?.path) ?? observed?.paths ?? null,
      },
    };
  }
  if (!reviewer) {
    // Writable position: the Planner is expected to be changing content,
    // so a changed (or entirely unread) artifact body is not drift. Only
    // version/identity/paths — already checked above — bind.
    return {
      action: "resume",
      code: "CHECKPOINT_RESUME",
      evidence: {position: checkpoint.position, mission: checkpoint.mission, artifactDigest: checkpoint.artifactDigest ?? null},
    };
  }
  const observedDigest = artifactDigest({
    artifacts: read.entries.map((entry) => ({path: entry.path, content: entry.content})),
  });
  if (observedDigest !== checkpoint.artifactDigest) {
    return {
      action: "escalate",
      code: DRIFT_CODE,
      evidence: {
        reason: "artifact drift",
        expectedArtifactDigest: checkpoint.artifactDigest,
        observedArtifactDigest: observedDigest,
      },
    };
  }
  return {
    action: "resume",
    code: "CHECKPOINT_RESUME",
    evidence: {position: checkpoint.position, mission: checkpoint.mission, artifactDigest: checkpoint.artifactDigest},
  };
}

// Pure resume evaluator for the SpecKit three-substage model. Same
// decision-object contract as the standalone evaluator, additionally
// bound to the gate's step id/index (`gate`/`gateIndex` in context): a
// checkpoint recorded at one gate never governs another. Content digests
// are compared only at the reviewer substages (`initial_review`,
// `post_revision_review`), never at `planner_revision`; the observed
// state covers exactly the gate-specific manifest for the recorded gate.
export function evaluateSpeckitGateReview(checkpoint, {framework, mission, feature, gate, gateIndex} = {}, observed = {}) {
  const bound = validateSpeckitCheckpointFor(checkpoint, {framework, mission, feature, gate, gateIndex});
  if (!bound.ok) {
    return {action: "escalate", code: bound.code, evidence: {reason: bound.reason, ...(bound.evidence ?? {})}};
  }
  const reviewer = isReviewerPosition(checkpoint.substage);
  const manifest = manifestForGate(checkpoint.gate);
  const read = readObserved(observed, {
    expectedCount: manifest.length,
    requireContents: reviewer,
    repoRoot: observed?.repoRoot,
  });
  if (!read.ok) return read.result;
  const recordedPaths = checkpoint.artifacts.map((entry) => normalizeRepoPath(entry, observed?.repoRoot));
  const observedPaths = read.entries.map((entry) => entry.path);
  if (JSON.stringify(sortedPathList(recordedPaths)) !== JSON.stringify(sortedPathList(observedPaths))) {
    return {
      action: "escalate",
      code: INVALID_CODE,
      evidence: {
        reason: "checkpoint artifact paths do not match the observed artifacts",
        gate: checkpoint.gate,
        expected: [...checkpoint.artifacts],
        observed: observed?.artifacts?.map?.((entry) => entry?.path) ?? observed?.paths ?? null,
      },
    };
  }
  if (!reviewer) {
    return {
      action: "resume",
      code: "CHECKPOINT_RESUME",
      evidence: {
        substage: checkpoint.substage,
        gate: checkpoint.gate,
        gateIndex: checkpoint.gateIndex,
        feature: checkpoint.feature,
        artifactDigest: checkpoint.artifactDigest ?? null,
      },
    };
  }
  const observedDigest = artifactDigest({
    artifacts: read.entries.map((entry) => ({path: entry.path, content: entry.content})),
  });
  if (observedDigest !== checkpoint.artifactDigest) {
    return {
      action: "escalate",
      code: DRIFT_CODE,
      evidence: {
        reason: "artifact drift",
        gate: checkpoint.gate,
        substage: checkpoint.substage,
        expectedArtifactDigest: checkpoint.artifactDigest,
        observedArtifactDigest: observedDigest,
      },
    };
  }
  return {
    action: "resume",
    code: "CHECKPOINT_RESUME",
    evidence: {
      substage: checkpoint.substage,
      gate: checkpoint.gate,
      gateIndex: checkpoint.gateIndex,
      feature: checkpoint.feature,
      artifactDigest: checkpoint.artifactDigest,
    },
  };
}

// Create the standalone checkpoint for a planning attempt with no
// checkpoint yet. Pure construction only — the caller persists it.
//
// `at` (a caller-supplied timestamp string; production passes ISO-8601
// from the orchestrator's `now()`) is required from the caller. Reading
// the clock inside this module would make identical inputs produce
// different checkpoints, breaking referential transparency for a module
// whose contract is purity; the orchestrator owns time and passes it in.
export function createStandaloneCheckpoint({framework = "standalone", mission, position, artifacts, artifactDigest: digest, at} = {}) {
  if (typeof at !== "string" || !at) {
    throw new TypeError("createStandaloneCheckpoint requires an explicit `at` timestamp string from the caller");
  }
  return {
    version: PLANNING_REVIEW_CHECKPOINT_VERSION,
    framework,
    mission,
    position,
    artifacts: Array.isArray(artifacts) ? [...artifacts] : artifacts,
    artifactDigest: digest ?? null,
    updatedAt: at,
  };
}

// Create the SpecKit gate-review checkpoint for one gate/substage. Pure
// construction only — the caller persists it. Same `at` contract as above.
export function createSpeckitCheckpoint(
  {framework = "speckit", mission, feature, gate, gateIndex, substage, artifacts, artifactDigest: digest, at} = {}
) {
  if (typeof at !== "string" || !at) {
    throw new TypeError("createSpeckitCheckpoint requires an explicit `at` timestamp string from the caller");
  }
  return {
    version: PLANNING_REVIEW_CHECKPOINT_VERSION,
    framework,
    mission,
    feature,
    gate,
    gateIndex,
    substage,
    artifacts: Array.isArray(artifacts) ? [...artifacts] : artifacts,
    artifactDigest: digest ?? null,
    updatedAt: at,
  };
}
