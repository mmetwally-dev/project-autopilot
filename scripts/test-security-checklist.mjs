#!/usr/bin/env node
// Mission 066 task 1.1 — security checklist helper tests (helper-only).
//
// Asserts: generic-only output covers secrets, injection, traversal,
// auth/IDOR, sensitive-data exposure, unsafe deps; no 'do not flag' phrase;
// whole generic section (with file+line instruction) is <=1500 chars;
// project file items are appended; oversized project file is cut to 2000
// chars with a truncation note; missing/unreadable file gives generic only;
// missing/non-string repoRoot gives generic only with no read; never throws.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
  SECURITY_PROJECT_MAX_CHARS,
  SECURITY_TRUNCATION_NOTE,
  buildSecurityChecklistSection,
} from "./security-checklist.mjs";
import {buildStandaloneHandoff} from "./standalone-handoff.mjs";
import {MISSION_FINAL_SECURITY_LINE} from "./standalone-handoff.mjs";

let ok = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); ok += 1; return; }
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  failed += 1;
}

const GENERIC_NEEDLES = [
  "secret",
  "injection",
  "traversal",
  "IDOR",
  "sensitive-data",
  "unsafe dep",
];

function genericOf(section) {
  return section.split("Project-specific checks:")[0];
}

// ── Generic-only (absent project file) ──────────────────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-generic-"));
  const section = buildSecurityChecklistSection(dir);
  for (const needle of GENERIC_NEEDLES) {
    check(`generic covers ${needle}`, section.toLowerCase().includes(needle.toLowerCase()), section.length);
  }
  check("generic has no 'do not flag' phrase", !section.toLowerCase().includes("do not flag"), null);
  check("generic carries file+line finding instruction", section.includes("file:line"), null);
  check("generic-only section is <=1500 chars", section.length <= 1500, section.length);
  check("generic-only has no project part", !section.includes("Project-specific checks:"), null);
  fs.rmSync(dir, {recursive: true, force: true});
}

// ── Temp-file inclusion ─────────────────────────────────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-project-"));
  fs.mkdirSync(path.join(dir, ".autopilot"), {recursive: true});
  fs.writeFileSync(path.join(dir, ".autopilot", "security-checklist.md"), "- check CSRF on project forms\n");
  const section = buildSecurityChecklistSection(dir);
  check("project items appended after generic", section.includes("Project-specific checks:") && section.includes("check CSRF on project forms"), section.length);
  check("project section keeps generic head", GENERIC_NEEDLES.every((n) => section.toLowerCase().includes(n.toLowerCase())), null);
  fs.rmSync(dir, {recursive: true, force: true});
}

// ── Oversized project file is cut with note ─────────────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-big-"));
  fs.mkdirSync(path.join(dir, ".autopilot"), {recursive: true});
  const big = `x${"y".repeat(SECURITY_PROJECT_MAX_CHARS + 500)}`;
  fs.writeFileSync(path.join(dir, ".autopilot", "security-checklist.md"), big);
  const section = buildSecurityChecklistSection(dir);
  const [, projectPart = ""] = section.split("Project-specific checks:\n");
  const body = projectPart.replace(SECURITY_TRUNCATION_NOTE, "").replace(/\n$/, "");
  check("oversized project file is cut with note", section.includes(SECURITY_TRUNCATION_NOTE) && body.length <= SECURITY_PROJECT_MAX_CHARS, {part: projectPart.length, body: body.length});
  fs.rmSync(dir, {recursive: true, force: true});
}

// ── Missing or unreadable file gives generic only ───────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-missing-"));
  const missing = buildSecurityChecklistSection(dir);
  const bare = buildSecurityChecklistSection(path.join(dir, "does-not-exist"));
  check("missing project dir gives generic only", !missing.includes("Project-specific checks:"), null);
  check("missing repoRoot dir gives generic only", !bare.includes("Project-specific checks:"), null);
  // Unreadable: a directory at the project-file path makes readFileSync throw.
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "sec-unread-"));
  fs.mkdirSync(path.join(dir2, ".autopilot", "security-checklist.md"), {recursive: true});
  let unreadable;
  let threw = false;
  try {
    unreadable = buildSecurityChecklistSection(dir2);
  } catch { threw = true; }
  check("unreadable project file gives generic only, never throws", !threw && !String(unreadable).includes("Project-specific checks:"), null);
  fs.rmSync(dir, {recursive: true, force: true});
  fs.rmSync(dir2, {recursive: true, force: true});
}

// ── Missing/non-string repoRoot gives generic only with no read ─────
{
  let threw = false;
  let results = [];
  try {
    results = [
      buildSecurityChecklistSection(undefined),
      buildSecurityChecklistSection(null),
      buildSecurityChecklistSection(42),
      buildSecurityChecklistSection(""),
    ];
  } catch { threw = true; }
  check("missing/non-string repoRoot never throws", !threw, null);
  // Must equal the provably-generic output for a repoRoot with no file, and
  // must not depend on cwd: run from a cwd that HAS a project file.
  const cwdProbe = fs.mkdtempSync(path.join(os.tmpdir(), "sec-cwd-"));
  fs.mkdirSync(path.join(cwdProbe, ".autopilot"), {recursive: true});
  fs.writeFileSync(path.join(cwdProbe, ".autopilot", "security-checklist.md"), "- cwd trap item\n");
  const prevCwd = process.cwd();
  process.chdir(cwdProbe);
  let cwdResult;
  try { cwdResult = buildSecurityChecklistSection(undefined); } finally { process.chdir(prevCwd); }
  const reference = buildSecurityChecklistSection(path.join(os.tmpdir(), "sec-066-no-such-dir"));
  check("missing/non-string repoRoot gives generic only", results.every((s) => !s.includes("Project-specific checks:")), null);
  check("missing repoRoot has no cwd fallback", !cwdResult.includes("cwd trap item") && cwdResult === reference, cwdResult?.length);
  check("generic-only section length <=1500 chars", reference.length <= 1500, reference.length);
  fs.rmSync(cwdProbe, {recursive: true, force: true});
}

// ── Standalone reviewer wiring (mission 066 task 1.2) ───────────────
{
  const base = {
    kind: "PHASE_REVIEW",
    phaseName: "P",
    phaseIndex: 0,
    phaseTotal: 1,
    phaseTasks: [{file: "/repo/TASKS.md", line: 3, text: "Do the thing"}],
    attempt: 1,
    deltaChunks: [],
    baselineKey: "sec-066",
    declaredPaths: [],
    implementationSummary: "",
  };
  let noRoot;
  let threw = false;
  try {
    noRoot = buildStandaloneHandoff({...base});
  } catch { threw = true; }
  const generic = buildSecurityChecklistSection(undefined);
  check("PHASE_REVIEW without repoRoot still returns generic section, no throw", !threw && noRoot.text.includes(generic) && generic.includes("file:line"), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-handoff-"));
  fs.mkdirSync(path.join(dir, ".autopilot"), {recursive: true});
  fs.writeFileSync(path.join(dir, ".autopilot", "security-checklist.md"), "- check CSRF on project forms\n");
  const wired = buildStandaloneHandoff({...base, repoRoot: dir});
  check("project items appear in PHASE_REVIEW brief via repoRoot", wired.text.includes("Project-specific checks:") && wired.text.includes("check CSRF on project forms"), null);
  const rereview = buildStandaloneHandoff({...base, kind: "PHASE_REREVIEW", repoRoot: dir, changedFiles: []});
  check("project items appear in PHASE_REREVIEW brief via repoRoot", rereview.text.includes("check CSRF on project forms"), null);
  fs.rmSync(dir, {recursive: true, force: true});
}

// ── SpecKit reviewer wiring (mission 066 task 1.3) ───────────────────
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const autopilotSrc = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");
  check("SpecKit wiring: autopilot.mjs imports the shared helper",
    autopilotSrc.includes('buildSecurityChecklistSection} from "./security-checklist.mjs"')
    || autopilotSrc.includes('buildSecurityChecklistSection} from \'./security-checklist.mjs\''), false);
  check("SpecKit wiring: reviewPrompt appends helper output with the repo root passed",
    /reviewPrompt\+=`\\n\\n\$\{buildSecurityChecklistSection\(repo\)\}`/.test(autopilotSrc), false);
  check("SpecKit wiring: append sits after the fresh-review/re-review if/else",
    autopilotSrc.indexOf("Changes since your last review") < autopilotSrc.indexOf("buildSecurityChecklistSection(repo)"), false);
}

// ── Mission-final wiring (mission 067 task 1.2) ─────────────────────
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const autopilotSrc = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");
  check("Mission-final wiring: autopilot.mjs imports MISSION_FINAL_SECURITY_LINE",
    /import\s*\{[^}]*MISSION_FINAL_SECURITY_LINE[^}]*\}\s*from\s*["']\.\/standalone-handoff\.mjs["']/.test(autopilotSrc), false);
  // All three standalone MISSION_FINAL handoff sites pass repoRoot:repo.
  const missionFinalSites = autopilotSrc.split('kind:"MISSION_FINAL"');
  check("Mission-final wiring: three standalone MISSION_FINAL handoff sites",
    missionFinalSites.length === 4, missionFinalSites.length - 1);
  check("Mission-final wiring: every MISSION_FINAL site passes repoRoot:repo",
    missionFinalSites.length === 4 && missionFinalSites.slice(1).every((seg) => seg.slice(0, 600).includes("repoRoot:repo")), false);
  // Both SpecKit mission-final prompts append the helper with the shared line.
  const helperUses = autopilotSrc.match(/buildSecurityChecklistSection\(repo\)/g) || [];
  check("Mission-final wiring: buildSecurityChecklistSection(repo) in phase + both mission-final prompts",
    helperUses.length === 3, helperUses.length);
  const lineUses = autopilotSrc.match(/\$\{MISSION_FINAL_SECURITY_LINE\}/g) || [];
  check("Mission-final wiring: both SpecKit mission-final prompts use MISSION_FINAL_SECURITY_LINE",
    lineUses.length === 2, lineUses.length);
  check("Mission-final wiring: no duplicate whole-mission-diff literal in autopilot.mjs",
    !autopilotSrc.includes(MISSION_FINAL_SECURITY_LINE), false);
  // Phase prompts untouched: the phase append keeps its exact form with no
  // whole-mission-diff line adjacent to it. (Backslash-n below is the
  // literal two-char sequence in autopilot.mjs source, not a newline.)
  const phaseAppend = "reviewPrompt+=`\\n\\n${buildSecurityChecklistSection(repo)}`";
  const phaseAt = autopilotSrc.indexOf(phaseAppend);
  check("Mission-final wiring: phase reviewPrompt append untouched",
    phaseAt !== -1 && !autopilotSrc.slice(phaseAt, phaseAt + phaseAppend.length + 300).includes("MISSION_FINAL_SECURITY_LINE"), phaseAt);
}

console.log(`\n${ok} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
