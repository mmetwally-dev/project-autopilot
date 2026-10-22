#!/usr/bin/env node
// Backlog #3: `ap finding` routes to scripts/autopilot.mjs and is listed in help.
// Run: node scripts/test-finding-wire.mjs
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const skillRoot = process.cwd();
const apCjs = path.join(skillRoot, "bin", "ap.cjs");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-finding-wire-"));

function runAp(args, cwd = skillRoot) {
  const result = spawnSync(process.execPath, [apCjs, ...args], {
    cwd, encoding: "utf8", timeout: 30000, shell: false, stdio: ["ignore", "pipe", "pipe"],
  });
  assert.ok(!result.error, `spawn failed: ${result.error && result.error.message}`);
  return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (error) { failed++; console.log(`FAIL ${name} :: ${error && error.message ? error.message : error}`); }
}

try {
  check("help lists `ap finding list` and `ap finding drop`", () => {
    const { status, stdout } = runAp(["help"]);
    assert.strictEqual(status, 0);
    assert.match(stdout, /ap finding list \[--scope <key>\]/);
    assert.match(stdout, /ap finding drop <n>/);
  });

  check("`ap finding list` in a temp repo is routed, not Unknown command", () => {
    const repo = path.join(tmpRoot, "repo");
    fs.mkdirSync(path.join(repo, ".autopilot"), { recursive: true });
    // A config keeps ap.cjs from starting the interactive setup wizard.
    fs.writeFileSync(path.join(repo, ".autopilot", "config.json"), `${JSON.stringify({ schema_version: "4.0", project: { repo: "." } }, null, 2)}\n`);
    const { stdout, stderr } = runAp(["finding", "list", "--repo", repo], repo);
    assert.doesNotMatch(`${stdout}\n${stderr}`, /Unknown command/);
  });

  check("bin/ap.cjs dispatches finding to scripts/autopilot.mjs", () => {
    const src = fs.readFileSync(apCjs, "utf8");
    assert.match(src, /command === 'finding'\) return runScript\('scripts\/autopilot\.mjs', \['finding', \.\.\.rest\]\)/);
  });
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

if (failed > 0) { console.log(`\n${failed} finding wire test(s) failed`); process.exit(1); }
console.log("\nAll finding wire tests passed");
