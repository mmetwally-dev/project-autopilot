#!/usr/bin/env node
// Mission 091 task 1.4: verify-file --cmd runner/capture helper.
//
// Executes --cmd OUTSIDE role containment with a timeout, never with a cwd
// inside the repo write path, and captures stdout/exit code into the parent
// adhoc dir (.autopilot/adhoc/<timestamp>-<role>/) as verifier evidence.
// Pure capture + save only: no prompt building, no relay invocation.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runGuardedCommand } from "./guarded-command.mjs";
import { createShellGuard } from "./shell-guard.mjs";

export const ADHOC_CMD_EVIDENCE_FILENAME = "cmd-evidence.txt";
export const DEFAULT_ADHOC_CMD_TIMEOUT_MS = 30000;
export const ADHOC_CMD_STDOUT_MAX = 20000;

function fail(message) {
  return { ok: false, error: `Usage error: ${message}` };
}

// Resolved exec cwd must stay outside the repo write path (repoRoot,
// defaulting to process.cwd()). The default cwd is os.tmpdir().
export function isSafeExecCwd(cwd, repoRoot = process.cwd()) {
  const resolved = path.resolve(String(cwd ?? ""));
  const root = path.resolve(String(repoRoot ?? ""));
  if (!resolved || !root) return false;
  if (resolved === root) return false;
  return !resolved.startsWith(root + path.sep);
}

// Runs --cmd through the guarded executor (runGuardedCommand: shell-guard
// denylist/isolation, shell:false) with piped output and a timeout. The guard
// log lives in a throwaway temp dir, never in the repo.
export function defaultExecAdhocCmd(cmd, { timeoutMs, cwd } = {}) {
  const guardDir = fs.mkdtempSync(path.join(os.tmpdir(), "adhoc-cmd-guard-"));
  try {
    const shellGuard = createShellGuard(guardDir);
    const res = runGuardedCommand(cwd, cmd, process.env, shellGuard, { label: "adhoc.verify-file.cmd", pipe: true, timeoutMs });
    return {
      stdout: typeof res.stdout === "string" ? res.stdout : String(res.stdout ?? ""),
      stderr: typeof res.stderr === "string" ? res.stderr : String(res.stderr ?? ""),
      exitCode: typeof res.status === "number" ? res.status : null,
      timedOut: Boolean(res.error && res.error.code === "ETIMEDOUT"),
      signal: res.signal ?? null,
    };
  } finally {
    try { fs.rmSync(guardDir, { recursive: true, force: true }); } catch {}
  }
}

function normalizeTimeout(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_ADHOC_CMD_TIMEOUT_MS;
  return Math.floor(n);
}

// Run --cmd with a timeout outside role containment. execFn is injectable for
// tests: (cmd, { timeoutMs, cwd }) => { stdout, stderr, exitCode, timedOut }.
// Returns { ok:true, evidence } where evidence is null when no --cmd was
// supplied, else { cmd, stdout, stderr, exitCode, timedOut, truncated }.
export function runAdhocCmd(cmd, {
  timeoutMs = DEFAULT_ADHOC_CMD_TIMEOUT_MS,
  cwd = os.tmpdir(),
  execFn = defaultExecAdhocCmd,
  repoRoot = process.cwd(),
} = {}) {
  if (cmd === null || cmd === undefined || String(cmd).trim() === "") {
    return { ok: true, evidence: null };
  }
  const command = String(cmd);
  const timeout = normalizeTimeout(timeoutMs);
  const execCwd = path.resolve(String(cwd ?? os.tmpdir()));
  if (!isSafeExecCwd(execCwd, repoRoot)) {
    return fail(`--cmd cwd must be outside the repo write path (got ${execCwd}).`);
  }
  let raw;
  try {
    raw = execFn(command, { timeoutMs: timeout, cwd: execCwd });
  } catch (e) {
    return fail(`--cmd failed to start: ${e?.message || String(e)}`);
  }
  const r = raw ?? {};
  const timedOut = Boolean(r.timedOut);
  let stdout = r.stdout === undefined || r.stdout === null ? "" : String(r.stdout);
  const stderr = r.stderr === undefined || r.stderr === null ? "" : String(r.stderr);
  let truncated = false;
  if (stdout.length > ADHOC_CMD_STDOUT_MAX) {
    stdout = stdout.slice(0, ADHOC_CMD_STDOUT_MAX);
    truncated = true;
  }
  const exitCode = typeof r.exitCode === "number"
    ? r.exitCode
    : (typeof r.status === "number" ? r.status : null);
  const signal = typeof r.signal === "string" && r.signal !== "" ? r.signal : null;
  return {
    ok: true,
    evidence: {
      cmd: command,
      stdout,
      stderr,
      exitCode,
      signal,
      timedOut,
      truncated,
    },
  };
}

// Human-readable evidence file body: cmd + exit code + fenced stdout.
export function formatAdhocCmdEvidence(evidence) {
  if (!evidence) return "";
  const lines = [];
  if (evidence.cmd) lines.push(`cmd: ${evidence.cmd}`);
  if (evidence.exitCode === undefined || evidence.exitCode === null) {
    lines.push("exit_code: null");
  } else {
    lines.push(`exit_code: ${evidence.exitCode}`);
  }
  if (typeof evidence.signal === "string" && evidence.signal !== "") {
    lines.push(`signal: ${evidence.signal}`);
  }
  lines.push(`timed_out: ${Boolean(evidence.timedOut)}`);
  const out = evidence.stdout === undefined || evidence.stdout === null
    ? ""
    : String(evidence.stdout).replace(/\s+$/, "");
  if (out !== "") {
    lines.push("", "--- stdout begin ---", out, "--- stdout end ---");
  }
  if (evidence.truncated) lines.push("(stdout truncated)");
  return lines.join("\n") + "\n";
}

// Save captured evidence into the parent adhoc dir (already created). Never
// writes anywhere else; never executes anything.
export function saveAdhocCmdEvidence(parentDir, evidence) {
  const parent = String(parentDir ?? "");
  if (!parent || !path.isAbsolute(parent)) {
    return fail(`missing: parent adhoc dir must be an absolute path (got ${JSON.stringify(parent)}).`);
  }
  let stat = null;
  try {
    stat = fs.statSync(parent);
  } catch {
    return fail(`missing: parent adhoc dir not found: ${parent}`);
  }
  if (!stat.isDirectory()) {
    return fail(`unreadable: parent adhoc dir is not a directory: ${parent}`);
  }
  if (!evidence || !evidence.cmd) {
    return fail("missing: cmd evidence with a cmd string is required.");
  }
  const evidencePath = path.join(path.resolve(parent), ADHOC_CMD_EVIDENCE_FILENAME);
  if (path.dirname(evidencePath) !== path.resolve(parent)) {
    return fail("summary path escapes the parent adhoc dir; refusing.");
  }
  const body = formatAdhocCmdEvidence(evidence);
  fs.writeFileSync(evidencePath, body, "utf8");
  return { ok: true, evidencePath, body };
}

// Convenience: run --cmd then save into adhocDir (when evidence non-null).
// Returns { ok:true, evidence, evidencePath } (evidencePath null when no cmd).
export function captureAdhocCmdEvidence(cmd, {
  timeoutMs = DEFAULT_ADHOC_CMD_TIMEOUT_MS,
  cwd,
  execFn,
  repoRoot,
  adhocDir = null,
} = {}) {
  const runOpts = { timeoutMs };
  if (cwd !== undefined) runOpts.cwd = cwd;
  if (execFn !== undefined) runOpts.execFn = execFn;
  if (repoRoot !== undefined) runOpts.repoRoot = repoRoot;
  const ran = runAdhocCmd(cmd, runOpts);
  if (!ran.ok) return ran;
  if (ran.evidence === null) return { ok: true, evidence: null, evidencePath: null };
  if (adhocDir === null || adhocDir === undefined) {
    return { ok: true, evidence: ran.evidence, evidencePath: null };
  }
  const saved = saveAdhocCmdEvidence(adhocDir, ran.evidence);
  if (!saved.ok) return saved;
  return { ok: true, evidence: ran.evidence, evidencePath: saved.evidencePath, body: saved.body };
}
