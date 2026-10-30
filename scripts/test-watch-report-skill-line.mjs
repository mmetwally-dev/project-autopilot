#!/usr/bin/env node
// WATCH-REPORT `Skill:` line: the recorded skill copy (version · mode · path)
// instead of the old "unknown" label, and the mode detection behind it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { skillText } from "./watch-report.mjs";
import { renderWatchReport } from "./run-history.mjs";
import { skillCopyInfo, skillCopyMode, recordSkillCopy } from "./skill-copy.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const tmpBase = path.join(repo, ".autopilot", "tmp-test-skill-line");
const failures = [];
const check = (name, cond, extra) => {
  if (cond) console.log(`PASS ${name}`);
  else { failures.push(name); console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`); }
};

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
};

fs.mkdirSync(tmpBase, { recursive: true });

try {
  // ── (a) skillText formatting ──────────────────────────────────────────────
  {
    const line = skillText({ skill: { version: "12.0.1", mode: "npm-global", path: "/usr/lib/node_modules/project-autopilot" } });
    check("format: recorded version · mode · path", line === "12.0.1 · npm-global · /usr/lib/node_modules/project-autopilot", line);
    check("format: missing record degrades", skillText({}) === "unknown · skill copy location not recorded", skillText({}));
    check("format: null record degrades", skillText({ skill: null }) === "unknown · skill copy location not recorded", skillText({ skill: null }));
  }

  // ── (b) mode detection for the three install shapes ──────────────────────
  {
    const npmRoot = path.join(tmpBase, "npm", "node_modules", "project-autopilot");
    const devRoot = path.join(tmpBase, "dev-checkout");
    const folderRoot = path.join(tmpBase, "skill-folder");
    fs.mkdirSync(npmRoot, { recursive: true });
    fs.mkdirSync(path.join(devRoot, ".git"), { recursive: true });
    fs.mkdirSync(folderRoot, { recursive: true });

    check("mode: inside node_modules -> npm-global", skillCopyMode(npmRoot) === "npm-global", skillCopyMode(npmRoot));
    check("mode: .git directory -> dev-checkout", skillCopyMode(devRoot) === "dev-checkout", skillCopyMode(devRoot));
    check("mode: plain copied folder -> skill-folder", skillCopyMode(folderRoot) === "skill-folder", skillCopyMode(folderRoot));
  }

  // ── (c) the recording path writes what the report reads ──────────────────
  {
    const fixtureRepo = path.join(tmpBase, "fixture-repo");
    const mission = "099-skill-line";
    const missionDir = path.join(fixtureRepo, ".autopilot", "missions", mission);
    fs.mkdirSync(missionDir, { recursive: true });
    fs.writeFileSync(path.join(missionDir, "watch-events.jsonl"), "");

    const info = skillCopyInfo(repo);
    const state = recordSkillCopy({
      mission,
      phase: "planning",
      step: "standalone-plan",
      planningStartedAt: "2026-10-28T00:00:00+00:00",
    }, info);
    check("record: state carries the real copy identity", state.skill?.version === info.version && state.skill?.mode === info.mode && state.skill?.path === info.path, state.skill);
    writeJson(path.join(fixtureRepo, ".autopilot", "state.json"), state);
    writeJson(path.join(fixtureRepo, ".autopilot", "config.json"), { policy: {} });

    const report = renderWatchReport(fixtureRepo, mission, { now: "2026-10-28T00:01:00+00:00", tail: 5 });
    const expected = [info.version, info.mode, info.path].filter(Boolean).join(" · ");
    const skillRow = report.split("\n").find((l) => l.trim().startsWith("Skill:")) || "";
    check("report: Skill row prints the recorded copy", skillRow.includes(expected), skillRow);
    check("report: recorded row is not the unknown label", !skillRow.includes("unknown · skill copy location not recorded"), skillRow);

    const oldRepo = path.join(tmpBase, "old-run-repo");
    const oldMissionDir = path.join(oldRepo, ".autopilot", "missions", mission);
    fs.mkdirSync(oldMissionDir, { recursive: true });
    fs.writeFileSync(path.join(oldMissionDir, "watch-events.jsonl"), "");
    writeJson(path.join(oldRepo, ".autopilot", "state.json"), { mission, phase: "planning", step: "standalone-plan" });
    writeJson(path.join(oldRepo, ".autopilot", "config.json"), { policy: {} });
    const oldReport = renderWatchReport(oldRepo, mission, { now: "2026-10-28T00:01:00+00:00", tail: 5 });
    check("report: old run without a record keeps the unknown label", oldReport.includes("Skill:   unknown · skill copy location not recorded"), oldReport.split("\n").find((l) => l.trim().startsWith("Skill:")) || "");
  }
} finally {
  fs.rmSync(tmpBase, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`${failures.length} check(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("All watch-report skill-line checks passed.");
