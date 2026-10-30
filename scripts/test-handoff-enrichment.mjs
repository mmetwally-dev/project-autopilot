import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {buildReviewWrapUpPrompt, parseFoundEntries, parseIncompleteSignal, parsePlanningIncompleteSignal, buildStandaloneHandoff, absolutePathsSection, REVIEW_EFFICIENCY_INSTRUCTIONS} from "./standalone-handoff.mjs";

let ok = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`PASS ${name}`); ok++; return; }
  console.error(`FAIL ${name}${detail ? ` :: ${JSON.stringify(detail)}` : ""}`);
  failed++;
}
function describe(name, fn) {
  console.log(`# describe: ${name}`);
  fn();
}

// ===================================================================
// describe: template structure
// ===================================================================
describe("template structure", () => {
  const cr = buildReviewWrapUpPrompt("code_reviewer", {phaseName: "Phase 1", taskRef: "task:x:phase-0:code_reviewer"});
  check("code_reviewer: Found section", /^#{1,2}\s*Found/m.test(cr), cr.slice(0, 200));
  check("code_reviewer: Found = already checked + result", cr.includes("already checked + result"), cr.slice(0, 400));
  check("code_reviewer: Next section", /^#{1,2}\s*Next/m.test(cr), cr.slice(0, 400));
  check("code_reviewer: Next = left to check", cr.includes("left to check"), cr.slice(0, 600));
  check("code_reviewer: progress signal = Found section growth", cr.includes("Found section growth"), cr.slice(0, 800));

  const vf = buildReviewWrapUpPrompt("verifier", {});
  check("verifier: Found section", /^#{1,2}\s*Found/m.test(vf));
  check("verifier: Found = already checked + result", vf.includes("already checked + result"));
  check("verifier: Next section", /^#{1,2}\s*Next/m.test(vf));
  check("verifier: Next = left to check", vf.includes("left to check"));
  check("verifier: progress signal = Found section growth", vf.includes("Found section growth"));

  const pr = buildReviewWrapUpPrompt("plan_reviewer", {});
  check("plan_reviewer: Found section", /^#{1,2}\s*Found/m.test(pr));
  check("plan_reviewer: Found = plan sections/tasks already checked + result", pr.includes("already checked + result") && pr.includes("PLAN.md") && pr.includes("TASKS.md"), pr.slice(0, 600));
  check("plan_reviewer: cites TASKS.md numeric ID / PLAN.md section", pr.includes("numeric ID"), pr.slice(0, 800));
  check("plan_reviewer: Next section", /^#{1,2}\s*Next/m.test(pr));
  check("plan_reviewer: Next = plan sections/tasks left to check", pr.includes("left to check"), pr.slice(0, 600));
  check("plan_reviewer: progress signal = Found section growth", pr.includes("Found section growth"), pr.slice(0, 800));

  const pl = buildReviewWrapUpPrompt("planner", {});
  check("planner: PLAN.md/TASKS.md change tracking", pl.includes("PLAN.md") && pl.includes("TASKS.md"));
  check("planner: Next section for unfinished items", /^#{1,2}\s*Next/m.test(pl) && pl.includes("unfinished"));
  check("planner: progress signal = PLAN/TASKS change + Next section", pl.includes("PLAN.md/TASKS.md change"));
  check("planner: Found — code facts", pl.includes("Found — code facts"));
  check("planner: Found names file:line and function names", pl.includes("file:line") && pl.includes("function names"));

  try { buildReviewWrapUpPrompt("implementer", {}); check("unknown role rejected", false); }
  catch (e) { check("unknown role rejected", e.code === "INVALID_REVIEW_ROLE", String(e && e.code)); }
});

// ===================================================================
// describe: parser
// ===================================================================
describe("parser", () => {
  check("parser: counts Found bullets", parseFoundEntries("## Found (already checked + result)\n- a.js:1 — ok\n- b.js:2 — fail\n## Next (left to check)\n- c.js\n") === 2);
  check("parser: Next bullets not counted", parseFoundEntries("## Found\n- one — ok\n## Next\n- two\n- three\n") === 1);
  check("parser: (none) counts as zero", parseFoundEntries("## Found\n(none)\n## Next\n- x\n") === 0);
  check("parser: missing Found section is zero", parseFoundEntries("## Next\n- x\n") === 0);
  check("parser: numbered entries count", parseFoundEntries("## Found\n1. first — ok\n2. second — ok\n## Next\n(none)\n") === 2);
  check("parser: empty input is zero", parseFoundEntries("") === 0);
  check("parser: Found-only note (no later header) counts entries", parseFoundEntries("## Found\n- a\n- b\n") === 2);
  check("parser: Found entry containing 'Z' not truncated", parseFoundEntries("## Found\n- Zod schema ok\n- b\n## Next\n- c\n") === 2);
});

// ===================================================================
// describe: incomplete signals (Mission 031 phase 3 task 3.4)
// ===================================================================
describe("incomplete signals", () => {
  check("parseIncompleteSignal: INCOMPLETE decision is true",
    parseIncompleteSignal({decision: "INCOMPLETE"}) === true);
  check("parseIncompleteSignal: nested verdict INCOMPLETE is true",
    parseIncompleteSignal({verdict: {decision: "INCOMPLETE"}}) === true);
  check("parseIncompleteSignal: non-empty Next section is true",
    parseIncompleteSignal({decision: "PASS", handoffNote: "## Found\n- a — ok\n## Next (left to check)\n- b.js:10-20 — verify guard\n"}) === true);
  check("parseIncompleteSignal: PASS with (none) Next is false",
    parseIncompleteSignal({decision: "PASS", handoffNote: "## Found\n- a — ok\n## Next\n(none)\n"}) === false);
  check("parseIncompleteSignal: PASS with no note is false",
    parseIncompleteSignal({decision: "PASS"}) === false);
  check("parseIncompleteSignal: odd input is false",
    parseIncompleteSignal(null) === false && parseIncompleteSignal({}) === false);
  check("parsePlanningIncompleteSignal: non-empty Next is true",
    parsePlanningIncompleteSignal({handoffNote: "## Found\n- TASKS.md updated\n## Next (unfinished items)\n- decide open question\n"}) === true);
  check("parsePlanningIncompleteSignal: (none) Next is false",
    parsePlanningIncompleteSignal({handoffNote: "## Found\n- done\n## Next\n(none)\n"}) === false);
  check("parsePlanningIncompleteSignal: missing Next is false",
    parsePlanningIncompleteSignal({handoffNote: "## Found\n- done\n"}) === false);
  check("parsePlanningIncompleteSignal: string note with Next items is true",
    parsePlanningIncompleteSignal("## Found\n- done\n## Next\n- leftover item\n") === true);
});

// ===================================================================
// describe: absolute paths (Mission 031 phase 8 task 8.1)
// ===================================================================
describe("absolute paths", () => {
  const MISSION_DIR = "/repo/.autopilot/missions/001-x";
  const base = {
    phaseName: "Phase 1", phaseIndex: 0, phaseTotal: 1, attempt: 1,
    phaseTasks: [
      {file: `${MISSION_DIR}/TASKS.md`, line: 55, text: "Do the thing"},
      {file: `${MISSION_DIR}/TASKS.md`, line: 56, text: "Do the other"},
    ],
    deltaChunks: [], baselineKey: "k", declaredPaths: [], implementationSummary: "",
    missionDir: MISSION_DIR,
  };
  const r = buildStandaloneHandoff({kind: "PHASE_REVIEW", ...base});
  check("review: ABSOLUTE PATHS section", r.text.includes("ABSOLUTE PATHS:"), r.text.slice(0, 500));
  check("review: lists mission PLAN.md", r.text.includes(`${MISSION_DIR}/PLAN.md`));
  check("review: lists mission TASKS.md", r.text.includes(`${MISSION_DIR}/TASKS.md`));
  check("review: lists each task file:line range",
    r.text.includes(`${MISSION_DIR}/TASKS.md:55`) && r.text.includes(`${MISSION_DIR}/TASKS.md:56`));

  const v = buildStandaloneHandoff({kind: "PHASE_VERIFY", ...base});
  check("verify: ABSOLUTE PATHS section", v.text.includes("ABSOLUTE PATHS:"));
  check("verify: lists mission PLAN.md", v.text.includes(`${MISSION_DIR}/PLAN.md`));
  check("verify: lists mission TASKS.md", v.text.includes(`${MISSION_DIR}/TASKS.md`));
  check("verify: lists each task file:line range",
    v.text.includes(`${MISSION_DIR}/TASKS.md:55`) && v.text.includes(`${MISSION_DIR}/TASKS.md:56`));

  // No missionDir: dirname of the first absolute task file is the fallback.
  const noDir = {...base};
  delete noDir.missionDir;
  const f = buildStandaloneHandoff({kind: "PHASE_REVIEW", ...noDir});
  check("review fallback: ABSOLUTE PATHS without missionDir", f.text.includes("ABSOLUTE PATHS:"));
  check("review fallback: derives PLAN.md/TASKS.md from task file",
    f.text.includes(`${MISSION_DIR}/PLAN.md`) && f.text.includes(`${MISSION_DIR}/TASKS.md`));

  // Helper unit checks.
  check("helper: empty without paths", absolutePathsSection({phaseTasks: []}) === "");
  check("helper: plan/tasks override used",
    absolutePathsSection({planPath: "/m/PLAN.md", tasksPath: "/m/TASKS.md", phaseTasks: []}).includes("/m/PLAN.md"));
});

// ===================================================================
// describe: review instructions (Mission 031 phase 8 task 8.2)
// ===================================================================
describe("review instructions", () => {
  const MISSION_DIR = "/repo/.autopilot/missions/001-x";
  const base = {
    phaseName: "Phase 1", phaseIndex: 0, phaseTotal: 1, attempt: 1,
    phaseTasks: [
      {file: `${MISSION_DIR}/TASKS.md`, line: 55, text: "Do the thing"},
    ],
    deltaChunks: [], baselineKey: "k", declaredPaths: [], implementationSummary: "",
    missionDir: MISSION_DIR,
  };
  const r = buildStandaloneHandoff({kind: "PHASE_REVIEW", ...base});
  check("review: instruction block present verbatim", r.text.includes(REVIEW_EFFICIENCY_INSTRUCTIONS), r.text.slice(0, 800));
  check("review: read only the ranges you need", r.text.includes("read only the ranges you need"));
  check("review: re-run evidence before new probe", r.text.includes("re-run the implementer evidence command before writing a new probe"));
  check("review: PASS lists what could not be verified", r.text.includes("a PASS must list what could not be verified"));

  const v = buildStandaloneHandoff({kind: "PHASE_VERIFY", ...base});
  check("verify: instruction block present verbatim", v.text.includes(REVIEW_EFFICIENCY_INSTRUCTIONS), v.text.slice(0, 800));
  check("verify: read only the ranges you need", v.text.includes("read only the ranges you need"));
  check("verify: re-run evidence before new probe", v.text.includes("re-run the implementer evidence command before writing a new probe"));
  check("verify: PASS lists what could not be verified", v.text.includes("a PASS must list what could not be verified"));
});

// ===================================================================
// describe: planner brief wiring (backlog #55)
// ===================================================================
describe("planner brief wiring (backlog #55)", () => {
  // The planner brief names the hand-off note path the standalone loop reads,
  // so a stopped planning session resumes from the note it wrote.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const autopilot = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");
  const standaloneBrief = "Keep a hand-off note at ${handoffNoteRelPath(mission, 'standalone-planning-planner')}";
  check("standalone planner brief (revision + fresh) names the planner hand-off note",
    autopilot.split(standaloneBrief).length - 1 >= 2);
  // SpecKit and GSD planning now run capped with their own per-framework
  // taskRef, so each planner brief names its own note and each loop reads it
  // back through planningContinuationText.
  const perFrameworkBrief = "Keep a hand-off note at ${handoffNoteRelPath(s.mission, taskRef)}";
  const windowAt = (marker, len = 2500) => {
    const at = autopilot.indexOf(marker);
    return {at, text: at < 0 ? "" : autopilot.slice(at, at + len)};
  };
  const speckitPlanner = windowAt(`planningContinuationText(s,"speckit","planner")`);
  check("speckit planner brief names its own planner hand-off note",
    speckitPlanner.at !== -1 && speckitPlanner.text.includes(perFrameworkBrief), speckitPlanner.at);
  const gsdPlanner = windowAt(`planningContinuationText(s,"gsd","planner")`);
  check("gsd planner brief names its own planner hand-off note",
    gsdPlanner.at !== -1 && gsdPlanner.text.includes(perFrameworkBrief), gsdPlanner.at);
  check("planning continuation text reads the planner hand-off note back",
    /function planningContinuationText\(s,framework,role\)\{[\s\S]*?readHandoffNote\(s\?\.mission,taskRef\)/.test(autopilot));
  check("planner taskRef is derived per framework",
    /function planningScopeParts\(framework,role\)\{\s*return \{taskRef:`\$\{framework\}-planning-\$\{role\}`,contScope:`task:\$\{framework\}:planning:\$\{role\}`\};/.test(autopilot));
  check("standalone loop reads the brief's planner hand-off note",
    autopilot.includes("readHandoffNote(mission, 'standalone-planning-planner')"));
  // The brief text itself carries the Found/Dead-ends contract.
  const briefAt = autopilot.indexOf(standaloneBrief);
  const briefText = briefAt >= 0 ? autopilot.slice(briefAt, briefAt + 1200) : "";
  check("brief Found names file:line", briefText.includes("file:line"));
  check("brief tracks Dead ends", briefText.includes("Dead ends"));
});

console.log(`\n${ok} passed, ${failed} failed`);
if (failed) process.exit(1);
