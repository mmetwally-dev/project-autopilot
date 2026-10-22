#!/usr/bin/env node
// Backlog #37: implementers leave throw-away debug scripts in the repo.
// Pure helper: given the repository's NEW untracked files and the TASKS.md
// text, return the ones that no task names and whose path looks like scratch
// (`debug-*`, `tmp-*`, `scratch-*`, `*.tmp`, or a dot-folder like
// `.f1-tmp-*`). The orchestrator puts the result into the code-review brief
// as "unexpected new files"; nothing is deleted automatically.
//
// The caller injects the file list, so this module performs no filesystem
// access itself.

function normalize(value) {
  let text = typeof value === "string" ? value.replace(/\\/g, "/").trim() : "";
  if (!text) return "";
  return text.replace(/^\.\/+/, "");
}

function isScratchSegment(segment) {
  if (!segment) return false;
  if (/^(?:debug|tmp|scratch)-/i.test(segment)) return true;
  return /\.tmp$/i.test(segment);
}

function isScratchDotFolder(segment) {
  return /^\.[^/]*(?:debug|tmp|scratch)/i.test(segment);
}

export function looksLikeScratch(filePath) {
  const path = normalize(filePath);
  if (!path) return false;
  const segments = path.split("/").filter(Boolean);
  return segments.some((segment) => isScratchSegment(segment) || isScratchDotFolder(segment));
}

// A task "names" a file when TASKS.md contains its path or its basename
// (the planner is told to put exact paths in task lines; older plans may
// only mention a basename). Exact substring matching is deliberate: it can
// only under-report, never delete.
function taskNamesFile(tasksText, filePath) {
  const text = String(tasksText ?? "");
  if (!text) return false;
  if (text.includes(filePath)) return true;
  const base = filePath.split("/").pop();
  return Boolean(base) && text.includes(base);
}

export function findUnexpectedScratchFiles(untrackedFiles, tasksText) {
  const seen = new Set();
  const out = [];
  for (const entry of Array.isArray(untrackedFiles) ? untrackedFiles : []) {
    const filePath = normalize(entry);
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);
    if (filePath.startsWith(".autopilot/")) continue;
    if (!looksLikeScratch(filePath)) continue;
    if (taskNamesFile(tasksText, filePath)) continue;
    out.push(filePath);
  }
  return out;
}

export function unexpectedNewFilesNote(files) {
  const list = (Array.isArray(files) ? files : []).map(normalize).filter(Boolean);
  if (!list.length) return "";
  return `Unexpected new files (untracked, named by no task in TASKS.md, scratch-like — do not delete automatically, report them in your findings):\n${list.map((file) => `- ${file}`).join("\n")}`;
}
