// TASK-19 Phase 4 task 12 — pure per-task delta attribution helpers.
//
// The Implementer's per-task changed-file set is computed from the tree, never
// taken from the model's reply: at each task checkpoint the phase baseline's
// `scopedDeltaChunks()` result is recorded as a `path -> digest(chunk.text)`
// map, and a path is attributed to task T exactly when its chunk digest was
// added or changed between task T-1's map and task T's. No per-task baseline is
// created (`ensureBaseline()` copies file content, so one baseline per task
// would multiply that store by the task count).
//
// The later-task work-ahead check is deliberately heuristic and evidence-only:
// a path named in a LATER task's own prose that shows up in an earlier task's
// attributed set is a signal to record and feed the whole-phase review, never a
// `die()`. A prose path-name match is not strong enough to kill a phase, and a
// task may legitimately create a file a later task edits.
import {createHash} from "node:crypto";

export function chunkDigest(text) {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

export function normalizePath(value) {
  return String(value ?? "").replace(/\\/g, "/").trim().replace(/^\.\//, "");
}

// `{path: digest}` for the current tree state. Paths with an empty/blank name
// are ignored; duplicate paths keep the last chunk (scopedDeltaChunks emits one
// chunk per path).
export function attributionMap(deltaChunks) {
  const map = {};
  for (const chunk of Array.isArray(deltaChunks) ? deltaChunks : []) {
    const rel = normalizePath(chunk?.path);
    if (!rel) continue;
    map[rel] = chunkDigest(chunk?.text);
  }
  return map;
}

// Paths added or changed from `prevMap` to `nextMap`, sorted for determinism.
export function changedPaths(prevMap, nextMap) {
  const prev = prevMap && typeof prevMap === "object" ? prevMap : {};
  const next = nextMap && typeof nextMap === "object" ? nextMap : {};
  const out = [];
  for (const [rel, digest] of Object.entries(next)) {
    if (prev[rel] !== digest) out.push(rel);
  }
  return out.sort();
}

// Candidate repository-relative paths named in a task's own prose. Heuristic by
// design (see module header): a false positive costs one recorded fact.
export function pathsNamedInText(text) {
  const found = new Set();
  const source = String(text ?? "").replace(/<!--[\s\S]*?-->/g, "");
  const matches = source.matchAll(/(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+|[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,8}/g);
  for (const match of matches) {
    const rel = normalizePath(match[0]).replace(/[.,;:)]+$/, "");
    if (rel && !rel.startsWith(".")) found.add(rel);
  }
  return [...found].sort();
}

// A path attributed to an EARLIER task that a LATER task's text names. Returns
// `{paths, tasks}` (evidence only). `currentIndex` is the current task's
// position; only tasks after it are considered.
export function detectWorkAhead(attributedPaths, tasks, currentIndex) {
  const later = (Array.isArray(tasks) ? tasks : []).slice(currentIndex + 1);
  const hits = [];
  for (const path of Array.isArray(attributedPaths) ? attributedPaths : []) {
    const owners = [];
    later.forEach((task, offset) => {
      if (pathsNamedInText(task?.text).includes(path)) owners.push(currentIndex + 1 + offset);
    });
    if (owners.length) hits.push({path, laterTaskIndexes: owners});
  }
  return {paths: hits.map((h) => h.path), tasks: hits};
}
