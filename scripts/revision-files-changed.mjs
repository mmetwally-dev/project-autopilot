import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { loadReviewFeedback, feedbackText } from "./review-feedback.mjs";
import { plannerEarlierRoundsText, planReviewNotesText } from "./plan-review-rounds.mjs";

export function computeFileSha256(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    const content = fs.readFileSync(filePath);
    return crypto.createHash("sha256").update(content).digest("hex");
  } catch {
    return null;
  }
}

export function recordReviewFailSnapshot(state, key, filePaths, repo = ".") {
  if (!state || typeof state !== "object" || !key || !Array.isArray(filePaths)) return {};
  const hashes = {};
  for (const fp of filePaths) {
    if (typeof fp !== "string" || !fp) continue;
    const abs = path.isAbsolute(fp) ? fp : path.resolve(repo, fp);
    const hash = computeFileSha256(abs);
    if (hash !== null) {
      const base = path.basename(abs);
      const rel = path.relative(repo, abs);
      hashes[base] = hash;
      hashes[rel] = hash;
      hashes[abs] = hash;
    }
  }
  if (!state.reviewStageSnapshots || typeof state.reviewStageSnapshots !== "object") {
    state.reviewStageSnapshots = {};
  }
  state.reviewStageSnapshots[key] = { ...(state.reviewStageSnapshots[key] || {}), ...hashes };
  if (state.reviewFeedback?.[key] && typeof state.reviewFeedback[key] === "object") {
    state.reviewFeedback[key].stageFileHashes = { ...(state.reviewFeedback[key].stageFileHashes || {}), ...hashes };
  }
  return hashes;
}

export function clearReviewFailSnapshot(state, key) {
  if (state?.reviewStageSnapshots && typeof state.reviewStageSnapshots === "object") {
    delete state.reviewStageSnapshots[key];
  }
  if (state?.reviewFeedback?.[key]?.stageFileHashes) {
    delete state.reviewFeedback[key].stageFileHashes;
  }
}

export function stageFilesChangedSinceReview(recordedHashes, currentFilesOrHashes) {
  if (!recordedHashes || typeof recordedHashes !== "object") {
    const res = [];
    res.changed = false;
    res.line = "";
    return res;
  }

  // Handle case where state object was passed
  let hashes = recordedHashes;
  if (recordedHashes.reviewFeedback || recordedHashes.reviewStageSnapshots) {
    hashes = recordedHashes.reviewStageSnapshots || {};
  }

  const changedSet = new Set();

  if (Array.isArray(currentFilesOrHashes)) {
    for (const fp of currentFilesOrHashes) {
      if (typeof fp !== "string" || !fp) continue;
      const base = path.basename(fp);
      const hashAtReview = hashes[base] ?? hashes[fp];
      if (hashAtReview !== undefined) {
        const currentHash = computeFileSha256(fp);
        if (currentHash !== hashAtReview) {
          changedSet.add(base);
        }
      }
    }
  } else if (currentFilesOrHashes && typeof currentFilesOrHashes === "object") {
    for (const [key, val] of Object.entries(currentFilesOrHashes)) {
      const base = path.basename(key);
      const hashAtReview = hashes[base] ?? hashes[key];
      if (hashAtReview !== undefined) {
        if (typeof val === "string") {
          if (val === hashAtReview) {
            continue;
          }
          const contentHash = crypto.createHash("sha256").update(val).digest("hex");
          if (contentHash === hashAtReview) {
            continue;
          }
        }
        changedSet.add(base);
      }
    }
  }

  const result = Array.from(changedSet);
  result.changed = result.length > 0;
  result.line = stageFilesChangedLine(result);
  return result;
}

export function stageFilesChangedLine(changedFiles) {
  if (!changedFiles || !changedFiles.length) return "";
  const list = Array.from(new Set(changedFiles.map(f => path.basename(f))));
  return `The stage file(s) changed after this review (${list.join(", ")}): an earlier session already edited them. Check the cited lines first; some findings may already be fixed.`;
}

export function speckitStageFilePaths(repo, s, stage) {
  const featureDir = s?.speckitFeatureDir;
  const stageFileName = (stage === "specify" || stage === "spec")
    ? "spec.md"
    : (stage === "plan" ? "plan.md" : "tasks.md");
  const candidates = [
    featureDir ? path.join(repo, "specs", featureDir, stageFileName) : null,
    path.join(repo, "specs", "<new-feature>", stageFileName),
    path.join(repo, stageFileName),
  ].filter(Boolean);
  const found = candidates.filter(p => {
    try { return fs.existsSync(p); } catch { return false; }
  });
  return found.length ? [found[0]] : [candidates[0]];
}

export function speckitGateNote(s, step, repo, c = {}) {
  const gateKey = `speckit-stage:${step}`;
  const gateFindings = feedbackText(loadReviewFeedback(s, gateKey));
  if (!gateFindings) return "";
  const gateEarlierRounds = plannerEarlierRoundsText(s, gateKey, c?.workflow?.plan_review_convergence !== false);
  const gateNotes = planReviewNotesText(s, gateKey);
  const files = speckitStageFilePaths(repo, s, step);
  const recorded = s?.reviewFeedback?.[gateKey]?.stageFileHashes || s?.reviewStageSnapshots?.[gateKey];
  const changed = stageFilesChangedSinceReview(recorded, files);
  const changedLine = stageFilesChangedLine(changed);
  return `\n\n${changedLine ? `${changedLine}\n\n` : ""}The plan reviewer REJECTED the previous attempt at this stage. Address every finding; do not repeat the same output:\n${gateFindings}${gateEarlierRounds ? `\n\n${gateEarlierRounds}` : ""}${gateNotes ? `\n\n${gateNotes}` : ""}`;
}

export function standalonePlanFeedbackNote(s, repo, mission, c = {}, feedback = null) {
  const fb = feedback !== null ? feedback : feedbackText(loadReviewFeedback(s, "standalone-plan"));
  if (!fb) return "";
  const planFile = path.join(repo, ".autopilot", "specs", mission || "mission", "PLAN.md");
  const tasksFile = path.join(repo, ".autopilot", "specs", mission || "mission", "TASKS.md");
  const altPlan = path.join(repo, "specs", mission || "mission", "PLAN.md");
  const altTasks = path.join(repo, "specs", mission || "mission", "TASKS.md");
  const rootPlan = path.join(repo, "PLAN.md");
  const rootTasks = path.join(repo, "TASKS.md");
  const candidateFiles = [
    fs.existsSync(planFile) ? planFile : (fs.existsSync(altPlan) ? altPlan : rootPlan),
    fs.existsSync(tasksFile) ? tasksFile : (fs.existsSync(altTasks) ? altTasks : rootTasks),
  ];
  const recorded = s?.reviewFeedback?.["standalone-plan"]?.stageFileHashes || s?.reviewStageSnapshots?.["standalone-plan"];
  const changed = stageFilesChangedSinceReview(recorded, candidateFiles);
  const changedLine = stageFilesChangedLine(changed);
  return `${changedLine ? `${changedLine}\n\n` : ""}Plan reviewer feedback that MUST be addressed:\n${fb}`;
}

export function standaloneSpecFeedbackNote(s, repo, mission, c = {}, feedback = null) {
  const fb = feedback !== null ? feedback : feedbackText(loadReviewFeedback(s, "standalone-spec"));
  if (!fb) return "";
  const specFile = path.join(repo, "specs", mission || "mission", "SPEC.md");
  const rootSpec = path.join(repo, "SPEC.md");
  const candidateFiles = [fs.existsSync(specFile) ? specFile : rootSpec];
  const recorded = s?.reviewFeedback?.["standalone-spec"]?.stageFileHashes || s?.reviewStageSnapshots?.["standalone-spec"];
  const changed = stageFilesChangedSinceReview(recorded, candidateFiles);
  const changedLine = stageFilesChangedLine(changed);
  return `${changedLine ? `${changedLine}\n\n` : ""}Spec reviewer feedback that MUST be addressed:\n${fb}`;
}

export function gsdStageFiles(repo, phase, stage, c = {}) {
  const root = path.join(repo, ".planning");
  const candidates = [
    path.join(root, `${stage}.md`),
    path.join(repo, `${stage}.md`),
    path.join(repo, `${String(stage).toUpperCase()}.md`),
    path.join(root, "PLAN.md"),
    path.join(root, "RESEARCH.md"),
    path.join(root, "CONTEXT.md"),
    path.join(root, "DISCUSS.md"),
  ];
  const found = candidates.filter(p => {
    try { return fs.existsSync(p); } catch { return false; }
  });
  return found.length ? found : [path.join(repo, ".planning")];
}

