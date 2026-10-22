// Backlog #91: red phase gate forces the recorded verifier verdict to FAIL.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {applyRedGateOverride, persistRedGateOverride, isRedGate} from "./verifier-red-gate-override.mjs";

const tail = "2 test file(s) failed (--keep-going):\n- scripts/test-a.mjs: exit 1 assertion x\n- scripts/test-b.mjs [1/2]: boom\n";
const red = {ok: false, command: "node scripts/test-all.mjs", results: [{command: "node scripts/test-all.mjs", ok: false, tail}]};
const green = {ok: true, command: "node scripts/test-all.mjs", results: [{command: "node scripts/test-all.mjs", ok: true}]};
const tasks = [{id: "T1.1", text: "T1.1 do a; verify: node scripts/test-a.mjs"}];

assert.equal(isRedGate(red), true);
assert.equal(isRedGate(green), false);
assert.equal(isRedGate(null), false);

// PASS + red -> FAIL with marker and gate findings, model findings kept
{
  const r = applyRedGateOverride({decision: "PASS", findings: ["model note"]}, red, tasks);
  assert.equal(r.overridden, true);
  assert.equal(r.review.decision, "FAIL");
  assert.equal(r.review.verdictOverride, "red_gate");
  assert.deepEqual(r.review.findings, ["model note"]);
  assert.ok(r.review.gateFindings.some((f) => f.startsWith("T1.1: ") && f.includes("scripts/test-a.mjs") && f.includes("exit 1 assertion x")), JSON.stringify(r.review.gateFindings));
  assert.ok(r.review.gateFindings.some((f) => f.includes("scripts/test-b.mjs") && f.includes("boom")));
}
// PASS + green / no gate -> unchanged
for (const g of [green, null, undefined, {}]) {
  const rv = {decision: "PASS", findings: ["ok"]};
  const r = applyRedGateOverride(rv, g, tasks);
  assert.equal(r.review, rv);
  assert.equal(r.overridden, false);
}
// FAIL + red -> review returned untouched
{
  const rv = {decision: "FAIL", findings: ["other"]};
  const r = applyRedGateOverride(rv, red, tasks);
  assert.equal(r.overridden, false);
  assert.equal(r.review, rv);
}
// red gate with no parsable failures -> command-level finding
{
  const r = applyRedGateOverride({decision: "PASS", findings: []}, {ok: false, command: "npm test"}, []);
  assert.equal(r.review.decision, "FAIL");
  assert.deepEqual(r.review.findings, []);
  assert.deepEqual(r.review.gateFindings, ["Phase gate FAIL: npm test"]);
}
// persistence rewrites result.json and status.json
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "red91-"));
  const run = path.join(dir, "03-verifier-abcdef12");
  fs.mkdirSync(run);
  fs.writeFileSync(path.join(run, "result.json"), JSON.stringify({review: {decision: "PASS", findings: []}, verdict: {decision: "PASS", findings: []}}));
  fs.writeFileSync(path.join(run, "status.json"), JSON.stringify({decision: "PASS"}));
  const r = applyRedGateOverride({decision: "PASS", findings: []}, red, tasks);
  assert.equal(persistRedGateOverride(dir, "abcdef12-0000", r.review), true);
  const res = JSON.parse(fs.readFileSync(path.join(run, "result.json"), "utf8"));
  assert.equal(res.review.decision, "FAIL");
  assert.equal(res.verdict.decision, "FAIL");
  assert.equal(res.verdictOverride, "red_gate");
  assert.equal(JSON.parse(fs.readFileSync(path.join(run, "status.json"), "utf8")).decision, "FAIL");
  assert.equal(persistRedGateOverride(dir, "nope", r.review), false);
  fs.rmSync(dir, {recursive: true, force: true});
}
console.log("test-verifier-red-gate-override: ok");
