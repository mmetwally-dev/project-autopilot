// Backlog #215 — prove gate locality against the PHASE BASELINE before
// escalating "all gate failures outside the delta".
//
// The static (text/import) scan in gate-failure-locality.mjs is the fast
// path, but a test can reach phase-changed code by spawning `bin/ap.cjs` or
// `scripts/setup.mjs` (or by importing deeper than the scan's maxDepth). Such
// a test FAILS with the phase changes and PASSES on the phase-start tree.
//
// This module re-runs each failing test file once on a clean copy of the
// phase baseline: HEAD materialized with `git archive`, with the captured
// `.autopilot/baseline/<key>/files` copies overlaid (files, symlinks, and
// "absent at baseline" removals). The copy lives under the repository's own
// `.autopilot/scratch` tree (never /tmp) and is removed afterwards.
//
// Bounded and fail-open: at most five files, each with its measured or the
// 10-minute default timeout. Any error while preparing or running the check
// returns outcome "error"; the caller must then fall through to the normal
// implementer fix round (fixing is safe; a false escalation is not).
//
// The filesystem/process seams are injectable (materialize/runTest/makeId),
// so the decision logic is unit-testable without a git repository.

import fs from "node:fs";
import path from "node:path";
import {spawn, spawnSync} from "node:child_process";
import {randomUUID} from "node:crypto";

import {runBoundedInheritedProcess} from "./bounded-process-tree.mjs";

export const GATE_BASELINE_MAX_FILES = 5;
export const GATE_BASELINE_TIMEOUT_MS = 10 * 60 * 1000;

function isInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, {shell: false, encoding: "utf8", ...options});
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return result;
}

// Copy `src` over `target`, creating parent directories.
function copyOver(src, target) {
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.rmSync(target, {recursive: true, force: true});
  fs.copyFileSync(src, target);
}

// Overlay the captured baseline entries onto the extracted HEAD tree.
function overlayBaseline({repo, baselineKey, dest}) {
  const dir = path.join(repo, ".autopilot", "baseline", baselineKey);
  const manifestFile = path.join(dir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const entries = manifest?.entries && typeof manifest.entries === "object" ? manifest.entries : {};
  for (const [rel, entry] of Object.entries(entries)) {
    if (!entry || typeof entry !== "object") throw new Error(`baseline entry for ${rel} is not an object`);
    const target = path.resolve(dest, rel);
    if (!isInside(dest, target) || target === path.resolve(dest)) {
      throw new Error(`baseline entry escapes the scratch copy: ${rel}`);
    }
    if (entry.type === "absent") {
      fs.rmSync(target, {recursive: true, force: true});
      continue;
    }
    if (entry.type === "file") {
      const source = path.join(dir, "files", rel);
      if (!fs.existsSync(source)) throw new Error(`baseline copy is missing for ${rel}`);
      copyOver(source, target);
      continue;
    }
    if (entry.type === "symlink") {
      fs.rmSync(target, {recursive: true, force: true});
      fs.mkdirSync(path.dirname(target), {recursive: true});
      fs.symlinkSync(String(entry.target ?? ""), target);
      continue;
    }
    throw new Error(`unsupported baseline entry type for ${rel}: ${entry.type}`);
  }
}

// Make the repository's installed dependencies resolvable from the copy
// without copying them. Best effort: a test that does not need them is
// unaffected, and a failure to link is not itself a locality error.
function linkNodeModules(repo, dest) {
  const source = path.join(repo, "node_modules");
  const target = path.join(dest, "node_modules");
  if (!fs.existsSync(source) || fs.existsSync(target)) return;
  try {
    fs.symlinkSync(fs.realpathSync(source), target, process.platform === "win32" ? "junction" : "dir");
  } catch {
    // no dependencies in the copy; runTest reports the real result
  }
}

// Materialize the phase-start tree (HEAD + baseline copies) in `dest`.
export function materializePhaseBaseline({repo, baselineKey, dest}) {
  const parent = path.dirname(dest);
  const tarFile = path.join(parent, `.gate-baseline-${randomUUID()}.tar`);
  try {
    runSync("git", ["archive", "--format=tar", `--output=${tarFile}`, "HEAD"], {cwd: repo});
    runSync("tar", ["-xf", tarFile, "-C", dest], {cwd: repo});
  } finally {
    try { fs.rmSync(tarFile, {force: true}); } catch {}
  }
  overlayBaseline({repo, baselineKey, dest});
  linkNodeModules(repo, dest);
}

// Run one test file in the baseline copy. Injection point for tests.
export function runBaselineTest({cwd, file, timeoutMs, spawnFn = spawn, runFn = runBoundedInheritedProcess}) {
  return runFn(
    spawnFn,
    process.execPath,
    [file],
    {
      cwd,
      env: {...process.env, AP_TEST_TIMEOUT_FACTOR: process.env.AP_TEST_TIMEOUT_FACTOR || "1"},
      deadlineMs: timeoutMs,
      stdio: "ignore",
    },
  ).then((result) => ({
    passed: result?.status === 0 && !result?.timedOut && !result?.terminationFailed && !result?.error,
    timedOut: result?.timedOut === true,
    status: result?.status ?? null,
    error: result?.error ?? null,
  }));
}

function positiveTimeout(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

/**
 * Re-run failing gate files on a clean copy of the phase baseline.
 *
 * Returns one of:
 *   {outcome: "pass", passingFile, attempts}
 *   {outcome: "all-fail", attempts}
 *   {outcome: "error", error, attempts}
 *
 * `pass` means the file passes on the phase-start tree, so the failure is the
 * phase's regression and needs the normal fix round. Only `all-fail` is
 * evidence for escalation. Any error is fail-open (`error`).
 *
 * @param {object} options
 * @param {string} options.repo repository root
 * @param {string} options.baselineKey phase baseline key
 * @param {Array<{file: string}>} options.failures parsed gate failures
 * @param {number} [options.maxFiles] bound (default 5)
 * @param {(failure: object) => number} [options.timeoutFor] measured timeout
 * @param {string} [options.scratchRoot] default <repo>/.autopilot/scratch
 * @param {Function} [options.materialize] injection point
 * @param {Function} [options.runTest] injection point
 * @param {Function} [options.makeId] injection point
 */
export async function checkGateBaseline({
  repo,
  baselineKey,
  failures,
  maxFiles = GATE_BASELINE_MAX_FILES,
  timeoutFor = () => GATE_BASELINE_TIMEOUT_MS,
  scratchRoot = null,
  materialize = materializePhaseBaseline,
  runTest = runBaselineTest,
  makeId = () => randomUUID(),
} = {}) {
  if (typeof repo !== "string" || !repo || typeof baselineKey !== "string" || !baselineKey) {
    return {outcome: "error", error: "missing repo or phase baseline key", attempts: []};
  }
  const files = (Array.isArray(failures) ? failures : [])
    .map((failure) => failure && typeof failure.file === "string" ? failure.file : "")
    .filter(Boolean)
    .slice(0, Math.max(1, Number.isInteger(maxFiles) ? maxFiles : GATE_BASELINE_MAX_FILES));
  if (!files.length) {
    return {outcome: "error", error: "no failing files to check", attempts: []};
  }

  const base = scratchRoot || path.join(repo, ".autopilot", "scratch");
  const attempts = [];
  for (const file of files) {
    let dest = null;
    try {
      fs.mkdirSync(base, {recursive: true});
      dest = path.join(base, `gate-baseline-${makeId()}`);
      fs.mkdirSync(dest, {recursive: true});
      await materialize({repo, baselineKey, dest});
      const timeoutMs = positiveTimeout(timeoutFor({file}), GATE_BASELINE_TIMEOUT_MS);
      const result = await runTest({cwd: dest, file, timeoutMs});
      const passed = result === true || result?.passed === true;
      attempts.push({file, passed, timeoutMs});
      if (passed) return {outcome: "pass", passingFile: file, attempts};
    } catch (error) {
      attempts.push({file, passed: null, error: String(error?.message ?? error)});
      return {outcome: "error", error: String(error?.message ?? error), attempts};
    } finally {
      if (dest) {
        try { fs.rmSync(dest, {recursive: true, force: true}); } catch {}
      }
    }
  }
  return {outcome: "all-fail", attempts};
}
