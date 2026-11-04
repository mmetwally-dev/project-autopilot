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
const RULE_5 = "5. Gather before you act: read every cited location and run every lookup you need in 1-2 responses (one grep -n -e A -e B for several IDs), not one per response.";
const RULE_6 = "6. Do not re-read lines you already read in this session unless they changed (you edited them) or you need lines outside what you read; then read only the missing or changed part.";
const RULE_7 = "7. Search with grep -n or rg, not git grep: new files are not tracked by git yet, so git grep misses them.";
const BATCH_EDIT_RULE = "9. Make independent edits together in ONE response when they touch different places (different files or non-overlapping lines). An edit that depends on, or overlaps, an earlier edit goes in the next response.";
const PLANNER_8 = "8. Edit as you go, as soon as you know the change; never save edits for the end.";
const PLANNER_10 = "10. After editing, do not run git status/log/diff and do not re-read what you just edited only to double-check, and do not write checker scripts.";
const PLANNER_12 = "12. If the work is bigger than your turns: do what fits, write in the hand-off note exactly what is done and what is left (file:line), then end your turn.";
const IMPLEMENTER_8 = "8. Edit as you go; run the task's tests once after the edits and fix what fails.";
const IMPLEMENTER_10 = "10. Do not run git status/log/diff or re-read files only to double-check, and do not write checker scripts.";
const IMPLEMENTER_11 = "11. If the work is bigger than your turns: hand-off note with done / left (file:line), then end your turn.";

// 1. Gemini planner on antigravity -> has rules 1-12 lines (header + rules 1-7 + planner 8-12)
const agyPlannerLines = modelBriefLines({ model: "gemini-2.5-pro", roleName: "planner" });
check(
  "gemini planner on antigravity has 13 total lines (header + rules 1-12)",
  agyPlannerLines.length === 13,
  agyPlannerLines.length
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
  "gemini planner on antigravity contains rule 5",
  agyPlannerLines.includes(RULE_5),
  agyPlannerLines
);
check(
  "gemini planner on antigravity contains rule 6",
  agyPlannerLines.includes(RULE_6),
  agyPlannerLines
);
check(
  "gemini planner on antigravity contains rule 7",
  agyPlannerLines.includes(RULE_7),
  agyPlannerLines
);
check(
  "gemini planner on antigravity contains planner rule 8",
  agyPlannerLines.includes(PLANNER_8),
  agyPlannerLines
);
check(
  "gemini planner on antigravity contains edit-batching rule 9",
  agyPlannerLines.includes(BATCH_EDIT_RULE),
  agyPlannerLines
);
check(
  "gemini planner on antigravity contains planner rule 10",
  agyPlannerLines.includes(PLANNER_10),
  agyPlannerLines
);
check(
  "gemini planner on antigravity contains planner rule 12",
  agyPlannerLines.includes(PLANNER_12),
  agyPlannerLines
);
check(
  "gemini planner on antigravity does not contain implementer rule 8",
  !agyPlannerLines.includes(IMPLEMENTER_8),
  agyPlannerLines
);

// 2. Gemini implementer -> rules 1-7 + implementer 8-11, not planner 8-12
const agyImplementerLines = modelBriefLines({ model: "gemini-2.5-flash", roleName: "implementer" });
check(
  "gemini implementer has 12 total lines (header + rules 1-7 + implementer 8-11)",
  agyImplementerLines.length === 12,
  agyImplementerLines.length
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
  "gemini implementer contains rule 5",
  agyImplementerLines.includes(RULE_5),
  agyImplementerLines
);
check(
  "gemini implementer contains rule 6",
  agyImplementerLines.includes(RULE_6),
  agyImplementerLines
);
check(
  "gemini implementer contains rule 7",
  agyImplementerLines.includes(RULE_7),
  agyImplementerLines
);
check(
  "gemini implementer contains implementer rule 8",
  agyImplementerLines.includes(IMPLEMENTER_8),
  agyImplementerLines
);
check(
  "gemini implementer contains edit-batching rule 9",
  agyImplementerLines.includes(BATCH_EDIT_RULE),
  agyImplementerLines
);
check(
  "gemini implementer contains implementer rule 10",
  agyImplementerLines.includes(IMPLEMENTER_10),
  agyImplementerLines
);
check(
  "gemini implementer contains implementer rule 11",
  agyImplementerLines.includes(IMPLEMENTER_11),
  agyImplementerLines
);
check(
  "gemini implementer does not contain planner rule 8",
  !agyImplementerLines.includes(PLANNER_8),
  agyImplementerLines
);
check(
  "gemini implementer does not contain planner rule 12",
  !agyImplementerLines.includes(PLANNER_12),
  agyImplementerLines
);

// 3. Gemini plan_reviewer / code_reviewer / verifier -> only rules 1-7, no edit-batching line
for (const reviewerRole of ["plan_reviewer", "code_reviewer", "verifier"]) {
  const reviewLines = modelBriefLines({ model: "gemini-2.5-pro", roleName: reviewerRole });
  check(
    `gemini ${reviewerRole} has exactly 8 lines (header + rules 1-7)`,
    reviewLines.length === 8,
    reviewLines.length
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
    `gemini ${reviewerRole} contains rule 5`,
    reviewLines.includes(RULE_5),
    reviewLines
  );
  check(
    `gemini ${reviewerRole} contains rule 6`,
    reviewLines.includes(RULE_6),
    reviewLines
  );
  check(
    `gemini ${reviewerRole} contains rule 7`,
    reviewLines.includes(RULE_7),
    reviewLines
  );
  check(
    `gemini ${reviewerRole} does not contain edit-batching rule`,
    !reviewLines.includes(BATCH_EDIT_RULE),
    reviewLines
  );
  check(
    `gemini ${reviewerRole} does not contain planner rule 8`,
    !reviewLines.includes(PLANNER_8),
    reviewLines
  );
  check(
    `gemini ${reviewerRole} does not contain implementer rule 8`,
    !reviewLines.includes(IMPLEMENTER_8),
    reviewLines
  );
}

// 4. Gemini model on opencode (e.g. "opencode/gemini-x") -> block present
const opencodeGeminiLines = modelBriefLines({ model: "opencode/gemini-x", roleName: "planner" });
check(
  "gemini model on opencode has block present with 13 lines",
  opencodeGeminiLines.length === 13,
  opencodeGeminiLines.length
);
check(
  "gemini model on opencode includes rule 1",
  opencodeGeminiLines.includes(RULE_1),
  opencodeGeminiLines
);
check(
  "gemini model on opencode includes rule 7",
  opencodeGeminiLines.includes(RULE_7),
  opencodeGeminiLines
);
check(
  "gemini model on opencode includes edit-batching rule",
  opencodeGeminiLines.includes(BATCH_EDIT_RULE),
  opencodeGeminiLines
);

// Case insensitivity check (e.g. GEMINI-2.5-PRO)
const upperGeminiLines = modelBriefLines({ model: "GEMINI-2.5-PRO", roleName: "implementer" });
check(
  "case-insensitive model match GEMINI-2.5-PRO has block present with 12 lines",
  upperGeminiLines.length === 12,
  upperGeminiLines.length
);
check(
  "case-insensitive model match GEMINI-2.5-PRO includes edit-batching rule",
  upperGeminiLines.includes(BATCH_EDIT_RULE),
  upperGeminiLines
);

// 5. Claude/codex/deepseek model -> no block
for (const nonGeminiModel of ["claude-3-7-sonnet", "codex", "deepseek-v3"]) {
  const noBlockLines = modelBriefLines({ model: nonGeminiModel, roleName: "planner" });
  check(
    `${nonGeminiModel} planner produces no block (empty array)`,
    Array.isArray(noBlockLines) && noBlockLines.length === 0,
    noBlockLines.length
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
