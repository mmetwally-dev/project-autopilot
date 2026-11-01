#!/usr/bin/env node
// WATCH-REPORT framework in Command line (backlog #6):
// The mission's framework (standalone, SpecKit, GSD) is displayed on the
// `Command:` line in the PIPELINE STATE header:
//   - Append the framework to the Command line: `Command:  ap run (full loop) · SpecKit`
//     (labels: standalone -> "standalone", speckit -> "SpecKit", gsd -> "GSD").
//   - When state.command is missing but framework is known: `Command:  - · SpecKit`.
//   - When both are missing: keep output unchanged (no Command line).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { commandText, frameworkLabel, renderPipelineState } from "./watch-report.mjs";
import { renderWatchReport } from "./run-history.mjs";
import { makeFixtureRepo, cleanup } from "./test-fixtures/workflow-order-harness.mjs";

const failures = [];
const check = (name, cond, extra) => {
  if (cond) console.log(`PASS ${name}`);
  else {
    failures.push(name);
    console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`);
  }
};

const commandRow = (report) => report.split("\n").find((l) => l.trim().startsWith("Command:")) || "";

// ── (a) frameworkLabel normalization ──────────────────────────────────────
check("label: standalone -> standalone", frameworkLabel("standalone") === "standalone", frameworkLabel("standalone"));
check("label: speckit -> SpecKit", frameworkLabel("speckit") === "SpecKit", frameworkLabel("speckit"));
check("label: gsd -> GSD", frameworkLabel("gsd") === "GSD", frameworkLabel("gsd"));
check("label: case insensitive speckit", frameworkLabel("SpecKit") === "SpecKit", frameworkLabel("SpecKit"));
check("label: case insensitive gsd", frameworkLabel("GSD") === "GSD", frameworkLabel("GSD"));
check("label: null / undefined / empty", frameworkLabel(null) === null && frameworkLabel(undefined) === null && frameworkLabel("") === null);

// ── (b) commandText formatting ────────────────────────────────────────────
check("format: run + standalone",
  commandText({ command: { name: "run", stopAfter: null }, framework: "standalone" }) === "ap run (full loop) · standalone",
  commandText({ command: { name: "run", stopAfter: null }, framework: "standalone" }));

check("format: run + speckit",
  commandText({ command: { name: "run", stopAfter: null }, framework: "speckit" }) === "ap run (full loop) · SpecKit",
  commandText({ command: { name: "run", stopAfter: null }, framework: "speckit" }));

check("format: run + gsd",
  commandText({ command: { name: "run", stopAfter: null }, framework: "gsd" }) === "ap run (full loop) · GSD",
  commandText({ command: { name: "run", stopAfter: null }, framework: "gsd" }));

check("format: plan (stops after planning) + speckit",
  commandText({ command: { name: "plan", stopAfter: "planning" }, framework: "speckit" }) === "ap plan (stops after planning) · SpecKit",
  commandText({ command: { name: "plan", stopAfter: "planning" }, framework: "speckit" }));

check("format: missing command + standalone -> - · standalone",
  commandText({ command: null, framework: "standalone" }) === "- · standalone",
  commandText({ command: null, framework: "standalone" }));

check("format: missing command + speckit -> - · SpecKit",
  commandText({ command: null, framework: "speckit" }) === "- · SpecKit",
  commandText({ command: null, framework: "speckit" }));

check("format: missing command + gsd -> - · GSD",
  commandText({ command: null, framework: "gsd" }) === "- · GSD",
  commandText({ command: null, framework: "gsd" }));

check("format: old state (no command, no framework) -> null",
  commandText({}) === null && commandText({ command: null, framework: null }) === null);

check("format: command without framework -> ap run (full loop)",
  commandText({ command: { name: "run", stopAfter: null } }) === "ap run (full loop)",
  commandText({ command: { name: "run", stopAfter: null } }));

// ── (c) renderPipelineState block ─────────────────────────────────────────
{
  const standaloneBlock = renderPipelineState({ command: { name: "run", stopAfter: null }, framework: "standalone" });
  check("pipeline: standalone line", commandRow(standaloneBlock) === "Command: ap run (full loop) · standalone", commandRow(standaloneBlock));

  const speckitBlock = renderPipelineState({ command: { name: "run", stopAfter: null }, framework: "speckit" });
  check("pipeline: speckit line", commandRow(speckitBlock) === "Command: ap run (full loop) · SpecKit", commandRow(speckitBlock));

  const gsdBlock = renderPipelineState({ command: { name: "run", stopAfter: null }, framework: "gsd" });
  check("pipeline: gsd line", commandRow(gsdBlock) === "Command: ap run (full loop) · GSD", commandRow(gsdBlock));

  const missingCmdSpeckit = renderPipelineState({ command: null, framework: "speckit" });
  check("pipeline: missing command with speckit", commandRow(missingCmdSpeckit) === "Command: - · SpecKit", commandRow(missingCmdSpeckit));

  const oldStateBlock = renderPipelineState({});
  check("pipeline: old state has no Command line", commandRow(oldStateBlock) === "", commandRow(oldStateBlock));
}

// ── (d) end-to-end rendered report from state files ───────────────────────
const mission = "106-framework-report";
const renderFor = (name, state) => {
  const repo = makeFixtureRepo(`framework-${name}`);
  try {
    const missionDir = path.join(repo, ".autopilot", "missions", mission);
    fs.mkdirSync(missionDir, { recursive: true });
    fs.writeFileSync(path.join(missionDir, "watch-events.jsonl"), "");
    fs.writeFileSync(
      path.join(repo, ".autopilot", "state.json"),
      JSON.stringify({ mission, phase: "planning", step: "standalone-plan", ...state }, null, 2)
    );
    fs.writeFileSync(path.join(repo, ".autopilot", "config.json"), JSON.stringify({ policy: {} }));
    return renderWatchReport(repo, mission, { now: "2026-10-31T00:00:00+00:00", tail: 5 });
  } finally {
    cleanup(repo);
  }
};

{
  const reportStandalone = renderFor("standalone", {
    command: { name: "run", stopAfter: null },
    planningDetection: { framework: "standalone" },
  });
  const rowStandalone = commandRow(reportStandalone);
  check("report: standalone with command", rowStandalone === "Command: ap run (full loop) · standalone", rowStandalone);

  const reportSpeckit = renderFor("speckit", {
    command: { name: "run", stopAfter: null },
    planningDetection: { framework: "speckit" },
  });
  const rowSpeckit = commandRow(reportSpeckit);
  check("report: speckit with command", rowSpeckit === "Command: ap run (full loop) · SpecKit", rowSpeckit);

  const reportGsd = renderFor("gsd", {
    command: { name: "run", stopAfter: null },
    planningDetection: { framework: "gsd" },
  });
  const rowGsd = commandRow(reportGsd);
  check("report: gsd with command", rowGsd === "Command: ap run (full loop) · GSD", rowGsd);

  const reportNoCmdSpeckit = renderFor("no-cmd-speckit", {
    planningDetection: { framework: "speckit" },
  });
  const rowNoCmdSpeckit = commandRow(reportNoCmdSpeckit);
  check("report: missing command + speckit prints Command: - · SpecKit", rowNoCmdSpeckit === "Command: - · SpecKit", rowNoCmdSpeckit);

  const reportNoCmdStandalone = renderFor("no-cmd-standalone", {
    planningDetection: { framework: "standalone" },
  });
  const rowNoCmdStandalone = commandRow(reportNoCmdStandalone);
  check("report: missing command + standalone prints Command: - · standalone", rowNoCmdStandalone === "Command: - · standalone", rowNoCmdStandalone);

  const reportNoCmdGsd = renderFor("no-cmd-gsd", {
    planningDetection: { framework: "gsd" },
  });
  const rowNoCmdGsd = commandRow(reportNoCmdGsd);
  check("report: missing command + gsd prints Command: - · GSD", rowNoCmdGsd === "Command: - · GSD", rowNoCmdGsd);

  const reportOldState = renderFor("old-state", {});
  const rowOldState = commandRow(reportOldState);
  check("report: old state (no command, no framework) prints no Command row", rowOldState === "", rowOldState);

  const reportCmdOnly = renderFor("cmd-only", {
    command: { name: "run", stopAfter: null },
  });
  const rowCmdOnly = commandRow(reportCmdOnly);
  check("report: command without framework keeps today's output unchanged", rowCmdOnly === "Command: ap run (full loop)", rowCmdOnly);

  const reportPlanSpeckit = renderFor("plan-speckit", {
    command: { name: "plan", stopAfter: "planning" },
    planningDetection: { framework: "speckit" },
  });
  const rowPlanSpeckit = commandRow(reportPlanSpeckit);
  check("report: ap plan (stops after planning) · SpecKit", rowPlanSpeckit === "Command: ap plan (stops after planning) · SpecKit", rowPlanSpeckit);

  // Line order check
  const lines = reportSpeckit.split("\n").map((l) => l.trim());
  const iStatus = lines.findIndex((l) => l.startsWith("Status:"));
  const iCommand = lines.findIndex((l) => l.startsWith("Command:"));
  const iStage = lines.findIndex((l) => l.startsWith("Stage:"));
  check("report: Command line directly after Status, before Stage",
    iStatus >= 0 && iCommand === iStatus + 1 && iStage > iCommand,
    { iStatus, iCommand, iStage }
  );
}

if (failures.length) {
  console.error(`${failures.length} check(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("All watch-report framework checks passed.");
