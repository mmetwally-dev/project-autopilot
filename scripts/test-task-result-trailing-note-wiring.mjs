#!/usr/bin/env node
// Mission 076 task 1.2 — pin parsed.trailingNote wiring at both
// parseTaskResultContract call sites in scripts/autopilot.mjs.
// Static coverage via fs read (autopilot.mjs runs main() on import,
// same pattern as test-cap-breach-wiring.mjs).
import fs from "node:fs";

let ok = 0;
let failed = 0;
function check(name, condition, evidence) {
  if (condition) { console.log(`PASS ${name}`); ok += 1; return; }
  console.error(`FAIL ${name}${evidence !== undefined ? ` :: ${JSON.stringify(evidence)}` : ""}`);
  failed += 1;
}

const src = fs.readFileSync(new URL("./autopilot.mjs", import.meta.url), "utf8");
const count = (re) => [...src.matchAll(re)].length;
const NOTE = "trailing text ignored after a valid result";

// Both existing call sites still present.
check("both parseTaskResultContract call sites present",
  count(/parseTaskResultContract\(taskImpl\.finalMessage\?\?""/g) === 2,
  count(/parseTaskResultContract\(taskImpl\.finalMessage\?\?""/g));

// Both loops guard on parsed.trailingNote.
check("both loops check parsed.trailingNote",
  count(/if\(parsed\.trailingNote\)/g) === 2,
  count(/if\(parsed\.trailingNote\)/g));

// Both loops log the exact note string with the task id.
check("both loops log the exact note with the task id",
  count(/console\.log\(`Task \$\{taskId\}: trailing text ignored after a valid result`\)/g) === 2,
  count(/trailing text ignored after a valid result/g));
check("logged string is exactly the parser note",
  src.includes(NOTE) && count(/trailing text ignored after a valid result/g) >= 2);

// Both loops persist facts.trailingNote only when the parser set it
// (conditional spread — never set for clean blocks).
check("both loops persist facts.trailingNote conditionally",
  count(/\.\.\.\(parsed\.trailingNote\?\{trailingNote:parsed\.trailingNote\}:\{\}\)/g) === 2,
  count(/trailingNote:parsed\.trailingNote/g));
check("no unconditional trailingNote assignment",
  count(/trailingNote:parsed\.trailingNote/g) === 2);

// Existing sentinel-failure paths untouched: same classification,
// same retry (break to budget/enforcement path), same commit escalation.
check("sentinel-failure guard intact at both sites",
  count(/if\(!parsed\.ok\)\{/g) === 2);
check("adapter failure classification intact at both sites",
  count(/failure\(parsed\.code,"adapter",true,\[\{source:"task-result",message:parsed\.reason,taskId\}\]\)/g) === 2);
check("commit-invalid escalation intact for both loops",
  src.includes('s.step="standalone_task_commit_invalid"')
  && src.includes('s.step="speckit_task_commit_invalid"'));

// Facts shape otherwise unchanged: summary/files/taskLocalCheck still the base.
check("facts base shape unchanged at both sites",
  count(/facts:\{summary:parsed\.summary,files:attributed,taskLocalCheck:parsed\.taskLocalCheck,/g) === 2);

console.log(`\n${ok} passed, ${failed} failed`);
if (failed) process.exit(1);
