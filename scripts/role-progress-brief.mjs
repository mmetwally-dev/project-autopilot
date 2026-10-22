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
import {sanitizeKeySegment} from "./implementation-baseline.mjs";
import {taskTitle} from "./role-progress-prompt.mjs";

export const PHASE_BRIEF_BUDGET = 20000;
export const PHASE_BRIEF_DIR = "phase-briefs";

const HEADER_RE = /^<!--\s*autopilot-phase-brief\s+revision=(\d+)\s+digest=(\S+)\s*-->/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function bounded(value, max) {
  const text = String(value ?? "");
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}\n… [truncated]`;
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

// Pure brief construction. Returns `{text, meta}` — never writes.
export function buildPhaseBrief(opts = {}) {
  const mission = String(opts.mission ?? "");
  const phaseName = String(opts.phaseName ?? "");
  if (!mission || !phaseName) throw new TypeError("buildPhaseBrief requires mission and phaseName");
  if (!Number.isInteger(opts.revision) || opts.revision < 1) throw new TypeError("buildPhaseBrief requires revision >= 1");
  const phaseNumber = phaseNumberOf(opts);
  const taskIds = Array.isArray(opts.taskIds) ? opts.taskIds : [];
  const tasks = Array.isArray(opts.tasks) ? opts.tasks : [];
  const mapLines = tasks.map((task, i) => `- ${taskIds[i] ?? `task-${i}`}: ${taskTitle(task)}`);

  const sections = [
    header(opts.revision, opts.phaseTaskDigest),
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
    meta: {phaseNumber, revision: opts.revision, digest: opts.phaseTaskDigest ?? null, truncated, originalChars: sections.join("\n").length, emittedChars: text.length},
  };
}

// Concise caller-side warning; call sites must log it when meta.truncated.
export function truncationWarning(meta) {
  return `Phase brief truncated for phase ${meta.phaseNumber} revision ${meta.revision}: ${meta.originalChars} chars -> ${meta.emittedChars} chars.`;
}

// Produce/refresh the brief for a phase revision. Rewrites only when the
// on-disk revision differs, so repeated calls within a revision are idempotent.
export function ensurePhaseBrief(opts = {}) {
  const repo = opts.repo;
  if (typeof repo !== "string" || !repo) return {ok: false, code: "PHASE_BRIEF_INVALID", reason: "repo is required", evidence: {}};
  const phaseNumber = phaseNumberOf(opts);
  const file = phaseBriefPath(repo, opts.mission, phaseNumber);
  const existing = readPhaseBriefHeader(repo, opts.mission, phaseNumber);
  if (existing && existing.revision === opts.revision) {
    return {ok: true, written: false, path: file, revision: opts.revision, phaseNumber};
  }
  const built = buildPhaseBrief({...opts, phaseNumber});
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, built.text);
  return {ok: true, written: true, path: file, revision: opts.revision, phaseNumber, meta: built.meta};
}

// Wiring entry point for `autopilot.mjs`. It is a deliberate no-op until a
// checkpoint carries `roleProgress` (i.e. per-task dispatch has started), so it
// changes nothing for phase-level runs while guaranteeing the brief exists
// before the first per-task invocation once that progress does.
export function ensurePhaseBriefForCheckpoint({repo, mission, framework, checkpoint, phase, tasks, planContext, priorRevisionNotes} = {}) {
  if (!isPlainObject(checkpoint) || !isPlainObject(checkpoint.roleProgress)) {
    return {ok: true, written: false, skipped: "no-role-progress"};
  }
  return ensurePhaseBrief({
    repo,
    mission,
    framework,
    phaseIndex: checkpoint.phaseIndex,
    phaseNumber: checkpoint.phaseNumber,
    phaseName: phase?.name ?? checkpoint.phaseName,
    phaseTotal: phase?.phaseTotal,
    revision: checkpoint.revision,
    phaseTaskDigest: checkpoint.phaseTaskDigest,
    taskIds: checkpoint.roleProgress?.taskIds ?? tasks?.map((t) => t.id) ?? [],
    tasks: tasks ?? [],
    planContext,
    priorRevisionNotes,
  });
}
