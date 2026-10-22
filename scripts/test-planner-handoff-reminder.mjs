#!/usr/bin/env node
// Mission 049 Phase 1 task 1.4 — planner + plan reviewer milestone reminders.
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

let ok = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`PASS ${name}`); ok += 1; return; }
  console.error(`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(String(detail).slice(0, 400))}` : ""}`);
  failed += 1;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "autopilot.mjs"), "utf8");

// ── Planner: repo-note reminder moved adjacent to the request text ──
const plannerRepo = "Keep a hand-off note at ${handoffNoteRelPath(mission, 'standalone-planning-planner')}";
check("planner: repo-note reminder present in both branches",
  src.split(plannerRepo).length - 1 >= 2, src.split(plannerRepo).length - 1);
const adjacentPair = "`Project request/context: ${request}`,\n      `Keep a hand-off note at ${handoffNoteRelPath(mission, 'standalone-planning-planner')}";
check("planner: reminder sits adjacent to the request text (after it, not duplicated before dead-ends)",
  src.split(adjacentPair).length - 1 >= 2, src.split(adjacentPair).length - 1);
const firstPlanner = src.indexOf(plannerRepo);
const plannerSlice = firstPlanner >= 0 ? src.slice(firstPlanner, firstPlanner + 1200) : "";
check("planner: reminder names file:line", plannerSlice.includes("file:line"), plannerSlice.slice(0, 200));
check("planner: reminder tracks Dead ends", plannerSlice.includes("Dead ends"), plannerSlice.slice(0, 200));

// ── Plan reviewer: scratch-note reminder from the shared 1.1 helper ──
check("reviewer: reviewPrompt renders the shared scratch-note helper",
  src.includes("scratchHandoffNotePath(SCRATCH_HANDOFF_NOTE_DEFAULT_DIR, 'standalone-planning-plan_reviewer')"));
check("reviewer: scratch helper import present",
  src.includes("SCRATCH_HANDOFF_NOTE_DEFAULT_DIR") && src.includes("scratchHandoffNotePath"));
const reviewerMarker = "scratchHandoffNotePath(SCRATCH_HANDOFF_NOTE_DEFAULT_DIR, 'standalone-planning-plan_reviewer')";
const revAt = src.indexOf(reviewerMarker);
const revSlice = revAt >= 0 ? src.slice(revAt - 200, revAt + 1200) : "";
check("reviewer: reminder pins the overwrite discipline", revSlice.includes("OVERWRITE it (never append)"), revSlice.slice(0, 200));
check("reviewer: reminder names file:line", revSlice.includes("file:line"), revSlice.slice(0, 200));
check("reviewer: reminder tracks Dead ends", revSlice.includes("Dead ends"), revSlice.slice(0, 200));
check("reviewer: reminder lists Done/Found/Next sections",
  revSlice.includes("1. Done") && revSlice.includes("2. Found") && revSlice.includes("3. Next"), revSlice.slice(0, 300));

console.log(`\n${ok} passed, ${failed} failed`);
if (failed) process.exit(1);
