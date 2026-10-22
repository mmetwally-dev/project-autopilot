#!/usr/bin/env node
// Mission 091 task 1.4: --cmd runner/capture coverage.
// Accept: --cmd output captured with stubbed exec incl. timeout, saved in the
// adhoc dir and passed as verifier evidence.
// Run: node scripts/test-091-adhoc-cmd-evidence.mjs
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ADHOC_CMD_EVIDENCE_FILENAME,
  captureAdhocCmdEvidence,
  formatAdhocCmdEvidence,
  isSafeExecCwd,
  runAdhocCmd,
  saveAdhocCmdEvidence,
} from "./adhoc-cmd-evidence.mjs";
import { buildVerifierPrompt } from "./adhoc-prompts.mjs";

let failed = 0;
let ran = 0;
const check = (name, fn) => {
  ran++;
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name} :: ${e?.message || String(e)}`);
  }
};

// Fixtures live under $TMPDIR, outside the project repo.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "091-adhoc-cmd-"));
const adhocDir = path.join(root, ".autopilot", "adhoc", "20260101T000000-verifier");
fs.mkdirSync(adhocDir, { recursive: true });

const stubOk = (cmd, { timeoutMs, cwd }) => {
  assert.ok(typeof cmd === "string" && cmd.length > 0, "exec receives cmd string");
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0, "exec receives positive timeout");
  assert.ok(typeof cwd === "string" && cwd.length > 0, "exec receives cwd");
  return { stdout: "1 passing\n", stderr: "", exitCode: 0, timedOut: false };
};

check("stubbed exec captures stdout + exit code", () => {
  const r = runAdhocCmd("npm test", { execFn: stubOk });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.evidence.cmd, "npm test");
  assert.ok(r.evidence.stdout.includes("1 passing"), "captures stdout");
  assert.equal(r.evidence.exitCode, 0);
  assert.equal(r.evidence.timedOut, false);
});

check("timeout is captured as timedOut evidence", () => {
  const stubTimeout = () => ({ stdout: "partial\n", stderr: "", exitCode: null, timedOut: true });
  const r = runAdhocCmd("sleep 30", { timeoutMs: 50, execFn: stubTimeout });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.evidence.timedOut, true);
  assert.ok(r.evidence.stdout.includes("partial"));
  const body = formatAdhocCmdEvidence(r.evidence);
  assert.ok(body.includes("timed_out: true"), "formats timeout flag");
});

check("evidence saved into the adhoc dir", () => {
  const r = runAdhocCmd("npm test", { execFn: stubOk });
  const saved = saveAdhocCmdEvidence(adhocDir, r.evidence);
  assert.equal(saved.ok, true, saved.error);
  assert.equal(saved.evidencePath, path.join(adhocDir, ADHOC_CMD_EVIDENCE_FILENAME));
  const onDisk = fs.readFileSync(saved.evidencePath, "utf8");
  assert.ok(onDisk.includes("npm test"), "file records cmd");
  assert.ok(onDisk.includes("1 passing"), "file records stdout");
  assert.ok(onDisk.includes("exit_code: 0"), "file records exit code");
});

check("capture helper runs + saves + feeds verifier evidence", () => {
  const dir2 = path.join(root, ".autopilot", "adhoc", "20260101T000001-verifier");
  fs.mkdirSync(dir2, { recursive: true });
  const cap = captureAdhocCmdEvidence("npm test", { execFn: stubOk, adhocDir: dir2 });
  assert.equal(cap.ok, true, cap.error);
  assert.ok(cap.evidence.stdout.includes("1 passing"));
  assert.ok(cap.evidencePath && fs.existsSync(cap.evidencePath), "evidence file saved");
  const v = buildVerifierPrompt({
    criteriaPath: "/tmp/CRITERIA.md",
    criteriaText: "# Acceptance\n\n- [ ] must pass tests\n",
    cmdEvidence: cap.evidence,
  });
  assert.equal(v.ok, true, v.error);
  assert.ok(v.prompt.includes("npm test") && v.prompt.includes("1 passing"), "evidence passed to verifier prompt");
});

check("exec cwd defaults outside repo; repo cwd refused", () => {
  const seen = {};
  const probe = (cmd, opts) => { seen.cwd = opts.cwd; return stubOk(cmd, opts); };
  const r = runAdhocCmd("npm test", { execFn: probe });
  assert.equal(r.ok, true, r.error);
  assert.ok(isSafeExecCwd(seen.cwd), `default cwd ${seen.cwd} must be outside repo ${process.cwd()}`);
  assert.notEqual(path.resolve(seen.cwd), path.resolve(process.cwd()));
  const refused = runAdhocCmd("npm test", { cwd: process.cwd(), execFn: stubOk });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /outside the repo/);
});

check("empty --cmd is a no-op (no exec, no file)", () => {
  let called = false;
  const never = () => { called = true; return stubOk("", {}); };
  const r = runAdhocCmd(null, { execFn: never });
  assert.equal(r.ok, true);
  assert.equal(r.evidence, null);
  assert.equal(called, false, "exec must not run without --cmd");
  assert.equal(formatAdhocCmdEvidence(null), "");
  const cap = captureAdhocCmdEvidence("", { execFn: never, adhocDir });
  assert.equal(cap.ok, true);
  assert.equal(cap.evidence, null);
  assert.equal(cap.evidencePath, null);
});

check("signal-killed cmd keeps exitCode null and records signal", () => {
  const stubKilled = () => ({ stdout: "hi\n", stderr: "", exitCode: null, timedOut: false, signal: "SIGKILL" });
  const r = runAdhocCmd("echo hi; kill -9 $$", { execFn: stubKilled });
  assert.equal(r.ok, true, r.error);
  assert.strictEqual(r.evidence.exitCode, null);
  assert.strictEqual(r.evidence.signal, "SIGKILL");
  assert.equal(r.evidence.timedOut, false);
  const body = formatAdhocCmdEvidence(r.evidence);
  assert.ok(body.includes("exit_code: null"), "renders null exit code");
  assert.ok(body.includes("SIGKILL"), "renders kill signal");
});

check("missing adhoc dir is refused (no silent write)", () => {
  const r = runAdhocCmd("npm test", { execFn: stubOk });
  const res = saveAdhocCmdEvidence(path.join(root, "no-such-dir"), r.evidence);
  assert.equal(res.ok, false);
  assert.match(res.error, /not found/);
});

console.log(`\n${ran - failed}/${ran} passed`);
if (failed > 0) process.exit(1);
