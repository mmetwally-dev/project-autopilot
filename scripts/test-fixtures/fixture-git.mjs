// Fast git for building disposable practice repos in os.tmpdir().
//
// Inside a mission gate, `git` on PATH is the Autopilot git-guard shim, so
// every fixture-setup write (init, config, add, commit, tag, ...) pays the
// shim's Node start-up cost. Fixture setup is not exercising the guard, so it
// runs the real git directly (AUTOPILOT_REAL_GIT, else `git`) with the outer
// guard removed from the environment.
//
// Safety: only paths inside the real os.tmpdir() are allowed. The project
// repository itself is never a valid target, and the check happens before
// any child process is spawned.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {withoutOuterGitGuard} from "./workflow-order-harness.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REAL_TMP = fs.realpathSync(os.tmpdir());

const GLOBAL_VALUE_FLAGS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"]);
const INIT_VALUE_FLAGS = new Set(["-b", "--initial-branch", "--template", "--separate-git-dir", "--object-format", "--ref-format"]);
const CLONE_VALUE_FLAGS = new Set([
  "-b", "--branch", "-o", "--origin", "-u", "--upload-pack", "--template", "--reference",
  "-c", "--config", "--depth", "--shallow-since", "--shallow-exclude", "--separate-git-dir",
  "-j", "--jobs", "--filter"
]);

// Canonicalize as much of `target` as exists, so a symlinked parent cannot
// hide a path outside the temp tree.
function canonical(target) {
  let current = path.resolve(target);
  const missing = [];
  while (true) {
    try { return path.join(fs.realpathSync(current), ...missing.reverse()); }
    catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

function parseCommand(args, cwd) {
  let baseDir = cwd;
  let i = 0;
  while (i < args.length) {
    const token = args[i];
    if (token === "-C") {
      if (args[i + 1] !== undefined) baseDir = path.resolve(baseDir, args[i + 1]);
      i += 2;
      continue;
    }
    if (token.startsWith("-C") && token.length > 2) {
      baseDir = path.resolve(baseDir, token.slice(2));
      i += 1;
      continue;
    }
    if (GLOBAL_VALUE_FLAGS.has(token)) { i += 2; continue; }
    if (token.startsWith("--git-dir=") || token.startsWith("--work-tree=")
      || token.startsWith("--namespace=") || token.startsWith("--super-prefix=")
      || token.startsWith("--config-env=")) { i += 1; continue; }
    if (token.startsWith("-")) { i += 1; continue; }
    return {subcommand: token, rest: args.slice(i + 1), baseDir};
  }
  return {subcommand: null, rest: [], baseDir};
}

function positional(rest, valueFlags) {
  const out = [];
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (valueFlags.has(token)) { i += 1; continue; }
    if (token.startsWith("-")) continue;
    out.push(token);
  }
  return out;
}

function targetFor(args, cwd) {
  const {subcommand, rest, baseDir} = parseCommand(args, cwd);
  if (subcommand === "init") {
    const operands = positional(rest, INIT_VALUE_FLAGS);
    return operands.length ? path.resolve(baseDir, operands[0]) : baseDir;
  }
  if (subcommand === "clone") {
    const operands = positional(rest, CLONE_VALUE_FLAGS);
    return operands.length >= 2 ? path.resolve(baseDir, operands[1]) : baseDir;
  }
  return baseDir;
}

function assertFixtureTarget(args, cwd) {
  const target = canonical(targetFor(args, cwd));
  const project = canonical(PROJECT_ROOT);
  if (target === project || target.startsWith(project + path.sep)) {
    throw new Error(`fixtureGit refuses to run against the project repository: ${target}`);
  }
  if (target !== REAL_TMP && !target.startsWith(REAL_TMP + path.sep)) {
    throw new Error(`fixtureGit refuses target outside os.tmpdir() (${REAL_TMP}): ${target}`);
  }
}

let cleanEnvCache = null;
let cleanEnvHome;

export function fixtureGitEnv() {
  if (cleanEnvCache === null || cleanEnvHome !== process.env.HOME) {
    cleanEnvCache = withoutOuterGitGuard(process.env);
    cleanEnvHome = process.env.HOME;
  }
  return cleanEnvCache;
}

export function fixtureGit(args, opts = {}) {
  const {cwd = process.cwd(), env: extraEnv, ...spawnOptions} = opts;
  assertFixtureTarget(args, cwd);
  return spawnSync(process.env.AUTOPILOT_REAL_GIT || "git", args, {
    ...spawnOptions,
    cwd,
    env: {...fixtureGitEnv(), ...(extraEnv || {})},
    encoding: "utf8",
    shell: false
  });
}
