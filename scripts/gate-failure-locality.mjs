#!/usr/bin/env node
// Mission 073 Phase 1 task 1.1 — gate-failure locality: are the red gate's
// failing test files inside or outside this phase's delta?
//
// A red standalone verifier gate today always dispatches an implementer fix
// round, even when every failing test file is unrelated to the phase (a
// stale/broken test elsewhere in the repo). These pure helpers let the
// STANDALONE verifier-stage FAIL fallthrough escalate once instead, and only
// when every failing file is provably outside the phase delta.
//
// Pure module: no filesystem, process, or state-file access, no imports, no
// exit hooks. The caller (scripts/autopilot.mjs) reads the gate log files
// and the phase delta, then passes plain values in.

// Repository-relative comparison form: forward slashes, no trailing `:line` /
// `:line:col`, no leading `./` or `/`. Applied to BOTH sides of the match,
// so `scripts\a.mjs:12:4` still equals the `scripts/a.js` delta entry.
function comparablePath(value) {
  let text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!text) return "";
  text = text.replace(/\\/g, "/");
  text = text.replace(/:\d+(:\d+)?$/, "");
  text = text.replace(/^\.\/+/, "").replace(/^\/+/, "");
  return text;
}

function basenameOf(normalized) {
  const at = normalized.lastIndexOf("/");
  return at < 0 ? normalized : normalized.slice(at + 1);
}

// Basename/relative-path tolerant membership: a failing file counts as
// inside the delta when its normalized form equals a delta entry, when both
// basenames are equal and non-empty, or when one normalized form is a
// path-suffix of the other (covers `a.js` vs `scripts/a.js` either way).
function inDelta(failing, deltaSet) {
  const norm = comparablePath(failing);
  if (!norm) return false;
  if (deltaSet.has(norm)) return true;
  const base = basenameOf(norm);
  for (const entry of deltaSet) {
    if (!entry) continue;
    if (basenameOf(entry) === base && base) return true;
    if (norm.length < entry.length && entry.endsWith(`/${norm}`)) return true;
    if (entry.length < norm.length && norm.endsWith(`/${entry}`)) return true;
  }
  return false;
}

// Partition failing gate files into inside/outside the phase delta.
// `failingFiles`: file names (strings); `phaseDeltaFiles`: phase delta paths
// PLUS task-linked test files (the caller unions them — a test named by a
// phase task counts as inside, never as escalation evidence).
// `allOutsideDelta` is true only when there is at least one failing file,
// every failing file is outside the delta, and the log is NOT truncated
// (a `--max-failures` stop hides failures, so locality is unprovable).
// Empty failingFiles yields false: no locality information means "retry",
// never "escalate".
export function classifyGateFailures({failingFiles, phaseDeltaFiles, truncated, testSources, failureText} = {}) {
  const failing = (Array.isArray(failingFiles) ? failingFiles : [])
    .filter((f) => typeof f === "string" && comparablePath(f));
  const delta = new Set(
    (Array.isArray(phaseDeltaFiles) ? phaseDeltaFiles : [])
      .map(comparablePath)
      .filter(Boolean),
  );
  const sources = testSources && typeof testSources === "object" ? testSources : {};
  const outside = [];
  const inside = [];
  const related = [];
  for (const file of failing) {
    if (inDelta(file, delta)) { inside.push(file); continue; }
    const key = comparablePath(file);
    const byRef = sourceReferencesDelta(sources[file] ?? sources[key], delta);
    const byOutput = failureTextNamesDelta(failureText, delta);
    if (byRef || byOutput) {
      inside.push(file);
      related.push({file, reason: byRef ? `test source references ${byRef}` : `failure output names ${byOutput}`});
      continue;
    }
    outside.push(file);
  }
  const allOutsideDelta = failing.length > 0 && inside.length === 0 && truncated !== true;
  return {allOutsideDelta, outside, inside, related};
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// (a) A failing test whose SOURCE TEXT mentions a delta file by relative path
// or basename (path-boundary anchored), or scans the delta file's directory
// (readdir/glob next to a quoted directory name), is phase-related even when
// the phase never touched the test file. Returns the matched delta entry.
function sourceReferencesDelta(sourceText, deltaSet) {
  const text = typeof sourceText === "string" ? sourceText : "";
  if (!text) return "";
  const scansDirs = /readdir|glob|walk|opendir/i.test(text);
  for (const entry of deltaSet) {
    const base = basenameOf(entry);
    if (!base) continue;
    if (new RegExp(`(?<![\\w.-])${escapeRegExp(entry)}(?![\\w-])`).test(text)) return entry;
    if (new RegExp(`(?<![\\w-])${escapeRegExp(base)}(?![\\w-])`).test(text)) return entry;
    if (scansDirs) {
      const dir = entry.includes("/") ? entry.slice(0, entry.lastIndexOf("/")) : "";
      const dirName = dir ? basenameOf(dir) : "";
      if (dirName && new RegExp(`["'\`/]${escapeRegExp(dirName)}["'\`/]`).test(text)) return entry;
    }
  }
  return "";
}

// (b) The failure output itself names a delta file by repo-relative path
// (e.g. `scripts/adhoc-cmd-evidence.mjs:1298`). Full relative path only, so a
// bare common basename in unrelated output cannot match.
function failureTextNamesDelta(failureText, deltaSet) {
  const text = typeof failureText === "string" ? failureText.replace(/\\/g, "/") : "";
  if (!text) return "";
  for (const entry of deltaSet) {
    if (!entry.includes("/")) continue;
    if (new RegExp(`(?<![\\w.-])${escapeRegExp(entry)}(?![\\w-])`).test(text)) return entry;
  }
  return "";
}

// Parse a gate log into failing files plus their first failing check.
// Primary: `--keep-going` summary lines `- <name>: <firstCheck>` (see
// scripts/test-all.mjs), with any trailing ` [k/n]` shard suffix stripped
// from the name. Summary lines are ONLY read after the last
// `N test file(s) failed (--keep-going):` header line: failing tests' own
// output (e.g. a Node assertion diff `- a: 2`) can contain identical
// `- key: value` shapes, and mistaking them for summary entries both invents
// bogus files and suppresses the TEST FAILED fallback. Fallback (no header,
// or no summary lines under it): `TEST FAILED: ...` lines, with the whole
// trimmed line as firstCheck. `truncated` is true when the
// `Reached --max-failures` early-stop line is present.
export function parseGateFailures(logText) {
  const text = typeof logText === "string" ? logText : "";
  const truncated = /Reached --max-failures/.test(text);
  const failures = [];
  const seen = new Set();
  const push = (file, firstCheck) => {
    const norm = comparablePath(file);
    if (!norm || seen.has(norm)) return;
    seen.add(norm);
    failures.push({file: norm, firstCheck: typeof firstCheck === "string" ? firstCheck : ""});
  };
  const lines = text.split(/\r?\n/);
  let summaryStart = -1;
  lines.forEach((rawLine, index) => {
    if (/test file\(s\) failed \(--keep-going\):/.test(rawLine)) summaryStart = index + 1;
  });
  if (summaryStart >= 0) {
    for (const rawLine of lines.slice(summaryStart)) {
      const line = rawLine.trim();
      const summary = /^-\s+(.+?):\s+(.+?)\s*$/.exec(line);
      if (summary) {
        const name = summary[1].trim().replace(/\s*\[\d+\/\d+\]\s*$/, "").trim();
        const check = summary[2].trim();
        if (name && check) push(name, check);
      }
    }
  }
  if (failures.length === 0) {
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      const failed = /^TEST FAILED:\s*(\S+)/.exec(line);
      if (failed) push(failed[1].replace(/\s*\[\d+\/\d+\]\s*$/, ""), line);
    }
  }
  return {failures, truncated};
}

// Test files a phase's tasks name, in task order, deduplicated. Reads each
// task's `text` (which carries the `; verify: <cmd>` segment) and its
// `verify` field when present. Phase tasks ONLY — the caller passes
// phaseTasks, never gate commands, so gate files can never count as inside.
const TEST_FILE_REF = /(?<![\w/.-])((?:[\w.-]+\/)*[\w.-]+\.(?:mjs|cjs|js|ts))\b/g;
export function taskLinkedTestFiles(phaseTasks) {
  const out = [];
  const seen = new Set();
  for (const task of Array.isArray(phaseTasks) ? phaseTasks : []) {
    if (!task || typeof task !== "object" || Array.isArray(task)) continue;
    const sources = [];
    if (typeof task.text === "string" && task.text) sources.push(task.text);
    if (typeof task.verify === "string" && task.verify) sources.push(task.verify);
    for (const source of sources) {
      TEST_FILE_REF.lastIndex = 0;
      let match;
      while ((match = TEST_FILE_REF.exec(source)) !== null) {
        const norm = comparablePath(match[1]);
        if (!norm || seen.has(norm)) continue;
        seen.add(norm);
        out.push(norm);
      }
    }
  }
  return out;
}

// Escalation message for an all-outside-delta red gate: every outside file
// with its first failing check, the stale-test hint, and the `ap run`
// resume line. `failures` is parseGateFailures().failures (or the
// `outside` subset re-paired with checks); `phaseName`/`mission` label the
// message only.
export function formatGateFailureEscalation({failures, phaseName, mission} = {}) {
  const list = (Array.isArray(failures) ? failures : [])
    .filter((f) => f && typeof f === "object" && comparablePath(f.file));
  const lines = list.map((f) => {
    const check = typeof f.firstCheck === "string" && f.firstCheck.trim()
      ? f.firstCheck.trim()
      : "(no failing check captured)";
    return `- ${comparablePath(f.file)}: ${check}`;
  });
  const label = typeof phaseName === "string" && phaseName.trim() ? phaseName.trim() : "this phase";
  const missionNote = typeof mission === "string" && mission.trim() ? ` (mission ${mission.trim()})` : "";
  return [
    `Standalone gate failures are all outside the ${label} delta${missionNote} — escalating instead of dispatching an implementer fix round. STOP — human intervention required.`,
    `Failing files (${lines.length}), none touched by the phase:`,
    ...lines,
    "These look like stale or broken tests unrelated to the phase: re-run them on the clean baseline before changing phase code.",
    "To resume after fixing or skipping them: ap run",
  ].join("\n");
}
