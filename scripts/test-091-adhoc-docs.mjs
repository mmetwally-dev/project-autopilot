#!/usr/bin/env node
// Mission 091 task 3.3: adhoc docs coverage.
// Accept: README.md and SKILL.md both contain the new adhoc section with
// all three command names and invocations (CLI + per-agent slash names,
// refusals, adhoc output dir).
// Run: node scripts/test-091-adhoc-docs.mjs
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

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

const skillRoot = process.cwd();
const readme = fs.readFileSync(path.join(skillRoot, "README.md"), "utf8");
const skill = fs.readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");

const COMMANDS = ["plan-review", "code-review", "verify-file"];
const INVOCATIONS = ["ap plan-review", "ap code-review", "ap verify-file"];
// Per-agent slash-command names (identical in every CLI: `/ap.<name>`).
const SLASH = [
  "/ap.plan-review", "/ap.code-review", "/ap.verify-file",
];

for (const [label, body] of [["README.md", readme], ["SKILL.md", skill]]) {
  check(`${label} has an adhoc reviews section`, () => {
    assert.ok(/adhoc reviews/i.test(body), `${label} must contain an adhoc reviews section`);
  });

  for (const cmd of COMMANDS) {
    check(`${label} names ${cmd}`, () => {
      assert.ok(body.includes(cmd), `${label} must mention ${cmd}`);
    });
  }

  for (const invocation of INVOCATIONS) {
    check(`${label} documents CLI invocation \`${invocation}\``, () => {
      assert.ok(body.includes(invocation), `${label} must document \`${invocation}\``);
    });
  }

  for (const slash of SLASH) {
    check(`${label} documents slash command \`${slash}\``, () => {
      assert.ok(body.includes(slash), `${label} must document \`${slash}\``);
    });
  }

  check(`${label} documents refusals`, () => {
    assert.ok(/refusal/i.test(body), `${label} must document refusals`);
    assert.ok(/no checkable criteria/i.test(body), `${label} must document the verify-file no-criteria refusal`);
  });

  check(`${label} documents the adhoc output dir`, () => {
    assert.ok(body.includes(".autopilot/adhoc"), `${label} must document the .autopilot/adhoc output dir`);
    assert.ok(body.includes("summary.md"), `${label} must document summary.md`);
  });
}

console.log(`\n${ran - failed}/${ran} passed`);
if (failed > 0) process.exit(1);
