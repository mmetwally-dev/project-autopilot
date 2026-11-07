// TASK-8 "Prompt contract" / TASK-19 Phase 3 task 10 — the orchestrator-owned
// phase brief PRODUCER.
//
// The per-task prompt assembler (task 9) only *points at* this artifact; it
// never writes it. This module is the one producer: a bounded, per-phase file
// under `.autopilot/missions/<mission>/phase-briefs/phase-<N>.md`, rewritten
// once per phase before the first per-task invocation and after every revision
// increment. Reading it is optional — every constraint essential to the
// current task still lives inline in the task prompt.
//
// Location is deliberate: under `.autopilot/`, so the brief is excluded from
// the scoped delta, the worktree listing, and the meaningful-status filter, and
// is never a tracked repository file. It is distinct from `brief.txt`, which
// is the per-relay prompt dump written fresh for every relay call.
//
// Sizing is bounded with an explicit cap and an announced truncation, the same
// discipline as `standalone-handoff.mjs`'s truncation warning — never
// unbounded growth.
import fs from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import {sanitizeKeySegment} from "./implementation-baseline.mjs";
import {taskTitle, taskDisplayRef} from "./role-progress-prompt.mjs";

export const PHASE_BRIEF_BUDGET = 20000;
export const PHASE_BRIEF_DIR = "phase-briefs";

const HEADER_RE = /^<!--\s*autopilot-phase-brief\s+revision=(\d+)\s+digest=(\S+)\s*-->/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256Hex(text) {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

function bounded(value, max) {
  const text = String(value ?? "");
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}\n… [truncated]`;
}

// Deterministic brief digest covering the tasks file plus phase/task map.
export function phaseBriefDigest({framework, mission, phaseNumber, phaseIndex, phaseName, phaseTotal, taskIds, tasks, tasksFile, tasksContent, repoRoot, repo} = {}) {
  const root = repoRoot ?? repo ?? "";
  const tList = Array.isArray(tasks) ? tasks : [];
  const idList = Array.isArray(taskIds) ? taskIds : [];
  let tasksHash = "";
  if (typeof tasksContent === "string") {
    tasksHash = sha256Hex(tasksContent);
  } else if (tasksFile && root) {
    try {
      const fullPath = path.isAbsolute(tasksFile) ? tasksFile : path.join(root, tasksFile);
      if (fs.existsSync(fullPath)) {
        tasksHash = sha256Hex(fs.readFileSync(fullPath, "utf8"));
      }
    } catch {}
  }
  const num = Number.isInteger(phaseNumber) ? phaseNumber : (Number.isInteger(phaseIndex) ? phaseIndex + 1 : "");
  const total = Number.isInteger(phaseTotal) ? phaseTotal : (phaseTotal != null ? String(phaseTotal) : "");
  const canonical = {
    framework: String(framework ?? ""),
    mission: String(mission ?? ""),
    phaseNumber: num,
    phaseTotal: total,
    phaseName: String(phaseName ?? "").trim(),
    tasksHash,
    taskIds: idList.length ? idList : tList.map((t, i) => (t?.ref ?? (typeof t?.id === "string" ? t.id : null) ?? taskDisplayRef(t, i) ?? `task-${i}`)),
    tasks: tList.map((t, i) => ({
      id: idList[i] ?? (t?.ref ?? (typeof t?.id === "string" ? t.id : null) ?? taskDisplayRef(t, i) ?? `task-${i}`),
      title: taskTitle(t),
    })),
  };
  return `sha256:${sha256Hex(JSON.stringify(canonical))}`;
}

// `.autopilot/missions/<mission>/phase-briefs/phase-<N>.md`, relative to repo.
export function phaseBriefRelativePath(mission, phaseNumber) {
  return `.autopilot/missions/${sanitizeKeySegment(mission)}/${PHASE_BRIEF_DIR}/phase-${phaseNumber}.md`;
}

export function phaseBriefPath(repo, mission, phaseNumber) {
  return path.join(repo, phaseBriefRelativePath(mission, phaseNumber));
}

function phaseNumberOf({phaseNumber, phaseIndex}) {
  if (Number.isInteger(phaseNumber) && phaseNumber >= 1) return phaseNumber;
  if (Number.isInteger(phaseIndex) && phaseIndex >= 0) return phaseIndex + 1;
  throw new TypeError("phase brief requires an integer phaseNumber or phaseIndex");
}

function header(revision, phaseTaskDigest) {
  return `<!-- autopilot-phase-brief revision=${revision} digest=${phaseTaskDigest ?? "none"} -->`;
}

// Parse the revision/digest the on-disk brief was written for, or null when the
// file is absent or unrecognized (unrecognized is treated as absent so a
// hand-edited brief is rewritten rather than trusted).
export function readPhaseBriefHeader(repo, mission, phaseNumber) {
  const file = phaseBriefPath(repo, mission, phaseNumber);
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
  const first = String(raw).split("\n", 1)[0];
  const match = HEADER_RE.exec(first);
  if (!match) return null;
  return {revision: Number(match[1]), digest: match[2]};
}

// Validate a phase brief on disk against expected plan properties.
export function validatePhaseBrief(repo, mission, phaseNumber, expected = {}) {
  const file = phaseBriefPath(repo, mission, phaseNumber);
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    return {ok: false, reason: "missing_file", file};
  }
  const headerInfo = readPhaseBriefHeader(repo, mission, phaseNumber);
  if (!headerInfo) return {ok: false, reason: "invalid_header", file};
  if (Number.isInteger(expected.revision) && headerInfo.revision !== expected.revision) {
    return {ok: false, reason: "revision_mismatch", expected: expected.revision, actual: headerInfo.revision};
  }
  if (expected.digest && headerInfo.digest !== expected.digest) {
    return {ok: false, reason: "digest_mismatch", expected: expected.digest, actual: headerInfo.digest};
  }
  if (Number.isInteger(expected.phaseTotal)) {
    const phaseLine = raw.split("\n").find((l) => /^Phase:\s*\d+\/\d+/i.test(l.trim()));
    if (phaseLine) {
      const m = phaseLine.match(/^Phase:\s*(\d+)\/(\d+)/i);
      if (m && Number(m[2]) !== expected.phaseTotal) {
        return {ok: false, reason: "phase_count_mismatch", expected: expected.phaseTotal, actual: Number(m[2]), line: phaseLine};
      }
    }
  }
  if (Array.isArray(expected.taskIds) && expected.taskIds.length) {
    const mapSection = raw.split(/^##\s+Phase task map/m)[1]?.split(/^##\s+/m)[0] ?? "";
    const foundIds = [];
    for (const line of mapSection.split("\n")) {
      const m = line.match(/^\s*-\s*([^:]+):/);
      if (m) foundIds.push(m[1].trim());
    }
    if (foundIds.length !== expected.taskIds.length || !foundIds.every((id, idx) => id === expected.taskIds[idx])) {
      return {ok: false, reason: "task_ids_mismatch", expected: expected.taskIds, actual: foundIds};
    }
  }
  return {ok: true, header: headerInfo, file};
}

// Pure brief construction. Returns `{text, meta}` — never writes.
export function buildPhaseBrief(opts = {}) {
  const mission = String(opts.mission ?? "");
  const phaseName = String(opts.phaseName ?? "");
  if (!mission || !phaseName) throw new TypeError("buildPhaseBrief requires mission and phaseName");
  if (!Number.isInteger(opts.revision) || opts.revision < 1) throw new TypeError("buildPhaseBrief requires revision >= 1");
  const phaseNumber = phaseNumberOf(opts);
  const taskIds = Array.isArray(opts.taskIds) ? opts.taskIds : [];
  const tasks = Array.isArray(opts.tasks) ? opts.tasks : [];
  const mapLines = tasks.map((task, i) => {
    const id = taskIds[i] ?? task?.id ?? task?.ref ?? taskDisplayRef(task, i) ?? `task-${i}`;
    return `- ${id}: ${taskTitle(task)}`;
  });
  const digest = opts.phaseTaskDigest ?? phaseBriefDigest({...opts, phaseNumber, taskIds, tasks});

  const sections = [
    header(opts.revision, digest),
    `# Phase brief — ${phaseName}`,
    "",
    `Framework: ${opts.framework ?? "(unspecified)"}`,
    `Mission: ${mission}`,
    `Phase: ${phaseNumber}/${opts.phaseTotal ?? "?"} "${phaseName}"`,
    `Revision: ${opts.revision}`,
    "",
    "## Phase task map (titles only)",
    mapLines.length ? mapLines.join("\n") : "(no tasks)",
    "",
    "## Plan context",
    String(opts.planContext ?? "").trim() || "(none provided)",
    "",
    "## Prior-revision notes (context only — NEVER approvals)",
    String(opts.priorRevisionNotes ?? "").trim() || "(none)",
  ];
  let text = sections.join("\n");
  let truncated = false;
  if (text.length > PHASE_BRIEF_BUDGET) {
    truncated = true;
    text = `${text.slice(0, PHASE_BRIEF_BUDGET).trimEnd()}\n\nTRUNCATED: phase brief exceeded ${PHASE_BRIEF_BUDGET} chars; the tail was omitted. Every constraint essential to a task remains inline in that task's prompt.`;
  }
  return {
    text,
    meta: {phaseNumber, revision: opts.revision, digest, truncated, originalChars: sections.join("\n").length, emittedChars: text.length},
  };
}

// Concise caller-side warning; call sites must log it when meta.truncated.
export function truncationWarning(meta) {
  return `Phase brief truncated for phase ${meta.phaseNumber} revision ${meta.revision}: ${meta.originalChars} chars -> ${meta.emittedChars} chars.`;
}

// Produce/refresh the brief for a phase revision. Rewrites only when the
// on-disk revision differs or digest differs, so repeated calls within a revision are idempotent.
export function ensurePhaseBrief(opts = {}) {
  const repo = opts.repo;
  if (typeof repo !== "string" || !repo) return {ok: false, code: "PHASE_BRIEF_INVALID", reason: "repo is required", evidence: {}};
  const phaseNumber = phaseNumberOf(opts);
  const file = phaseBriefPath(repo, opts.mission, phaseNumber);
  const existing = readPhaseBriefHeader(repo, opts.mission, phaseNumber);
  const expectedDigest = opts.phaseTaskDigest ?? phaseBriefDigest({...opts, phaseNumber});
  if (existing && existing.revision === opts.revision && (!expectedDigest || existing.digest === expectedDigest)) {
    return {ok: true, written: false, path: file, revision: opts.revision, phaseNumber};
  }
  const built = buildPhaseBrief({...opts, phaseNumber, phaseTaskDigest: expectedDigest});
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, built.text, "utf8");
  fs.renameSync(tmp, file);
  return {ok: true, written: true, path: file, revision: opts.revision, phaseNumber, meta: built.meta};
}

// Atomically regenerate every phase brief from the authoritative plan.
export function regenerateAllPhaseBriefs({repo, mission, framework = "speckit", phases = [], tasksFile, tasksContent, planContext = "", priorRevisionNotes = "", revision = 1} = {}) {
  if (typeof repo !== "string" || !repo || !mission) {
    return {ok: false, reason: "repo_and_mission_required"};
  }
  const phaseList = Array.isArray(phases) ? phases : [];
  const regenerated = [];
  const briefDir = path.join(repo, `.autopilot/missions/${sanitizeKeySegment(mission)}/${PHASE_BRIEF_DIR}`);
  fs.mkdirSync(briefDir, {recursive: true});

  for (let i = 0; i < phaseList.length; i++) {
    const p = phaseList[i];
    const phaseNumber = Number.isInteger(p?.number) ? p.number : i + 1;
    const tasks = Array.isArray(p?.tasks) ? p.tasks : [];
    const taskIds = tasks.map((t, idx) => (typeof t?.ref === "string" && t.ref ? t.ref : (typeof t?.id === "string" && t.id ? t.id : taskDisplayRef(t, idx) ?? `task-${idx}`)));
    const digest = phaseBriefDigest({
      repo, repoRoot: repo, mission, framework, phaseIndex: i, phaseNumber,
      phaseName: p?.name ?? `Phase ${phaseNumber}`,
      phaseTotal: phaseList.length,
      taskIds,
      tasks,
      tasksFile,
      tasksContent,
    });
    const built = buildPhaseBrief({
      repo,
      mission,
      framework,
      phaseIndex: i,
      phaseNumber,
      phaseName: p?.name ?? `Phase ${phaseNumber}`,
      phaseTotal: phaseList.length,
      revision,
      phaseTaskDigest: digest,
      taskIds,
      tasks,
      planContext,
      priorRevisionNotes,
    });
    const target = phaseBriefPath(repo, mission, phaseNumber);
    const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, built.text, "utf8");
    fs.renameSync(tmp, target);
    regenerated.push({phaseNumber, path: target, digest});
  }

  // Clean up any stale phase briefs for phases beyond phaseList.length
  try {
    const existingFiles = fs.readdirSync(briefDir);
    for (const f of existingFiles) {
      const m = f.match(/^phase-(\d+)\.md$/);
      if (m && Number(m[1]) > phaseList.length) {
        fs.unlinkSync(path.join(briefDir, f));
      }
    }
  } catch {}

  return {ok: true, regenerated};
}

// Validate each brief against runtime plan; rebuild any stale/missing briefs.
export function validateAndReconcilePhaseBriefs({repo, mission, framework = "speckit", phases = [], tasksFile, tasksContent, planContext = "", priorRevisionNotes = "", revision = 1} = {}) {
  if (typeof repo !== "string" || !repo || !mission) {
    return {ok: false, reason: "repo_and_mission_required"};
  }
  const phaseList = Array.isArray(phases) ? phases : [];
  const rebuilt = [];
  const checked = [];
  for (let i = 0; i < phaseList.length; i++) {
    const p = phaseList[i];
    const phaseNumber = Number.isInteger(p?.number) ? p.number : i + 1;
    const tasks = Array.isArray(p?.tasks) ? p.tasks : [];
    const taskIds = tasks.map((t, idx) => (typeof t?.ref === "string" && t.ref ? t.ref : (typeof t?.id === "string" && t.id ? t.id : taskDisplayRef(t, idx) ?? `task-${idx}`)));
    const digest = phaseBriefDigest({
      repo, repoRoot: repo, mission, framework, phaseIndex: i, phaseNumber,
      phaseName: p?.name ?? `Phase ${phaseNumber}`,
      phaseTotal: phaseList.length,
      taskIds,
      tasks,
      tasksFile,
      tasksContent,
    });
    const val = validatePhaseBrief(repo, mission, phaseNumber, {
      revision,
      digest,
      phaseTotal: phaseList.length,
      taskIds,
    });
    checked.push({phaseNumber, valid: val.ok, reason: val.reason});
    if (!val.ok) {
      const built = buildPhaseBrief({
        repo,
        mission,
        framework,
        phaseIndex: i,
        phaseNumber,
        phaseName: p?.name ?? `Phase ${phaseNumber}`,
        phaseTotal: phaseList.length,
        revision,
        phaseTaskDigest: digest,
        taskIds,
        tasks,
        planContext,
        priorRevisionNotes,
      });
      const target = phaseBriefPath(repo, mission, phaseNumber);
      fs.mkdirSync(path.dirname(target), {recursive: true});
      const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
      fs.writeFileSync(tmp, built.text, "utf8");
      fs.renameSync(tmp, target);
      rebuilt.push({phaseNumber, path: target, previousReason: val.reason, digest});
    }
  }

  const briefDir = path.join(repo, `.autopilot/missions/${sanitizeKeySegment(mission)}/${PHASE_BRIEF_DIR}`);
  try {
    const existingFiles = fs.readdirSync(briefDir);
    for (const f of existingFiles) {
      const m = f.match(/^phase-(\d+)\.md$/);
      if (m && Number(m[1]) > phaseList.length) {
        fs.unlinkSync(path.join(briefDir, f));
      }
    }
  } catch {}

  return {ok: true, checked, rebuilt};
}

// Wiring entry point for `autopilot.mjs`. It is a deliberate no-op until a
// checkpoint carries `roleProgress` (i.e. per-task dispatch has started), so it
// changes nothing for phase-level runs while guaranteeing the brief exists
// before the first per-task invocation once that progress does.
export function ensurePhaseBriefForCheckpoint({repo, mission, framework, checkpoint, phase, tasks, planContext, priorRevisionNotes, tasksFile, phaseTotal} = {}) {
  if (!isPlainObject(checkpoint) || !isPlainObject(checkpoint.roleProgress)) {
    return {ok: true, written: false, skipped: "no-role-progress"};
  }
  const pTotal = phaseTotal ?? phase?.phaseTotal;
  const pNumber = checkpoint.phaseNumber ?? (checkpoint.phaseIndex != null ? checkpoint.phaseIndex + 1 : 1);
  const taskList = tasks ?? [];
  const taskIds = checkpoint.roleProgress?.taskIds ?? taskList.map((t, idx) => (t?.ref ?? (typeof t?.id === "string" ? t.id : null) ?? taskDisplayRef(t, idx) ?? `task-${idx}`));
  const digest = phaseBriefDigest({
    repo, repoRoot: repo, mission, framework,
    phaseIndex: checkpoint.phaseIndex,
    phaseNumber: pNumber,
    phaseName: phase?.name ?? checkpoint.phaseName,
    phaseTotal: pTotal,
    taskIds,
    tasks: taskList,
    tasksFile,
  });
  return ensurePhaseBrief({
    repo,
    mission,
    framework,
    phaseIndex: checkpoint.phaseIndex,
    phaseNumber: pNumber,
    phaseName: phase?.name ?? checkpoint.phaseName,
    phaseTotal: pTotal,
    revision: checkpoint.revision,
    phaseTaskDigest: digest,
    taskIds,
    tasks: taskList,
    planContext,
    priorRevisionNotes,
  });
}
