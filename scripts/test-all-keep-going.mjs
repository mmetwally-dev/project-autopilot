#!/usr/bin/env node
// Keep-going runner behavior for scripts/test-all.mjs, proven on a temp
// copy of the runner + suite-schedule.mjs with fake pass/fail files only.
// No real test files are run. Every runner invocation passes --jobs 1 and
// deletes the temp timings cache first for determinism.
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

function makeFixture(fakes) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ap-keep-going-"));
  const scriptsDir = path.join(tmp, "scripts");
  fs.mkdirSync(scriptsDir, {recursive: true});
  fs.copyFileSync(path.join(repoScripts, "test-all.mjs"), path.join(scriptsDir, "test-all.mjs"));
  fs.copyFileSync(path.join(repoScripts, "suite-schedule.mjs"), path.join(scriptsDir, "suite-schedule.mjs"));
  fs.copyFileSync(path.join(repoScripts, "process-group-stop.mjs"), path.join(scriptsDir, "process-group-stop.mjs"));
  fs.copyFileSync(path.join(repoScripts, "bounded-process-tree.mjs"), path.join(scriptsDir, "bounded-process-tree.mjs"));
  fs.copyFileSync(path.join(repoScripts, "suite-live-file-guard.mjs"), path.join(scriptsDir, "suite-live-file-guard.mjs"));
  for (const [name, src] of Object.entries(fakes)) {
    fs.writeFileSync(path.join(scriptsDir, name), src);
  }
  return {tmp, scriptsDir};
}

function clearTimings(tmp) {
  fs.rmSync(path.join(tmp, "node_modules", ".cache", "ap-test-timings.json"), {force: true});
}

function runSuite(scriptsDir, tmp, args) {
  clearTimings(tmp);
  const fullArgs = [path.join(scriptsDir, "test-all.mjs"), "--jobs", "1", ...args];
  return spawnSync(process.execPath, fullArgs, {
    cwd: tmp, encoding: "utf8", shell: false, timeout: 60000,
  });
}

function combined(r) {
  return `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
}

function summaryFailLines(out) {
  return out.split(/\r?\n/).filter((line) => line.startsWith("- ") && line.includes(".mjs:"));
}

const passSrc = (marker) => `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "yes"); console.log("fake pass ran");`;
const failSrc = (marker, outLine, code) =>
  `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "yes"); console.log(${JSON.stringify(outLine)}); process.exit(${code});`;

try {
  // 1. Keep-going reports all failures + summary names each failing fake
  // with its first failing check.
  {
    const {tmp, scriptsDir} = makeFixture({
      "test-aaa-pass.mjs": passSrc(".ran-pass"),
      "test-aab-fail-one.mjs": failSrc(".ran-fail-one", "FAIL first boom", 1),
      "test-aac-fail-two.mjs": failSrc(".ran-fail-two", "AssertionError: second boom", 2),
      "test-aad-fail-quiet.mjs": failSrc(".ran-fail-quiet", "some quiet output", 1),
    });
    try {
      const r = runSuite(scriptsDir, tmp, ["--keep-going"]);
      const out = combined(r);
      check("keep-going: exit nonzero", r.status !== 0);
      check("keep-going: exits with first failing fake status (1)", r.status === 1);
      check("keep-going: all fakes ran", [".ran-pass", ".ran-fail-one", ".ran-fail-two", ".ran-fail-quiet"].every((m) => fs.existsSync(path.join(tmp, m))));
      check("keep-going: summary header", out.includes("test file(s) failed (--keep-going):"));
      check("keep-going: summary names fail-one with FAIL line", out.includes("- test-aab-fail-one.mjs: FAIL first boom"));
      check("keep-going: summary names fail-two with AssertionError line", out.includes("- test-aac-fail-two.mjs: AssertionError: second boom"));
      check("keep-going: summary falls back to TEST FAILED line", out.includes("- test-aad-fail-quiet.mjs: TEST FAILED: test-aad-fail-quiet.mjs"));
      check("keep-going: reports all three failing files", summaryFailLines(out).length === 3);
    } finally {
      fs.rmSync(tmp, {recursive: true, force: true});
    }
  }

  // 2. --max-failures stops launching new runs early (3 failing fakes,
  // --max-failures 1, --jobs 1 => exactly one failing file reported).
  {
    const {tmp, scriptsDir} = makeFixture({
      "test-aaa-fail-one.mjs": failSrc(".ran-one", "FAIL one", 1),
      "test-aab-fail-two.mjs": failSrc(".ran-two", "FAIL two", 1),
      "test-aac-fail-three.mjs": failSrc(".ran-three", "FAIL three", 1),
    });
    try {
      const r = runSuite(scriptsDir, tmp, ["--keep-going", "--max-failures", "1"]);
      const out = combined(r);
      check("max-failures: exit nonzero", r.status !== 0);
      check("max-failures: early-stop notice", out.includes("Reached --max-failures 1"));
      check("max-failures: exactly one failing file reported", summaryFailLines(out).length === 1);
      check("max-failures: later fakes did not run", !fs.existsSync(path.join(tmp, ".ran-two")) && !fs.existsSync(path.join(tmp, ".ran-three")));
    } finally {
      fs.rmSync(tmp, {recursive: true, force: true});
    }
  }

  // 2b. --max-failures=N form is accepted identically.
  {
    const {tmp, scriptsDir} = makeFixture({
      "test-aaa-fail-one.mjs": failSrc(".ran-one", "FAIL one", 1),
      "test-aab-fail-two.mjs": failSrc(".ran-two", "FAIL two", 1),
      "test-aac-fail-three.mjs": failSrc(".ran-three", "FAIL three", 1),
    });
    try {
      const r = runSuite(scriptsDir, tmp, ["--keep-going", "--max-failures=1"]);
      const out = combined(r);
      check("max-failures=: exactly one failing file reported", summaryFailLines(out).length === 1);
    } finally {
      fs.rmSync(tmp, {recursive: true, force: true});
    }
  }

  // 3. Default stays fail-fast (no --keep-going): later fakes never run,
  // no keep-going summary.
  {
    const {tmp, scriptsDir} = makeFixture({
      "test-aaa-fail-one.mjs": failSrc(".ran-one", "FAIL one", 1),
      "test-aab-fail-two.mjs": failSrc(".ran-two", "FAIL two", 1),
    });
    try {
      const r = runSuite(scriptsDir, tmp, []);
      const out = combined(r);
      check("fail-fast: exit 1", r.status === 1);
      check("fail-fast: first fake ran", fs.existsSync(path.join(tmp, ".ran-one")));
      check("fail-fast: second fake did NOT run", !fs.existsSync(path.join(tmp, ".ran-two")));
      check("fail-fast: no keep-going summary", !out.includes("test file(s) failed (--keep-going):"));
    } finally {
      fs.rmSync(tmp, {recursive: true, force: true});
    }
  }

  // 4. Invalid --max-failures exits 2.
  {
    const {tmp, scriptsDir} = makeFixture({
      "test-aaa-pass.mjs": passSrc(".ran-pass"),
    });
    try {
      for (const [label, flag] of [["zero", "0"], ["negative", "-1"], ["non-integer", "1.5"], ["nan", "abc"]]) {
        const r = runSuite(scriptsDir, tmp, ["--keep-going", "--max-failures", flag]);
        check(`invalid max-failures ${label}: exit 2`, r.status === 2);
      }
      const rEq = runSuite(scriptsDir, tmp, ["--keep-going", "--max-failures=0"]);
      check("invalid max-failures=0: exit 2", rEq.status === 2);
    } finally {
      fs.rmSync(tmp, {recursive: true, force: true});
    }
  }

  // 5. Keep-going exits with the first failing fake's exit status:
  // exactly one failing fake exiting 3 gives runner exit 3.
  {
    const {tmp, scriptsDir} = makeFixture({
      "test-aaa-pass.mjs": passSrc(".ran-pass"),
      "test-aab-fail-three.mjs": failSrc(".ran-fail", "FAIL boom three", 3),
    });
    try {
      const r = runSuite(scriptsDir, tmp, ["--keep-going"]);
      check("exit-3: runner exit 3", r.status === 3);
      check("exit-3: summary names the failing fake", combined(r).includes("- test-aab-fail-three.mjs: FAIL boom three"));
    } finally {
      fs.rmSync(tmp, {recursive: true, force: true});
    }
  }

  // 6. Keep-going exits 0 when all passed.
  {
    const {tmp, scriptsDir} = makeFixture({
      "test-aaa-pass-one.mjs": passSrc(".ran-one"),
      "test-aab-pass-two.mjs": passSrc(".ran-two"),
    });
    try {
      const r = runSuite(scriptsDir, tmp, ["--keep-going"]);
      check("all-pass: exit 0", r.status === 0);
      check("all-pass: final line", /All 2 test scripts passed in [\d.]+ min\./.test(r.stdout));
    } finally {
      fs.rmSync(tmp, {recursive: true, force: true});
    }
  }
} catch (error) {
  failures += 1;
  console.error(`ERROR ${error?.stack ?? error}`);
}

if (failures) {
  console.error(`${failures} test-all-keep-going check(s) failed.`);
  process.exit(1);
}
console.log("test-all-keep-going tests passed");
