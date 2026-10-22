#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  buildReportModel, renderPlanningStage, renderImplementationStage, renderLiveProgress,
  snapshotCell, renderFindings, parseDiffStat,
} from "./watch-report.mjs";
import { changedFilesStat } from "./changed-files-stat.mjs";

const failures = [];
const check = (name, cond, extra) => {
  if (cond) console.log(`PASS ${name}`);
  else { failures.push(name); console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`); }
};

const run = (o) => ({ status: "completed", decision: null, findings: [], ...o });
const write = (p, data) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(data, null, 2)); };
const root = fs.mkdtempSync(path.join(os.tmpdir(), "watch-report-r3-"));

try {
  // ── #10 shared helper: modified + new untracked, ignored excluded ─────────
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo, { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q");
  git("config", "user.email", "r3@example.com");
  git("config", "user.name", "R3");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), "ignored.txt\n");
  git("add", "a.txt", ".gitignore");
  git("commit", "-qm", "base");
  fs.appendFileSync(path.join(repo, "a.txt"), "two\n");
  fs.writeFileSync(path.join(repo, "b.mjs"), "one\ntwo\n");
  fs.writeFileSync(path.join(repo, "ignored.txt"), "nope\n");
  const stat = changedFilesStat(repo);
  check("helper: modified file listed", /a\.txt/.test(stat), stat);
  check("helper: new file listed with line count", /b\.mjs \+2 new/.test(stat), stat);
  check("helper: ignored file excluded", !/ignored\.txt/.test(stat), stat);
  check("helper: file count includes the new file", /2 files changed/.test(stat), stat);
  check("helper: no raw diff summary duplication", (stat.match(/files changed/g) || []).length === 1, stat);

  const parsed = parseDiffStat(" scripts/a.mjs | 2 +-\n new.mjs +3 new\n 2 files changed, 5 insertions(+), 1 deletion(-)");
  check("parse: new-file line parsed", parsed.files.length === 2 && parsed.files[1].isNew === true && parsed.files[1].added === 3, parsed.files);
  check("parse: new-file rendered verbatim", parsed.text.includes("new.mjs +3 new"), parsed.text);
  check("parse: new file counted in the total", parsed.text.includes("(2 files)"), parsed.text);

  // ── #4 snapshot durations from a run-dir fixture ─────────────────────────
  const durDir = path.join(root, "duration-run");
  write(path.join(durDir, "status.json"), {
    status: "completed", sessionNumber: 1,
    snapshotBeforeStartedAt: "2026-10-19T10:00:00.000Z", snapshotBeforeAt: "2026-10-19T10:00:01.000Z",
    snapshotAfterStartedAt: "2026-10-19T10:05:00.000Z", snapshotAfterAt: "2026-10-19T10:05:02.000Z",
  });
  const durModel = buildReportModel({
    state: { phase: "implementing", phaseIndex: 0 },
    runs: [run({ dir: durDir, id: "01-implementer-abcdef", role: "implementer", phase: "1", attempt: "1", taskRef: "T1.1", status: "completed", started_at: "2026-10-19T10:00:00.000Z" })],
    phases: [{ number: 1, name: "Phase 1", done: false, tasks: [{ text: "a" }] }],
    policy: { continuation_allowance: 5 },
  });
  check("snapshot: real durations not started_at offsets", snapshotCell(durModel.runs[0]) === "1.0s/2.0s", snapshotCell(durModel.runs[0]));

  const oldDir = path.join(root, "old-run");
  write(path.join(oldDir, "status.json"), { status: "completed", snapshotBeforeAt: "2026-10-19T10:00:01.000Z", snapshotAfterAt: "2026-10-19T10:05:02.000Z" });
  const oldModel = buildReportModel({
    state: { phase: "implementing", phaseIndex: 0 },
    runs: [run({ dir: oldDir, id: "02-implementer-abcdef", role: "implementer", phase: "1", attempt: "1", taskRef: "T1.2", status: "completed", started_at: "2026-10-19T10:00:00.000Z" })],
    phases: [{ number: 1, name: "Phase 1", done: false, tasks: [{ text: "a" }] }],
    policy: { continuation_allowance: 5 },
  });
  check("snapshot: old end-only stamps print -", snapshotCell(oldModel.runs[0]) === "-/-", snapshotCell(oldModel.runs[0]));

  // ── #6 findings cap + suppression ────────────────────────────────────────
  const long = `${"T2.3: ".padEnd(40, "x")} ${"detail ".repeat(30)}end`;
  const lines = renderFindings([long, "second finding", "third finding", "fourth finding"], { runId: "07-code_reviewer-abc" });
  check("findings: at most two shown plus one more line", lines.length === 3, lines);
  check("findings: first is shortened at a word boundary", lines[0].includes("…") && lines[0].length < long.length, lines[0]);
  check("findings: body stays near 90 chars", lines[0].replace(/^      findings → 1\. /, "").length <= 90, lines[0]);
  check("findings: more line names the run result", lines[2] === "                 +2 more → runs/07-code_reviewer-abc/result.json", lines[2]);

  const hidden = buildReportModel({
    state: { phase: "implementing", phaseIndex: 0 },
    runs: [
      run({ id: "v1", role: "verifier", phase: "1", attempt: "1", taskRef: "T1.1", decision: "FAIL", findings: ["a bad finding here"], carriedForwardTasks: ["T2.2"], started_at: "2026-10-19T10:00:00.000Z" }),
      run({ id: "v2", role: "verifier", phase: "1", attempt: "2", taskRef: "T1.1", decision: "PASS", started_at: "2026-10-19T10:10:00.000Z" }),
    ],
    phases: [{ number: 1, name: "Phase 1", done: true, tasks: [] }],
    policy: { continuation_allowance: 5 },
  });
  const hiddenReport = renderImplementationStage(hidden);
  check("findings: passed phase hides findings", !hiddenReport.includes("a bad finding here"), hiddenReport);
  check("findings: passed phase hides carried forward", !hiddenReport.includes("carried forward"), hiddenReport);
  check("findings: note still holds the count", hiddenReport.includes("1 finding"), hiddenReport);

  const shown = buildReportModel({
    state: { phase: "implementing", phaseIndex: 0 },
    runs: [run({ id: "v3", role: "verifier", phase: "1", attempt: "1", taskRef: "T1.1", decision: "FAIL", findings: ["a bad finding here"], carriedForwardTasks: ["T2.2"], started_at: "2026-10-19T10:00:00.000Z" })],
    phases: [{ number: 1, name: "Phase 1", done: false, tasks: [] }],
    policy: { continuation_allowance: 5 },
  });
  const shownReport = renderImplementationStage(shown);
  check("findings: denied attempt keeps its findings", shownReport.includes("a bad finding here"), shownReport);
  check("findings: denied attempt keeps carried forward", shownReport.includes("carried forward"), shownReport);

  const planHidden = buildReportModel({
    state: { phase: "planning", phaseIndex: null },
    runs: [
      run({ id: "p1", role: "planner", phase: "1", attempt: "0", planRevision: 0, started_at: "2026-10-19T09:00:00.000Z" }),
      run({ id: "r1", role: "plan_reviewer", phase: "1", attempt: "0", planRevision: 0, decision: "FAIL", findings: ["plan bad"], started_at: "2026-10-19T09:01:00.000Z" }),
      run({ id: "p2", role: "planner", phase: "1", attempt: "1", planRevision: 1, started_at: "2026-10-19T09:02:00.000Z" }),
      run({ id: "r2", role: "plan_reviewer", phase: "1", attempt: "1", planRevision: 1, decision: "PASS", started_at: "2026-10-19T09:03:00.000Z" }),
    ],
    phases: [],
    policy: { continuation_allowance: 5, max_plan_revisions: 8 },
  });
  const planReport = renderPlanningStage(planHidden);
  check("findings: later plan approval hides earlier findings", !planReport.includes("plan bad"), planReport);
  check("findings: planning NOTE keeps the count", planReport.includes("1 finding"), planReport);

  // ── #12 session total, escalation and retry notes ────────────────────────
  const escDir = path.join(root, "escalated-run");
  write(path.join(escDir, "status.json"), { status: "capped", sessionNumber: 3 });
  write(path.join(escDir, "result.json"), { status: "capped", policyViolation: "git_mutation_blocked" });
  const retryDir = path.join(root, "retry-run");
  write(path.join(retryDir, "status.json"), { status: "capped", sessionNumber: 3 });
  write(path.join(retryDir, "result.json"), { status: "capped" });
  const escModel = buildReportModel({
    state: { phase: "implementing", phaseIndex: 0 },
    runs: [
      run({ dir: escDir, id: "11-implementer-4c180d0a", role: "implementer", phase: "1", attempt: "1", taskRef: "T1.3", status: "capped", sessionNumber: 3, started_at: "2026-10-19T10:00:00.000Z" }),
      run({ dir: retryDir, id: "12-implementer-52eb1c07", role: "implementer", phase: "1", attempt: "1", taskRef: "T1.3", status: "capped", sessionNumber: 3, started_at: "2026-10-19T10:10:00.000Z" }),
    ],
    phases: [{ number: 1, name: "Phase 1", done: false, tasks: [] }],
    policy: { continuation_allowance: 5 },
  });
  const escReport = renderImplementationStage(escModel);
  check("session: total is allowance + 1", escModel.runs[0].sessionLabel === "session 3 of 6", escModel.runs[0].sessionLabel);
  check("session: capped escalation note", escReport.includes("capped · escalated (git mutation blocked)"), escReport);
  check("session: retry after escalation note", escReport.includes("session 3 of 6 · retry after escalation"), escReport);

  // ── #12 capped result.json status source pin ─────────────────────────────
  const autopilotSource = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
  check("result: capped run writes capped status + capType", /if\(capBreach\)\{\s*onDisk\.status="capped";\s*onDisk\.capType=capBreach\.type;/.test(autopilotSource));
  check("result: no generation wording in continuation logs", !/continuing as generation/.test(autopilotSource));
  check("result: continuation logs say session with the same total", /continuing as session \$\{cont\.used\+1\} of \$\{cont\.limit\+1\}/.test(autopilotSource));
  check("result: planner continuation uses the same total", /Planner[^\n]*continuing as session \$\{cont\.used\+1\} of \$\{cont\.limit\+1\}/.test(autopilotSource));
  check("snapshot: autopilot records both snapshot starts", /updateRunSnapshots\(dir,\{snapshotBeforeStartedAt,snapshotBeforeAt\}\)/.test(autopilotSource)
    && /updateRunSnapshots\(dir,\{snapshotAfterStartedAt,snapshotAfterAt\}\)/.test(autopilotSource));
  check("changed files: one helper, no inline diff-stat duplication", /changedFilesStat\(repo\)/.test(autopilotSource)
    && !/gitOutput\(cwd,\["diff","--stat"/.test(autopilotSource));

  // ── #5 LIVE PROGRESS spacing ─────────────────────────────────────────────
  const live = renderLiveProgress({
    status: "RUNNING",
    current: { kind: "run" },
    liveProgress: [
      { at: "2026-10-19T15:35:50.000Z", kind: "FINISHED", text: "run finished" },
      { at: "2026-10-19T15:35:51.000Z", kind: "GATE", text: "full test suite passed" },
    ],
  });
  const finishedLine = live.split("\n").find((l) => l.includes("FINISHED"));
  check("live: FINISHED column keeps a space before the text", /\bFINISHED run finished\b/.test(finishedLine), finishedLine);
  check("live: no FINISHEDrun concatenation", !/FINISHEDrun finished/.test(live), live);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

if (failures.length) { console.error(`${failures.length} R3 check(s) failed.`); process.exit(1); }
console.log("All R3 checks passed.");
