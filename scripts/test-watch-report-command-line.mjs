#!/usr/bin/env node
// WATCH-REPORT `Command:` line (backlog #10): the entry command recorded on
// the mission state at run start ({name, stopAfter}) is printed in the header;
// old states without the field print nothing. Also pins that autopilot records
// the command for every entry command and for both the standalone and SpecKit
// loops.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { commandText } from "./watch-report.mjs";
import { renderWatchReport } from "./run-history.mjs";
import { recordCommand } from "./skill-copy.mjs";
import { makeFixtureRepo, makeFixtureBin, writeConfig, withoutOuterGitGuard, cleanup, skillRoot } from "./test-fixtures/workflow-order-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const failures = [];
const check = (name, cond, extra) => {
  if (cond) console.log(`PASS ${name}`);
  else { failures.push(name); console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`); }
};

const commandRow = (report) => report.split("\n").find((l) => l.trim().startsWith("Command:")) || "";

// ── (a) commandText formatting ───────────────────────────────────────────
check("format: run -> full loop", commandText({ command: { name: "run", stopAfter: null } }) === "ap run (full loop)", commandText({ command: { name: "run", stopAfter: null } }));
check("format: plan -> stops after planning", commandText({ command: { name: "plan", stopAfter: "planning" } }) === "ap plan (stops after planning)");
check("format: no record -> null", commandText({}) === null && commandText({ command: null }) === null);

// ── (b) recordCommand writes the shape the report reads ──────────────────
{
  const st = recordCommand({ mission: "m" }, "plan", "planning");
  check("record: {name, stopAfter}", JSON.stringify(st.command) === JSON.stringify({ name: "plan", stopAfter: "planning" }), st.command);
  check("record: stopAfter defaults to null", recordCommand({}, "run").command.stopAfter === null);
}

// ── (c) the report header, from a state file ─────────────────────────────
const mission = "100-command-line";
const renderFor = (name, state) => {
  const repo = makeFixtureRepo(`cmd-line-${name}`);
  try {
    const missionDir = path.join(repo, ".autopilot", "missions", mission);
    fs.mkdirSync(missionDir, { recursive: true });
    fs.writeFileSync(path.join(missionDir, "watch-events.jsonl"), "");
    fs.writeFileSync(path.join(repo, ".autopilot", "state.json"), JSON.stringify({ mission, phase: "planning", step: "standalone-plan", ...state }, null, 2));
    fs.writeFileSync(path.join(repo, ".autopilot", "config.json"), JSON.stringify({ policy: {} }));
    return renderWatchReport(repo, mission, { now: "2026-10-30T00:01:00+00:00", tail: 5 });
  } finally {
    cleanup(repo);
  }
};
{
  const runRow = commandRow(renderFor("run", { command: { name: "run", stopAfter: null } }));
  check("report: ap run prints the full loop", /Command:\s+ap run \(full loop\)/.test(runRow), runRow);
  const planRow = commandRow(renderFor("plan", { command: { name: "plan", stopAfter: "planning" } }));
  check("report: ap plan prints the stop-after stage", /Command:\s+ap plan \(stops after planning\)/.test(planRow), planRow);
  const lines = renderFor("order", { command: { name: "run", stopAfter: null } }).split("\n").map((l) => l.trim());
  const iStatus = lines.findIndex((l) => l.startsWith("Status:"));
  const iCommand = lines.findIndex((l) => l.startsWith("Command:"));
  const iStage = lines.findIndex((l) => l.startsWith("Stage:"));
  check("report: Command line directly after Status, before Stage", iStatus >= 0 && iCommand === iStatus + 1 && iStage > iCommand, { iStatus, iCommand, iStage });
  check("report: old state without the field prints no Command row", commandRow(renderFor("old", {})) === "");
}

// ── (d) autopilot records it, for every entry command ────────────────────
const source = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");
{
  const grab = (name) => {
    const start = source.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`function ${name} not found in autopilot.mjs`);
    let depth = 0, i = source.indexOf("{", source.indexOf(")", start));
    for (; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}" && --depth === 0) break;
    }
    return source.slice(start, i + 1);
  };
  const table = (name) => source.match(new RegExp(`const ${name}=\\{[^}]*\\};`))?.[0];
  if (!table("COMMAND_STOP_AFTER") || !table("STAGE_STOP_AFTER")) throw new Error("stop-after tables not found in autopilot.mjs");
  const recordFor = (command, activeStage) => {
    const fn = new Function("recordCommand", "command", "activeStage",
      `${table("COMMAND_STOP_AFTER")} ${table("STAGE_STOP_AFTER")} ${grab("recordEntryCommand")}; const s={}; recordEntryCommand(s); return s.command;`);
    return fn(recordCommand, command, activeStage);
  };
  const expect = [
    ["run", null, "run", null],
    ["resume", null, "run", null],
    ["full", null, "full", null],
    ["plan", null, "plan", "planning"],
    ["spec", null, "spec", "planning"],
    ["review", null, "review", "review"],
    ["implement", null, "implement", null],
    ["run", "planning", "run", "planning"],
    ["run", "implement", "run", "implementation"],
    ["run", "review", "run", "review"],
    ["run", "verify", "run", "verification"],
  ];
  for (const [cmd, stage, name, stopAfter] of expect) {
    const got = recordFor(cmd, stage);
    check(`record: ap ${cmd}${stage ? ` --stage ${stage}` : ""} -> ${name}/${stopAfter}`, got.name === name && got.stopAfter === stopAfter, got);
  }
  // The three entry points call it once each, next to where the run starts.
  check("wiring: runImplementation records right after the skill copy",
    /recordSkillCopy\(s\);\s*recordEntryCommand\(s\);\s*saveState\(s\);/.test(source));
  check("wiring: runSpec records at start", /async function runSpec\(c,s\)\{\s*recordEntryCommand\(s\);saveState\(s\);/.test(source));
  check("wiring: reviewPlanCommand records at start", /async function reviewPlanCommand\(c,s\)\{\s*recordEntryCommand\(s\);saveState\(s\);/.test(source));
}

// ── (e) behaviour: a real `ap review` process records it, both loops ─────
function runReview(framework) {
  const repo = makeFixtureRepo(`cmd-line-review-${framework}`);
  const binDir = makeFixtureBin(`cmd-line-review-${framework}`);
  try {
    writeConfig(repo, { planningFramework: framework });
    const delimiter = process.platform === "win32" ? ";" : ":";
    const base = withoutOuterGitGuard(process.env);
    delete base.AUTOPILOT_SPEC;
    const result = spawnSync(process.execPath,
      [path.join(skillRoot, "scripts", "autopilot.mjs"), "review", "--repo", repo],
      { cwd: repo, encoding: "utf8", env: { ...base, PATH: `${binDir}${delimiter}${base.PATH || ""}` }, timeout: 120000, stdio: ["ignore", "pipe", "pipe"], shell: false });
    const statePath = path.join(repo, ".autopilot", "state.json");
    const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : null;
    return { status: result.status, state, out: `${result.stdout || ""}\n${result.stderr || ""}` };
  } finally {
    cleanup(repo, binDir);
  }
}
for (const framework of ["standalone", "speckit"]) {
  const r = runReview(framework);
  check(`behaviour: ap review (${framework}) exits non-zero on a fresh fixture (no plan)`, r.status !== 0, { status: r.status, out: r.out.slice(-300) });
  check(`behaviour: ap review (${framework}) recorded state.command`,
    r.state?.command?.name === "review" && r.state?.command?.stopAfter === "review", { command: r.state?.command, out: r.out.slice(-300) });
}

if (failures.length) {
  console.error(`${failures.length} check(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("All watch-report command-line checks passed.");
