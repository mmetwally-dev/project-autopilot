#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {buildTaskPrompt} from "./role-progress-prompt.mjs";
import {emptyRoleProgress} from "./phase-stage-checkpoint.mjs";
import {buildOrchestratorFallbackNote} from "./per-task-budget.mjs";
import { changedFilesStat } from "./changed-files-stat.mjs";
import {spawnRelayChild} from "./subprocess-relay.mjs";
import {appendOrchestratorExitEvent} from "./autopilot.mjs";
import {runDetached} from "../bin/ap.cjs";
import {withoutOuterGitGuard} from "./test-fixtures/workflow-order-harness.mjs";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ap-f2b-"));
process.on("exit", () => {
  try { fs.rmSync(scratch, {recursive:true, force:true}); } catch {}
});

let ok = 0, failed = 0;
function check(name, cond, ev) {
  if (cond) { console.log("PASS " + name); ok += 1; }
  else { console.error("FAIL " + name + (ev !== undefined ? " :: " + JSON.stringify(ev) : "")); failed += 1; }
}

// Scratch-repo git commands must never inherit an outer mission's repo
// selection or guard (GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE/GIT_CONFIG_*,
// PATH shim) and must not discover any repository above the scratch dir.
function scratchGitEnv() {
  const env = withoutOuterGitGuard(process.env);
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  env.GIT_CEILING_DIRECTORIES = path.dirname(scratch);
  return env;
}

// 1. free vs paid
function makeBrief(extra) {
  const taskIds = ["t0", "t1"];
  const tasks = [{id: taskIds[0], text: "Build widget", file: "a.mjs", line: 1}, {id: taskIds[1], text: "Ship", file: "b.mjs", line: 2}];
  const progress = emptyRoleProgress();
  progress.implementer.status = "running";
  progress.implementer.completedTaskIds = [];
  progress.implementer.taskCursor = 0;
  return buildTaskPrompt({
    framework: "standalone", mission: "m", phaseIndex: 0, phaseNumber: 1, phaseName: "P", phaseTotal: 1,
    revision: 1, role: "implementer", phaseTaskDigest: "sha256:" + "d".repeat(64),
    taskIds, tasks, currentTaskId: taskIds[0], roleProgress: progress, phaseBriefPath: null, ...extra
  });
}
{
  const free = makeBrief({handoffPerTaskMaxTurns: 45});
  const paid = makeBrief({handoffPerTaskMaxTurns: 40});
  const freeText = free.ok ? free.text : "";
  const paidText = paid.ok ? paid.text : "";
  check("free model -> of 45", freeText.includes("of 45"), freeText.slice(0,120));
  check("paid model -> of 40", paidText.includes("of 40"), paidText.slice(0,120));
  // checkpoint inside top milestone block and once
  for (const [label, text] of [["free", freeText], ["paid", paidText]]) {
    const milestoneIdx = text.indexOf("Milestone note-keeping reminder");
    const nextSectionIdx = text.indexOf("\n## ", milestoneIdx + 1);
    const block = nextSectionIdx > milestoneIdx ? text.slice(milestoneIdx, nextSectionIdx) : text.slice(milestoneIdx);
    check(`${label}: checkpoint inside milestone block`, block.includes("Budget checkpoints"), block.slice(0,200));
    check(`${label}: checkpoint appears once`, (text.match(/Budget checkpoints/g) || []).length === 1, text.match(/Budget checkpoints/g));
  }
}

// 2. fallback note
{
  const repo = path.join(scratch, "repo1");
  fs.mkdirSync(repo, {recursive:true});
  const git = (args) => spawnSync("git", args, {cwd: repo, encoding: "utf8", shell: false, env: scratchGitEnv()});
  const init = git(["init", "-q"]);
  check("fixture: git init", init.status === 0, init.stderr);
  git(["config", "user.email", "t@e.invalid"]); git(["config", "user.name", "T"]);
  fs.writeFileSync(path.join(repo, "README.md"), "x\n"); git(["add", "-A"]);
  const initCommit = git(["commit", "-q", "-m", "init"]);
  check("fixture: git init commit", initCommit.status === 0, initCommit.stderr);
  const editedFile = path.join(repo, "edited.mjs");
  const newFile = path.join(repo, "new.mjs");
  fs.writeFileSync(editedFile, "a\nb\nc\nd\ne\n");
  fs.writeFileSync(newFile, "1\n2\n3\n");
  const stat = changedFilesStat(repo, {paths: ["edited.mjs", "new.mjs"], beforePaths: ["edited.mjs"]});
  check("fallback: edited -> (untracked, edited)", stat.includes("edited.mjs (untracked, edited)"), stat);
  check("fallback: new -> +N new", stat.includes("new.mjs +3 new"), stat);
  const note = buildOrchestratorFallbackNote("T1", [], "opencode", repo, stat, null, ["edited.mjs", "new.mjs"]);
  check("fallback: footer Next session:", note.includes("Next session:"), note.slice(-120));
  check("fallback: no Next generation:", !note.includes("Next generation:"), note.slice(-120));
}

// 3. opencode stdin not open pipe
{
  const fake = path.join(scratch, "stdin-wait.mjs");
  fs.writeFileSync(fake, "process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); setTimeout(()=>process.exit(1), 4000);");
  const t0 = Date.now();
  const r = await spawnRelayChild({binary: process.execPath, args: [fake], cwd: scratch, env: process.env, stdinData: "hello", writeStdin: true, timeoutMs: 5000});
  const dt = Date.now() - t0;
  check("opencode stdin: process exits (pipe ended)", r.status === 0, r);
  check("opencode stdin: not hanging", dt < 3000, {dt});
}

// 4. detach argv
{
  const repo = path.join(scratch, "repo2");
  fs.mkdirSync(path.join(repo, ".autopilot"), {recursive:true});
  fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify({mission: "m1"}));
  const calls = [];
  const spawner = (cmd, args, opts) => { calls.push({cmd, args, opts}); return {pid: 4242, unref() {}}; };
  const capture = (fn) => {
    const origLog = console.log;
    let printed = "";
    console.log = (m) => { printed += String(m) + "\n"; };
    let result;
    try { result = fn(); } finally { console.log = origLog; }
    return {result, printed};
  };
  process.env.OPENCODE_X = "forwarded-value";
  // systemd path, NEW request: state names the finished m1 mission, but the
  // detached unit/log must belong to the request's new mission, never m1.
  const {result: r1, printed: printed1} = capture(() => runDetached(["--detach", "req", "--repo", repo], {spawner, useSystemd: true}));
  check("detach systemd: returns 0", r1 === 0, r1);
  check("detach systemd: spawner called", calls.length === 1, calls.length);
  const c1 = calls[0];
  check("detach systemd: command systemd-run", c1.cmd === "systemd-run", c1.cmd);
  check("detach systemd: flags present", Array.isArray(c1.args) && c1.args.includes("--user") && c1.args.includes("--collect") && c1.args.some(a=>String(a).startsWith("--working-directory=")) && c1.args.some(a=>String(a).startsWith("--unit")), c1.args);
  check("detach systemd: rest args present", c1.args.includes("run") && c1.args.includes("req"), c1.args);
  check("detach systemd: stdin ignore", Array.isArray(c1.opts.stdio) && c1.opts.stdio[0] === "ignore", c1.opts);
  const outArg1 = c1.args.find(a => String(a).startsWith("StandardOutput=append:"));
  const log1 = outArg1 ? outArg1.slice("StandardOutput=append:".length) : "";
  check("detach systemd: request log is not the previous mission's", log1 !== "" && !log1.includes(path.join(".autopilot", "missions", "m1")), log1);
  check("detach systemd: request log is a root-level timestamped log",
    path.dirname(log1) === path.join(repo, ".autopilot") && /^orchestrator-\d{8}-\d{6}\.log$/.test(path.basename(log1)), log1);
  check("detach systemd: StandardError matches StandardOutput", c1.args.includes("StandardError=append:" + log1), c1.args);
  const unit1 = c1.args[c1.args.indexOf("--unit") + 1] || "";
  check("detach systemd: request unit is not the previous mission's", !unit1.includes("m1") && /^ap-repo2-\d{8}-\d{6}$/.test(unit1), unit1);
  check("detach systemd: prints the real unit and log",
    printed1.includes("unit: " + unit1) && printed1.includes("log: " + log1), printed1);
  check("detach systemd: PATH setenv present", c1.args.includes("--setenv=PATH"), c1.args);
  check("detach systemd: HOME setenv present", c1.args.includes("--setenv=HOME"), c1.args);
  check("detach systemd: OPENCODE_ var forwarded by name", c1.args.includes("--setenv=OPENCODE_X"), c1.args);
  check("detach systemd: no env value in argv", !c1.args.some(a => String(a).includes("forwarded-value")), c1.args);
  check("detach systemd: request forwards the detached log by name",
    c1.args.includes("--setenv=AUTOPILOT_DETACHED_LOG"), c1.args);
  check("detach systemd: request forwards the request text by name",
    c1.args.includes("--setenv=AUTOPILOT_DETACHED_REQUEST"), c1.args);
  check("detach systemd: request forwards the previous mission by name",
    c1.args.includes("--setenv=AUTOPILOT_DETACHED_PREVIOUS_MISSION"), c1.args);
  // Resume (no request) keeps the recorded mission's unit/log and the
  // already-running refusal.
  const callsResume = [];
  const spawnerResume = (cmd, args, opts) => { callsResume.push({cmd, args, opts}); return {pid: 9, unref(){}}; };
  const spawnSyncResume = (cmd, args) => {
    if (cmd === "systemctl" && Array.isArray(args) && args.includes("is-active")) return {status: 3};
    return {status: 0};
  };
  const rResume = runDetached(["--detach", "--repo", repo], {spawner: spawnerResume, spawnSync: spawnSyncResume, useSystemd: true});
  check("detach resume: returns 0", rResume === 0, rResume);
  const cResume = callsResume[0];
  check("detach resume: unit keeps the recorded mission", cResume.args[cResume.args.indexOf("--unit") + 1] === "ap-m1", cResume.args);
  check("detach resume: log stays in the recorded mission",
    cResume.args.includes("StandardOutput=append:" + path.join(repo, ".autopilot", "missions", "m1", "orchestrator.log")), cResume.args);
  check("detach resume: no detached-log hand-off", !cResume.args.includes("--setenv=AUTOPILOT_DETACHED_LOG"), cResume.args);
  check("detach resume: no detached-request hand-off", !cResume.args.includes("--setenv=AUTOPILOT_DETACHED_REQUEST"), cResume.args);
  check("detach resume: no previous-mission hand-off", !cResume.args.includes("--setenv=AUTOPILOT_DETACHED_PREVIOUS_MISSION"), cResume.args);
  // already-active refusal
  const callsActive = [];
  const spawnerActive = (cmd, args, opts) => { callsActive.push({cmd, args, opts}); return {pid: 1, unref(){}}; };
  const spawnSyncActive = (cmd, args, opts) => {
    if (cmd === "systemctl" && Array.isArray(args) && args.includes("is-active")) return {status: 0};
    if (cmd === "systemd-run") return {status: 0};
    if (cmd === "systemctl" && Array.isArray(args) && args.includes("is-system-running")) return {status: 0};
    return {status: 0};
  };
  const {result: rActive, printed} = capture(() => runDetached(["--detach", "--repo", repo], {spawner: spawnerActive, spawnSync: spawnSyncActive, useSystemd: true}));
  check("detach: already-active returns 1", rActive === 1, rActive);
  check("detach: already-active prints already running", printed.includes("already running: ap-m1"), printed);
  check("detach: already-active does not spawn", callsActive.length === 0, callsActive.length);
  // fallback path (new request): neutral unit/log, handed to the child
  const calls2 = [];
  let unref2 = false;
  const spawner2 = (cmd, args, opts) => { calls2.push({cmd, args, opts}); return {pid: 7, unref() { unref2 = true; }}; };
  const {result: r2, printed: printed2Text} = capture(() => runDetached(["--detach", "req2", "--repo", repo], {spawner: spawner2, useSystemd: false}));
  check("detach fallback: returns 0", r2 === 0, r2);
  const c2 = calls2[0];
  check("detach fallback: detached true", c2.opts.detached === true, c2.opts);
  check("detach fallback: stdio ignore/fd", Array.isArray(c2.opts.stdio) && c2.opts.stdio[0] === "ignore", c2.opts);
  check("detach fallback: unref called", unref2 === true, unref2);
  const log2 = c2.opts.env?.AUTOPILOT_DETACHED_LOG;
  check("detach fallback: child gets the root-level request log",
    typeof log2 === "string" && path.dirname(log2) === path.join(repo, ".autopilot") && /^orchestrator-\d{8}-\d{6}\.log$/.test(path.basename(log2)), log2);
  check("detach fallback: prints the same log", printed2Text.includes("log: " + log2), printed2Text);
  check("detach fallback: child also gets the request text",
    c2.opts.env?.AUTOPILOT_DETACHED_REQUEST === "req2", c2.opts.env?.AUTOPILOT_DETACHED_REQUEST);
  check("detach fallback: child also gets the previous mission",
    c2.opts.env?.AUTOPILOT_DETACHED_PREVIOUS_MISSION === "m1", c2.opts.env?.AUTOPILOT_DETACHED_PREVIOUS_MISSION);
  check("detach: previous-mission env not leaked",
    process.env.AUTOPILOT_DETACHED_PREVIOUS_MISSION === undefined, process.env.AUTOPILOT_DETACHED_PREVIOUS_MISSION);
}

// 5. orchestrator_exit event
{
  const missionDir = path.join(scratch, "missions", "m1");
  fs.mkdirSync(missionDir, {recursive:true});
  appendOrchestratorExitEvent(missionDir, "SIGTERM");
  const evFile = path.join(missionDir, "watch-events.jsonl");
  const content = fs.readFileSync(evFile, "utf8");
  const lines = content.trim().split(/\r?\n/).map(l => JSON.parse(l));
  const last = lines[lines.length - 1];
  check("handler: event written", last.type === "orchestrator_exit", last);
  check("handler: signal recorded", last.signal === "SIGTERM", last);
  check("handler: at present", typeof last.at === "string", last);
}

// cleanup
try { fs.rmSync(scratch, {recursive:true, force:true}); } catch {}

console.log(`\n${ok} passed, ${failed} failed`);
if (failed) process.exit(1);
