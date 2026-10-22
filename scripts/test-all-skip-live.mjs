#!/usr/bin/env node
// --skip-live runner behavior for scripts/test-all.mjs, proven on a temp
// copy of the runner + suite-schedule.mjs with two fake test files (one
// listed in liveTests). No real test files are run.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";

let failures = 0;
function check(name, condition) {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}`); }
}

const repoScripts = path.dirname(new URL(import.meta.url).pathname);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ap-skip-live-"));
const scriptsDir = path.join(tmp, "scripts");
fs.mkdirSync(scriptsDir, {recursive: true});
fs.copyFileSync(path.join(repoScripts, "test-all.mjs"), path.join(scriptsDir, "test-all.mjs"));
fs.copyFileSync(path.join(repoScripts, "suite-schedule.mjs"), path.join(scriptsDir, "suite-schedule.mjs"));
fs.copyFileSync(path.join(repoScripts, "process-group-stop.mjs"), path.join(scriptsDir, "process-group-stop.mjs"));
fs.copyFileSync(path.join(repoScripts, "bounded-process-tree.mjs"), path.join(scriptsDir, "bounded-process-tree.mjs"));
fs.copyFileSync(path.join(repoScripts, "suite-live-file-guard.mjs"), path.join(scriptsDir, "suite-live-file-guard.mjs"));

// Each fake test drops a `.ran-*` marker in the temp root to prove it ran.
const fakeRegular = `import fs from "node:fs"; fs.writeFileSync(".ran-regular", "yes"); console.log("fake regular ran");`;
const fakeLive = `import fs from "node:fs"; fs.writeFileSync(".ran-live", "yes"); console.log("fake live ran");`;
fs.writeFileSync(path.join(scriptsDir, "test-aaa-regular.mjs"), fakeRegular);
fs.writeFileSync(path.join(scriptsDir, "test-opencode-scratch-permission.mjs"), fakeLive);

function runSuite(args, env) {
  const r = spawnSync(process.execPath, [path.join(scriptsDir, "test-all.mjs"), ...args], {
    cwd: tmp, encoding: "utf8", env: {...process.env, ...env}, shell: false, timeout: 60000,
  });
  return r;
}

try {
  // Without the flag: the live-named fake runs, no skip line, today's final
  // line format.
  {
    fs.rmSync(path.join(tmp, ".ran-regular"), {force: true});
    fs.rmSync(path.join(tmp, ".ran-live"), {force: true});
    const r = runSuite([], {});
    check("no flag: exit 0", r.status === 0);
    check("no flag: regular fake ran", fs.existsSync(path.join(tmp, ".ran-regular")));
    check("no flag: live fake ran", fs.existsSync(path.join(tmp, ".ran-live")));
    check("no flag: no skip line", !r.stdout.includes("Skipping"));
    check("no flag: final line omits skip note", /All 2 test scripts passed in [\d.]+ min\./.test(r.stdout));
  }

  // With --skip-live: the live fake does not run; skip line + new final
  // line appear.
  {
    fs.rmSync(path.join(tmp, ".ran-regular"), {force: true});
    fs.rmSync(path.join(tmp, ".ran-live"), {force: true});
    const r = runSuite(["--skip-live"], {});
    check("--skip-live: exit 0", r.status === 0);
    check("--skip-live: regular fake ran", fs.existsSync(path.join(tmp, ".ran-regular")));
    check("--skip-live: live fake did NOT run", !fs.existsSync(path.join(tmp, ".ran-live")));
    check("--skip-live: skip line printed", r.stdout.includes("Skipping 1 live test file(s) (--skip-live): test-opencode-scratch-permission.mjs"));
    check("--skip-live: final line names the skip", /All 1 test scripts passed \(1 live skipped\) in [\d.]+ min\./.test(r.stdout));
  }

  // Env-var form behaves identically.
  {
    fs.rmSync(path.join(tmp, ".ran-regular"), {force: true});
    fs.rmSync(path.join(tmp, ".ran-live"), {force: true});
    const r = runSuite([], {AP_TEST_SKIP_LIVE: "1"});
    check("AP_TEST_SKIP_LIVE=1: live fake did NOT run", !fs.existsSync(path.join(tmp, ".ran-live")));
    check("AP_TEST_SKIP_LIVE=1: final line names the skip", /All 1 test scripts passed \(1 live skipped\) in [\d.]+ min\./.test(r.stdout));
  }
} finally {
  fs.rmSync(tmp, {recursive: true, force: true});
}

if (failures) {
  console.error(`${failures} test-all-skip-live check(s) failed.`);
  process.exit(1);
}
console.log("test-all-skip-live tests passed");
