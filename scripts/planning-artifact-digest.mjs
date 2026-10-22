// Backlog #119: content digest of the standalone planning artifacts
// (PLAN.md + TASKS.md) with checkbox state normalised, so execution progress
// (`- [ ]` -> `- [x]`) does not count as a plan change.
import crypto from "node:crypto";
import fs from "node:fs";

export function normalisePlanningText(text){
  return String(text).replace(/\r\n/g,"\n").replace(/^(\s*[-*+]\s+)\[[ xX]\]/gm,"$1[ ]");
}

export function planningArtifactDigest(planFile,tasksFile){
  try{
    const h=crypto.createHash("sha256");
    for(const f of [planFile,tasksFile]){
      h.update(normalisePlanningText(fs.readFileSync(f,"utf8")));
      h.update("\0");
    }
    return h.digest("hex");
  }catch{ return null; }
}

// True when the stored passed review has a digest equal to the current one.
export function canSkipPlanningStateReview(stored,currentDigest){
  return !!(stored && stored.status==="passed" && stored.framework==="standalone"
    && typeof stored.artifactDigest==="string" && stored.artifactDigest
    && currentDigest && stored.artifactDigest===currentDigest);
}
