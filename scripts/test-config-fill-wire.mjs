#!/usr/bin/env node
// Mission 097 task 2.8: `ap config fill` routes to scripts/config-fill.mjs
// (not the setup --edit fallback) and the top-level help lists the command.
// Run: node scripts/test-config-fill-wire.mjs
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const skillRoot = process.cwd();
const apCjs = path.join(skillRoot, "bin", "ap.cjs");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-config-fill-wire-"));

function runAp(args, cwd = skillRoot) {
  const result = spawnSync(process.execPath, [apCjs, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 30000,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.ok(!result.error, `spawn failed: ${result.error && result.error.message}`);
  return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name} :: ${error && error.message ? error.message : error}`);
  }
}

try {
  check("top-level help lists `ap config fill [--dry-run] [--repo <path>]`", () => {
    const { status, stdout } = runAp(["help"]);
    assert.strictEqual(status, 0);
    assert.match(stdout, /ap config fill \[--dry-run\] \[--repo <path>\]/);
  });

  check("`config fill --help` reaches the fill script", () => {
    const { status, stdout, stderr } = runAp(["config", "fill", "--help"]);
    const output = `${stdout}\n${stderr}`;
    assert.strictEqual(status, 0, output);
    assert.match(output, /Usage: ap config fill/);
    assert.match(output, /Fill \.autopilot\/config\.json/);
    assert.doesNotMatch(output, /setup/i);
  });

  check("`config fill --dry-run --repo <tmp>` fills via the script, not setup", () => {
    const repo = path.join(tmpRoot, "repo");
    const configDir = path.join(repo, ".autopilot");
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, "config.json");
    const original = `${JSON.stringify({ schema_version: "4.0", project: { repo: "." } }, null, 2)}\n`;
    fs.writeFileSync(configPath, original);

    const { status, stdout, stderr } = runAp(["config", "fill", "--dry-run", "--repo", repo]);
    const output = `${stdout}\n${stderr}`;
    assert.strictEqual(status, 0, output);
    assert.match(stdout, /^\+ /m, `expected added key lines, got:\n${output}`);
    assert.match(stdout, /~ \$schema/, `expected a $schema repair line, got:\n${output}`);
    assert.doesNotMatch(output, /Setup wizard|setup --edit/i);
    assert.strictEqual(fs.readFileSync(configPath, "utf8"), original, "dry run must not write");
    assert.deepStrictEqual(
      fs.readdirSync(configDir).filter(name => name.startsWith("config.json.bak-")),
      [],
      "dry run must not create a backup"
    );
  });
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

if (failed > 0) {
  console.log(`\n${failed} config fill wire test(s) failed`);
  process.exitCode = 1;
} else {
  console.log("\nAll config fill wire tests passed!");
}
