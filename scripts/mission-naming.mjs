import fs from "node:fs";
import path from "node:path";
import {planPath as standalonePlanPath, tasksPath as standaloneTasksPath} from "../adapters/standalone.mjs";

export const sanitizeMissionName = (name) => {
  return String(name || "").trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^[.\-]+|[.\-]+$/g, "")
    .slice(0, 120) || "unassigned";
};

function unsafeMissionName(message) {
  // Same fail-closed shape as `standaloneMigrationConflict` below: throw with
  // a `.code` the top-level `main().catch` in `autopilot.mjs` turns into
  // `process.exit(2)`, same as `die()`.
  const err = new Error(message);
  err.code = "UNSAFE_MISSION_NAME";
  throw err;
}

// Fail-closed guard for a mission string immediately before it becomes a
// path segment (`ensureStandaloneMigrated`'s persisted-mission branch,
// `standalone.planPath()`). Every CURRENT production caller that sets
// `s.mission` already routes through `sanitizeMissionName()` via
// `missionFor()`'s return value, so this should never fire in normal
// operation — its job is to catch a hand-edited or corrupted
// `.autopilot/state.json` (e.g. `"mission": "../../../outside"`) before it
// reaches `fs.renameSync`/`fs.writeFileSync`/`fs.readFileSync`.
//
// Deliberately fails closed instead of silently re-sanitizing: silently
// substituting the sanitized name would bind the plan to a DIFFERENT
// mission folder than the one actually recorded in state, masking the
// corruption instead of surfacing it. The two checks are independent
// defenses — `sanitizeMissionName` strips `/`/`\` so most traversal strings
// already fail the equality check, but the `path.resolve` containment
// check also catches anything that could slip through unequal-but-still-escaping.
export function assertSafeMissionName(repo, name, label) {
  const n = String(name || "");
  const sanitized = sanitizeMissionName(n);
  if (sanitized !== n) {
    unsafeMissionName(`UNSAFE_MISSION_NAME: ${label} "${n}" is not an already-sanitized mission name (sanitizeMissionName would produce "${sanitized}"); refusing to use it as-is. This usually means .autopilot/state.json was hand-edited or corrupted.`);
  }
  const missionsRoot = path.resolve(repo, ".autopilot", "missions");
  const resolved = path.resolve(missionsRoot, n);
  const boundary = missionsRoot + path.sep;
  if (resolved !== missionsRoot && !resolved.startsWith(boundary)) {
    unsafeMissionName(`UNSAFE_MISSION_NAME: ${label} "${n}" resolves outside .autopilot/missions (${resolved}); refusing to use it.`);
  }
  return n;
}

function projectMissionFromFile(repo) {
  try {
    const raw = fs.readFileSync(path.join(repo, ".autopilot", "config.json"), "utf8");
    const c = JSON.parse(raw);
    return c?.project?.mission || "";
  } catch {
    return "";
  }
}

function projectFrameworkFromFile(repo) {
  try {
    const raw = fs.readFileSync(path.join(repo, ".autopilot", "config.json"), "utf8");
    return String(JSON.parse(raw)?.project?.planning_framework || "");
  } catch {
    return "";
  }
}

export const missionOverride = (repo) => {
  const mi = process.argv.indexOf("--mission");
  const cli = mi !== -1 && process.argv[mi + 1] && !process.argv[mi + 1].startsWith("--") ? process.argv[mi + 1] : "";
  return cli || process.env.AUTOPILOT_MISSION || projectMissionFromFile(repo) || "";
};

// Pure `ap run` argument parser (backlog #39, task 1.1). Takes the run
// command's args (i.e. `commandArgs`, NOT full `process.argv`) and splits
// them into a mission-flag value plus residual request text, stripping both
// `--mission <name>` (and its value) and `--repo <path>` (and its value) so
// flag text never becomes request text. Pure and import-safe: unlike
// `missionOverride()` it never reads `process.argv`, so unit tests can call
// it directly (`scripts/autopilot.mjs` runs its CLI on import and cannot be
// imported for tests — it only imports this helper).
//
// Returns `{mission, request, error}`:
//   mission — the `--mission` value ("" when absent; first flag wins,
//     consistent with `missionOverride()`'s `indexOf`).
//   request — residual args joined with single spaces, trimmed.
//   error   — a usage-error string, or null when parsing succeeded:
//     * `--mission` with no value, or a value starting with `--`
//       (`missionOverride()` silently ignores those; here they are errors
//       so a typo like `ap run --mission --repo <path>` fails closed
//       instead of silently running without the override).
//     * residual request text starting with `--` (an unknown flag where the
//       request should be, e.g. `ap run --verbose`), refused rather than
//       treated as a feature description.
export function parseRunArgs(args) {
  const list = Array.isArray(args) ? args : [];
  const VALID_STAGES = ["planning", "implement", "review", "verify"];
  let mission = "";
  let seenMission = false;
  let missionError = null;
  let stage = null;
  let seenStage = false;
  let stageError = null;
  const residual = [];
  for (let i = 0; i < list.length; i++) {
    const token = String(list[i]);
    if ((token === "--stage" || token.startsWith("--stage=")) && !seenStage) {
      seenStage = true;
      const value = token.startsWith("--stage=")
        ? token.slice("--stage=".length)
        : (list[i + 1] != null ? String(list[i + 1]) : "");
      if (!token.startsWith("--stage=")) i++;
      if (!value || value.startsWith("--") || !VALID_STAGES.includes(value)) {
        stageError = `Usage error: --stage requires one of planning|implement|review|verify (got ${value ? JSON.stringify(value) : "none"}). Use: ap run --stage <planning|implement|review|verify> [request]`;
      } else {
        stage = value;
      }
      continue;
    }
    if (token === "--stage" || token.startsWith("--stage=")) {
      // A second --stage flag: skip it and its value the same way so no
      // flag text leaks into the request (first value still wins).
      if (token === "--stage") i++;
      continue;
    }
    if (token === "--mission" && !seenMission) {
      seenMission = true;
      const value = list[i + 1] != null ? String(list[i + 1]) : "";
      if (!value || value.startsWith("--")) {
        missionError = "Usage error: --mission requires a value (got none or a flag-like value). Use: ap run --mission <name> [request]";
      } else {
        mission = value;
      }
      i++;
      continue;
    }
    if (token === "--mission") {
      // A second --mission flag: skip it and its value the same way so no
      // flag text leaks into the request (first value still wins).
      i++;
      continue;
    }
    if (token === "--repo") {
      // Mirror the run handler's stripping (`autopilot.mjs` skips `--repo`
      // plus the next token unconditionally).
      i++;
      continue;
    }
    residual.push(token);
  }
  const request = residual.join(" ").trim();
  if (stageError) return { mission: "", request, stage: null, error: stageError };
  if (missionError) return { mission: "", request, stage, error: missionError };
  if (request.startsWith("--")) {
    return { mission, request, stage, error: `Usage error: request text must not start with a flag (${request.split(/\s+/)[0]}). Use: ap run [request] [--mission <name>] [--repo <path>]` };
  }
  return { mission, request, stage, error: null };
}

// A "usable" request is non-empty and NOT the fallback placeholder — a bare
// `ap run` must not be treated as a real feature description.
export const PLACEHOLDER_REQUEST = "Use the current project request/context.";
export const hasUsableRequest = (req) => Boolean(String(req || "").trim()) && String(req).trim() !== PLACEHOLDER_REQUEST;
export const stripSpecNumber = (name) => String(name || "").replace(/^\d+-/, "").trim();
export const missionSeqOf = (mission) => { const m = String(mission || "").match(/^(\d+)-/); return m ? m[1] : null; };
export const stripSeqPrefix = (mission) => String(mission || "").replace(/^\d+-/, "");

// Next available autopilot mission sequence (SpecKit-style: scan existing
// `missions/*/`, max numeric prefix + 1).
export function nextMissionSeq(repo) {
  const root = path.join(repo, ".autopilot", "missions");
  if (!fs.existsSync(root)) return "001";
  let max = 0;
  for (const d of fs.readdirSync(root)) {
    const dir = path.join(root, d);
    if (!fs.statSync(dir).isDirectory()) continue;
    const m = String(d).match(/^(\d+)/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return String(max + 1).padStart(3, "0");
}

// Reuse the seq of an existing mission folder whose name matches — so a resume
// (or post-migration re-derivation) lands in the SAME folder, not a new one.
// With `{reusableOnly: true}` reuse is an ALLOWLIST: every entry in the folder
// must be `WATCH-REPORT.md` or a leftover temp file matching
// /^WATCH-REPORT\.md\.tmp\.\d+$/ (writeWatchReportFile in run-history.mjs
// writes through `${file}.tmp.${pid}` + rename). An empty folder is reusable.
// Anything else — NOTES.md, FINDINGS.md, phase-briefs/, runs/, PLAN.md,
// TASKS.md, or any file/dir a future version adds — blocks reuse by default.
// `since` is accepted for call-site documentation but intentionally NOT
// consulted: folder creation time (birthtime) is not reliable across
// platforms (WSL/NTFS/native Windows), so the allowlist above is the sole
// reuse rule.
export function existingMissionSeqForName(repo, name, opts) {
  const n = String(name || "").trim();
  if (!n) return null;
  const root = path.join(repo, ".autopilot", "missions");
  if (!fs.existsSync(root)) return null;
  for (const d of fs.readdirSync(root)) {
    const dir = path.join(root, d);
    if (!fs.statSync(dir).isDirectory()) continue;
    if (stripSpecNumber(d) === n) {
      const m = d.match(/^(\d+)/);
      if (!m) continue;
      if (opts?.reusableOnly) {
        const reusable = fs.readdirSync(dir).every(
          (entry) => entry === "WATCH-REPORT.md" || /^WATCH-REPORT\.md\.tmp\.\d+$/.test(entry)
        );
        if (!reusable) continue;
      }
      return m[1];
    }
  }
  return null;
}

// Port of SpecKit's `generate_branch_name()` (see
// `.specify/extensions/git/scripts/bash/create-new-feature.sh`): lowercase,
// drop stop-words, keep words >=3 chars (or original-case acronyms), join the
// top 3 (or 4 if exactly 4 remain) with `-`; fall back to the first 3 tokens.
// Returns "" when the request is empty/placeholder.
export const nameFromRequest = (req) => {
  if (!hasUsableRequest(req)) return "";
  const stopWords = String.raw`^(i|a|an|the|to|for|of|in|on|at|by|with|from|is|are|was|were|be|been|being|have|has|had|do|does|did|will|would|should|could|can|may|might|must|shall|this|that|these|those|my|your|our|their|want|need|add|get|set)$`;
  const clean = String(req).toLowerCase().replace(/[^a-z0-9]/g, " ");
  const tokens = String(req).split(/\s+/).filter(Boolean);
  const meaningful = [];
  for (const w of clean.split(/\s+/).filter(Boolean)) {
    if (new RegExp(stopWords).test(w)) continue;
    if (w.length >= 3) meaningful.push(w);
    else if (tokens.some(t => t === w.toUpperCase())) meaningful.push(w);
  }
  if (meaningful.length > 0) {
    const max = meaningful.length === 4 ? 4 : 3;
    return meaningful.slice(0, max).join("-");
  }
  return clean.split(/\s+/).filter(Boolean).slice(0, 3).join("-");
};

export function missionFor(repo, s) {
  const ov = missionOverride(repo);
  if (ov) return sanitizeMissionName(ov);
  const phase = String(s?.phase || "");
  const isPlanningPhase = /planning|escalated/.test(phase) || String(s?.step || "").startsWith("planning");
  let name = null;
  if (s?.mission) { const n = stripSeqPrefix(s.mission); if (n) name = n; }
  if (!name && !isPlanningPhase) {
    const file = String(s?.currentTask?.file || "");
    const m = file.match(/(?:^|[\\/])specs[\\/]([^\\/]+)[\\/]/);
    if (m) name = stripSpecNumber(m[1]);
  }
  // During planning the name comes from the REQUEST, for every framework.
  // This mission's spec does not exist yet at planning start, so "the newest
  // `specs/*/`" is always a PREVIOUS feature — and it changes once SpecKit
  // creates the new spec, splitting one mission across two folders (runs
  // under one name, plan + watch report under another). The request name uses
  // SpecKit's own short-name algorithm, so it normally equals the spec name.
  if (!name && isPlanningPhase && hasUsableRequest(s?.planningRequest)) {
    name = nameFromRequest(s.planningRequest);
  }
  // Fallback only when there is no request at all (e.g. a bare `ap run`
  // resuming a SpecKit mission): newest spec, never for standalone.
  if (!name && isPlanningPhase && projectFrameworkFromFile(repo) !== "standalone") {
    const specsRoot = path.join(repo, "specs");
    if (fs.existsSync(specsRoot)) {
      let best = null, bestTime = 0;
      for (const d of fs.readdirSync(specsRoot)) {
        const dir = path.join(specsRoot, d);
        if (!fs.statSync(dir).isDirectory()) continue;
        let t = fs.statSync(dir).mtimeMs;
        const specFile = path.join(dir, "spec.md");
        if (fs.existsSync(specFile)) t = Math.max(t, fs.statSync(specFile).mtimeMs);
        if (t > bestTime) { bestTime = t; best = d; }
      }
      if (best) name = stripSpecNumber(best);
    }
  }
  if (!name && s?.gsdPhase) name = stripSpecNumber(String(s.gsdPhase));
  if (!name) name = nameFromRequest(s?.planningRequest || process.env.AUTOPILOT_SPEC || "");
  if (!name) return null;
  const seq = s?.missionSeq || missionSeqOf(s?.mission) || existingMissionSeqForName(repo, name) || nextMissionSeq(repo);
  return sanitizeMissionName(`${seq}-${name}`);
}

export function missionDirFor(repo, s) {
  return missionFor(repo, s);
}

// Standalone mission resolution (plan design decision 1): tell "resume the
// same thing" apart from "this is a different request than last time".
// `missionFor` alone reads persisted `s.mission` first with no awareness of
// the live request text, so a stale `s.mission` would swallow every
// subsequent unrelated request. The new-request comparison below mirrors the
// exact check in `runImplementation` (`scripts/autopilot.mjs:2596`).
export function resolveStandaloneMission(repo, s, request) {
  const persisted = String(s?.planningRequest || "").trim();
  if (hasUsableRequest(request) && String(request).trim() !== persisted) {
    // Genuinely new request: resolve purely from the live request text via
    // `nameFromRequest` + `existingMissionSeqForName`, deliberately ignoring
    // both the stale `s.mission` and the stale `s.planningRequest` fields.
    // The explicit `planningRequest: request` override is required:
    // `missionFor` derives its name via
    // `nameFromRequest(s?.planningRequest || AUTOPILOT_SPEC)`, so spreading
    // `...s` alone would leave the previous request's text in place (at both
    // detection call sites the live request has not yet been persisted into
    // `s.planningRequest`). Lands back in an existing mission directory when
    // the newly-derived slug matches one; only allocates a fresh sequence
    // when no match exists.
    return missionFor(repo, { ...s, mission: null, missionSeq: null, planningRequest: request });
  }
  // Resume/continuation (no usable live request, or it matches the persisted
  // request): trust persisted `s.mission` exactly as `missionFor` does today.
  return missionFor(repo, s);
}

function standaloneMigrationConflict(message) {
  // Fail closed like `die()` in `scripts/autopilot.mjs` (console + non-zero
  // exit there). Throwing keeps the same fail-closed semantics while staying
  // testable with plain `fs` fixtures (`assert.throws(/MIGRATION_CONFLICT/)`);
  // the top-level `main().catch` in `autopilot.mjs` converts an uncaught
  // throw into `process.exit(2)` just like `die()`.
  const err = new Error(message);
  err.code = "MIGRATION_CONFLICT";
  throw err;
}

// One-time cleanup of a legacy fixed-path standalone plan (plan design
// decision 2). Decided from PERSISTED `s.mission` only, independent of any
// live request. Read-only callers (`detect`/`state`/`tasks`/`markDone`'s own
// read, `reviewPlanCommand`, `inspect`, `status`) must never call this.
// Write-capable entry points only (`ensurePlanningReady` gated on
// `planningAdapter(c)===standalone`, `runStandalonePlanning`,
// `runStandaloneImplementation` — wired in a later task).
export function ensureStandaloneMigrated(repo, s) {
  const legacyFile = path.join(repo, ".autopilot", "standalone", "PLAN.md");
  if (!fs.existsSync(legacyFile)) return;
  const persistedMission = String(s?.mission || "").trim();
  if (!persistedMission) {
    // Branch 2: genuine orphan — no mission on record ever claimed it.
    const destMission = sanitizeMissionName(`${nextMissionSeq(repo)}-legacy-standalone-plan`);
    const destFile = path.join(repo, ".autopilot", "missions", destMission, "PLAN.md");
    if (fs.existsSync(destFile)) {
      migrationLog(repo, `MIGRATION_CONFLICT legacy ${legacyFile} destination ${destFile} already exists (orphan)`);
      standaloneMigrationConflict(`MIGRATION_CONFLICT: legacy standalone plan destination already exists: ${destFile}`);
    }
    fs.mkdirSync(path.dirname(destFile), { recursive: true });
    fs.renameSync(legacyFile, destFile);
    try { fs.rmdirSync(path.join(repo, ".autopilot", "standalone")); } catch { /* only removes when empty */ }
    migrationLog(repo, `migrated legacy standalone plan ${legacyFile} -> ${destFile} (orphan, branch 2)`);
    return;
  }
  // Branches 3/4: a persisted mission exists.
  assertSafeMissionName(repo, persistedMission, "state.json mission");
  const destFile = path.join(repo, ".autopilot", "missions", persistedMission, "PLAN.md");
  if (fs.existsSync(destFile)) {
    // Branch 4 (genuine three-way conflict: legacy file + recorded mission
    // + that mission's new-path file all present): fail closed, never
    // silently reclassify as orphan. This clause also covers the
    // destination-collision rule for branch 3.
    migrationLog(repo, `MIGRATION_CONFLICT legacy ${legacyFile} owned by mission ${persistedMission} destination ${destFile} already exists`);
    standaloneMigrationConflict(`MIGRATION_CONFLICT: legacy standalone plan and mission ${persistedMission} plan both exist; refusing to overwrite either file`);
  }
  // Branch 3: persisted mission is the identifiable active owner.
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  fs.renameSync(legacyFile, destFile);
  try { fs.rmdirSync(path.join(repo, ".autopilot", "standalone")); } catch { /* only removes when empty */ }
  migrationLog(repo, `migrated legacy standalone plan ${legacyFile} -> ${destFile} (owner ${persistedMission}, branch 3)`);
}

// Standalone PLAN.md -> PLAN.md + TASKS.md split (Task 2 v5).
//
// All ambiguity checks run BEFORE the first filesystem write so
// MIGRATION_CONFLICT causes zero modifications. Returns {migrated, splitPerformed}:
//   migrated=true means the mission is now on the split contract (fresh split or
//   crash-recovery heal completed) and gated stale-key cleanup should run once.
//   splitPerformed=true only on the fresh write path.
export function ensureStandaloneSplit(repo, s){
  const mission = String(s?.mission || "").trim();
  if(!mission) return {migrated:false, splitPerformed:false};
  let planFile, tasksFile;
  try{
    planFile = standalonePlanPath(repo, mission);
    tasksFile = standaloneTasksPath(repo, mission);
  }catch(e){
    if(e?.code==="UNSAFE_MISSION_NAME") throw e;
    return {migrated:false, splitPerformed:false};
  }
  if(!fs.existsSync(planFile)) return {migrated:false, splitPerformed:false};
  const planContent = fs.readFileSync(planFile,"utf8");
  const planLines = planContent.split(/\r?\n/);
  // Find checklist section: first "- [ ]" line to last checklist line inclusive,
  // preserving continuation paragraphs/indented content between items verbatim.
  // If any non-checklist, non-blank, non-fence content is interleaved in a way
  // that cannot be cleanly extracted, we fail closed rather than lose it.
  const checklistInfo = locateChecklistSection(planLines);
  const hasChecklist = checklistInfo.hasChecklist;
  const tasksExists = fs.existsSync(tasksFile);

  if(!hasChecklist && !tasksExists) return {migrated:false, splitPerformed:false};
  if(!hasChecklist && tasksExists) return {migrated:false, splitPerformed:false};

  // Build what TASKS.md would be from PLAN.md's checklist section verbatim.
  const extractedTasksContent = buildTasksFileContent(planLines, checklistInfo);
  const pointerLine = "Tasks: ./TASKS.md";

  if(tasksExists){
    const existingTasksContent = fs.readFileSync(tasksFile,"utf8");
    const identical = existingTasksContent === extractedTasksContent;
    if(identical){
      // Crash-recovery: TASKS.md already correct, but PLAN.md may still have checklist.
      // Heal PLAN.md side idempotently, gated on migrated=true so stale cleanup runs once.
      if(hasChecklist){
        // All checks passed, now mutate PLAN.md side only.
        const newPlanContent = stripChecklistSection(planLines, checklistInfo, pointerLine);
        fs.writeFileSync(planFile, newPlanContent);
        migrationLog(repo, `healed PLAN.md checklist after split for mission ${mission} (recovery, TASKS.md already identical)`);
      } else if(!planContent.includes(pointerLine)){
        // PLAN.md already stripped but missing pointer (edge)
        fs.writeFileSync(planFile, planContent.trimEnd() + "\n\n" + pointerLine + "\n");
      }
      return {migrated:true, splitPerformed:false};
    }
    // TASKS.md exists and differs -> conflict, zero modifications.
    migrationLog(repo, `MIGRATION_CONFLICT standalone split: ${tasksFile} already exists and differs from extracted checklist for mission ${mission}`);
    standaloneMigrationConflict(`MIGRATION_CONFLICT: standalone TASKS.md already exists and differs from PLAN.md checklist for mission ${mission}; refusing to overwrite`);
  }

  // Fresh split: TASKS.md missing, checklist present -> all checks done, now write.
  // Also need to detect ambiguous interleaved content before writing.
  if(checklistInfo.ambiguous){
    migrationLog(repo, `MIGRATION_CONFLICT standalone split ambiguous checklist section for mission ${mission}`);
    standaloneMigrationConflict(`MIGRATION_CONFLICT: standalone PLAN.md checklist section is ambiguous for mission ${mission}; refusing to guess`);
  }
  fs.mkdirSync(path.dirname(tasksFile), {recursive:true});
  fs.writeFileSync(tasksFile, extractedTasksContent);
  const newPlanContent = stripChecklistSection(planLines, checklistInfo, pointerLine);
  fs.writeFileSync(planFile, newPlanContent);
  migrationLog(repo, `split standalone PLAN.md -> PLAN.md + TASKS.md for mission ${mission}`);
  return {migrated:true, splitPerformed:true};
}

function locateChecklistSection(lines){
  let first=-1, last=-1;
  let inFence=false;
  let hasChecklist=false;
  let ambiguous=false;
  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    if(/^\s*(```|~~~)/.test(line)){ inFence=!inFence; continue; }
    if(inFence) continue;
    if(/^\s*-\s*\[\s*[xX ]?\s*\]\s+/.test(line)){
      hasChecklist=true;
      if(first===-1) first=i;
      last=i;
    }
  }
  if(!hasChecklist) return {hasChecklist:false, first, last, ambiguous:false};
  // Check for non-checklist, non-blank, non-heading content interleaved between first and last
  // that is not a continuation (indented) or blank. If found outside checklist grammar,
  // mark ambiguous — caller will fail closed before any write.
  // For now, any line between first and last that is neither blank, fence, checklist,
  // nor indented continuation (>=2 spaces) is ambiguous.
  for(let i=first;i<=last;i++){
    const line=lines[i];
    if(/^\s*(```|~~~)/.test(line)) continue;
    if(/^\s*-\s*\[\s*[xX ]?\s*\]\s+/.test(line)) continue;
    if(line.trim()==="") continue;
    if(/^\s{2,}\S/.test(line)) continue; // indented continuation
    if(/^\s*#/.test(line)) continue; // heading inside section (rare but not ambiguous)
    // Any other non-blank, non-indented line between checklist items is ambiguous.
    // Example: a paragraph at column 0 between two tasks.
    if(line.trim().length>0 && !/^\s/.test(line)){
      // This is technically between tasks but could be section text — treat as ambiguous
      // only if it's not obviously part of checklist. Conservative: mark ambiguous.
      ambiguous=true;
    }
  }
  return {hasChecklist, first, last, ambiguous};
}

function buildTasksFileContent(planLines, info){
  if(!info.hasChecklist) return "";
  const slice = planLines.slice(info.first, info.last+1);
  // Preserve verbatim (including continuations, blanks, fences between)
  const body = slice.join("\n").trimEnd();
  return `## Phase 1: General\n\n${body}\n`;
}

function stripChecklistSection(planLines, info, pointerLine){
  if(!info.hasChecklist) return planLines.join("\n");
  const before = planLines.slice(0, info.first);
  const after = planLines.slice(info.last+1);
  // Trim trailing blanks from before, then append pointer, then after (trim leading blanks)
  let out = before.join("\n").trimEnd();
  if(out) out += "\n\n" + pointerLine + "\n";
  else out = pointerLine + "\n";
  const afterTrimmed = after.join("\n").trimStart();
  if(afterTrimmed) out += "\n" + afterTrimmed;
  if(!out.endsWith("\n")) out += "\n";
  return out;
}

// Append an audit line to `.autopilot/MIGRATION.md` (mission folder renames).
export function migrationLog(repo, line) {
  try {
    const file = path.join(repo, ".autopilot", "MIGRATION.md");
    const entry = `${new Date().toISOString()}  ${line}\n`;
    fs.appendFileSync(file, entry);
  } catch { /* logging must never break a run */ }
}

// Standalone equivalent of validatePendingCheckboxSnapshot: fail-closed
// validation for the isolated pendingStandaloneCheckboxSnapshot. Feature is
// always null (standalone has no scoped feature directory). All task files
// must point to the standalone TASKS.md — standalone tasks are all in one
// file, never multi-file. Repo containment check prevents path traversal.
export function validateStandaloneSnapshot(snapshot, mission, tasksFilePath) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return {ok: false, reason: "standalone snapshot is not an object"};
  if (typeof snapshot.capturedAt !== "string" || !snapshot.capturedAt) return {ok: false, reason: "standalone snapshot is missing capturedAt"};
  if (!("feature" in snapshot) || snapshot.feature !== null) return {ok: false, reason: "standalone snapshot feature must be null"};
  if (!("mission" in snapshot) || typeof snapshot.mission !== "string" || !snapshot.mission) return {ok: false, reason: "standalone snapshot is missing a valid mission identity"};
  if (snapshot.mission !== mission) return {ok: false, reason: `standalone snapshot mission mismatch: snapshot="${snapshot.mission}" current="${mission}"`};
  if (!Array.isArray(snapshot.tasks) || snapshot.tasks.length === 0) return {ok: false, reason: "standalone snapshot tasks is not a non-empty array"};
  for (const task of snapshot.tasks) {
    if (!task || typeof task !== "object" || Array.isArray(task)) return {ok: false, reason: "standalone snapshot contains a malformed task entry"};
    if (typeof task.file !== "string" || !task.file) return {ok: false, reason: "standalone snapshot task entry has an invalid file"};
    if (!Number.isInteger(task.line) || task.line <= 0) return {ok: false, reason: "standalone snapshot task entry has an invalid (non-positive) line number"};
    if (typeof task.text !== "string" || !task.text.trim()) return {ok: false, reason: "standalone snapshot task entry is missing task text"};
    if (typeof task.done !== "boolean") return {ok: false, reason: "standalone snapshot task entry has a non-boolean done value"};
    const resolved = path.resolve(task.file);
    const expected = path.resolve(tasksFilePath);
    if (resolved !== expected) return {ok: false, reason: `standalone snapshot task file does not match tasks path: ${task.file} !== ${tasksFilePath}`};
  }
  return {ok: true, tasks: snapshot.tasks};
}
