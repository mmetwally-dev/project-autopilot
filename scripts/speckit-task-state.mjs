// Validated SpecKit tasks.md checkbox mutation.
//
// Project Autopilot is the sole owner of task-completion checkbox state in
// SpecKit tasks.md files (see scripts/autopilot.mjs's speckit phase loop).
// Nothing else — not the Implementer, not a stale read, not a crash
// mid-attempt — may cause a task line to end up "[x]" (or stay "[x]") in
// the persisted file. This module is the only place that writes checkbox
// tokens.
//
// Read/validate/mutate use the SAME in-memory read of each file: every task
// targeting a given file is identity-checked against ONE read of that
// file's current content, and the eventual write is derived from mutating
// that same in-memory copy — never a second, later re-read that could
// silently observe different content than what was validated (TASK 14
// correction). A mismatch fails the whole call closed: no file is written
// at all, not even the other, still-valid tasks in the same call.
//
// Each individual file's write is atomic (write to a sibling temp file in
// the same directory, then rename over the target — never a partial
// write). This is per-file atomicity only: if a call touches more than one
// file and the process is killed between two files' writes, the files
// written so far are each internally consistent, but the set as a whole is
// not atomic across files. Recovering from THAT (an interrupted multi-file
// or multi-attempt operation) is scripts/autopilot.mjs's job, via its own
// persisted "pending checkbox snapshot" reconciliation on resume — this
// module intentionally makes no cross-file atomicity claim of its own.
import fs from "node:fs";
import path from "node:path";
import {stripInlineRequirements} from "./role-requirements.mjs";

const CHECKBOX_LINE_RE = /^(\s*-\s*\[)([ xX]?)(\]\s+)(.*)$/;

function normalizeForCompare(text) {
  return stripInlineRequirements(text).trim();
}

function detectEol(content) {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function loadFile(file) {
  if (!fs.existsSync(file)) return null;
  const content = fs.readFileSync(file, "utf8");
  return {eol: detectEol(content), lines: content.split(/\r\n|\n/)};
}

// Validates ONE task against an already-loaded {eol, lines} snapshot of its
// file (never re-reading disk) — same checkbox syntax, same text once
// inline requirement annotations are stripped (the checkbox mark itself is
// intentionally NOT part of the identity check, since flipping it is
// exactly what this module exists to do).
function validateAgainstLoaded(fileState, task) {
  if (!fileState) return {ok: false, reason: `file not found: ${task.file}`};
  const idx = task.line - 1;
  if (idx < 0 || idx >= fileState.lines.length) return {ok: false, reason: `line ${task.line} out of range in ${task.file}`};
  const m = fileState.lines[idx].match(CHECKBOX_LINE_RE);
  if (!m) return {ok: false, reason: `line ${task.line} in ${task.file} is no longer a task checkbox line`};
  if (normalizeForCompare(m[4]) !== normalizeForCompare(task.text)) {
    return {ok: false, reason: `line ${task.line} in ${task.file} no longer matches the expected task text`};
  }
  return {ok: true, match: m};
}

// Write-to-temp-then-rename in the SAME directory as `file`, so the rename
// is same-filesystem and atomic: a reader never observes a partially
// written file, and a crash before the rename leaves the original file
// completely untouched.
function writeFileAtomic(file, content) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.task-state-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

// Sets the checkbox mark for exactly the given tasks. Each task is
// {file, line, text, done} — `done` is that task's OWN desired state
// (true -> "[x]", false -> "[ ]"), so a single call can simultaneously
// check some tasks and uncheck others (e.g. restoring a whole feature's
// checkboxes to a mixed pre-attempt snapshot). Only the single checkbox
// character is ever replaced — indentation, the task text, any trailing
// inline "<!-- autopilot-requires: ... -->" annotation, and every other
// line in the file are byte-for-byte untouched. Each file's own
// line-ending style (CRLF vs LF) is preserved.
//
// Fails closed: every task is identity-validated against ONE in-memory
// read of its file BEFORE any file is written; if even one fails
// validation (missing file, out-of-range line, drifted text), NO file is
// written at all and {ok:false, reason, task} is returned. Already-correct
// checkboxes are left alone (idempotent — safe to call again for tasks
// already in the desired state, and safe to call twice in a row with the
// same effect).
export function applyTaskCheckboxStates(tasks) {
  if (!tasks || !tasks.length) return {ok: true, changed: []};
  const files = new Map();
  for (const task of tasks) {
    if (!files.has(task.file)) files.set(task.file, loadFile(task.file));
  }
  for (const task of tasks) {
    const v = validateAgainstLoaded(files.get(task.file), task);
    if (!v.ok) return {ok: false, reason: v.reason, task};
  }
  const changed = [];
  const touchedFiles = new Set();
  for (const task of tasks) {
    const state = files.get(task.file);
    const idx = task.line - 1;
    const m = state.lines[idx].match(CHECKBOX_LINE_RE);
    const desiredMark = task.done ? "x" : " ";
    if (m[2] === desiredMark) continue;
    state.lines[idx] = `${m[1]}${desiredMark}${m[3]}${m[4]}`;
    changed.push({file: task.file, line: task.line});
    touchedFiles.add(task.file);
  }
  for (const file of touchedFiles) {
    const state = files.get(file);
    writeFileAtomic(file, state.lines.join(state.eol));
  }
  return {ok: true, changed};
}

// Convenience wrapper over applyTaskCheckboxStates for the common case of
// setting every given task to the SAME desired state (true -> all "[x]",
// false -> all "[ ]").
export function setTaskCheckboxes(tasks, checked) {
  return applyTaskCheckboxStates((tasks || []).map(task => ({...task, done: checked})));
}
