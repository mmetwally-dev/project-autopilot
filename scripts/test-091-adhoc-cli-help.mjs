#!/usr/bin/env node
// Mission 091 task 2.3: CLI routing + help for
// `ap plan-review|code-review|verify-file` in bin/ap.cjs.
// Accept: all three commands route to the 2.2 runner and --help lists
// them; unknown/missing args refuse clearly.
// Run: node scripts/test-091-adhoc-cli-help.mjs
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

let failed = 0;
let ran = 0;
const check = (name, fn) => {
  ran++;
  try {
    const r = fn();
    if (r && typeof r.then === "function") return r.then(
      () => console.log(`PASS ${name}`),
      (e) => { failed++; console.log(`FAIL ${name} :: ${e?.message || String(e)}`); },
    );
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name} :: ${e?.message || String(e)}`);
  }
};

const skillRoot = process.cwd();
const apCjs = path.join(skillRoot, "bin", "ap.cjs");
const apSrc = fs.readFileSync(apCjs, "utf8");

function runAp(args, { cwd = skillRoot, timeout = 30000 } = {}) {
  const r = spawnSync(process.execPath, [apCjs, ...args], {
    cwd, encoding: "utf8", timeout, shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.ok(!r.error, `spawn failed: ${r.error?.message || r.error}`);
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

// Fixture dir under $TMPDIR (outside the repo) so routed refusals never
// touch project state.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "091-adhoc-cli-help-"));

check("ap.cjs parses (node --check)", () => {
  const r = spawnSync(process.execPath, ["--check", apCjs], { encoding: "utf8" });
  assert.equal(r.status, 0, `node --check failed: ${r.stderr || ""}`);
});

check("usage + main route all three commands to the 2.2 runner", () => {
  for (const cmd of ["plan-review", "code-review", "verify-file"]) {
    assert.ok(apSrc.includes(cmd), `bin/ap.cjs must mention ${cmd}`);
  }
  assert.ok(apSrc.includes("adhoc-runner.mjs"), "bin/ap.cjs must delegate to scripts/adhoc-runner.mjs");
  assert.ok(apSrc.includes("runAdhocCommand"), "bin/ap.cjs must call runAdhocCommand (2.2 runner)");
  const routeIdx = apSrc.indexOf("adhocRoute(command, rest)");
  assert.ok(routeIdx !== -1, "main() must route to adhocRoute(command, rest)");
  for (const cmd of ["plan-review", "code-review", "verify-file"]) {
    assert.ok(apSrc.indexOf(`'${cmd}'`) !== -1, `main() must list '${cmd}'`);
  }
});

for (const flag of ["--help", "help"]) {
  check(`ap ${flag} lists all three commands (exit 0)`, () => {
    const r = runAp([flag]);
    assert.equal(r.status, 0, `exit=${r.status} stderr=${JSON.stringify(r.stderr.slice(-300))}`);
    const combined = `${r.stdout}\n${r.stderr}`;
    for (const cmd of ["plan-review", "code-review", "verify-file"]) {
      assert.ok(combined.includes(cmd), `--help must list ${cmd}`);
    }
  });
}

for (const cmd of ["plan-review", "code-review", "verify-file"]) {
  check(`${cmd} --help prints usage (exit 0)`, () => {
    const r = runAp([cmd, "--help"], { cwd: tmpRoot });
    assert.equal(r.status, 0, `exit=${r.status} stderr=${JSON.stringify(r.stderr.slice(-300))}`);
    const combined = `${r.stdout}\n${r.stderr}`;
    assert.ok(combined.includes(cmd), `${cmd} --help must name ${cmd}`);
    assert.ok(/use:/i.test(combined), `${cmd} --help must print usage text`);
  });
}

check("all three commands route to the runner (missing-input refusals name the command, exit 2)", () => {
  const cases = [
    { cmd: "plan-review", args: [], match: /plan-review/ },
    { cmd: "code-review", args: [], match: /code-review/ },
    { cmd: "verify-file", args: [], match: /verify-file/ },
  ];
  for (const { cmd, args, match } of cases) {
    const r = runAp([cmd, ...args], { cwd: tmpRoot });
    const combined = `${r.stdout}\n${r.stderr}`;
    assert.equal(r.status, 2, `${cmd} missing input must exit 2 (got ${r.status}): ${JSON.stringify(combined.slice(-300))}`);
    assert.ok(/usage error|missing:/i.test(combined), `${cmd} refusal must be a clear usage refusal`);
    assert.ok(match.test(combined), `${cmd} refusal must name ${cmd}`);
  }
});

check("routed unknown/missing inputs refuse clearly (exit 2)", () => {
  const missing = runAp(["plan-review", path.join(tmpRoot, "no-such-plan.md")], { cwd: tmpRoot });
  assert.equal(missing.status, 2, `exit=${missing.status}`);
  assert.ok(/usage error|missing:/i.test(`${missing.stdout}\n${missing.stderr}`), "missing plan file must refuse clearly");

  const flag = runAp(["plan-review", "--bogus"], { cwd: tmpRoot });
  assert.equal(flag.status, 2, `exit=${flag.status}`);
  assert.ok(/usage error/i.test(`${flag.stdout}\n${flag.stderr}`), "unknown flag must refuse with a usage error");

  const unknown = runAp(["bogus-cmd"], { cwd: tmpRoot });
  assert.equal(unknown.status, 2, `exit=${unknown.status}`);
  assert.ok(/unknown command/i.test(`${unknown.stdout}\n${unknown.stderr}`), "unknown command must say 'Unknown command'");
});

check("no-arg invocation still prints help (exit 0)", () => {
  const r = runAp([], { cwd: tmpRoot });
  assert.equal(r.status, 0, `exit=${r.status}`);
  assert.ok(r.stdout.includes("plan-review") && r.stdout.includes("verify-file"), "bare help must list the adhoc commands");
});

fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\n${ran - failed}/${ran} passed`);
if (failed > 0) process.exit(1);
