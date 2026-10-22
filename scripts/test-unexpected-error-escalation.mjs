#!/usr/bin/env node
// Backlog #98: an unexpected exception (Unsupported Git topology from an extra
// worktree) must end in a clean `unexpected_error` escalation, not a bare crash.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { makeFixtureRepo, makeFixtureBin, writeConfig, setScenario, runAutopilot, withoutOuterGitGuard, skillRoot, cleanup } from "./test-fixtures/workflow-order-harness.mjs";

const assert = (c, m) => { if (!c) throw new Error(m); };
const git = (cwd, args) => spawnSync("git", args, { cwd, encoding: "utf8" });

const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), "ap-emptybin-"));
function runWith(repoDir, cmd, args = []) {
  const base = withoutOuterGitGuard(process.env);
  return spawnSync(process.execPath, [path.join(skillRoot, "scripts", "autopilot.mjs"), cmd, ...args, "--repo", repoDir], {
    cwd: repoDir, encoding: "utf8", timeout: 50000, env: { ...base, PATH: `${emptyBin}${path.delimiter}${base.PATH || ""}` }
  });
}
// Preflight failure (missing CLI) must not touch state: completed mission, fresh repo, live non-owned mission.
{
  const r1 = makeFixtureRepo("unexpected-pre"); const b1 = makeFixtureBin("unexpected-pre");
  try {
    writeConfig(r1, { planningFramework: "standalone", gatesCommands: ["true"] });
    fs.rmSync(path.join(b1, "cursor-agent"), { force: true });
    fs.rmSync(path.join(b1, "cursor-agent.cmd"), { force: true });
    const sp = path.join(r1, ".autopilot", "state.json");
    fs.rmSync(sp, { force: true });
    const fresh = runWith(r1, "run", ["x"]);
    assert(fresh.status !== 0, "fresh preflight failure should exit non-zero");
    assert(!fs.existsSync(sp), "fresh repo: state.json must not be created");
    for (const phase of ["complete", "implementing"]) {
      fs.mkdirSync(path.dirname(sp), { recursive: true });
      fs.writeFileSync(sp, JSON.stringify({ phase, step: "x", mission: "m1" }, null, 2));
      const before = fs.readFileSync(sp);
      for (const [cmd, a] of [["run", ["x"]], ["plan", []], ["review", []]]) {
        const r = runWith(r1, cmd, a);
        assert(r.status !== 0, `${cmd} should exit non-zero`);
        assert(Buffer.compare(before, fs.readFileSync(sp)) === 0, `${cmd} on ${phase} state must leave state.json byte-equal`);
      }
    }
    console.log("  preflight failures leave state untouched");
  } finally { cleanup(r1, b1); }
}
// relayAsync fatal errors are tagged and recorded as ORCHESTRATOR_FATAL (source anchors).
{
  const src = fs.readFileSync(path.join(skillRoot, "scripts", "autopilot.mjs"), "utf8");
  assert(/function orchestratorFatal\(message\)\{[^}]*autopilotFatal=true/.test(src), "orchestratorFatal must tag errors");
  assert((src.match(/fatal:orchestratorFatal/g) || []).length >= 2, "relayAsync paths must use orchestratorFatal");
  assert(/ORCHESTRATOR_FATAL/.test(src) && /ownsMission/.test(src), "handler must classify fatals and gate on ownsMission");
  console.log("  relayAsync fatal tagging anchored");
}
const repo = makeFixtureRepo("unexpected-err");
const binDir = makeFixtureBin("unexpected-err");
const wt = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ap-wt-")), "extra");
try {
  writeConfig(repo, { planningFramework: "standalone", gatesCommands: ["true"] });
  setScenario(repo, "standalone_basic");
  const add = git(repo, ["worktree", "add", "-q", "-b", "extra-wt", wt]);
  assert(add.status === 0, `worktree add failed: ${add.stderr}`);

  const run = runAutopilot(repo, binDir, { request: "implement the fixture task", timeoutMs: 50000 });
  const out = run.stdout + run.stderr;
  assert(run.status !== 0 && !run.timedOut, `expected non-zero exit, got ${run.status}`);
  assert(/unexpected error/i.test(out) && /git worktree/.test(out), `message should name the unexpected error and git worktree:\n${out}`);
  assert(/ap run/.test(out), "resume hint missing");
  const state = JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
  assert(state.phase === "escalated" && state.step === "unexpected_error", `state: ${state.phase}/${state.step}`);
  assert(state.lastFailure?.class === "UNEXPECTED_ERROR" && /git worktree/.test(state.lastFailure.message), "lastFailure not recorded");
  assert(typeof state.lastFailure.location === "string", "first stack frame missing");
  // Any run directory must not be left `running`.
  const stack = (function walk(d) { return fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : e.name === "status.json" ? [path.join(d, e.name)] : []); })(path.join(repo, ".autopilot"));
  for (const f of stack) {
    const st = JSON.parse(fs.readFileSync(f, "utf8"));
    assert(String(st.status).toLowerCase() !== "running", `${f} still running`);
  }
  console.log(`  escalated; ${stack.length} status file(s) finalized`);

  git(repo, ["worktree", "remove", "--force", wt]);
  const base = withoutOuterGitGuard(process.env);
  const resume = spawnSync(process.execPath, [path.join(skillRoot, "scripts", "autopilot.mjs"), "run", "implement the fixture task", "--repo", repo], {
    cwd: repo, encoding: "utf8", timeout: 50000, env: { ...base, PATH: `${binDir}${path.delimiter}${base.PATH || ""}` }
  });
  const after = JSON.parse(fs.readFileSync(path.join(repo, ".autopilot", "state.json"), "utf8"));
  assert(!(after.phase === "escalated" && after.step === "unexpected_error"), `resume stayed escalated:\n${resume.stdout}${resume.stderr}`);
  console.log(`  resume exit ${resume.status}, phase ${after.phase}`);
  console.log("PASS");
} finally { cleanup(repo, binDir, emptyBin); try { fs.rmSync(path.dirname(wt), { recursive: true, force: true }); } catch {} }
