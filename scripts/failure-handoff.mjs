// Backlog #116: a relaunch after a failed implementer run (rate limit,
// provider error, idle hang, infra retry) that already did work gets the
// orchestrator hand-off note + continuation quotes in its brief. Same
// generation: no continuation allowance is consumed.
import {countTurns} from "./per-task-budget.mjs";

export const FAILURE_HANDOFF_MARKER = "<!-- ap:failure-handoff -->";

// True only when the failed run changed files or ran at least one tool turn.
export function failedRunDidWork({adapterId, touchedFiles, events} = {}) {
  if (Array.isArray(touchedFiles) && touchedFiles.length > 0) return true;
  let turns = null;
  try { turns = countTurns(adapterId, events); } catch { turns = null; }
  return Number(turns) >= 1;
}

export function stripFailureHandoff(task) {
  const text = String(task ?? "");
  const i = text.indexOf(FAILURE_HANDOFF_MARKER);
  return i < 0 ? text : text.slice(0, i).replace(/\n+$/, "");
}

// Append the note (+ quotes) to a brief; replaces an earlier appended section.
export function appendFailureHandoff(task, note, excerpts = "") {
  const base = stripFailureHandoff(task);
  const n = String(note ?? "").trim();
  if (!n) return base;
  const parts = [`${base}\n\n${FAILURE_HANDOFF_MARKER}`, `## Hand-off note from the previous session\n${n}\nTrust this note. The previous run failed (not a cap); its edits are on disk. Do not redo or re-read what it explains; continue from "Next".`];
  const q = String(excerpts ?? "").trim();
  if (q) parts.push(`## Code the hand-off note cites\nContinuation-only quotes (current file content):\n${q}`);
  return parts.join("\n\n");
}
