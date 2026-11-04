#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import { modelBriefLines } from "./model-briefs.mjs";

globalThis.modelBriefLines = modelBriefLines;

let ok = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); ok += 1; return; }
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${detail}` : ""}`);
  failed += 1;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const autopilotSource = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");

// Extract the rawRelayTaskText array construction from runRelay in autopilot.mjs
const rawRelayMatch = autopilotSource.match(/const rawRelayTaskText\s*=\s*(\[[\s\S]*?\])\.filter\(Boolean\)\.join\("\\n"\);/);
if (!rawRelayMatch) {
  console.error("FAIL: could not locate rawRelayTaskText array in scripts/autopilot.mjs");
  process.exit(1);
}

const GEMINI_HEADER = "Gemini working rules:";
const RULE_1 = "1. Put all independent tool calls in ONE response (e.g. read_file a + read_file b + grep -n -e X -e Y files).";
const RULE_4 = "4. No web search, no task-management tools.";
const PLANNER_5 = "5. Edit as you go, as soon as you know the change; never save edits for the end.";
const PLANNER_8 = "8. If the work is bigger than your turns: do what fits, write in the hand-off note exactly what is done and what is left (file:line), then end your turn.";
const IMPLEMENTER_5 = "5. Edit as you go; run the task's tests once after the edits and fix what fails.";
const IMPLEMENTER_7 = "7. If the work is bigger than your turns: hand-off note with done / left (file:line), then end your turn.";

// Build brief evaluator from autopilot.mjs source
const evaluateBrief = new Function(
  "roleName", "promptRepository", "mission", "role", "readOnly", "promptScratch", "disposableWorkspace", "relayTask", "review", "planRevision = null",
  `return (${rawRelayMatch[1]}).filter(Boolean).join("\\n");`
);

function buildBrief({
  roleName = "planner",
  role = {adapter: "antigravity", model: "gemini-2.5-pro"},
  readOnly = false,
  mission = "test-mission",
  promptRepository = "/workspace/repository",
  promptScratch = "/workspace/scratch",
  disposableWorkspace = false,
  relayTask = "task details",
  review = false,
  planRevision = null
} = {}) {
  return evaluateBrief(roleName, promptRepository, mission, role, readOnly, promptScratch, disposableWorkspace, relayTask, review, planRevision);
}

// Common brief assertions: verify baseline delegated worker & foreground instructions
const baseBrief = buildBrief({roleName: "planner", role: {adapter: "antigravity", model: "gemini-2.5-pro"}, readOnly: false});
check("brief contains 'You are a delegated worker'", baseBrief.includes("You are a delegated worker"), baseBrief);
check("brief contains 'Run every command in the foreground'", baseBrief.includes("Run every command in the foreground"), baseBrief);

// ── 1. Antigravity write roles with Gemini model carry the Gemini family rules ──
const agyPlannerBrief = buildBrief({roleName: "planner", role: {adapter: "antigravity", model: "gemini-2.5-pro"}, readOnly: false});
check("antigravity planner brief contains Gemini working rules header",
  agyPlannerBrief.includes(GEMINI_HEADER),
  agyPlannerBrief
);
check("antigravity planner brief contains rule 1",
  agyPlannerBrief.includes(RULE_1),
  agyPlannerBrief
);
check("antigravity planner brief contains rule 4",
  agyPlannerBrief.includes(RULE_4),
  agyPlannerBrief
);
check("antigravity planner brief contains planner rule 5",
  agyPlannerBrief.includes(PLANNER_5),
  agyPlannerBrief
);
check("antigravity planner brief contains planner rule 8",
  agyPlannerBrief.includes(PLANNER_8),
  agyPlannerBrief
);
check("antigravity planner brief does not contain implementer rule 5",
  !agyPlannerBrief.includes(IMPLEMENTER_5),
  agyPlannerBrief
);

const posGeminiPlanner = agyPlannerBrief.indexOf(GEMINI_HEADER);
const posDelegatedPlanner = agyPlannerBrief.indexOf("You are a delegated worker");
check("antigravity planner Gemini instruction comes before 'You are a delegated worker' line",
  posGeminiPlanner >= 0 && posDelegatedPlanner >= 0 && posGeminiPlanner < posDelegatedPlanner,
  `posGemini=${posGeminiPlanner}, posDelegated=${posDelegatedPlanner}`
);
const posMissionPlanner = agyPlannerBrief.indexOf("MISSION=test-mission");
check("antigravity planner Gemini instruction comes after MISSION= line",
  posMissionPlanner >= 0 && posGeminiPlanner > posMissionPlanner,
  `posMission=${posMissionPlanner}, posGemini=${posGeminiPlanner}`
);

const agyImplementerBrief = buildBrief({roleName: "implementer", role: {adapter: "antigravity", model: "gemini-2.5-flash"}, readOnly: false});
check("antigravity implementer brief contains Gemini working rules header",
  agyImplementerBrief.includes(GEMINI_HEADER),
  agyImplementerBrief
);
check("antigravity implementer brief contains rule 1",
  agyImplementerBrief.includes(RULE_1),
  agyImplementerBrief
);
check("antigravity implementer brief contains rule 4",
  agyImplementerBrief.includes(RULE_4),
  agyImplementerBrief
);
check("antigravity implementer brief contains implementer rule 5",
  agyImplementerBrief.includes(IMPLEMENTER_5),
  agyImplementerBrief
);
check("antigravity implementer brief contains implementer rule 7",
  agyImplementerBrief.includes(IMPLEMENTER_7),
  agyImplementerBrief
);
check("antigravity implementer brief does not contain planner rule 5",
  !agyImplementerBrief.includes(PLANNER_5),
  agyImplementerBrief
);
check("antigravity implementer brief does not contain planner rule 8",
  !agyImplementerBrief.includes(PLANNER_8),
  agyImplementerBrief
);

const posGeminiImplementer = agyImplementerBrief.indexOf(GEMINI_HEADER);
const posDelegatedImplementer = agyImplementerBrief.indexOf("You are a delegated worker");
check("antigravity implementer Gemini instruction comes before 'You are a delegated worker' line",
  posGeminiImplementer >= 0 && posDelegatedImplementer >= 0 && posGeminiImplementer < posDelegatedImplementer,
  `posGemini=${posGeminiImplementer}, posDelegated=${posDelegatedImplementer}`
);

// ── 2. Other adapters / non-Gemini roles do NOT carry the Gemini block ──
for (const adapter of ["claude", "opencode", "codex"]) {
  const plannerBrief = buildBrief({roleName: "planner", role: {adapter, model: `${adapter}-default`}, readOnly: false});
  check(`${adapter} planner brief does NOT contain Gemini instruction`,
    !plannerBrief.includes(GEMINI_HEADER),
    plannerBrief
  );

  const implementerBrief = buildBrief({roleName: "implementer", role: {adapter, model: `${adapter}-default`}, readOnly: false});
  check(`${adapter} implementer brief does NOT contain Gemini instruction`,
    !implementerBrief.includes(GEMINI_HEADER),
    implementerBrief
  );

  for (const roleName of ["plan_reviewer", "code_reviewer", "verifier"]) {
    const readOnlyBrief = buildBrief({roleName, role: {adapter, model: `${adapter}-default`}, readOnly: true, review: true});
    check(`${adapter} read-only ${roleName} brief does NOT contain Gemini instruction`,
      !readOnlyBrief.includes(GEMINI_HEADER),
      readOnlyBrief
    );
  }
}

// Antigravity with non-Gemini model does not carry block
const agyNonGeminiBrief = buildBrief({roleName: "planner", role: {adapter: "antigravity", model: "claude-3-5-sonnet"}, readOnly: false});
check("antigravity with non-Gemini model does not carry Gemini block",
  !agyNonGeminiBrief.includes(GEMINI_HEADER),
  agyNonGeminiBrief
);

// ── 3. Antigravity read-only roles DO carry rules 1-4 without planner/implementer rules ──
for (const roleName of ["plan_reviewer", "code_reviewer", "verifier"]) {
  const readOnlyBrief = buildBrief({roleName, role: {adapter: "antigravity", model: "gemini-2.5-pro"}, readOnly: true, review: true});
  check(`antigravity read-only ${roleName} brief contains Gemini working rules header`,
    readOnlyBrief.includes(GEMINI_HEADER),
    readOnlyBrief
  );
  check(`antigravity read-only ${roleName} brief contains rule 1`,
    readOnlyBrief.includes(RULE_1),
    readOnlyBrief
  );
  check(`antigravity read-only ${roleName} brief contains rule 4`,
    readOnlyBrief.includes(RULE_4),
    readOnlyBrief
  );
  check(`antigravity read-only ${roleName} brief does NOT contain planner rule 5`,
    !readOnlyBrief.includes(PLANNER_5),
    readOnlyBrief
  );
  check(`antigravity read-only ${roleName} brief does NOT contain implementer rule 5`,
    !readOnlyBrief.includes(IMPLEMENTER_5),
    readOnlyBrief
  );
  const posGemini = readOnlyBrief.indexOf(GEMINI_HEADER);
  const posDelegated = readOnlyBrief.indexOf("You are a delegated worker");
  check(`antigravity read-only ${roleName} Gemini instruction comes before 'You are a delegated worker'`,
    posGemini >= 0 && posDelegated >= 0 && posGemini < posDelegated,
    `posGemini=${posGemini}, posDelegated=${posDelegated}`
  );
  const posMission = readOnlyBrief.indexOf("MISSION=test-mission");
  check(`antigravity read-only ${roleName} Gemini instruction comes after MISSION= line`,
    posMission >= 0 && posGemini > posMission,
    `posMission=${posMission}, posGemini=${posGemini}`
  );
}

if (failed > 0) {
  console.error(`FAILED: ${failed} check(s) failed`);
  process.exit(1);
}
console.log(`ALL CHECKS PASSED (${ok}/${ok})`);
