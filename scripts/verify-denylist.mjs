#!/usr/bin/env node
// Mission 038 task 1.1: importable verify-denylist gate shared by the
// standalone and GSD planning loops (SpecKit task-text scan lands in 1.3).
// Pure module — no filesystem or config side effects, safe to import from
// unit tests and from scripts/autopilot.mjs.
import {ROLE_PROGRESS_COMMAND_MAX_CHARS} from "./phase-stage-checkpoint.mjs";
import {shards} from "./suite-schedule.mjs";
import {parseInlineRequirements} from "./role-requirements.mjs";
import {normalizeRequirement, CapabilityRequirementError} from "./capability-contract.mjs";

export const FULL_SUITE_VERIFY_ENTRY = "test-all.mjs";

function normalizeList(value) {
  return (Array.isArray(value) ? value : [])
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter(Boolean);
}

// Effective denylist for a loaded config `c`: operator-configured
// `planning.verify_denylist` plus the always-forbidden full-suite runner
// (`test-all.mjs`) plus every human-configured `gates.commands` entry (the
// orchestrator's full-suite gate commands — a task must never run them).
// Deduped, order-stable: config entries first, then test-all.mjs, then gates.
export function effectiveVerifyDenylist(c) {
  const base = normalizeList(c?.planning?.verify_denylist);
  const gates = normalizeList(c?.gates?.commands);
  const out = [...base];
  for (const entry of [FULL_SUITE_VERIFY_ENTRY, ...gates]) {
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

// A matched denylist entry counts as a "full-suite" hit when it is the
// full-suite runner itself or looks like a gate shell command (gate commands
// such as "npm test" contain whitespace; operator file-name entries such as
// "test-execution-plane-safety.mjs" do not). Full-suite hits get their own
// correction text pointing at the orchestrator gate.
function isFullSuiteDenied(denied) {
  if (denied === FULL_SUITE_VERIFY_ENTRY) return true;
  if (String(denied || "").includes("test-all")) return true;
  if (/\s/.test(String(denied || ""))) return true;
  return false;
}

function fullSuiteCorrection(denied) {
  return `a task's verify must run only its linked tests — never run the full suite ("${denied}"); the orchestrator runs the full suite as a gate after code review, not as a task verify`;
}

// Clause break before a denied span resets the negation rule: a "do not" /
// "don't" / "never" only excuses a match in the same clause.
function isNegatedProse(beforeMatch) {
  const clause = String(beforeMatch || "").split(/[.;:!?]/).pop();
  return /\bdo\s+not\b|\bdon't\b|\bdo\s+n't\b|\bnever\b/i.test(clause);
}

// SpecKit tasks.md scan: SpecKit tasks carry no per-task `verify` field, so
// the gate scans each task line's full text for a forbidden command span
// (`test-all.mjs` or any `gates.commands` entry). Prose that tells the reader
// NOT to run the command ("do not run npm test") is not flagged — a match
// preceded by 'do not', "don't" or 'never' in the same clause is skipped.
// Findings cite the task by its phase heading and line text.
export function speckitTaskDenylistFindings(tasksMdText, denylist) {
  const list = normalizeList(denylist);
  if (!tasksMdText || list.length === 0) return [];
  const findings = [];
  let heading = "";
  for (const rawLine of String(tasksMdText).split(/\r?\n/)) {
    const h = rawLine.match(/^\s*#{1,6}\s+(.*\S)\s*$/);
    if (h) {
      heading = h[1].trim();
      continue;
    }
    if (!/^\s*[-*]\s*\[[ xX]\]/.test(rawLine)) continue;
    const line = rawLine.trim();
    for (const denied of list) {
      const idx = line.indexOf(denied);
      if (idx === -1) continue;
      if (isNegatedProse(line.slice(0, idx))) continue;
      const fullSuiteHit = isFullSuiteDenied(denied);
      findings.push({
        location: heading ? `tasks.md "${heading}" ${line.slice(0, 120)}` : `tasks.md ${line.slice(0, 120)}`,
        problem: `task line names the denied entry "${denied}" (${line.slice(0, 200)})`,
        correction: fullSuiteHit
          ? fullSuiteCorrection(denied)
          : "pick a verify that runs in this project's suite",
      });
    }
  }
  return findings;
}
// Mission 054 task 1.2: plan-time verify-length gate. The recorded verify is
// re-run verbatim downstream (taskLocalCheck.command is bounded to
// ROLE_PROGRESS_COMMAND_MAX_CHARS in scripts/phase-stage-checkpoint.mjs),
// so a verify longer than that bound can never execute as recorded: every
// task verify must be ONE short command naming a test file. One
// {location,problem,correction} finding per entry whose verify exceeds the
// bound; an entry without a verify is never flagged. Exactly-at-bound is
// accepted (only strictly-over is flagged).
export function verifyLengthFindings(entries) {
  const findings = [];
  for (const e of entries || []) {
    const verify = e?.verify;
    if (typeof verify !== "string" || !verify) continue;
    if (verify.length <= ROLE_PROGRESS_COMMAND_MAX_CHARS) continue;
    findings.push({
      location: `${e.file || "TASKS.md"} ${e.taskLabel}`,
      problem: `verify exceeds ${ROLE_PROGRESS_COMMAND_MAX_CHARS} characters (observed ${verify.length} characters): ${verify.slice(0, 200)}`,
      correction: "make the task verify ONE short command naming a test file (at most 500 characters); a script the task needs must live in its own test file instead of an inline command",
    });
  }
  return findings;
}

// Mission 054 task 1.2: SpecKit tasks.md length scan. SpecKit task lines
// carry no per-task `verify` field, so each checklist line is scanned for an
// inline `verify:` segment extracted the same way
// scripts/autopilot.mjs's standaloneTaskVerifyEntries() does
// (`/;\s*verify:\s*(.+?)(?:\s*<!--|$)/`, trimmed); a line without a verify
// segment is never flagged. Findings cite the task by its phase heading and
// line text, mirroring speckitTaskDenylistFindings().
export function speckitTaskVerifyLengthFindings(tasksMdText) {
  if (!tasksMdText) return [];
  const findings = [];
  let heading = "";
  for (const rawLine of String(tasksMdText).split(/\r?\n/)) {
    const h = rawLine.match(/^\s*#{1,6}\s+(.*\S)\s*$/);
    if (h) {
      heading = h[1].trim();
      continue;
    }
    if (!/^\s*[-*]\s*\[[ xX]\]/.test(rawLine)) continue;
    const line = rawLine.trim();
    const vm = line.match(/;\s*verify:\s*(.+?)(?:\s*<!--|$)/);
    if (!vm) continue;
    const verify = vm[1].trim();
    if (!verify || verify.length <= ROLE_PROGRESS_COMMAND_MAX_CHARS) continue;
    findings.push({
      location: heading ? `tasks.md "${heading}" ${line.slice(0, 120)}` : `tasks.md ${line.slice(0, 120)}`,
      problem: `verify exceeds ${ROLE_PROGRESS_COMMAND_MAX_CHARS} characters (observed ${verify.length} characters): ${verify.slice(0, 200)}`,
      correction: "make the task verify ONE short command naming a test file (at most 500 characters); a script the task needs must live in its own test file instead of an inline command",
    });
  }
  return findings;
}
// Mission 061 task 1.1: plan-time sharded-verify gate. Files listed in
// scripts/suite-schedule.mjs's `shards` run far too long bare (e.g.
// test-finding-task-locality.mjs: 20 end-to-end cases, ~31 min serially), so
// a task verify naming a sharded file must pin one shard via an AP_TEST_SHARD
// k/n assignment (`AP_TEST_SHARD=3/20`, single/double-quoted forms accepted).
// A bare mention — including a bare `AP_TEST_SHARD` mention without a k/n
// assignment — is rejected; a fast file (not in `shards`) is never flagged.
export const SHARD_ASSIGNMENT_RE = /\bAP_TEST_SHARD=(["']?)\d+\/\d+\1(?![\w\/])/;

function shardedFilesIn(text) {
  const out = [];
  for (const file of Object.keys(shards || {})) {
    if (shards[file] > 1 && String(text || "").includes(file)) out.push(file);
  }
  return out;
}

function shardCorrection(file) {
  return `a task's verify must not run the whole slow sharded file "${file}" — pin one shard with AP_TEST_SHARD=k/n (e.g. AP_TEST_SHARD=3/20 node scripts/${file}); the full file belongs to the gate, not a task verify`;
}

// Standalone loop: `entries` are {taskLabel, verify[, file]}; one finding per
// entry naming a sharded file without a shard assignment. An entry without a
// verify is never flagged.
export function verifyShardFindings(entries) {
  const findings = [];
  for (const e of entries || []) {
    const verify = e?.verify;
    if (typeof verify !== "string" || !verify) continue;
    if (SHARD_ASSIGNMENT_RE.test(verify)) continue;
    for (const file of shardedFilesIn(verify)) {
      findings.push({
        location: `${e.file || "TASKS.md"} ${e.taskLabel}`,
        problem: `verify runs the sharded file "${file}" without an AP_TEST_SHARD=k/n assignment (${verify.slice(0, 200)})`,
        correction: shardCorrection(file),
      });
    }
  }
  return findings;
}

// SpecKit loop: SpecKit task lines carry no per-task `verify` field, so the
// inline `verify:` segment is extracted the same way
// speckitTaskVerifyLengthFindings() does
// (`/;\s*verify:\s*(.+?)(?:\s*<!--|$)/`, trimmed); a line without a verify
// segment is never flagged. Only the verify text is scanned: a line that
// merely names a sharded file outside a fast verify is not flagged. A verify
// naming a sharded file without an AP_TEST_SHARD=k/n assignment is flagged.
// Findings cite the task by its phase heading and line text, mirroring
// speckitTaskDenylistFindings().
export function speckitTaskVerifyShardFindings(tasksMdText) {
  if (!tasksMdText) return [];
  const findings = [];
  let heading = "";
  for (const rawLine of String(tasksMdText).split(/\r?\n/)) {
    const h = rawLine.match(/^\s*#{1,6}\s+(.*\S)\s*$/);
    if (h) {
      heading = h[1].trim();
      continue;
    }
    if (!/^\s*[-*]\s*\[[ xX]\]/.test(rawLine)) continue;
    const line = rawLine.trim();
    const vm = line.match(/;\s*verify:\s*(.+?)(?:\s*<!--|$)/);
    if (!vm) continue;
    const verify = vm[1].trim();
    if (!verify) continue;
    if (SHARD_ASSIGNMENT_RE.test(verify)) continue;
    for (const file of shardedFilesIn(verify)) {
      findings.push({
        location: heading ? `tasks.md "${heading}" ${line.slice(0, 120)}` : `tasks.md ${line.slice(0, 120)}`,
        problem: `task line runs the sharded file "${file}" without an AP_TEST_SHARD=k/n assignment (${line.slice(0, 200)})`,
        correction: shardCorrection(file),
      });
    }
  }
  return findings;
}

// One denied-verify finding per offending task. `entries` are
// {taskLabel, verify[, file]}; substring match against every denylist entry.
// A task without a verify is never flagged. Same contract as the former
// inline `verifyDenylistFindings` in scripts/autopilot.mjs.
// Optional third arg `fullSuiteEntries` lets a caller mark extra entries as
// full-suite (full-suite correction); defaults to the test-all heuristic.
export function verifyDenylistFindings(entries, denylist, fullSuiteEntries) {
  const list = normalizeList(denylist);
  const fullSuite = fullSuiteEntries === undefined ? null : new Set(normalizeList(fullSuiteEntries));
  const findings = [];
  for (const e of entries || []) {
    for (const denied of list) {
      if (String(e.verify || "").includes(denied)) {
        const fullSuiteHit = fullSuite ? fullSuite.has(denied) : isFullSuiteDenied(denied);
        findings.push({
          location: `${e.file || "TASKS.md"} ${e.taskLabel}`,
          problem: `verify names the denied entry "${denied}" (${e.verify})`,
          correction: fullSuiteHit
            ? fullSuiteCorrection(denied)
            : "pick a verify that runs in this project's suite",
        });
      }
    }
  }
  return findings;
}

// Backlog #85: plan-time phase-size gate. The standalone planner prompt caps a
// phase at MAX_PHASE_TASKS tasks; this enforces it deterministically. Parses
// TASKS.md text with the same rules as autopilot.mjs's
// standaloneTaskVerifyEntries(): ``` / ~~~ fences ignored, one task per
// `- [ ]` / `- [x]` line. Tasks are attributed to the most recent `## ` heading
// (`## Phase N: name`); one finding per phase over the cap.
// Backlog #13: the per-phase limit counts WORK, not tasks. With small
// one-action tasks (task size wins over phase count) 10 is still cheap,
// whereas every extra phase costs a full suite gate plus reviews.
export const MAX_PHASE_TASKS = 10;

export function phaseTaskCountFindings(tasksText, max = MAX_PHASE_TASKS) {
  const findings = [];
  let phase = null;
  const flush = () => {
    if (phase && phase.count > max) {
      findings.push({
        location: `TASKS.md ${phase.label}`,
        problem: `${phase.label} has ${phase.count} tasks (maximum ${max} per phase)`,
        correction: `split this phase: at most ${max} tasks per phase — move the extra tasks into an additional phase`,
      });
    }
  };
  let inFence = false;
  for (const line of String(tasksText || "").split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const h = line.match(/^\s*##\s+(.*\S)\s*$/);
    if (h && !/^#/.test(h[1])) {
      flush();
      const pm = h[1].match(/^Phase\s+(\d+)/i);
      phase = {label: pm ? `Phase ${pm[1]}` : h[1].slice(0, 80), count: 0};
      continue;
    }
    if (phase && /^\s*-\s*\[\s*([xX ]?)\s*\]\s+(.+)$/.test(line)) phase.count++;
  }
  flush();
  return findings;
}

// Backlog #85: the planner is told not to add `autopilot-requires` annotations;
// a recognised capability is tolerated, but an UNRECOGNISED token (anything
// normalizeRequirement() rejects, after dropping an optional `role:` scope)
// would fail the mission at verification, so flag it at plan time. Fences
// ignored like the other standalone TASKS.md scans.
export function unrecognizedAnnotationFindings(tasksText) {
  const findings = [];
  let inFence = false;
  const lines = String(tasksText || "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = line.match(/^\s*-\s*\[\s*([xX ]?)\s*\]\s+(.+)$/);
    if (!m) continue;
    const idm = m[2].match(/\*\*(\d+\.\d+)\*\*/);
    const label = idm ? idm[1] : `line ${i + 1}`;
    for (const raw of parseInlineRequirements(m[2])) {
      const sep = raw.indexOf(":");
      const token = sep > 0 && /^(planner|plan_reviewer|implementer|code_reviewer|verifier)$/.test(raw.slice(0, sep)) ? raw.slice(sep + 1) : raw;
      try { normalizeRequirement(token); } catch (err) {
        if (!(err instanceof CapabilityRequirementError)) throw err;
        findings.push({
          location: `TASKS.md ${label}`,
          problem: `autopilot-requires annotation '${raw}' is not a capability Project Autopilot recognises`,
          correction: "remove the autopilot-requires annotation from this task — capability needs are detected from the accept/verify text, and an unrecognized annotation fails the mission at verification",
        });
      }
    }
  }
  return findings;
}
