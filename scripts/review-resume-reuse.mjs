import { loadReviewFeedback } from "./review-feedback.mjs";
import { loadFindingTasks } from "./finding-task-locality.mjs";
import { hasBaseline, headMovedSinceBaseline, scopedDelta } from "./implementation-baseline.mjs";

/**
 * Backlog #9: on resume after a budget stop (or crash/interruption), check if
 * the last phase review FAILed, its findings are saved in reviewFeedback and
 * reviewFindingTasks, and the working tree matches the snapshot that review saw.
 *
 * If so, the review can be safely skipped and the fix round started immediately
 * with the saved findings. Otherwise, review as today (fail-closed).
 */
export function canReuseFailedReviewOnResume({
  repo,
  state,
  key,
  revision,
  reviewKey,
  declaredPaths = null,
  mission = null,
  phaseTaskDigest,
} = {}) {
  if (!repo || !state || !key || !reviewKey || typeof revision !== "number") {
    return { canReuse: false, reason: "missing-parameters" };
  }

  // 1. Check saved review feedback (must have findings from a FAIL review)
  const findings = loadReviewFeedback(state, key);
  if (!Array.isArray(findings) || findings.length === 0) {
    return { canReuse: false, reason: "no-saved-findings" };
  }

  // 2. Check saved finding tasks locality record
  const findingRecord = loadFindingTasks(state, key, { phaseTaskDigest });
  if (!findingRecord || !Array.isArray(findingRecord.entries) || findingRecord.entries.length === 0) {
    return { canReuse: false, reason: "no-finding-tasks" };
  }
  if (findingRecord.revision !== revision) {
    return { canReuse: false, reason: "revision-mismatch" };
  }

  // 3. Check review baseline snapshot
  if (!hasBaseline(repo, reviewKey)) {
    return { canReuse: false, reason: "no-review-baseline" };
  }
  const headState = headMovedSinceBaseline(repo, reviewKey);
  if (headState && headState.moved) {
    return { canReuse: false, reason: "head-moved" };
  }

  // 4. Check if working tree matches the snapshot
  try {
    const opts = { mission };
    if (Array.isArray(declaredPaths)) opts.declaredPaths = declaredPaths;
    const delta = scopedDelta(repo, reviewKey, opts);
    if (typeof delta === "string" && delta.trim() !== "") {
      return { canReuse: false, reason: "tree-changed" };
    }
  } catch (err) {
    return { canReuse: false, reason: "delta-error", error: err };
  }

  return { canReuse: true, findings, findingRecord };
}
