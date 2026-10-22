// TASK 14 CORRECTION 2: strict, fail-closed schema/authority validation for
// a persisted pending checkbox snapshot BEFORE it is ever trusted for
// reconciliation. The original correction only checked `Array.isArray(...)
// && ...length`, which silently skipped (i.e. trusted whatever was already
// on disk, including poisoned "[x]" values) a snapshot that existed but was
// malformed, empty, or missing its identity fields — this is that gap
// closed. Returns {ok:true} only when EVERY check below passes; otherwise
// {ok:false, reason}. Never mutates the snapshot, never invents/repairs a
// missing field, never falls back to trusting on-disk checkboxes instead —
// an invalid snapshot is a hard stop, not a soft one.
//
// Extracted from scripts/autopilot.mjs (which cannot itself be imported —
// it runs its CLI unconditionally at module load) into its own module so
// this pure function is directly unit-testable in-process, with no
// subprocess, against every malformed-snapshot shape. `repo` is passed
// explicitly instead of closed over a module-level variable — same
// computation, same result for the same inputs, no behavior change from the
// in-line version this replaced.
import path from "node:path";

export function validatePendingCheckboxSnapshot(snapshot, currentFeatureDir, currentMissionIdentity, repo) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return {ok: false, reason: "pending checkbox snapshot is not an object"};
  if (typeof snapshot.capturedAt !== "string" || !snapshot.capturedAt) return {ok: false, reason: "pending checkbox snapshot is missing capturedAt"};
  // "feature" identifies the active SpecKit feature directory this
  // snapshot was captured for (repo-relative), or null for a mission with
  // no scoped feature.json (repo-wide task_candidates). The KEY must be
  // present with a valid type either way — a snapshot from before this
  // schema existed (no "feature" key at all) is exactly the "legacy
  // snapshot without the new identities" case that must fail closed, never
  // be treated as implicitly matching.
  if (!("feature" in snapshot) || !(snapshot.feature === null || (typeof snapshot.feature === "string" && snapshot.feature))) return {ok: false, reason: "pending checkbox snapshot is missing a valid feature identity"};
  if (!("mission" in snapshot) || typeof snapshot.mission !== "string" || !snapshot.mission) return {ok: false, reason: "pending checkbox snapshot is missing a valid mission identity"};
  if (snapshot.feature !== currentFeatureDir) return {ok: false, reason: `pending checkbox snapshot feature mismatch: snapshot="${snapshot.feature}" current="${currentFeatureDir}"`};
  if (snapshot.mission !== currentMissionIdentity) return {ok: false, reason: `pending checkbox snapshot mission mismatch: snapshot="${snapshot.mission}" current="${currentMissionIdentity}"`};
  if (!Array.isArray(snapshot.tasks) || snapshot.tasks.length === 0) return {ok: false, reason: "pending checkbox snapshot tasks is not a non-empty array"};

  const repoRoot = path.resolve(repo);
  const featureRoot = currentFeatureDir ? path.resolve(repo, currentFeatureDir) : null;
  for (const task of snapshot.tasks) {
    if (!task || typeof task !== "object" || Array.isArray(task)) return {ok: false, reason: "pending checkbox snapshot contains a malformed task entry"};
    if (typeof task.file !== "string" || !task.file) return {ok: false, reason: "pending checkbox snapshot task entry has an invalid file"};
    if (!Number.isInteger(task.line) || task.line <= 0) return {ok: false, reason: "pending checkbox snapshot task entry has an invalid (non-positive) line number"};
    if (typeof task.text !== "string" || !task.text.trim()) return {ok: false, reason: "pending checkbox snapshot task entry is missing task text"};
    if (typeof task.done !== "boolean") return {ok: false, reason: "pending checkbox snapshot task entry has a non-boolean done value"};
    // Containment: never trust a path supplied by persisted state without
    // canonicalizing and confirming it stays inside the repository (and,
    // when the mission is scoped to a specific feature, inside that
    // feature's own directory) — rejects both a straightforward escape and
    // a "../"-style traversal encoded into the stored path.
    const resolved = path.resolve(task.file);
    const withinRepo = resolved === repoRoot || resolved.startsWith(repoRoot + path.sep);
    if (!withinRepo) return {ok: false, reason: `pending checkbox snapshot task file escapes the repository: ${task.file}`};
    if (featureRoot) {
      const withinFeature = resolved === featureRoot || resolved.startsWith(featureRoot + path.sep);
      if (!withinFeature) return {ok: false, reason: `pending checkbox snapshot task file escapes the active feature: ${task.file}`};
    }
  }
  return {ok: true};
}
