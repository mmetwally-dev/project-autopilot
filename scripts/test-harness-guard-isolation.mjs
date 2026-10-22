#!/usr/bin/env node
// Mission 022 T3.3: a fixture orchestrator spawned by the test harness must
// not inherit an OUTER mission's git guard (PATH shim + GIT_CONFIG_* hooks),
// or every nested git call pays the shim's node start-up (~600ms) and e2e
// scenarios time out when the suite runs inside a live mission.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";

let failures = 0;
const check = (name, condition, detail) => {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`); }
};

const delimiter = process.platform === "win32" ? ";" : ":";
// Scratch lives inside the repo (gitignored .autopilot/test-scratch) so this
// mission's tests never write outside the repo. Inside a read-only execution
// envelope the repo is not writable (EROFS); fall back to os.tmpdir(), which
// the envelope points at its sanctioned scratch (TMPDIR=/workspace/scratch).
const makeScratch = (prefix) => {
  const repoScratch = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), ".autopilot", "test-scratch");
  try {
    fs.mkdirSync(repoScratch, {recursive: true});
    return fs.mkdtempSync(path.join(repoScratch, prefix));
  } catch (err) {
    if (!["EROFS", "EACCES", "EPERM"].includes(err?.code)) throw err;
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  }
};
const tmp = makeScratch("ap-guard-iso-");
try {
  const guardDir = path.join(tmp, "git-guard");
  const plainDir = path.join(tmp, "bin");
  const lookalike = path.join(tmp, "other");
  for (const d of [guardDir, plainDir, lookalike]) fs.mkdirSync(d);
  const shimName = process.platform === "win32" ? "git.cmd" : "git";
  fs.writeFileSync(path.join(guardDir, shimName), "#!/bin/sh\n# AUTOPILOT GIT GUARD — PATH shim.\n");
  fs.writeFileSync(path.join(lookalike, shimName), "#!/bin/sh\n# some other git wrapper\n");

  const env = {
    PATH: [guardDir, plainDir, lookalike].join(delimiter),
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: path.join(guardDir, "hooks"),
    GIT_CONFIG_KEY_1: "x.y", GIT_CONFIG_VALUE_1: "z",
    AUTOPILOT_GIT_GUARD_LOG: path.join(guardDir, "blocked.log"),
    AUTOPILOT_NO_GIT_MUTATIONS: "1",
    KEEP_ME: "yes",
  };
  const out = withoutOuterGitGuard(env);
  const parts = out.PATH.split(delimiter);
  check("guard shim dir removed from PATH", !parts.includes(guardDir), out.PATH);
  check("ordinary PATH dirs kept, in order", parts[0] === plainDir && parts[1] === lookalike, out.PATH);
  check("a non-guard git wrapper is NOT removed", parts.includes(lookalike), out.PATH);
  check("GIT_CONFIG_* hook injection removed",
    !("GIT_CONFIG_COUNT" in out) && !("GIT_CONFIG_KEY_0" in out) && !("GIT_CONFIG_VALUE_0" in out)
    && !("GIT_CONFIG_KEY_1" in out) && !("GIT_CONFIG_VALUE_1" in out), out);
  check("guard log / no-mutation markers removed",
    !("AUTOPILOT_GIT_GUARD_LOG" in out) && !("AUTOPILOT_NO_GIT_MUTATIONS" in out), out);
  check("unrelated variables kept", out.KEEP_ME === "yes");
  check("input env not mutated", env.PATH.split(delimiter).includes(guardDir) && env.GIT_CONFIG_COUNT === "2");
  check("no guard in env → PATH unchanged",
    withoutOuterGitGuard({PATH: [plainDir, lookalike].join(delimiter)}).PATH === [plainDir, lookalike].join(delimiter));
} finally {
  fs.rmSync(tmp, {recursive: true, force: true});
}

if (failures) { console.error(`${failures} harness guard-isolation check(s) failed.`); process.exit(1); }
console.log("harness guard-isolation tests passed");
