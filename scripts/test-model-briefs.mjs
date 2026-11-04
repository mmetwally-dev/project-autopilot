#!/usr/bin/env node
import { loadModelBriefs, modelBriefLines } from "./model-briefs.mjs";

let ok = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`PASS ${name}`);
    ok += 1;
    return;
  }
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  failed += 1;
}

const RULE_1 = "1. Put all independent tool calls in ONE response (e.g. read_file a + read_file b + grep -n -e X -e Y files).";
const RULE_4 = "4. No web search, no task-management tools.";
const PLANNER_5 = "5. Edit as you go, as soon as you know the change; never save edits for the end.";
const PLANNER_8 = "8. If the work is bigger than your turns: do what fits, write in the hand-off note exactly what is done and what is left (file:line), then end your turn.";
const IMPLEMENTER_5 = "5. Edit as you go; run the task's tests once after the edits and fix what fails.";
const IMPLEMENTER_7 = "7. If the work is bigger than your turns: hand-off note with done / left (file:line), then end your turn.";

// 1. Gemini planner on antigravity -> has rules 1-8 lines
const agyPlannerLines = modelBriefLines({ model: "gemini-2.5-pro", roleName: "planner" });
check(
  "gemini planner on antigravity has 9 total lines (header + rules 1-8)",
  agyPlannerLines.length === 9,
  agyPlannerLines
);
check(
  "gemini planner on antigravity starts with Gemini working rules header",
  agyPlannerLines[0] === "Gemini working rules:",
  agyPlannerLines[0]
);
check(
  "gemini planner on antigravity contains rule 1",
  agyPlannerLines.includes(RULE_1),
  agyPlannerLines
);
check(
  "gemini planner on antigravity contains rule 4",
  agyPlannerLines.includes(RULE_4),
  agyPlannerLines
);
check(
  "gemini planner on antigravity contains planner rule 5",
  agyPlannerLines.includes(PLANNER_5),
  agyPlannerLines
);
check(
  "gemini planner on antigravity contains planner rule 8",
  agyPlannerLines.includes(PLANNER_8),
  agyPlannerLines
);
check(
  "gemini planner on antigravity does not contain implementer rule 5",
  !agyPlannerLines.includes(IMPLEMENTER_5),
  agyPlannerLines
);

// 2. Gemini implementer -> rules 1-4 + implementer 5-7, not planner 5-8
const agyImplementerLines = modelBriefLines({ model: "gemini-2.5-flash", roleName: "implementer" });
check(
  "gemini implementer has 8 total lines (header + rules 1-4 + implementer 5-7)",
  agyImplementerLines.length === 8,
  agyImplementerLines
);
check(
  "gemini implementer contains rule 1",
  agyImplementerLines.includes(RULE_1),
  agyImplementerLines
);
check(
  "gemini implementer contains rule 4",
  agyImplementerLines.includes(RULE_4),
  agyImplementerLines
);
check(
  "gemini implementer contains implementer rule 5",
  agyImplementerLines.includes(IMPLEMENTER_5),
  agyImplementerLines
);
check(
  "gemini implementer contains implementer rule 7",
  agyImplementerLines.includes(IMPLEMENTER_7),
  agyImplementerLines
);
check(
  "gemini implementer does not contain planner rule 5",
  !agyImplementerLines.includes(PLANNER_5),
  agyImplementerLines
);
check(
  "gemini implementer does not contain planner rule 8",
  !agyImplementerLines.includes(PLANNER_8),
  agyImplementerLines
);

// 3. Gemini plan_reviewer / code_reviewer / verifier -> only rules 1-4
for (const reviewerRole of ["plan_reviewer", "code_reviewer", "verifier"]) {
  const reviewLines = modelBriefLines({ model: "gemini-2.5-pro", roleName: reviewerRole });
  check(
    `gemini ${reviewerRole} has exactly 5 lines (header + rules 1-4)`,
    reviewLines.length === 5,
    reviewLines
  );
  check(
    `gemini ${reviewerRole} contains rule 1`,
    reviewLines.includes(RULE_1),
    reviewLines
  );
  check(
    `gemini ${reviewerRole} contains rule 4`,
    reviewLines.includes(RULE_4),
    reviewLines
  );
  check(
    `gemini ${reviewerRole} does not contain planner rule 5`,
    !reviewLines.includes(PLANNER_5),
    reviewLines
  );
  check(
    `gemini ${reviewerRole} does not contain implementer rule 5`,
    !reviewLines.includes(IMPLEMENTER_5),
    reviewLines
  );
}

// 4. Gemini model on opencode (e.g. "opencode/gemini-x") -> block present
const opencodeGeminiLines = modelBriefLines({ model: "opencode/gemini-x", roleName: "planner" });
check(
  "gemini model on opencode has block present with 9 lines",
  opencodeGeminiLines.length === 9,
  opencodeGeminiLines
);
check(
  "gemini model on opencode includes rule 1",
  opencodeGeminiLines.includes(RULE_1),
  opencodeGeminiLines
);

// Case insensitivity check (e.g. GEMINI-2.5-PRO)
const upperGeminiLines = modelBriefLines({ model: "GEMINI-2.5-PRO", roleName: "implementer" });
check(
  "case-insensitive model match GEMINI-2.5-PRO has block present",
  upperGeminiLines.length === 8,
  upperGeminiLines
);

// 5. Claude/codex/deepseek model -> no block
for (const nonGeminiModel of ["claude-3-7-sonnet", "codex", "deepseek-v3"]) {
  const noBlockLines = modelBriefLines({ model: nonGeminiModel, roleName: "planner" });
  check(
    `${nonGeminiModel} planner produces no block (empty array)`,
    Array.isArray(noBlockLines) && noBlockLines.length === 0,
    noBlockLines
  );
}

// 6. Missing/invalid json -> [] without throwing
const missingRoot = `/tmp/nonexistent-skillroot-${Date.now()}`;
let missingLinesResult = null;
let missingLoadResult = null;
let didThrow = false;

try {
  missingLinesResult = modelBriefLines({
    model: "gemini-2.5-pro",
    roleName: "planner",
    skillRoot: missingRoot,
  });
  missingLoadResult = loadModelBriefs(missingRoot);
} catch (err) {
  didThrow = true;
}

check("missing json does not throw", !didThrow, didThrow);
check(
  "missing json produces empty array from modelBriefLines",
  Array.isArray(missingLinesResult) && missingLinesResult.length === 0,
  missingLinesResult
);
check(
  "missing json produces empty families from loadModelBriefs",
  Array.isArray(missingLoadResult?.families) && missingLoadResult.families.length === 0,
  missingLoadResult
);

// 7. loadModelBriefs reads the json once (cached)
const briefs1 = loadModelBriefs();
const briefs2 = loadModelBriefs();
check(
  "loadModelBriefs returns cached reference on subsequent calls",
  briefs1 === briefs2 && briefs1 !== null,
  { isSame: briefs1 === briefs2 }
);

if (failed > 0) {
  console.error(`FAILED: ${failed} check(s) failed`);
  process.exit(1);
}
console.log(`ALL CHECKS PASSED (${ok}/${ok})`);
